// ===== THE `M` PROBE: DOES THE GPU MESHER PRODUCE `meshChunk`'S GEOMETRY, BYTE FOR BYTE? =====
// The M0 probe answered "can the GPU reproduce the FIELD" with `K`; this answers the mesher's question — "can it
// reproduce the GEOMETRY" — with `M`. It runs the kernels in `lod-gpu-mesher.ts` over a set of SYNTHETIC chunk
// patterns (so it says something on a pristine world, and so the closed-form cases are checkable) and then over the
// REAL chunks in the player's own column, and compares every one against the production CPU mesher: the face count,
// every look's slice, and then EVERY face's four corners, normals, UVs and indices, in order.
//
// IT IS A DEBUG PROBE: it owns no component, changes no streaming state, and does nothing unless `M` is pressed. The
// CPU half is the slow one and runs on the thread that asked, so a stall for the duration of the probe is expected
// and reported — the same shape M0 has.
import { ShowToast } from "../../../data/globals/commands";
import { RENDERER3D } from "../../../data/globals/gfx";
import { KEY_EVENTS, LOCAL_PLAYER, VOXEL, KeyEdgeReader } from "../../../data/globals/resources";
import { AIR, CHUNK_SIZE, CHUNK_VOLUME, SOLID, type Chunk } from "../../../data/world/chunk";
import { CHUNK_Y_COUNT, MIN_CHUNK_Y, type VoxelWorld } from "../../../data/world/world";
import { gatherChunkMeshInput, meshChunk, type ChunkMeshInput, type MeshResult } from "../../../data/world/mesh";
import { worldChunksX, worldChunksZ } from "../../../data/world/size";
import { POSITION } from "../../player/components";
import { entityIndex, type SystemAccess, type World } from "../../../core/world";
import { GpuChunkMesher, type PackedGeometry } from "./lod-gpu-mesher";
import type { WebGPURenderer } from "three/webgpu";

/** The probe touches the GPU and the voxel data (to build the reference input and to hand the kernel the same
 *  bytes); it owns its own buffers. */
export const MESH_PROBE_ACCESS: SystemAccess = {
  readsExternal: ["renderer3d", "voxelBlocks"],
  writesExternal: ["gpuMesherBuffers"],
};

/** How many of the player's own chunks the probe meshes both ways. */
const REAL_CHUNKS = 6;

/** A synthetic chunk's voxel value at a local coordinate. */
type Pattern = (lx: number, ly: number, lz: number) => number;

interface ProbeCase {
  readonly name: string;
  readonly input: ChunkMeshInput;
  /** A face count the pattern's GEOMETRY implies, checked as well: a GPU result that agrees with a wrong CPU
   *  reference would still be wrong, and these are the cases where the answer is known without meshing anything. */
  readonly expectedFaces?: number;
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

/** Compare a GPU packed geometry against `meshChunk`'s, face by face and in order. Positions, normals, UVs and
 *  indices are all exact: they are integers (or the faces' own 0/1 constants), so there is no tolerance to argue
 *  about — any difference is a bug in the kernel, the pad or the tables. */
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
 *  THE INDICES ARE COMPARED AS A PATTERN, NOT AS VALUES. They address a face's four vertices inside the chunk's own
 *  index buffer, and the two halves lay their slices out in different orders (`meshChunk` first-seen, the kernels
 *  ascending key), so the same face legitimately sits at a different global position in each. What must agree is the
 *  two-triangle pattern relative to the face's OWN first vertex — and the corners, normals and UVs, which are the
 *  real content. (Comparing the raw values reported `index 0 cpu 0 vs gpu 4096` on the gate's first run: the same
 *  face, at slice position 0 on the CPU and 1024 on the GPU.) */
function firstFaceDifference(cpu: MeshResult, gpu: PackedGeometry, cpuFace: number, gpuFace: number): string | null {
  for (let c = 0; c < 4; c++) {
    for (let axis = 0; axis < 3; axis++) {
      const a = cpu.positions[(cpuFace * 4 + c) * 3 + axis];
      const b = gpu.positions[(gpuFace * 4 + c) * 3 + axis];
      if (a !== b) return `corner ${c} position[${axis}] cpu ${a} vs gpu ${b}`;
      const na = cpu.normals[(cpuFace * 4 + c) * 3 + axis];
      const nb = gpu.normals[(gpuFace * 4 + c) * 3 + axis];
      if (na !== nb) return `corner ${c} normal[${axis}] cpu ${na} vs gpu ${nb}`;
    }
    for (let axis = 0; axis < 2; axis++) {
      const a = cpu.uvs[(cpuFace * 4 + c) * 2 + axis];
      const b = gpu.uvs[(gpuFace * 4 + c) * 2 + axis];
      if (a !== b) return `corner ${c} uv[${axis}] cpu ${a} vs gpu ${b}`;
    }
  }
  const cpuFirst = cpuFace * 4;
  const gpuFirst = gpuFace * 4;
  for (let i = 0; i < 6; i++) {
    const a = cpu.indices[cpuFace * 6 + i] - cpuFirst;
    const b = gpu.indices[gpuFace * 6 + i] - gpuFirst;
    if (a !== b) return `index pattern ${i} cpu ${a} vs gpu ${b} (relative to the face's first vertex)`;
  }
  return null;
}

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
    this.mesher ??= new GpuChunkMesher(this.renderer);
    let cases = 0;
    let mismatched = 0;
    let facesCompared = 0;
    let gpuMs = 0;
    let cpuMs = 0;
    const examples: string[] = [];
    try {
      const all: ProbeCase[] = [...syntheticCases(), ...this.realCases()];
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
        const gpu = await this.mesher.run(probeCase.input);
        const gpuCaseMs = performance.now() - gpuStart;
        gpuMs += gpuCaseMs;
        const tableProblem = checkSliceTable(gpu);
        const diff = compareGeometry(cpu, gpu);
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
            `, gpu ${gpuCaseMs.toFixed(2)}ms (3 dispatches + readback), cpu reference ${cpuCaseMs.toFixed(2)}ms`,
        );
      }
      // WHAT A MISMATCH MEANS, said out loud, because "the kernel is broken" and "the kernel did not run" need
      // opposite responses — the same distinction M0 had to learn: a WGSL/pipeline error leaves the buffers at their
      // reset value (no slots at all), and `computeAsync` does NOT reject for it.
      const ranAtAll = facesCompared > 0 || mismatched === 0;
      const verdict = !ranAtAll
        ? "KERNEL PRODUCED NOTHING (no slots came back at all: read renderer.log for the WGSL/pipeline error)"
        : mismatched === 0
          ? `OK — ${cases} case(s), ${facesCompared} faces, every corner, normal, UV and index identical`
          : `MISMATCH — ${mismatched} of ${cases} case(s) disagree; first: ${examples[0] ?? "(no example)"}`;
      this.log(
        `MESHPROBE RESULT: ${verdict}. gpu ${gpuMs.toFixed(1)}ms vs cpu ${cpuMs.toFixed(1)}ms for the same inputs ` +
          `(the CPU half is the PRODUCTION mesher, run once per case; the GPU half is 3 dispatches plus the READBACK ` +
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

  /** The REAL chunks: the player's own column, top down, the ones that actually have faces. This is the half that
   *  makes the probe a measurement of THIS world rather than of hand-written patterns. */
  private realCases(): ProbeCase[] {
    const out: ProbeCase[] = [];
    const periodX = worldChunksX();
    const periodZ = worldChunksZ();
    const wrap = (value: number, period: number): number => ((value % period) + period) % period;
    const cx = wrap(Math.floor(POSITION.x[this.playerIndex] / CHUNK_SIZE), periodX);
    const cz = wrap(Math.floor(POSITION.z[this.playerIndex] / CHUNK_SIZE), periodZ);
    for (let cy = MIN_CHUNK_Y + CHUNK_Y_COUNT - 1; cy >= MIN_CHUNK_Y && out.length < REAL_CHUNKS; cy--) {
      const chunk: Chunk | null = this.voxel.getChunk(cx, cy, cz);
      if (chunk === null) continue;
      const input = gatherChunkMeshInput(this.voxel, chunk, cx, cy, cz);
      if (meshChunk(input).faces === 0) continue; // a chunk with nothing to draw proves little
      out.push({ name: `real(${cx},${cy},${cz})`, input });
    }
    if (out.length === 0) this.log("MESHPROBE: no real chunk with faces in the player's column (synthetic cases only)");
    return out;
  }
}
