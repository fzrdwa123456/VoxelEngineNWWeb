// ===== M0 OF THE GPU ROUTE: does a GPU sampler agree with the CPU one? =====
// WHY THIS EXISTS. The LOD ladder's sampling is the engine's one CPU wall: one coarse super voxel takes the MAX
// and MIN height over `step × step` fine columns, so a rung-6 column (1024 fine columns per cell) costs ~290 ms
// ON THE MAIN THREAD, and the whole six-rung ladder adds up to ~71 s of it — measured, see ROADMAP P2.06. The
// plan is to move that sampling (then the meshing, then the drawing) to the GPU, and this probe is the FIRST
// step of it, because everything after it depends on one question:
//
//   CAN THE GPU REPRODUCE `terrainHeight` EXACTLY?
//
// The CPU field (`data/world/terrain.ts`) is f64 arithmetic over a 32-bit integer hash, while the GPU is f32.
// A one-block disagreement is not cosmetic: the coarse surface must never be BELOW the fine one (P1.93 — that
// is what makes a crack impossible), and a coarse cell a block low is exactly such a crack. So this probe runs
// the SAME field on the GPU, over the same grids the production CPU path builds, and REPORTS THE DIFFERENCE
// instead of pretending there is none.
//
// WHAT IT COMPARES. `lodSampleGrid` (the CPU reference, the real `sampledGrid` behind `buildLodMeshInput`) vs a
// TSL compute kernel that samples the field per GPU thread. The GPU kernel is a straight port, and its constants
// come from `TERRAIN_NOISE` — never retyped — so the two cannot drift.
//
// HOW TO RUN IT. In a world, press `K`: the probe runs a batch per rung (steps 2/4/8/16/32), compares every cell
// and writes one line per rung plus a verdict to `debug.log`, with a toast for the summary. It is a DEBUG PROBE:
// it owns no component, it changes no streaming state, and it is off unless asked for. The CPU reference is the
// slow half (~1 s in total, dominated by the two outer rungs) and it runs on the thread that asked, so a stall
// for the duration of the probe is expected and reported.
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
import { TERRAIN_NOISE, TERRAIN_SEED, terrainPeriod } from "../../../data/world/terrain";
import { worldChunksX } from "../../../data/world/size";
import { ShowToast } from "../../../data/globals/commands";
import { RENDERER3D } from "../../../data/globals/gfx";
import { KEY_EVENTS, KeyEdgeReader } from "../../../data/globals/resources";
import { n, tslTerrainHeight, tslWrap, type U32Node } from "./lod-gpu-field";
import type { SystemAccess, World } from "../../../core/world";

/** The probe touches the GPU and nothing the world models: it reads the renderer (the compute queue) and owns
 *  its own scratch buffers. Declared, so the schedule can place it — it also makes "who may use the GPU" a
 *  readable fact rather than a comment. */
export const LOD_PROBE_ACCESS: SystemAccess = {
  readsExternal: ["renderer3d"],
  writesExternal: ["lodProbeBuffers"],
};

/** Which rungs to compare and how many columns of each: the whole point is the OUTER rungs, but the CPU reference
 *  is what the probe pays for, so a rung-32 column is worth two of them and a step-2 column is nearly free. */
const COLUMNS_PER_STEP: ReadonlyArray<readonly [number, number]> = [
  [2, 8],
  [4, 8],
  [8, 8],
  [16, 3],
  [32, 2],
];

/** One probe batch: `columns` coarse columns of `step`, laid out over the same (S+2)² grid the CPU builds. The
 *  columns are DERIVED from the column index (the same two lines the CPU side uses), so no extra buffer is
 *  needed to carry their coordinates. */
interface ProbeBatch {
  readonly kernel: ReturnType<ReturnType<typeof Fn>>;
  readonly maxAttr: StorageBufferAttribute;
  readonly minAttr: StorageBufferAttribute;
  readonly cells: number;
  /** The column coordinates, in the order the kernel derives them — the CPU reference asks for the same ones. */
  readonly columns: ReadonlyArray<readonly [number, number]>;
  /** Threads this batch dispatches: `columns × cells × step²`, i.e. ONE PER SAMPLE. */
  readonly threads: number;
}

/** Where an untouched `min` slot starts: above every possible height (the field is clamped to
 *  `[TERRAIN_NOISE.minY, TERRAIN_NOISE.maxY]`), so a grid of these proves the kernel never ran. */
const UNSET_MIN = 4096;

/** ONE THREAD PER SAMPLE (M1a, now also the PRODUCTION layout — see lod-gpu-sampler.ts).
 *
 *  WHY THIS REPLACED THE CELL-PER-THREAD VERSION: that one gave each thread a whole grid cell with an inner loop
 *  of `step²` samples, so a step-32 batch was ~2300 threads — the device sat idle, and the batch took 605 ms where
 *  this one takes 340 ms for the same four million samples. (The "4M samples/s" both runs printed was NOT a
 *  measurement: the throughput formula clamped its divisor in the wrong unit, see the RESULT line's note. The honest
 *  figures are ~11.8M/s here against the CPU's 6.3M/s, round trips included.) Here every SAMPLE gets a thread:
 *  `columns × cells × step²` of them, millions for the outer rungs, and the per-cell max/min is combined with
 *  ATOMICS rather than by a serial loop (two `atomicMax`es per sample — one on the height, one on its complement,
 *  which is how a `min` is spelled when only max-atomics are needed).
 *
 *  u32 BUFFERS, because atomics need integers. The field ROUNDS to integers anyway, so nothing is lost, and the
 *  readback is compared against the CPU's Int16 grids exactly as before. */
function buildBatch(step: number, columns: number, lapCells: number, period: number): ProbeBatch {
  const W = LOD_SAMPLE_GRID_W;
  const cells = W * W;
  const perColumn = cells * step * step;
  const slots = columns * cells;
  const threads = columns * perColumn;
  const maxAttr = new StorageBufferAttribute(new Uint32Array(slots), 1);
  const minAttr = new StorageBufferAttribute(new Uint32Array(slots).fill(UNSET_MIN), 1);
  // `.toAtomic()` IS LOAD-BEARING, and its absence cost a whole test round (M1a run #1: every batch came back
  // untouched — the probe correctly said "the kernel did not run"). `storage(attr, "uint", n)` declares a plain
  // `ptr<storage, u32, read_write>`, and WGSL has NO `atomicMax` for that: the pipeline fails to compile, the
  // dispatch silently writes nothing, and the only trace is in `renderer.log`
  // (`no matching call to 'atomicMax(ptr<storage, u32, read_write>, u32)'`). `.toAtomic()` re-declares the buffer
  // as `ptr<storage, atomic<u32>>`, which is what the atomic builtins require. It must be applied to EVERY buffer
  // an atomic touches — the plain `storage()` above is the NODE, so this cannot be pushed down into `buildBatch`'s
  // caller.
  const outMax = storage(maxAttr, "uint", slots).toAtomic();
  const outMin = storage(minAttr, "uint", slots).toAtomic();
  const kernel = Fn(() => {
    const idx = instanceIndex;
    const col = div(idx, uint(perColumn));
    const rem = mod(idx, uint(perColumn));
    const cell = div(rem, uint(step * step));
    const s = mod(rem, uint(step * step));
    const i = mod(cell, uint(W));
    const j = div(cell, uint(W));
    const cx = mod(mul(col, uint(11)), uint(lapCells));
    const cz = mod(mul(col, uint(7)), uint(lapCells));
    const bx = mul(add(add(mul(cx.toFloat(), float(CHUNK_SIZE)), i.toFloat()), float(-1)), float(step));
    const bz = mul(add(add(mul(cz.toFloat(), float(CHUNK_SIZE)), j.toFloat()), float(-1)), float(step));
    // THE TYPES ARE THE TRAP HERE, and it cost a whole test round: `instanceIndex` is a u32 but `Loop`'s counter is
    // an i32, and mixing them (`i32 % u32`) does not compile at all — the pipeline is created invalid, the
    // dispatch writes nothing, and the probe reads its untouched buffers back (that run reported every value 0,
    // max |Δ| 149, with the reason only in `renderer.log`). Everything in this kernel is u32 on purpose, and the
    // untouched-buffer grid is what the probe now detects as "the kernel did not run".
    const within: U32Node = n(s).toUint();
    const dz: U32Node = div(within, uint(step));
    const dx: U32Node = mod(within, uint(step));
    // The wrap is `lod.ts`'s `wrapBlock` (a torus in X/Z), shared with the production sampler — see lod-gpu-field.ts.
    const t = tslTerrainHeight(period, tslWrap(add(bx, dx.toFloat()), period), tslWrap(add(bz, dz.toFloat()), period));
    const slot = add(mul(col, uint(cells)), cell);
    atomicMax(outMax.element(slot), uint(t));
    atomicMin(outMin.element(slot), uint(t));
  })().compute(threads);
  const coords: Array<readonly [number, number]> = [];
  for (let c = 0; c < columns; c++) coords.push([(c * 11) % lapCells, (c * 7) % lapCells]);
  return { kernel: kernel as ProbeBatch["kernel"], maxAttr, minAttr, cells, columns: coords, threads };
}

/** RENDER lane. `K` starts the probe; everything else about it is reported, never acted on. */
export class LodGpuProbeSystem {
  private readonly keys: KeyEdgeReader;
  private readonly renderer: WebGPURenderer;
  private readonly world: World;
  private readonly log: (line: string) => void;
  /** One probe at a time: a second `K` while it runs is ignored (it awaits the GPU). */
  private busy = false;

  constructor(world: World, log: (line: string) => void) {
    this.world = world;
    this.renderer = world.resource(RENDERER3D);
    this.keys = new KeyEdgeReader(world.resource(KEY_EVENTS));
    this.log = log;
  }

  step(): void {
    let presses = 0;
    this.keys.drain((edge) => {
      if (edge.down && !edge.repeat && edge.code === "KeyK") presses++;
    });
    if (presses > 0 && !this.busy) void this.run();
  }

  /** Run the comparison. Async on purpose: the lane may not block, and the readbacks are awaited one batch at a
   *  time — which is also how the probe measures the round trip it exists to report. */
  private async run(): Promise<void> {
    this.busy = true;
    const started = performance.now();
    const backend = this.renderer.backend as { isWebGPUBackend?: boolean } | undefined;
    this.log(`LODPROBE start: backend=${backend?.isWebGPUBackend === true ? "webgpu" : "not-webgpu"} lap=${worldChunksX()} chunks`);
    let compared = 0;
    let mismatched = 0;
    let maxDiff = 0;
    let gpuTotal = 0;
    let cpuTotal = 0;
    let samplesTotal = 0;
    /** Batches whose readback came back all zeros: the kernel did not run (a WGSL/pipeline error is in
     *  `renderer.log`, and `computeAsync` does not reject for it). */
    let deadPipelines = 0;
    const examples: string[] = [];
    try {
      const period = terrainPeriod();
      const lap = worldChunksX();
      for (const [step, columns] of COLUMNS_PER_STEP) {
        const lapCells = Math.max(1, Math.floor(lap / step));
        const batch = buildBatch(step, columns, lapCells, period);
        const gpuStart = performance.now();
        await this.renderer.computeAsync(batch.kernel as never);
        const gpuMax = new Uint32Array(await this.renderer.getArrayBufferAsync(batch.maxAttr));
        const gpuMin = new Uint32Array(await this.renderer.getArrayBufferAsync(batch.minAttr));
        const gpuMs = performance.now() - gpuStart;
        gpuTotal += gpuMs;
        const cpuStart = performance.now();
        let bad = 0;
        let diff = 0;
        for (let c = 0; c < batch.columns.length; c++) {
          const [cx, cz] = batch.columns[c];
          const reference = lodSampleGrid(step, cx, cz);
          for (let k = 0; k < batch.cells; k++) {
            for (const [want, got] of [
              [reference.max[k], gpuMax[c * batch.cells + k]] as const,
              [reference.min[k], gpuMin[c * batch.cells + k]] as const,
            ]) {
              compared++;
              if (got === want) continue;
              bad++;
              const d = Math.abs(got - want);
              if (d > diff) diff = d;
              if (examples.length < 6) {
                const i = k % LOD_SAMPLE_GRID_W;
                const j = Math.floor(k / LOD_SAMPLE_GRID_W);
                examples.push(`step${step} col(${cx},${cz}) cell(${i},${j}) cpu=${want} gpu=${got}`);
              }
            }
          }
        }
        const cpuMs = performance.now() - cpuStart;
        cpuTotal += cpuMs;
        mismatched += bad;
        samplesTotal += columns * batch.cells * step * step;
        if (diff > maxDiff) maxDiff = diff;
        // DID IT RUN AT ALL? A dead pipeline (a WGSL compile error, an unimplemented node) writes NOTHING rather
        // than failing the await: the buffers come back exactly as they were allocated — every `max` slot 0 and
        // every `min` slot `UNSET_MIN` — and the field is clamped well inside those bounds, so that grid is proof
        // the kernel did not execute. Reported as its own verdict, because "the field is wrong" and "nothing ran"
        // need opposite responses (one run reported 67048 untouched slots as a PORTING BUG; the actual error was a
        // WGSL type mix, and it was only in `renderer.log`).
        const dead = gpuMax.every((v) => v === 0) && gpuMin.every((v) => v === UNSET_MIN);
        if (dead) deadPipelines++;
        this.log(
          `LODPROBE step ${step}: ${columns} column(s), ${columns * batch.cells * 2} value(s), mismatch ${bad}, ` +
            `maxΔ ${diff}${dead ? " — KERNEL PRODUCED NOTHING (untouched buffers: check renderer.log for a WGSL/pipeline error)" : ""}` +
            ` — gpu ${gpuMs.toFixed(1)}ms for ${(batch.threads / 1e6).toFixed(2)}M threads (dispatch+2 readbacks), ` +
            `cpu reference ${cpuMs.toFixed(0)}ms`,
        );
      }
      // WHAT A DIFFERENCE MEANS, said out loud, because the cases need OPPOSITE responses:
      //   * nothing at all ran → the kernel is broken (a WGSL/pipeline error, in `renderer.log`);
      //   * one block → `PRECISION`: f32-vs-f64 rounding, which can only ever move a height by one block (a
      //     half-value landing on the other side of `round`);
      //   * more than one block → a PORTING mistake in the GPU field (a wrong constant, a wrong seed, a partial
      //     sample set), and the examples above are where to look. The probe's first run reported max |Δ| 26
      //     (a wrong hill seed) and its second max |Δ| 8 (nested loops that sampled only the diagonal).
      const verdict =
        deadPipelines > 0
          ? `KERNEL DID NOT RUN — ${deadPipelines} batch(es) came back untouched, so nothing was compared: read `
            + `renderer.log for the WGSL/pipeline error (debug.log only carries the symptom)`
          : mismatched === 0
            ? `OK — ${compared} values identical`
            : maxDiff <= 1
              ? `PRECISION — ${mismatched} of ${compared} values differ by 1 block (f32 vs f64 rounding)`
              : `PORTING BUG — ${mismatched} of ${compared} values differ, max |Δ| = ${maxDiff} (far more than f32 `
                + `rounding can explain: fix the GPU field, not the precision)`;
      // THE MILLISECONDS ARE CLAMPED, THEN CONVERTED — the other order is a silent lie: `gpuTotal / 1000` is in
      // SECONDS, so `Math.max(1, gpuTotal / 1000)` pins the divisor to 1 for any total under 1000 ms (i.e. always),
      // and every run then reports `samples ÷ 1 s` no matter how fast it was. That is where the "4M/s" in the M0
      // and M1a reports came from (the sample count is the same 4.03M every time, so the number never moved), and
      // it is why the honest figures are ~11.8M/s here against the CPU's 6.3M/s.
      const samplesPerSecond = (samplesTotal / Math.max(1, gpuTotal)) * 1000;
      this.log(
        `LODPROBE RESULT: ${verdict}; gpu ${gpuTotal.toFixed(1)}ms vs cpu ${cpuTotal.toFixed(0)}ms ` +
          `(both for ${compared / 2} grid values); ${(samplesTotal / 1e6).toFixed(1)}M field samples at ` +
          `${(samplesPerSecond / 1e6).toFixed(1)}M/s — M1a's layout: ONE THREAD PER SAMPLE with an atomic `
          + `reduce per cell. This is still only the SAMPLING half (the CPU mesher and the per-rung `
          + `dispatch+readback round trip are not in it), so compare it against the CPU numbers above. `
          + `examples: ${examples.join(" | ") || "(none)"}`,
      );
      this.log(`LODPROBE done in ${(performance.now() - started).toFixed(0)}ms`);
      this.world.commands.send(ShowToast, {
        key:
          `LOD GPU 探针: ` +
          (deadPipelines > 0
            ? "核函数没执行 (0 值; 看 renderer.log)"
            : mismatched === 0
              ? "与 CPU 完全一致 ✓"
              : maxDiff <= 1
                ? `精度差异 ${mismatched} 个值 (±1 格)`
                : `移植错误! ${mismatched} 个值不一致 (最大 ${maxDiff} 格)`) +
          ` — 详情见 debug.log`,
        raw: true,
      });
    } catch (err) {
      this.log(`LODPROBE FAILED: ${String((err as Error)?.message ?? err)}`);
      this.world.commands.send(ShowToast, { key: `LOD GPU 探针失败: ${String((err as Error)?.message ?? err)}`, raw: true });
    } finally {
      this.busy = false;
    }
  }
}

/** The probe's own sanity check, as a function the GATE can run: the TSL field is built from `TERRAIN_NOISE`, so
 *  this reports the pieces that must appear in it (the generation is lazy — the nodes only exist once a batch is
 *  built — so the gate checks the INPUT rather than the compiled shader). */
export function lodProbeSpec(): {
  readonly seed: number;
  readonly octaves: ReadonlyArray<readonly [number, number]>;
  readonly baseY: number;
  readonly minY: number;
  readonly maxY: number;
} {
  return {
    seed: TERRAIN_SEED,
    octaves: TERRAIN_NOISE.octaves,
    baseY: TERRAIN_NOISE.baseY,
    minY: TERRAIN_NOISE.minY,
    maxY: TERRAIN_NOISE.maxY,
  };
}
