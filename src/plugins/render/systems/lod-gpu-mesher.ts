// ===== M2a OF THE GPU ROUTE: THE MESHER'S DECISION, ON THE GPU =====
// WHY. The chunk pipeline is CPU-bound (measured: `gpu=` 2-4 ms inside a 20-30 ms frame) and the plan is to move
// it to the GPU — sampling first (M1, done), then the mesher (M2), then the drawing (M3). This file is M2's first
// milestone and it answers the ONLY question everything after it depends on:
//
//   CAN A COMPUTE KERNEL DECIDE EVERY FACE EXACTLY LIKE `meshChunk` DOES?
//
// WHAT "EXACTLY" MEANS HERE, AND WHY IT IS A CENSUS RATHER THAN A TRIANGLE BUFFER. The kernel walks the SAME
// padded block the CPU walk reads (`data/world/mesh.ts`'s `buildPaddedVoxels`), in the same order, with the face
// offsets and corner tables taken from the SAME `FACES` data — and for every face it decides to emit it
// accumulates, per look key, a COUNT and an order-independent SIGNATURE of the face (its voxel origin, its
// normal's table index, its four corner offsets and its four UVs). `meshChunk`'s own output produces the same
// three numbers per key when it is read back, so comparing them is comparing every emitted face's data — while
// the kernel needs no output geometry, no cursor, and no compaction. The probe (`M`) does that comparison on
// synthetic patterns AND on the real chunks around the player.
//
// WHY NOT WRITE THE VERTICES YET — the honest reason, because it is a real constraint and not a shortcut:
//   * the packed layout needs a per-look WRITE CURSOR, i.e. an atomic fetch-add whose RETURN VALUE decides where
//     the face goes, and three's TSL does not expose one: `atomicAdd` is built by `atomicFunc`, which wraps the
//     node in `.toStack()`, so it is a STATEMENT and its value cannot be used in an expression. (The CPU version
//     gets the cursor for free from a serial `cursor[slot]++`; a parallel kernel cannot.)
//   * the routes out of that are known and belong to M2b, which is also where the geometry has to become
//     GPU-RESIDENT (a `BatchedMesh.addGeometry` copies from CPU memory, so writing vertices and then reading them
//     back would keep the round trip M2 exists to remove): either a segmented scan over the per-key counts, or a
//     draw that consumes the per-key ranges directly.
// So M2a proves the DECISION and the FACE DATA, and M2b owns the placement. The signature is what makes that
// split honest: a wrong face cannot hide behind an unbuilt buffer.
//
// WHAT IS DELIBERATELY DIFFERENT FROM `meshChunk`, both visible in the numbers this file produces:
//   * the CPU mesher's slot order is FIRST-SEEN, the GPU's is the DENSE key order (`(value << 2) | kind`) — the
//     engine never cares (a slot's key travels with it), and the census is per key, so the order is irrelevant;
//   * the CPU mesher skips a uniform chunk's interior (a fast path); the kernel tests every voxel, which emits
//     nothing there because every neighbour is solid. Same answer, more threads, one less branch.
import {
  Fn,
  If,
  add,
  atomicAdd,
  atomicXor,
  bitXor,
  div,
  equal,
  instanceIndex,
  mod,
  mul,
  notEqual,
  storage,
  uint,
} from "three/tsl";
import { StorageBufferAttribute, type WebGPURenderer } from "three/webgpu";
import { AIR, CHUNK_SIZE, CHUNK_VOLUME } from "../../../data/world/chunk";
import { CORNER_UVS, FACES } from "../../../data/globals/faces";
import { PAD_W, buildPaddedVoxels, padIndex, type ChunkMeshInput, type MeshResult } from "../../../data/world/mesh";
import { n, type U32Node } from "./lod-gpu-field";

/** Cells in the padded block the kernel walks (34³): the chunk's own 32³ plus a one-cell solidity border. */
const PAD_CELLS = PAD_W * PAD_W * PAD_W;
/** The DENSE key space: `(voxel value << 2) | kind`, i.e. 256 values × 4 kinds. A dense space is what lets the
 *  kernel address a counter with an expression instead of a hash map — `meshChunk` uses a `Map` for the same
 *  thing, which is exactly the kind of per-face bookkeeping the GPU must not do. */
export const MESHER_KEYS = 256 * 4;
/** FNV-1a's prime, and the offset basis every signature starts from. */
const FNV_PRIME = 16777619;
const FNV_OFFSET = 0x811c9dc5;

/** ONE FACE of the shared table, in the form both halves need: the neighbour's offset in the PADDED block (a
 *  constant, because the pad makes every neighbour one step away), the look KIND the mesher assigns it, and the
 *  face's index in `FACES` (which the signature carries, so a wrong normal or a wrong winding shows up). */
interface MesherFace {
  readonly step: number;
  readonly kind: number;
  readonly index: number;
  /** FNV-1a's state after this face's CONSTANTS (its table index, its four corner offsets and its four UVs) —
   *  precomputed here so the kernel mixes three runtime values per face instead of twenty-four, and so the CPU
   *  half cannot use a different list. */
  readonly prefix: number;
}

/** FNV-1a over a list of integers: the signatures' constant half. Kept public because the CPU half of the census
 *  rebuilds it from the ARRAYS (see `censusOfMesh`) while the kernel and the pad walk use the precomputed prefix —
 *  the two must produce the same number for the same face, which is what the probe measures. */
export function valuePrefix(values: readonly number[]): number {
  let h = FNV_OFFSET;
  for (const value of values) h = Math.imul((h ^ (value >>> 0)) >>> 0, FNV_PRIME) >>> 0;
  return h;
}

const MESHER_FACES: readonly MesherFace[] = FACES.map((face, index) => {
  const values: number[] = [index];
  for (const corner of face.corners) values.push(corner[0], corner[1], corner[2]);
  for (const uv of CORNER_UVS) values.push(uv[0], uv[1]);
  return {
    step: (face.dir[0] + face.dir[1] * PAD_W + face.dir[2] * PAD_W * PAD_W) >>> 0,
    kind: face.dir[1] === 1 ? 0 : face.dir[1] === -1 ? 1 : 2,
    index,
    prefix: valuePrefix(values),
  };
});

/** One face's signature: its constant prefix (see `MesherFace.prefix`) mixed with the voxel it belongs to. The
 *  THREE runtime values are the whole variable part — the corner data and the UVs are constants of the face — and
 *  they are mixed in this order on BOTH sides. */
export function faceSignature(prefix: number, lx: number, ly: number, lz: number): number {
  let h = prefix;
  for (const value of [lx, ly, lz]) h = Math.imul((h ^ (value >>> 0)) >>> 0, FNV_PRIME) >>> 0;
  return h >>> 0;
}

/** Per-look census of a meshed chunk: how many faces, and two order-independent summaries of them. Order
 *  independence is the point — a parallel kernel writes these with atomics, in any order. */
export interface MeshCensus {
  readonly total: number;
  readonly counts: Uint32Array;
  readonly sum: Uint32Array;
  readonly xor: Uint32Array;
}

function emptyCensus(): { total: number; counts: Uint32Array; sum: Uint32Array; xor: Uint32Array } {
  return { total: 0, counts: new Uint32Array(MESHER_KEYS), sum: new Uint32Array(MESHER_KEYS), xor: new Uint32Array(MESHER_KEYS) };
}

/** THE CPU HALF OF THE CONTRACT: the census of a meshed chunk, read back out of the ARRAYS `meshChunk` produced
 *  (not out of the input), so a wrong corner, a wrong normal or a wrong UV in the production output shows up as a
 *  difference in the signature. Two things about it are load-bearing and were both learned the hard way:
 *
 *    * THE VOXEL ORIGIN IS *NOT* THE MINIMUM CORNER. A face whose four corners all sit on one side of the voxel
 *      (the top face's `y` is `+1` everywhere, the -X face's `x` is `0` everywhere) has its minimum corner one
 *      step away from the voxel it belongs to, so the origin has to come from a corner minus THAT CORNER'S OWN
 *      table offset. Using the min corner made every non-negative-axis face sign a different voxel, which the
 *      gate's very first run reported as four differing keys with identical COUNTS — the counts were right, only
 *      the signature moved.
 *    * the value list is rebuilt from the arrays (the face's table index, its four RELATIVE corner offsets and its
 *      four UVs) rather than taken from the tables, so this half validates the production WRITE PATH as well. The
 *      kernel's half uses the tables directly; for a correct writer the two lists are identical. */
export function censusOfMesh(mesh: MeshResult): MeshCensus {
  const out = emptyCensus();
  for (const slot of mesh.slots) {
    for (let face = slot.start; face < slot.start + slot.count; face++) {
      const first = face * 4;
      const index = FACES.findIndex(
        (entry) =>
          entry.normal[0] === mesh.normals[first * 3] &&
          entry.normal[1] === mesh.normals[first * 3 + 1] &&
          entry.normal[2] === mesh.normals[first * 3 + 2],
      );
      if (index < 0) {
        // A face whose normal is not in the table cannot be signed; it still counts, so the count disagrees.
        out.counts[slot.key]++;
        out.total++;
        continue;
      }
      const table = FACES[index];
      const ox = mesh.positions[first * 3] - table.corners[0][0];
      const oy = mesh.positions[first * 3 + 1] - table.corners[0][1];
      const oz = mesh.positions[first * 3 + 2] - table.corners[0][2];
      const values: number[] = [index];
      for (let c = 0; c < 4; c++) {
        values.push(
          mesh.positions[(first + c) * 3] - ox,
          mesh.positions[(first + c) * 3 + 1] - oy,
          mesh.positions[(first + c) * 3 + 2] - oz,
        );
      }
      for (let c = 0; c < 4; c++) values.push(mesh.uvs[(first + c) * 2], mesh.uvs[(first + c) * 2 + 1]);
      const signature = faceSignature(valuePrefix(values), ox, oy, oz);
      out.counts[slot.key]++;
      out.sum[slot.key] = (out.sum[slot.key] + signature) >>> 0;
      out.xor[slot.key] = (out.xor[slot.key] ^ signature) >>> 0;
      out.total++;
    }
  }
  return out;
}

/** THE KERNEL'S WALK, ON THE CPU — the same padded block, the same face offsets, the same signature. It exists so
 *  the gate can hold the kernel's logic to `meshChunk` without a GPU (the pad contract and the census must agree
 *  with the production mesher for every synthetic input), and it is deliberately a separate implementation from
 *  `censusOfMesh`: that one reads the OUTPUT arrays, this one the INPUT data. */
export function censusOfPad(padded: Uint32Array): MeshCensus {
  const out = emptyCensus();
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const center = padIndex(lx, ly, lz);
        const value = padded[center];
        if (value === AIR) continue;
        for (const face of MESHER_FACES) {
          if (padded[center + (face.step | 0)] !== 0) continue;
          const key = value * 4 + face.kind;
          const signature = faceSignature(face.prefix, lx, ly, lz);
          out.counts[key]++;
          out.sum[key] = (out.sum[key] + signature) >>> 0;
          out.xor[key] = (out.xor[key] ^ signature) >>> 0;
          out.total++;
        }
      }
    }
  }
  return out;
}

/** The same three mixes as `faceSignature`, as TSL. Every value is u32: WGSL wraps exactly like `Math.imul`, so
 *  the two halves agree bit for bit (and the probe measures that they do). */
function tslFaceSignature(prefix: number, lx: U32Node, ly: U32Node, lz: U32Node): U32Node {
  return n(
    mul(n(bitXor(n(mul(n(bitXor(n(mul(n(bitXor(n(uint(prefix)), n(lx))), n(uint(FNV_PRIME)))), n(ly))), n(uint(FNV_PRIME)))), n(lz))), n(uint(FNV_PRIME))),
  );
}

/** The GPU mesher: one padded block in, one census per look out. It owns its buffers and one kernel, and it can
 *  mesh a chunk per call — M2a's shape. `run` resolves when the readbacks have landed. */
export class GpuChunkMesher {
  private readonly renderer: WebGPURenderer;
  private readonly paddedAttr: StorageBufferAttribute;
  private readonly countAttr: StorageBufferAttribute;
  private readonly sumAttr: StorageBufferAttribute;
  private readonly xorAttr: StorageBufferAttribute;
  private readonly kernel: { count: number };

  constructor(renderer: WebGPURenderer) {
    this.renderer = renderer;
    this.paddedAttr = new StorageBufferAttribute(new Uint32Array(PAD_CELLS), 1);
    this.countAttr = new StorageBufferAttribute(new Uint32Array(MESHER_KEYS), 1);
    this.sumAttr = new StorageBufferAttribute(new Uint32Array(MESHER_KEYS), 1);
    this.xorAttr = new StorageBufferAttribute(new Uint32Array(MESHER_KEYS), 1);
    this.kernel = this.buildKernel();
  }

  /** The kernel, built ONCE (a per-call build would compile a pipeline per chunk). The three accumulators are
   *  ATOMIC, and `.toAtomic()` is load-bearing: `storage(attr, "uint", n)` declares
   *  `ptr<storage, u32, read_write>`, WGSL has no `atomicAdd`/`atomicXor` for that, and the pipeline then fails
   *  to compile while the dispatch still "succeeds" — the M0/M1a round that cost was exactly this. */
  private buildKernel(): { count: number } {
    const pad = storage(this.paddedAttr, "uint", PAD_CELLS);
    const counts = storage(this.countAttr, "uint", MESHER_KEYS).toAtomic();
    const sums = storage(this.sumAttr, "uint", MESHER_KEYS).toAtomic();
    const xors = storage(this.xorAttr, "uint", MESHER_KEYS).toAtomic();
    const kernel = Fn(() => {
      // The thread index is the CENTER voxel, in `meshChunk`'s own numbering (`lx + ly*32 + lz*1024`), converted
      // to the padded address once. Every arithmetic node is u32 on purpose: `instanceIndex` is a u32, and mixing
      // it with an i32 (a `Loop` counter, for instance) does not compile at all — see the M0 probe's note.
      const idx = instanceIndex;
      const lx = mod(idx, uint(CHUNK_SIZE));
      const ly = mod(div(idx, uint(CHUNK_SIZE)), uint(CHUNK_SIZE));
      const lz = div(idx, uint(CHUNK_SIZE * CHUNK_SIZE));
      const center = add(
        add(add(lx, uint(1)), mul(add(ly, uint(1)), uint(PAD_W))),
        mul(add(lz, uint(1)), uint(PAD_W * PAD_W)),
      );
      const value = pad.element(center);
      If(notEqual(value, uint(AIR)), () => {
        for (const face of MESHER_FACES) {
          // The neighbour is ONE STEP away in the pad, so culling is one read and one comparison — no plane
          // lookup, no axis branch (that is what `buildPaddedVoxels` exists for).
          const neighbour = pad.element(add(center, uint(face.step)));
          If(equal(neighbour, uint(0)), () => {
            const key = add(mul(value, uint(4)), uint(face.kind));
            const signature = tslFaceSignature(face.prefix, lx, ly, lz);
            atomicAdd(counts.element(key), uint(1));
            atomicAdd(sums.element(key), signature);
            atomicXor(xors.element(key), signature);
          });
        }
      });
    })().compute(CHUNK_VOLUME);
    return kernel as unknown as { count: number };
  }

  /** Mesh one chunk's input on the GPU and read the census back. The readback is 12 KB (three 4 KB buffers)
   *  whatever the chunk holds — the geometry itself never leaves the GPU, which is the whole direction of M2. */
  async run(input: ChunkMeshInput): Promise<MeshCensus> {
    (this.paddedAttr.array as Uint32Array).set(buildPaddedVoxels(input));
    this.paddedAttr.needsUpdate = true;
    for (const attr of [this.countAttr, this.sumAttr, this.xorAttr]) {
      (attr.array as Uint32Array).fill(0);
      attr.needsUpdate = true;
    }
    await this.renderer.computeAsync(this.kernel as never);
    const counts = new Uint32Array(await this.renderer.getArrayBufferAsync(this.countAttr));
    const sum = new Uint32Array(await this.renderer.getArrayBufferAsync(this.sumAttr));
    const xor = new Uint32Array(await this.renderer.getArrayBufferAsync(this.xorAttr));
    let total = 0;
    for (const count of counts) total += count;
    return { total, counts, sum, xor };
  }
}

/** What a census comparison found, per key and in total. Shared by the probe's report and (with stub data) by the
 *  gate, so "what a mismatch means" is stated in one place. */
export interface CensusDiff {
  readonly keysCompared: number;
  readonly mismatchedKeys: number;
  readonly totalCpu: number;
  readonly totalGpu: number;
  /** Up to a few human-readable examples of the first differing keys. */
  readonly examples: readonly string[];
}

/** Compare two censuses key by key. A key's COUNT and BOTH signatures must agree: the count catches a face the
 *  other side culled or invented, the signatures catch a face that is in the wrong place, has the wrong normal or
 *  the wrong UV. */
export function compareCensus(cpu: MeshCensus, gpu: MeshCensus): CensusDiff {
  let keysCompared = 0;
  let mismatchedKeys = 0;
  const examples: string[] = [];
  for (let key = 0; key < MESHER_KEYS; key++) {
    const a = cpu.counts[key];
    const b = gpu.counts[key];
    if (a === 0 && b === 0) continue;
    keysCompared++;
    if (a === b && cpu.sum[key] === gpu.sum[key] && cpu.xor[key] === gpu.xor[key]) continue;
    mismatchedKeys++;
    if (examples.length < 6) {
      const kind = ["top", "bottom", "side"][key & 3] ?? "?";
      examples.push(
        `value ${key >>> 2} ${kind}: cpu ${a} face(s) sum ${cpu.sum[key]} xor ${cpu.xor[key]} vs ` +
          `gpu ${b} sum ${gpu.sum[key]} xor ${gpu.xor[key]}`,
      );
    }
  }
  return { keysCompared, mismatchedKeys, totalCpu: cpu.total, totalGpu: gpu.total, examples };
}
