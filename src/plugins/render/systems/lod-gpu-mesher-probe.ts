// ===== THE `M` PROBE: DOES THE GPU MESHER PRODUCE `meshChunk`'S GEOMETRY, BYTE FOR BYTE? =====
// The M0 probe answered "can the GPU reproduce the FIELD" with `K`; this answers the mesher's question — "can it
// reproduce the GEOMETRY" — with `M`. It runs the kernels in `lod-gpu-mesher.ts` over a set of SYNTHETIC chunk
// patterns (so it says something on a pristine world, and so the closed-form cases are checkable) and then over the
// REAL chunks in the player's own column, and compares every one against the production CPU mesher: the face count,
// every look's slice, and then EVERY face's six drawn vertices, normals and UVs, in order.
//
// IT IS A DEBUG PROBE: it owns no component, changes no streaming state, and does nothing unless `M` is pressed. The
// CPU half is the slow one and runs on the thread that asked, so a stall for the duration of the probe is expected
// and reported — the same shape M0 has.
import { ShowToast } from "../../../data/globals/commands";
import { RENDERER3D, SCENE3D } from "../../../data/globals/gfx";
import { KEY_EVENTS, LOCAL_PLAYER, VOXEL, KeyEdgeReader } from "../../../data/globals/resources";
import { AIR, CHUNK_SIZE, CHUNK_VOLUME, SOLID, type Chunk } from "../../../data/world/chunk";
import { CHUNK_Y_COUNT, MIN_CHUNK_Y, nearestWrap, type VoxelWorld } from "../../../data/world/world";
import { gatherChunkMeshInput, meshChunk, type ChunkMeshInput, type MeshResult } from "../../../data/world/mesh";
import { worldChunksX, worldChunksZ } from "../../../data/world/size";
import { POSITION } from "../../player/components";
import { entityIndex, type SystemAccess, type World } from "../../../core/world";
import { GpuChunkMesher, MESHER_SLOTS, createMesherOutput, DRAWN_STRIDE, FACE_CORNERS, VERTS_PER_FACE, type PackedGeometry } from "./lod-gpu-mesher";
import type { WebGPURenderer } from "three/webgpu";
import * as THREE from "three/webgpu";

/** The probe touches the GPU and the voxel data (to build the reference input and to hand the kernel the same
 *  bytes); it owns its own buffers. */
export const MESH_PROBE_ACCESS: SystemAccess = {
  readsExternal: ["renderer3d", "voxelBlocks"],
  writesExternal: ["gpuMesherBuffers"],
};

/** How many of the player's own chunks the probe meshes both ways. */
const REAL_CHUNKS = 6;

/** The arena the batch check (M2c step 2a) sizes its output set for: `MESHER_SLOTS` real chunks of a surface column,
 *  which measured a few hundred to ~1400 faces each. A fixed capacity is what production wants, so the probe fails
 *  loudly instead of growing it — that failure IS the measurement the allocation policy needs. */
const ARENA_CAPACITY = 8192;

/** The mesher's dense key space (`(value << 2) | kind`), for the decode report's "what SHOULD this be" number. It is
 *  not imported because it is private to the mesher; if the two ever drift, the report says so out loud. */
const MESHER_KEYS = 256 * 4;

/** A synthetic chunk's voxel value at a local coordinate. */
type Pattern = (lx: number, ly: number, lz: number) => number;

interface ProbeCase {
  readonly name: string;
  readonly input: ChunkMeshInput;
  /** A face count the pattern's GEOMETRY implies, checked as well: a GPU result that agrees with a wrong CPU
   *  reference would still be wrong, and these are the cases where the answer is known without meshing anything. */
  readonly expectedFaces?: number;
  /** A real chunk's world origin, for the DRAWING check (`drawCopy`) — synthetic patterns have none. */
  readonly origin?: readonly [number, number, number];
}

/** One synthetic input: the voxel bytes the CPU mesher wants (the GPU gets the same data through
 *  `buildPaddedVoxels`), plus the six neighbour planes. */
function syntheticInput(pattern: Pattern, planeSolid: boolean): ChunkMeshInput {
  const blocks = new Uint8Array(CHUNK_VOLUME);
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        blocks[lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE] = pattern(lx, ly, lz);
      }
    }
  }
  const planes = new Uint8Array(6 * CHUNK_SIZE * CHUNK_SIZE);
  if (planeSolid) planes.fill(1);
  return { uniform: false, uniformValue: AIR, blocks, planes };
}

/** The cases, ordered cheap-first so a failure shows up before the 100k-face one. The closed forms are the shape of
 *  the culling rule: a solid block in air shows its whole shell (6 × 32²), one with solid neighbours on five sides
 *  shows only its top, and so on. `checker` is the worst case the buffers are sized for. */
function syntheticCases(): ProbeCase[] {
  const S = CHUNK_SIZE;
  return [
    { name: "empty-air", input: syntheticInput(() => AIR, false), expectedFaces: 0 },
    { name: "uniform-solid", input: syntheticInput(() => SOLID, false), expectedFaces: 6 * S * S },
    { name: "top-only", input: syntheticInput(() => SOLID, true), expectedFaces: 0 },
    {
      name: "floor-top",
      input: (() => {
        const input = syntheticInput(() => SOLID, true);
        // PLANE.PY is plane 2, laid out as (lx, lz): make it air, so the top face of every surface voxel emits.
        input.planes.fill(0, 2 * S * S, 3 * S * S);
        return input;
      })(),
      expectedFaces: S * S,
    },
    { name: "layers", input: syntheticInput((_lx, ly) => (ly < 8 ? 1 : ly < 16 ? 2 : ly < 24 ? 3 : AIR), false) },
    { name: "one-block", input: syntheticInput((lx, ly, lz) => (lx === 16 && ly === 16 && lz === 16 ? 4 : AIR), false), expectedFaces: 6 },
    { name: "hole", input: syntheticInput((lx, ly, lz) => (lx === 16 && ly === 16 && lz === 16 ? AIR : SOLID), false), expectedFaces: 6 * S * S + 6 },
    { name: "checker", input: syntheticInput((lx, ly, lz) => ((lx + ly + lz) % 2 === 0 ? 1 : AIR), false) },
    // A NON-UNIFORM BORDER, which is the only kind that exercises the pad's own ±Z transposition: a uniform plane is
    // symmetric, so the kernel would read it the same either way. (The gate caught that by mutation; this case is
    // what carries it to the GPU.)
    {
      name: "patterned-border",
      input: (() => {
        const input = syntheticInput((_lx, ly) => (ly < 16 ? SOLID : AIR), false);
        for (let a = 0; a < S; a++) {
          for (let b = 0; b < S; b++) {
            const on = (a * 5 + b * 3) % 7 < 2 ? 1 : 0;
            for (let plane = 0; plane < 6; plane++) input.planes[plane * S * S + a * S + b] = on;
          }
        }
        return input;
      })(),
    },
  ];
}

/** Is the GPU's own SLICE TABLE sane? `starts[key]` must be the prefix sum of the counts below it, and the last
 *  prefix must be the face total. Checked BEFORE the geometry, because a broken table is far easier to read than the
 *  geometry difference it causes: the first GPU run reported every look's count correctly while every slice's content
 *  sat one key late (a scan that kept its running total in a storage cell, which TSL re-evaluated). */
export function checkSliceTable(gpu: PackedGeometry): string | null {
  let running = 0;
  for (let key = 0; key < gpu.counts.length; key++) {
    if (gpu.starts[key] !== running) {
      return `starts[${key}] = ${gpu.starts[key]} but the counts below it sum to ${running}`;
    }
    running += gpu.counts[key];
  }
  return running === gpu.faces ? null : `faces ${gpu.faces} but the counts sum to ${running}`;
}

/** What a geometry comparison found. The slices are keyed by look, because the two halves order their slots
 *  differently (`meshChunk` first-seen, the kernels ascending key) — the engine carries each slot's key, so only the
 *  CONTENT per key is a contract. */
interface GeometryDiff {
  readonly keysCompared: number;
  readonly mismatchedKeys: number;
  readonly facesCpu: number;
  readonly facesGpu: number;
  readonly examples: readonly string[];
}

/** Compare a GPU packed geometry against `meshChunk`'s, face by face and in order. Positions, normals and UVs are all
 *  exact: they are integers (or the faces' own 0/1 constants), so there is no tolerance to argue about — any
 *  difference is a bug in the kernel, the pad or the tables. */
export function compareGeometry(cpu: MeshResult, gpu: PackedGeometry): GeometryDiff {
  const examples: string[] = [];
  let mismatchedKeys = 0;
  let keysCompared = 0;
  const gpuSlotOf = new Map<number, { start: number; count: number }>();
  for (const slot of gpu.slots) gpuSlotOf.set(slot.key, { start: slot.start, count: slot.count });
  for (const slot of cpu.slots) {
    keysCompared++;
    const mine = gpuSlotOf.get(slot.key);
    gpuSlotOf.delete(slot.key);
    if (mine === undefined) {
      mismatchedKeys++;
      if (examples.length < 6) examples.push(`value ${slot.key >>> 2} kind ${slot.key & 3}: missing on the GPU`);
      continue;
    }
    if (mine.count !== slot.count) {
      mismatchedKeys++;
      if (examples.length < 6) {
        examples.push(`value ${slot.key >>> 2} kind ${slot.key & 3}: cpu ${slot.count} face(s) vs gpu ${mine.count}`);
      }
      continue;
    }
    for (let i = 0; i < slot.count; i++) {
      const cpuFace = slot.start + i;
      const gpuFace = mine.start + i;
      const problem = firstFaceDifference(cpu, gpu, cpuFace, gpuFace);
      if (problem !== null) {
        mismatchedKeys++;
        if (examples.length < 6) {
          examples.push(`value ${slot.key >>> 2} kind ${slot.key & 3} face ${i}: ${problem}`);
        }
        break;
      }
    }
  }
  for (const [key] of gpuSlotOf) {
    mismatchedKeys++;
    if (examples.length < 6) examples.push(`value ${key >>> 2} kind ${key & 3}: only on the GPU`);
  }
  return { keysCompared, mismatchedKeys, facesCpu: cpu.faces, facesGpu: gpu.faces, examples };
}

/** The first thing that differs between one CPU face and one GPU face, or null when they are identical.
 *
 *  TWO VERTEX LAYOUTS, and neither is arbitrary: `meshChunk`'s arrays are PACKED and INDEXED (three floats per
 *  vertex, `4` vertices per face, `6` indices reusing them), while the kernel writes the DRAWN layout
 *  (`DRAWN_STRIDE` floats per vertex — three pads a storage attribute of `itemSize 3` to `vec4` before it creates
 *  the buffer, so the kernel writes that padding itself and the drawn vertex layout cannot disagree with it) with
 *  `VERTS_PER_FACE = 6` vertices per face and NO index buffer at all (see `lod-gpu-mesher.ts`). The comparison
 *  therefore walks the six drawn vertices and reads the CPU's vertex through `FACE_CORNERS`, which is exactly the
 *  two-triangle order both sides emit — so the CPU's index buffer is not read here at all, and one less structure
 *  can disagree. The comparison reads each side with its own stride. */
function firstFaceDifference(cpu: MeshResult, gpu: PackedGeometry, cpuFace: number, gpuFace: number): string | null {
  const gpuVertex = (vertex: number, axis: number): number =>
    gpu.positions[(gpuFace * VERTS_PER_FACE + vertex) * DRAWN_STRIDE + axis];
  const gpuNormal = (vertex: number, axis: number): number =>
    gpu.normals[(gpuFace * VERTS_PER_FACE + vertex) * DRAWN_STRIDE + axis];
  for (let v = 0; v < VERTS_PER_FACE; v++) {
    // The CPU vertex this drawn vertex is a copy of: the corner table is shared, so this is the only mapping.
    const c = FACE_CORNERS[v];
    for (let axis = 0; axis < 3; axis++) {
      const a = cpu.positions[(cpuFace * 4 + c) * 3 + axis];
      const b = gpuVertex(v, axis);
      if (a !== b) return `vertex ${v} (corner ${c}) position[${axis}] cpu ${a} vs gpu ${b}`;
      const na = cpu.normals[(cpuFace * 4 + c) * 3 + axis];
      const nb = gpuNormal(v, axis);
      if (na !== nb) return `vertex ${v} (corner ${c}) normal[${axis}] cpu ${na} vs gpu ${nb}`;
    }
    for (let axis = 0; axis < 2; axis++) {
      const a = cpu.uvs[(cpuFace * 4 + c) * 2 + axis];
      const b = gpu.uvs[(gpuFace * VERTS_PER_FACE + v) * 2 + axis];
      if (a !== b) return `vertex ${v} (corner ${c}) uv[${axis}] cpu ${a} vs gpu ${b}`;
    }
  }
  return null;
}

/** A built COMPUTE kernel, as much of it as this probe needs: `renderer.debug.onNodeBuilderCreated` hands over the
 *  builder, and after the first dispatch its `computeShader.code` is the WGSL three actually emitted. That is the
 *  only way to see a node graph's statement order — two rounds of "the counts are right and the bytes are not" were
 *  diagnosed from the emitted code, not from the TypeScript that produced it. */
interface ComputeBuilderLike {
  readonly compute?: unknown;
  readonly computeShader?: { readonly code?: string };
}

/** How many lines of emitted WGSL a failing case dumps into `debug.log` (the kernels unroll every face and corner, so
 *  the whole thing is a few thousand lines; this is a diagnostic, not a document). */
const WGSL_DUMP_LINES = 1400;

/** RENDER lane. `M` starts the probe; everything else about it is reported, never acted on. */
export class GpuMesherProbeSystem {
  private readonly keys: KeyEdgeReader;
  private readonly renderer: WebGPURenderer;
  private readonly world: World;
  private readonly log: (line: string) => void;
  private readonly voxel: VoxelWorld;
  private readonly playerIndex: number;
  /** Built on first use (it allocates ~30 MB of GPU buffers, the worst-case chunk) and kept, so a second `M`
   *  reuses the pipelines. */
  private mesher: GpuChunkMesher | null = null;
  /** Every COMPUTE builder the renderer has created, in dispatch order (census, scan, emit) — see `dumpEmitWgsl`. */
  private readonly computeBuilders: ComputeBuilderLike[] = [];
  /** The floating drawing copy (`drawCopy`), replaced on every probe run. */
  private copy: THREE.Mesh | null = null;
  private debugHooked = false;
  private dumped = false;
  /** One probe at a time: a second `M` while it runs is ignored (it awaits the GPU). */
  private busy = false;
  /** `null` until the backend is asked; a non-WebGPU backend turns the probe into a logged no-op. */
  private supported: boolean | null = null;

  constructor(world: World, log: (line: string) => void) {
    this.world = world;
    this.renderer = world.resource(RENDERER3D);
    this.voxel = world.resource(VOXEL);
    this.keys = new KeyEdgeReader(world.resource(KEY_EVENTS));
    this.playerIndex = entityIndex(world.resource(LOCAL_PLAYER));
    this.log = log;
  }

  step(): void {
    let presses = 0;
    this.keys.drain((edge) => {
      if (edge.down && !edge.repeat && edge.code === "KeyM") presses++;
    });
    if (presses > 0 && !this.busy) void this.run();
  }

  /** Run every case and report. Async on purpose: the lane may not block, and each case awaits its readback —
   *  which is also what the GPU-vs-CPU milliseconds are measured around. */
  private async run(): Promise<void> {
    this.busy = true;
    const started = performance.now();
    const backend = (this.renderer as { backend?: { isWebGPUBackend?: boolean } }).backend;
    if (this.supported === null) this.supported = backend?.isWebGPUBackend === true;
    if (!this.supported) {
      this.log("MESHPROBE off: this backend is not WebGPU, so there is no compute queue to mesh on");
      this.busy = false;
      return;
    }
    // ONE slot for the per-case path: every case is a single chunk, and `slots = 1` keeps these numbers comparable
    // with the runs from before the arena existed. The ARENA is checked separately, by `checkArena`.
    this.mesher ??= new GpuChunkMesher(this.renderer, createMesherOutput(), 1);
    this.hookComputeBuilders();
    let cases = 0;
    let mismatched = 0;
    let facesCompared = 0;
    let gpuMs = 0;
    let cpuMs = 0;
    const examples: string[] = [];
    try {
      const real = this.realCases();
      const all: ProbeCase[] = [...syntheticCases(), ...real];
      let drewCopy = false;
      for (const probeCase of all) {
        // THE CPU HALF IS TIMED ALONE — it is closed before the GPU call, and the GPU half is timed on its own. (The
        // first version printed `performance.now() - cpuStart` at LOG time, i.e. after the await, so every per-case
        // "cpu reference" number was really cpu+gpu: the RESULT line's totals were right and the per-case ones were
        // not, which is exactly the kind of number a probe must not lie about.)
        const cpuStart = performance.now();
        const cpu = meshChunk(probeCase.input);
        const cpuCaseMs = performance.now() - cpuStart;
        cpuMs += cpuCaseMs;
        const gpuStart = performance.now();
        const [gpu] = await this.mesher.run([probeCase.input]);
        const gpuCaseMs = performance.now() - gpuStart;
        gpuMs += gpuCaseMs;
        const tableProblem = checkSliceTable(gpu);
        const diff = compareGeometry(cpu, gpu);
        if ((tableProblem !== null || diff.mismatchedKeys > 0 || diff.facesCpu !== diff.facesGpu) && !this.dumped) {
          this.dumpEmitWgsl();
        }
        const closedForm =
          probeCase.expectedFaces === undefined
            ? ""
            : probeCase.expectedFaces === cpu.faces
              ? " (closed form ✓)"
              : ` (CLOSED FORM SAYS ${probeCase.expectedFaces} — the CPU mesher disagrees with the pattern!)`;
        cases++;
        facesCompared += diff.facesCpu;
        if (tableProblem !== null) {
          mismatched++;
          if (examples.length < 8) examples.push(`${probeCase.name}: SLICE TABLE BROKEN — ${tableProblem}`);
        } else if (diff.mismatchedKeys > 0 || diff.facesCpu !== diff.facesGpu) {
          mismatched++;
          for (const example of diff.examples) if (examples.length < 8) examples.push(`${probeCase.name}: ${example}`);
        }
        this.log(
          `MESHPROBE ${probeCase.name}: faces cpu ${diff.facesCpu} / gpu ${diff.facesGpu}, ` +
            `keys ${diff.keysCompared}, mismatched keys ${diff.mismatchedKeys}${closedForm}` +
            ` — slice table ${tableProblem === null ? "ok" : `BROKEN (${tableProblem})`}` +
            `, gpu ${gpuCaseMs.toFixed(2)}ms (4 dispatches + readback), cpu reference ${cpuCaseMs.toFixed(2)}ms`,
        );
        // …AND DRAW ONE OF THEM. Only the first real chunk (the topmost with faces, i.e. the one nearest the
        // surface), and only once: the point is the DRAW PATH, not a pile of copies.
        if (!drewCopy && probeCase.origin !== undefined) {
          drewCopy = true;
          await this.drawCopy(probeCase, probeCase.input, cpu.faces);
        }
      }
      // M2c STEP 2a: THE ARENA — several real chunks through ONE kernel build and ONE output set, which is the thing
      // a per-chunk pipeline build (~200 ms each) makes impossible. Counted as its own case in the verdict.
      const arenaProblem = await this.checkArena(real);
      if (arenaProblem !== null) {
        mismatched++;
        cases++;
        if (examples.length < 8) examples.push(`arena: ${arenaProblem}`);
      }
      // WHAT A MISMATCH MEANS, said out loud, because "the kernel is broken" and "the kernel did not run" need
      // opposite responses — the same distinction M0 had to learn: a WGSL/pipeline error leaves the buffers at their
      // reset value (no slots at all), and `computeAsync` does NOT reject for it.
      const ranAtAll = facesCompared > 0 || mismatched === 0;
      const verdict = !ranAtAll
        ? "KERNEL PRODUCED NOTHING (no slots came back at all: read renderer.log for the WGSL/pipeline error)"
        : mismatched === 0
          ? `OK — ${cases} case(s), ${facesCompared} faces, every drawn vertex, normal and UV identical`
          : `MISMATCH — ${mismatched} of ${cases} case(s) disagree; first: ${examples[0] ?? "(no example)"}`;
      this.log(
        `MESHPROBE RESULT: ${verdict}. gpu ${gpuMs.toFixed(1)}ms vs cpu ${cpuMs.toFixed(1)}ms for the same inputs ` +
          `(the CPU half is the PRODUCTION mesher, run once per case; the GPU half is 4 dispatches plus the READBACK ` +
          `the probe needs and the drawing side will not — see ROADMAP on the round trip). ` +
          `examples: ${examples.join(" | ") || "(none)"}`,
      );
      this.log(`MESHPROBE done in ${(performance.now() - started).toFixed(0)}ms`);
      this.world.commands.send(ShowToast, {
        key:
          "网格 GPU 探针: " +
          (mismatched === 0 ? `与 CPU 完全一致 ✓ (${facesCompared} 个面)` : `不一致! ${mismatched}/${cases} 个用例 (见 debug.log)`),
        raw: true,
      });
    } catch (err) {
      this.log(`MESHPROBE FAILED: ${String((err as Error)?.message ?? err)}`);
      this.world.commands.send(ShowToast, { key: `网格 GPU 探针失败: ${String((err as Error)?.message ?? err)}`, raw: true });
    } finally {
      this.busy = false;
    }
  }

  /** Install the WGSL-capture hook once. `onNodeBuilderCreated` fires for RENDER builders too, so only builders that
   *  carry a `compute` node are kept — the three that matter here arrive in dispatch order. */
  private hookComputeBuilders(): void {
    if (this.debugHooked) return;
    this.debugHooked = true;
    const debug = (this.renderer as unknown as { debug?: { onNodeBuilderCreated?: unknown } }).debug;
    if (debug === undefined) return;
    (debug as { onNodeBuilderCreated: (builder: ComputeBuilderLike) => void }).onNodeBuilderCreated = (builder) => {
      if (builder?.compute !== undefined) this.computeBuilders.push(builder);
    };
  }

  /** Dump the EMIT kernel's actual WGSL — the last compute builder created is the last kernel dispatched (census,
   *  scan, emit). Only on a mismatch, and only once: a node graph's statement order cannot be read off the
   *  TypeScript, and "the counts are right but the bytes are not" is answered by the emitted code. */
  private dumpEmitWgsl(): void {
    this.dumped = true;
    const builder = this.computeBuilders[this.computeBuilders.length - 1];
    const code = builder?.computeShader?.code;
    if (code === undefined) {
      this.log(
        `MESHPROBE WGSL: unavailable (${this.computeBuilders.length} compute builder(s) captured — the renderer's ` +
          `debug hook may not be wired)`,
      );
      return;
    }
    const lines = code.split("\n");
    this.log(
      `MESHPROBE WGSL emit kernel: ${lines.length} line(s)` +
        `${lines.length > WGSL_DUMP_LINES ? `, dumping the first ${WGSL_DUMP_LINES}` : ""}`,
    );
    for (let i = 0; i < Math.min(lines.length, WGSL_DUMP_LINES); i++) {
      this.log(`MESHPROBE WGSL ${String(i).padStart(4, "0")}| ${lines[i]}`);
    }
  }

  /** THE ARENA (M2c step 2a): SEVERAL REAL CHUNKS THROUGH ONE KERNEL BUILD AND ONE OUTPUT SET.
   *
   *  Why it needs its own check: everything above meshes ONE chunk per `run`, which is the shape that cannot ship —
   *  the capacity and the slot count are baked into a storage array's length, so a per-chunk output set means a
   *  pipeline build per chunk (~200 ms each), and the batch is the whole point of the milestone. What this proves on
   *  the device is the part no CPU test can: that `bases` — the arena offsets the FOURTH kernel computes from the
   *  per-slot totals — really places each chunk's faces where the readback says they are, with no two chunks
   *  overlapping and none running past the arena.
   *
   *  It also reports the number that decides the rollout's allocation policy: how big the arena had to be for the
   *  batch, i.e. the actual face counts (`bases` and the per-slot deltas) rather than a worst-case reservation. */
  private async checkArena(real: readonly ProbeCase[]): Promise<string | null> {
    const batch = real.slice(0, MESHER_SLOTS);
    if (batch.length < 2) return null;
    // ONE arena for the whole batch, sized for what these chunks really need plus headroom — a fixed capacity is
    // what production wants, and the probe should fail loudly rather than grow it.
    const output = createMesherOutput(ARENA_CAPACITY);
    const mesher = new GpuChunkMesher(this.renderer, output, batch.length);
    const gpuStart = performance.now();
    const gpu = await mesher.run(batch.map((probeCase) => probeCase.input));
    const gpuMs = performance.now() - gpuStart;
    let bad = 0;
    let firstProblem = "";
    const layout: string[] = [];
    let total = 0;
    for (let i = 0; i < gpu.length; i++) {
      const diff = compareGeometry(meshChunk(batch[i].input), gpu[i]);
      if (diff.mismatchedKeys > 0 || diff.facesCpu !== diff.facesGpu) {
        bad++;
        if (firstProblem === "") firstProblem = `${batch[i].name}: ${diff.examples[0] ?? `${diff.mismatchedKeys} key(s)`}`;
      }
      layout.push(`${batch[i].name} @${gpu[i].base}+${gpu[i].faces}`);
      total += gpu[i].faces;
    }
    // NO OVERLAP AND NO OVERRUN, read off the bases alone: the arena offsets must be the running sum, in slot order.
    let expected = 0;
    for (const entry of gpu) {
      if (entry.base !== expected) {
        bad++;
        if (firstProblem === "") firstProblem = `arena: slot base ${entry.base} where the running sum says ${expected}`;
      }
      expected += entry.faces;
    }
    this.log(
      `MESHPROBE arena: ${gpu.length} chunk(s) in ONE ${ARENA_CAPACITY}-face arena and ONE kernel build — ` +
        `${total} faces, ${layout.join(", ")}, ${bad === 0 ? "every slot matches the CPU mesher and the offsets are the running sum" : `${bad} problem(s)`}` +
        `, gpu ${gpuMs.toFixed(2)}ms (4 dispatches + readback of ${(total / Math.max(1, gpu.length)).toFixed(0)} faces/chunk)`,
    );
    return bad === 0 ? null : firstProblem;
  }

  /** THE DRAWING HALF OF M2, on ONE real chunk (M2c step 1).
   *
   *  Everything M2 has proven so far is about NUMBERS: the kernels' geometry equals the CPU mesher's, byte for byte.
   *  What no test in this repo can answer is whether three DRAWS a `BufferGeometry` whose attributes ARE the buffers a
   *  compute kernel wrote — the binding facts are in three's source (`createStorageAttribute` hands a storage
   *  attribute `STORAGE | VERTEX`, and a storage INDEX attribute gets `STORAGE` on top of `INDEX`, both in r186's
   *  `WebGPUBackend`), but a pipeline that binds them is a device question.
   *
   *  So this puts a FLOATING COPY of one real chunk in the scene, drawn ONLY from the GPU-written buffers: same
   *  column, 40 blocks up, one flat colour per face KIND (top/bottom/side) so the look SLICES are visible too. The
   *  test is visual and needs no instrumentation — the real chunk meshed by the CPU is right below it, so the copy's
   *  silhouette must match the terrain under it, with its top faces one colour, its sides another and its bottom a
   *  third. Nothing in the live path changes: this is additive, and a failure leaves the world exactly as it is. */
  private async drawCopy(probeCase: ProbeCase, input: ChunkMeshInput, capacityFaces: number): Promise<void> {
    const origin = probeCase.origin;
    if (origin === undefined) return;
    // One output set per probe run: the capacity is baked into the kernels, and the drawing geometry's attribute
    // lengths have to be the same numbers.
    const capacity = Math.max(1024, capacityFaces + 256);
    const output = createMesherOutput(capacity);
    const mesher = new GpuChunkMesher(this.renderer, output);
    const [gpu] = await mesher.run([input]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", output.position);
    geometry.setAttribute("normal", output.normal);
    geometry.setAttribute("uv", output.uv);
    // NO INDEX BUFFER: the geometry is NON-INDEXED (`VERTS_PER_FACE = 6`), which is deliberate — an index attribute
    // created by the compute binding would miss `BufferUsage::Index` (the first binding wins the usage) and make the
    // world's own render pass invalid. See the trap documented in `lod-gpu-mesher.ts`.
    // The chunk's geometry is chunk-local, so the bounds are constant — the same sphere `ChunkGeometry` sets, which is
    // what makes the mesh cullable without reading the (GPU-written) vertices.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(32 / 2, 32 / 2, 32 / 2), Math.SQRT2 * 32);
    geometry.setDrawRange(0, gpu.faces * 6);
    // One group per look slice, exactly as the CPU path builds them — with the material INDEX standing in for the
    // look's KIND, so the three kinds are three colours.
    for (const slot of gpu.slots) geometry.addGroup(slot.start * 6, slot.count * 6, slot.key & 3);
    const materials = [
      new THREE.MeshLambertMaterial({ color: 0x36d13a }), // kind 0: top faces
      new THREE.MeshLambertMaterial({ color: 0x8a5a2b }), // kind 1: bottom faces
      new THREE.MeshLambertMaterial({ color: 0xb9b9c4 }), // kind 2: side faces
    ];
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.name = "gpu-mesher-probe-copy";
    mesh.position.set(origin[0], origin[1] + 40, origin[2]);
    mesh.updateMatrix();
    this.disposeCopy();
    this.world.resource(SCENE3D).add(mesh);
    this.copy = mesh;
    this.log(
      `MESHPROBE draw: a floating copy of ${probeCase.name} (${gpu.faces} faces, ${gpu.slots.length} look slice(s)) ` +
        `at ${origin[0]}/${origin[1] + 40}/${origin[2]}, drawn ONLY from the compute-written buffers — the chunk's own ` +
        `CPU-meshed version is 40 blocks below it, and the copy's silhouette must match it (top faces green, sides ` +
        `grey, bottom brown). A second M replaces it.`,
    );
  }

  /** Take the previous floating copy down (geometry and materials included — the geometry owns nothing but the
   *  mesher's buffers, which are dropped with it). */
  private disposeCopy(): void {
    if (this.copy === null) return;
    this.world.resource(SCENE3D).remove(this.copy);
    this.copy.geometry.dispose();
    const material = this.copy.material;
    if (Array.isArray(material)) for (const one of material) one.dispose();
    else material.dispose();
    this.copy = null;
  }

  /** The REAL chunks: the player's own column, top down, the ones that actually have faces. This is the half that
   *  makes the probe a measurement of THIS world rather than of hand-written patterns. */
  private realCases(): ProbeCase[] {
    const out: ProbeCase[] = [];
    const periodX = worldChunksX();
    const periodZ = worldChunksZ();
    const wrap = (value: number, period: number): number => ((value % period) + period) % period;
    const playerCx = Math.floor(POSITION.x[this.playerIndex] / CHUNK_SIZE);
    const playerCz = Math.floor(POSITION.z[this.playerIndex] / CHUNK_SIZE);
    const cx = wrap(playerCx, periodX);
    const cz = wrap(playerCz, periodZ);
    // THE DRAWING COPY GOES WHERE THE STREAM WOULD DRAW THAT CHUNK, i.e. at the representation NEAREST the player
    // (`nearestWrap`), NOT at the wrapped lattice index. The wrapped index is a torus identity; its BLOCK origin is
    // only where the chunk actually is when the player is in the positive lap. Using it put the copy on the far side
    // of the torus — `at 16224/136/0` while the player stood at x = -137 — so past the seam `M` looked like it drew
    // nothing at all. The identity in the NAME stays wrapped (it is the chunk's real key); only the origin is flat.
    const drawX = nearestWrap(cx, playerCx, periodX) * CHUNK_SIZE;
    const drawZ = nearestWrap(cz, playerCz, periodZ) * CHUNK_SIZE;
    for (let cy = MIN_CHUNK_Y + CHUNK_Y_COUNT - 1; cy >= MIN_CHUNK_Y && out.length < REAL_CHUNKS; cy--) {
      const chunk: Chunk | null = this.voxel.getChunk(cx, cy, cz);
      if (chunk === null) continue;
      const input = gatherChunkMeshInput(this.voxel, chunk, cx, cy, cz);
      if (meshChunk(input).faces === 0) continue; // a chunk with nothing to draw proves little
      out.push({ name: `real(${cx},${cy},${cz})`, input, origin: [drawX, cy * CHUNK_SIZE, drawZ] });
    }
    if (out.length === 0) this.log("MESHPROBE: no real chunk with faces in the player's column (synthetic cases only)");
    return out;
  }
}
