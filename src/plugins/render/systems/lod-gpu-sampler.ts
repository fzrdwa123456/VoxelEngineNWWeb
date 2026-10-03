// ===== M1 OF THE GPU ROUTE: the far ring SAMPLES ON THE GPU =====
// WHAT THIS REPLACES. One coarse LOD column takes the MAX and MIN height over `step × step` fine columns, per cell
// of a (S+2)² grid, on the MAIN THREAD: measured 1.76 ms at step 2 and **289.7 ms at step 32**, i.e. ~71 s for the
// whole six-rung ladder (ROADMAP P2.06). That is the engine's one CPU wall, and it is what the player feels as the
// ~1 s stalls while the outer rungs fill. M0 proved the GPU reproduces the field EXACTLY (67048 of 67048 values
// identical), M1a measured the layout, and this module is the production half: the same field, one dispatch per
// batch, ONE readback, feeding the REAL streaming path.
//
// HOW IT PLUGS IN. `chunk.stream` asks this object for a column's grid (`LodGridSource.gridFor`). A READY column
// returns the GPU's max/min grids and the stream builds the mesh from them exactly as it did from the CPU's; a
// column that is NOT ready yet returns null and the stream leaves that far chunk for the next frame (it stays in
// `farWanted`, so it is retried — see the stream's own note). The sampler PREFETCHES: every frame it walks the
// stream's `farKeys` in order and samples the next batch, which is 16× faster than the stream consumes columns, so
// a miss is a first-frames event rather than the normal case.
//
// THE FALLBACKS ARE DELIBERATE, because a sampler that can hang the world is worse than a slow one:
//   * no WebGPU backend (a WebGL fallback install, or the Node gate) -> `lodSampleGrid`, i.e. exactly the path the
//     engine had before this file existed;
//   * a column the sampler has missed `MISS_LIMIT` times in a row (a bug, an eviction, a lost batch) -> CPU-sample
//     it: a bounded stall beats a permanent hole in the far ring;
//   * the renderer is not initialised yet (it is CONSTRUCTED during wiring and initialised behind the loading
//     screen) -> answer "not ready" rather than locking the CPU in for the rest of the session.
//
// ONE DISPATCH, ONE READBACK, ONE PIPELINE. The batch is a RUN of same-step columns (the far key set is ordered
// rung by rung, so a run is what the cursor naturally finds), which is what lets the step be a COMPILE-TIME
// constant: one kernel per (step, period), cached for the session, reused across frames with only `count` changed.
// The output is ONE packed u32 buffer holding the `max` half then the `min` half, so a batch costs exactly one
// `getArrayBufferAsync` — the fixed part of a dispatch (pipeline + sync + map) is what dominated the probe's
// numbers, and paying it once per batch is the whole point of M1.
//
// .toAtomic() IS LOAD-BEARING on the output: `storage(attr,"uint",n)` declares a plain `ptr<storage, u32>`, WGSL
// has no `atomicMax` for that, the pipeline then fails to compile and the dispatch writes NOTHING (silently —
// `computeAsync` still resolves). See the probe's M1a run and ROADMAP P2.06.
import {
  Fn,
  add,
  atomicMax,
  atomicMin,
  div,
  float,
  instanceIndex,
  mod,
  mul,
  storage,
  uint,
} from "three/tsl";
import { StorageBufferAttribute, type WebGPURenderer } from "three/webgpu";
import { CHUNK_SIZE } from "../../../data/world/chunk";
import { LOD_SAMPLE_GRID_W, lodSampleGrid } from "../../../data/world/lod";
import { TERRAIN_MAX_Y, terrainHeight, terrainPeriod } from "../../../data/world/terrain";
import { CHUNK_MESHES, RENDERER3D, type ChunkMeshCache } from "../../../data/globals/gfx";
import { n, tslTerrainHeight, tslWrap } from "./lod-gpu-field";
import type { LodGridSource } from "./chunk-stream";
import type { SystemAccess, World } from "../../../core/world";

/** The sampler reads the renderer (the compute queue) and the chunk cache (whose `farKeys` is its WORK LIST — the
 *  columns the stream wants, in the order it will want them), and writes buffers of its own. Declared, so the
 *  schedule places it after `chunk.stream` (the writer of that list) and models "who may use the GPU". */
export const LOD_SAMPLE_ACCESS: SystemAccess = {
  readsExternal: ["renderer3d", "chunkMeshes"],
  writesExternal: ["lodSampleBuffers"],
};

/** Cells in one sampled grid: the chunk's own 32² plus one border cell on every side (`LOD_SAMPLE_GRID_W²`). This
 *  is the slot count of ONE column, in BOTH halves of the packed buffer. */
const CELLS = LOD_SAMPLE_GRID_W * LOD_SAMPLE_GRID_W;
/** Columns in one batch. The other two limits (samples, and therefore workgroups) bite first for the outer rungs;
 *  this one bounds the readback and the bookkeeping. */
const BATCH_COLUMNS = 64;
/** Samples (i.e. THREADS) in one batch. 4M is a HARD ceiling, not a tuning choice: WebGPU's default
 *  `maxComputeWorkgroupsPerDimension` is 65535, and with 64-thread workgroups 4.19M threads is exactly that.
 *  The cap is spent on the outer rungs (a step-32 column is 1.18M samples, so 3 columns per batch there). */
const BATCH_SAMPLES = 4_000_000;
/** The `min` half starts here in the packed buffer. A compile-time constant, which is what lets the kernel stay
 *  a pure function of (instanceIndex, column buffer). */
const PACKED_HALF = CELLS * BATCH_COLUMNS;
/** Where an untouched `min` slot starts: above every possible height (the field is clamped to
 *  `[TERRAIN_NOISE.minY, TERRAIN_NOISE.maxY]`). The packed buffer is RESET to this before every dispatch, because
 *  `atomicMax`/`atomicMin` accumulate onto whatever the previous batch left there. */
const UNSET_MIN = 4096;
/** Samples the self-check compares per rung (5 cells of one column, computed on the CPU): ~1.3 ms even at
 *  step 32, which is why it can run for every rung in the production path. */
const SELF_CHECK_CELLS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 1],
  [LOD_SAMPLE_GRID_W - 1, LOD_SAMPLE_GRID_W - 1],
  [LOD_SAMPLE_GRID_W >> 1, LOD_SAMPLE_GRID_W >> 1],
  [LOD_SAMPLE_GRID_W - 1, 3],
];
/** How many frames the far ring may wait for a column before the CPU is allowed to build it (a runaway guard for
 *  the case where a column was never queued). At 60 fps this is 2 s. */
const MISS_LIMIT = 120;
/** How many frames the sampler waits for `renderer.backend` before deciding there is no GPU at all. The renderer
 *  is initialised behind the loading screen and the far ring only builds inside a world, so this is a broken-install
 *  guard, not a normal path. */
const ABSENT_LIMIT = 600;

const colKey = (step: number, cx: number, cz: number): string => `${step}:${cx},${cz}`;

/** One sampled column, in the shape the mesh input wants (`data/world/lod.ts`). */
export interface SampledGrid {
  readonly max: Int16Array;
  readonly min: Int16Array;
}

/** The production sampler (M1). Not a system itself — `LodGpuSamplerSystem` below is the scheduled shell, so this
 *  object can also be driven directly by a test (the gate drives `gridFor` on a stub). */
export class LodGpuSampler implements LodGridSource {
  private readonly renderer: WebGPURenderer;
  private readonly cache: ChunkMeshCache;
  private readonly log: (line: string) => void;
  /** `unknown` until the renderer says what it is. `cpu` is terminal: the far ring then samples on this thread,
   *  which is the pre-M1 behaviour. */
  private backend: "unknown" | "gpu" | "cpu" = "unknown";
  private absentFrames = 0;
  /** The sampled columns, keyed `"<step>:cx,cz"` (a column's grid serves all 8 of its Y chunks). */
  private readonly ready = new Map<string, SampledGrid>();
  /** Consecutive misses per column, for the "answer it on the CPU rather than never" guard (see `gridFor`). */
  private readonly misses = new Map<string, number>();
  /** The work list: the stream's far key set (its IDENTITY is the window token) and the distinct columns inside it,
   *  in the order the build budget will ask for them. */
  private keySet: Set<string> | null = null;
  private columns: Array<{ step: number; cx: number; cz: number }> = [];
  private cursor = 0;
  /** One kernel per (step, period): the step is a compile-time constant, the period is too (the field wraps on the
   *  lap, which is the world-size setting). */
  private readonly kernels = new Map<string, unknown>();
  private period = -1;
  private packedAttr: StorageBufferAttribute | null = null;
  private packedData: Uint32Array | null = null;
  private colAttr: StorageBufferAttribute | null = null;
  private colData: Uint32Array | null = null;
  /** One batch at a time: the readback is awaited, and a second `step()` while it flies is a no-op. */
  private busy = false;
  /** Rungs whose self-check has run (one column each), and what it found. */
  private readonly selfChecked = new Set<number>();
  private selfCheckFailures = 0;
  /** What the last window fill cost, for the one summary line per window. */
  private batches = 0;
  private sampledColumns = 0;
  private sampledSamples = 0;
  private gpuMs = 0;
  private firstBatchLogged = false;
  /** How many columns had to be answered on the CPU (see `gridFor`). */
  private fallbacks = 0;

  constructor(world: World, log: (line: string) => void) {
    this.renderer = world.resource(RENDERER3D);
    this.cache = world.resource(CHUNK_MESHES);
    this.log = log;
  }

  /** The stream's question: the max/min grid of one coarse column, or null when it is not ready yet.
   *  NEVER blocks and never samples on the CPU in the ready case — the three fallbacks are in the header. */
  gridFor(step: number, cx: number, cz: number): SampledGrid | null {
    if (this.backend === "cpu") return lodSampleGrid(step, cx, cz);
    if (this.backend === "unknown") return null; // the renderer is not up yet: the far ring waits a frame or two
    const key = colKey(step, cx, cz);
    const hit = this.ready.get(key);
    if (hit !== undefined) return hit;
    const misses = (this.misses.get(key) ?? 0) + 1;
    this.misses.set(key, misses);
    if (misses > MISS_LIMIT) {
      // A COLUMN THE SAMPLER NEVER PRODUCED. Not a hole: the CPU answers it (this thread, one stall) and the miss
      // counter resets, so a systematic failure costs one fallback per MISS_LIMIT frames instead of a blank ring.
      this.misses.set(key, 0);
      this.fallbacks++;
      return lodSampleGrid(step, cx, cz);
    }
    return null;
  }

  /** One pump per rendered frame: resolve the work list, then fire at most ONE batch (dispatch + readback). */
  step(): void {
    if (this.backend === "unknown") {
      const backend = (this.renderer as { backend?: { isWebGPUBackend?: boolean } }).backend;
      if (backend === undefined) {
        if (++this.absentFrames > ABSENT_LIMIT) {
          this.backend = "cpu";
          this.log(
            `LODSAMPLE off: the renderer never initialised after ${ABSENT_LIMIT} frames — the far ring samples on the CPU`,
          );
        }
        return;
      }
      if (backend.isWebGPUBackend !== true) {
        this.backend = "cpu";
        this.log("LODSAMPLE off: this backend has no compute (WebGL fallback) — the far ring samples on the CPU");
        return;
      }
      this.backend = "gpu";
      this.log(
        "LODSAMPLE on (M1): the far ring's height grids are sampled on the GPU — one dispatch and one readback per " +
          `batch of ${BATCH_COLUMNS} columns`,
      );
    }
    if (this.backend !== "gpu" || this.busy) return;

    // THE PERIOD IS PART OF THE FIELD: a world-size change (a new world) invalidates every sampled grid and every
    // kernel, because the wrap does.
    const period = terrainPeriod();
    if (period !== this.period) {
      this.period = period;
      this.kernels.clear();
      this.ready.clear();
      this.misses.clear();
      this.selfChecked.clear();
      this.keySet = null;
      this.cursor = 0;
      this.columns = [];
    }
    this.syncWindow();
    const batch = this.takeBatch();
    if (batch === null) return;
    void this.dispatch(batch);
  }

  /** Rebuild the column work list when the stream publishes a NEW far key set (its identity is the window token).
   *  The list is the distinct COLUMNS of that set, in the set's own order — the same order the build budget walks,
   *  so the sampler is always working on what the stream is about to ask for. */
  private syncWindow(): void {
    const keys = this.cache.farKeys;
    if (keys === this.keySet) return;
    this.keySet = keys;
    this.cursor = 0;
    this.columns = [];
    if (keys === null) return;
    const seen = new Set<string>();
    for (const key of keys) {
      const colon = key.indexOf(":");
      if (colon < 0) continue;
      const step = Number(key.slice(0, colon));
      if (!(step > 1)) continue; // rung 1 IS the fine ring: real chunks, nothing to sample
      const parts = key.slice(colon + 1).split(",");
      const cx = Number(parts[0]);
      const cz = Number(parts[2]);
      const ck = colKey(step, cx, cz);
      if (seen.has(ck)) continue;
      seen.add(ck);
      this.columns.push({ step, cx, cz });
    }
  }

  /** The next batch: a run of same-step, not-yet-sampled columns from the cursor, bounded by the column and sample
   *  caps. null when the window is fully sampled (the cursor only moves forward until the key set changes). */
  private takeBatch(): { step: number; cols: Array<readonly [number, number]> } | null {
    while (this.cursor < this.columns.length) {
      const step = this.columns[this.cursor].step;
      const perColumn = CELLS * step * step;
      const cols: Array<readonly [number, number]> = [];
      let samples = 0;
      while (this.cursor < this.columns.length && cols.length < BATCH_COLUMNS) {
        const c = this.columns[this.cursor];
        if (c.step !== step) break; // one step per dispatch: the step is a compile-time constant in the kernel
        this.cursor++;
        if (this.ready.has(colKey(c.step, c.cx, c.cz))) continue;
        // THE CAP IS CHECKED BEFORE THE COLUMN GOES IN: `samples` IS the thread count, and one thread too many is a
        // dispatch past `maxComputeWorkgroupsPerDimension` — a failed batch rather than a slow one.
        if (cols.length > 0 && samples + perColumn > BATCH_SAMPLES) {
          this.cursor--; // this column belongs to the NEXT batch
          break;
        }
        cols.push([c.cx, c.cz]);
        samples += perColumn;
        if (samples >= BATCH_SAMPLES) break;
      }
      if (cols.length > 0) return { step, cols };
    }
    return null;
  }

  /** Fire one batch and wait for its readback. The continuation runs between frames, so `step()` sees the result on
   *  the next one — the far ring is at most a frame or two behind, and `farWanted` keeps the keys alive. */
  private async dispatch(batch: { step: number; cols: Array<readonly [number, number]> }): Promise<void> {
    this.busy = true;
    const started = performance.now();
    try {
      const step = batch.step;
      const cols = batch.cols;
      const slots = cols.length * CELLS;
      this.ensureBuffers();
      const colData = this.colData!;
      for (let i = 0; i < cols.length; i++) {
        colData[i * 2] = cols[i][0];
        colData[i * 2 + 1] = cols[i][1];
      }
      this.colAttr!.needsUpdate = true;
      // THE PACKED BUFFER IS RESET FIRST: the atomics accumulate onto what is already there, so the used prefix must
      // start at 0 (`max`) / UNSET_MIN (`min`) or this batch's answer is the max over the LAST batch's leftovers.
      const packed = this.packedData!;
      packed.fill(0, 0, slots);
      packed.fill(UNSET_MIN, PACKED_HALF, PACKED_HALF + slots);
      this.packedAttr!.needsUpdate = true;

      const kernel = this.kernelFor(step) as { count: number };
      kernel.count = slots * step * step;
      await this.renderer.computeAsync(kernel as never);
      const raw = new Uint32Array(await this.renderer.getArrayBufferAsync(this.packedAttr!));
      for (let i = 0; i < cols.length; i++) {
        const max = new Int16Array(CELLS);
        const min = new Int16Array(CELLS);
        for (let k = 0; k < CELLS; k++) {
          max[k] = raw[i * CELLS + k];
          min[k] = raw[PACKED_HALF + i * CELLS + k];
        }
        const key = colKey(step, cols[i][0], cols[i][1]);
        this.ready.set(key, { max, min });
        this.misses.delete(key);
      }
      this.selfCheck(step, cols[0][0], cols[0][1], raw);
      this.batches++;
      this.sampledColumns += cols.length;
      this.sampledSamples += slots * step * step;
      this.gpuMs += performance.now() - started;
      if (!this.firstBatchLogged) {
        this.firstBatchLogged = true;
        this.log(
          `LODSAMPLE first batch: step ${step}, ${cols.length} column(s), ${(slots * step * step / 1e6).toFixed(2)}M ` +
            `samples in ${(performance.now() - started).toFixed(1)}ms (dispatch + one readback)`,
        );
      }
      if (this.cursor >= this.columns.length) {
        this.log(
          `LODSAMPLE window: ${this.sampledColumns} column(s) in ${this.batches} batch(es), ` +
            `${(this.sampledSamples / 1e6).toFixed(1)}M samples, ${this.gpuMs.toFixed(0)}ms of GPU round trips` +
            `${this.fallbacks > 0 ? `, ${this.fallbacks} CPU fallback(s)` : ""}` +
            `${this.selfCheckFailures > 0 ? `, ${this.selfCheckFailures} SELF-CHECK FAILURE(S) — see above` : ""}`,
        );
        this.batches = 0;
        this.sampledColumns = 0;
        this.sampledSamples = 0;
        this.gpuMs = 0;
        this.fallbacks = 0;
        this.firstBatchLogged = false;
        // The cache is kept (a column that comes back is a hit); the CAP is there because the map is keyed by
        // window and a long walk would otherwise hold every column ever sampled. The whole six-rung ring is 772
        // columns, so 2048 is roughly two and a half windows of headroom (~9 MB of Int16 grids).
        if (this.ready.size > 2048) {
          this.ready.clear();
          this.misses.clear();
        }
      }
    } catch (err) {
      // A failed batch is not fatal: the columns stay unsampled, the stream's miss guard falls back to the CPU, and
      // the reason is in the log (`renderer.log` is where a WGSL problem lands).
      this.log(`LODSAMPLE batch FAILED: ${String((err as Error)?.message ?? err)}`);
    } finally {
      this.busy = false;
    }
  }

  /** The kernel for one step: built once per (step, period) and reused, so a batch costs no pipeline creation.
   *  Everything is a compile-time constant except the column coordinates (a storage buffer) and the thread count. */
  private kernelFor(step: number): unknown {
    const key = `${step}:${this.period}`;
    const hit = this.kernels.get(key);
    if (hit !== undefined) return hit;
    const W = LOD_SAMPLE_GRID_W;
    const perCell = step * step;
    const perColumn = CELLS * perCell;
    const out = storage(this.packedAttr!, "uint", PACKED_HALF * 2).toAtomic();
    const cols = storage(this.colAttr!, "uint", BATCH_COLUMNS * 2);
    const period = this.period;
    const kernel = Fn(() => {
      const idx = instanceIndex;
      const col = div(idx, uint(perColumn));
      const rem = mod(idx, uint(perColumn));
      const cell = div(rem, uint(perCell));
      const s = mod(rem, uint(perCell));
      const i = mod(cell, uint(W));
      const j = div(cell, uint(W));
      const cx = cols.element(mul(col, uint(2)));
      const cz = cols.element(add(mul(col, uint(2)), uint(1)));
      // The same absolute-block layout the CPU builds: the grid's cell (i,j) covers the `step × step` fine columns
      // starting at `(cx*S + (i-1)) * step`, i.e. one cell of border on every side (`sampledGrid` in lod.ts).
      const bx = mul(add(add(mul(cx.toFloat(), float(CHUNK_SIZE)), i.toFloat()), float(-1)), float(step));
      const bz = mul(add(add(mul(cz.toFloat(), float(CHUNK_SIZE)), j.toFloat()), float(-1)), float(step));
      const within = n(s).toUint();
      const dz = div(within, uint(step));
      const dx = mod(within, uint(step));
      const t = tslTerrainHeight(period, tslWrap(add(bx, dx.toFloat()), period), tslWrap(add(bz, dz.toFloat()), period));
      const slot = add(mul(col, uint(CELLS)), cell);
      atomicMax(out.element(slot), uint(t));
      atomicMin(out.element(add(slot, uint(PACKED_HALF))), uint(t));
    })().compute(1);
    this.kernels.set(key, kernel);
    return kernel;
  }

  private ensureBuffers(): void {
    if (this.packedAttr !== null) return;
    this.packedData = new Uint32Array(PACKED_HALF * 2);
    this.packedAttr = new StorageBufferAttribute(this.packedData, 1);
    this.colData = new Uint32Array(BATCH_COLUMNS * 2);
    this.colAttr = new StorageBufferAttribute(this.colData, 1);
  }

  /** THE SAMPLER'S OWN SANITY CHECK, ONCE PER RUNG, IN THE PRODUCTION PATH: five cells of the first column of a
   *  rung, recomputed with `terrainHeight` on this thread (~1.3 ms at step 32). A wrong constant, a wrong seed, a
   *  missing wrap or a broken atomic shows up here as a number instead of as a hole in the world — and the full
   *  value-by-value comparison is still `K` (the M0 probe). */
  private selfCheck(step: number, cx: number, cz: number, raw: Uint32Array): void {
    if (this.selfChecked.has(step)) return;
    this.selfChecked.add(step);
    const W = LOD_SAMPLE_GRID_W;
    const period = terrainPeriod();
    const gx0 = cx * CHUNK_SIZE * step;
    const gz0 = cz * CHUNK_SIZE * step;
    const wrap = (v: number): number => ((v % period) + period) % period;
    let values = 0;
    let bad = 0;
    let maxDiff = 0;
    for (const [i, j] of SELF_CHECK_CELLS) {
      let hi = 0;
      let lo = TERRAIN_MAX_Y;
      for (let dz = 0; dz < step; dz++) {
        for (let dx = 0; dx < step; dx++) {
          const t = terrainHeight(wrap(gx0 + (i - 1) * step + dx), wrap(gz0 + (j - 1) * step + dz));
          if (t > hi) hi = t;
          if (t < lo) lo = t;
        }
      }
      const k = j * W + i;
      const gotMax = raw[k];
      const gotMin = raw[PACKED_HALF + k];
      values += 2;
      if (gotMax !== hi) {
        bad++;
        maxDiff = Math.max(maxDiff, Math.abs(gotMax - hi));
      }
      if (gotMin !== lo) {
        bad++;
        maxDiff = Math.max(maxDiff, Math.abs(gotMin - lo));
      }
    }
    if (bad > 0) this.selfCheckFailures++;
    this.log(
      `LODSAMPLE self-check step ${step}: ${bad === 0 ? `OK — ${values} values identical` : `${bad} of ${values} ` +
        `values DIFFER from the CPU (max |Δ| ${maxDiff}) — the far ring's heights are wrong, stop and fix the field`}`,
    );
  }
}

/** RENDER lane. One pump per frame; everything else about the sampler is a question the stream asks. */
export class LodGpuSamplerSystem {
  private readonly sampler: LodGpuSampler;

  constructor(world: World, log: (line: string) => void) {
    this.sampler = new LodGpuSampler(world, log);
  }

  /** What `chunk.stream` is handed (see `LodGridSource`). */
  get source(): LodGridSource {
    return this.sampler;
  }

  step(): void {
    this.sampler.step();
  }
}
