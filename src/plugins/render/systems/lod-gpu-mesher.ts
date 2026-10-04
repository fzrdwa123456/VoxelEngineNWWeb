// ===== M2 OF THE GPU ROUTE: THE CHUNK MESHER, ON THE GPU =====
// WHY. The chunk pipeline is CPU-bound — measured with the frame probe (`gpu=` 2-4 ms inside a 20-30 ms frame) and
// visible in `RENDER meshing: 11 worker(s)`: eleven cores meshing the fine ring while the MAIN THREAD meshes the far
// ring at ~0.83 ms per chunk. M0 proved the field can be sampled on the GPU (`K`), M1 moved the far ring's sampling
// there, and this file is the mesher: voxel data in, geometry out, all of it on the GPU.
//
// IT IS PROVEN AGAINST THE PRODUCTION MESHER, and that is not a formality. `meshChunk` (data/world/mesh.ts) is the
// reference the whole engine draws with, so this file has THREE halves that must agree:
//   * the KERNELS (below), which run on the device;
//   * `packFromPad`, the same walk on the CPU, which is what lets `check:ecs` hold the kernel's logic to `meshChunk`
//     with no device at all (a GPU-less test of a GPU mesher is only possible if the logic exists on both sides);
//   * the `M` probe, which runs the kernel over synthetic patterns and the player's own chunks and compares the
//     RESULT — every face's four corners, normals and UVs, in order — against `meshChunk`.
//
// ===== HOW THE PACKED LAYOUT IS PRODUCED WITHOUT A FETCH-ADD =====
// A chunk's geometry is written per LOOK KEY into a contiguous slice (`geometry.groups` need that), which on the CPU
// is one line: `writeFace(..., cursor[slot]++, ...)`. A parallel kernel cannot do that with a plain counter, and the
// usual answer — an atomic fetch-add, whose RETURN value is the destination — is NOT AVAILABLE in three's TSL:
// `atomicAdd` is built by `atomicFunc`, which wraps the node in `.toStack()`, so it is a statement and its value
// cannot appear in an expression. (That is why M2a landed as a per-look census first: it needed no destination at
// all.)
//
// THE WAY OUT IS TO GIVE EACH KEY ITS OWN THREAD. `emit` runs ONE THREAD PER KEY (the dense `(value << 2) | kind`
// space, 1024 of them) and each thread walks the whole chunk, appending its OWN faces with a plain read/increment
// of its own cursor. No atomics, no fetch-add, no compaction pass — and two properties fall out of it for free:
//   * the per-key face order is WALK ORDER, i.e. exactly `meshChunk`'s order inside a slot, so the comparison
//     against the CPU can be exact rather than order-insensitive;
//   * the walk is DETERMINISTIC (the same input gives the same bytes), which a parallel scatter could not promise.
// The cost is 1024 threads × 32³ voxels of guarded tests, and the guard that matters is the first one: a key with a
// zero count returns immediately, so a real chunk (a handful of non-empty looks) pays a handful of walks.
//
// THE THREE KERNELS, and why they cannot be fewer:
//   1. `census` — one thread per voxel, testing all six faces and `atomicAdd`ing this key's count. The counts are
//      what the slices are cut from, and the atomics are statements here, which is all a count needs.
//   2. `scan` — ONE thread, 1024 iterations: the exclusive prefix sum of the counts, written into `starts` and
//      copied into each key's mutable `cursor`. `total` (the last prefix) is the chunk's face count.
//   3. `emit` — one thread per key, as above. It reads the counts NON-atomically (a different shader, so the buffer
//      is simply bound twice in two passes — an atomic binding cannot be read as a plain value in WGSL, which is why
//      the counts are declared `.toAtomic()` in `census` and plain here).
//
// WHAT IT DELIBERATELY DOES NOT DO: nothing is read back. The geometry stays in GPU buffers; the `M` probe reads it
// only to VERIFY it (a 12 KB census in M2a's shape would have been cheaper, but comparing the real bytes is the
// stronger test), and the drawing side is M2c. The measurement that makes this non-negotiable is in ROADMAP: a
// dispatch+readback round trip costs 20-30 ms on the user's machine, so anything per-chunk that comes back to the
// CPU would be slower than the CPU mesher it replaces.
import {
  Fn,
  If,
  Loop,
  add,
  atomicAdd,
  div,
  equal,
  float,
  instanceIndex,
  mod,
  mul,
  notEqual,
  storage,
  uint,
  Var,
} from "three/tsl";
import { StorageBufferAttribute, type WebGPURenderer } from "three/webgpu";
import { AIR, CHUNK_SIZE, CHUNK_VOLUME } from "../../../data/world/chunk";
import { CORNER_UVS, FACES } from "../../../data/globals/faces";
import { PAD_W, buildPaddedVoxels, padIndex, type ChunkMeshInput, type MeshResult, type MeshSlot } from "../../../data/world/mesh";
import { n, type U32Node } from "./lod-gpu-field";

/** Cells in the padded block the kernels walk (34³): the chunk's own 32³ plus a one-cell solidity border. */
const PAD_CELLS = PAD_W * PAD_W * PAD_W;
/** The DENSE key space: `(voxel value << 2) | kind`, i.e. 256 values × 4 kinds. Dense is what lets a kernel address
 *  a slice with an expression instead of a hash map — `meshChunk` uses a `Map` for the same thing, which is exactly
 *  the per-face bookkeeping a GPU must not do. */
const KEYS = 256 * 4;
/** The worst case a chunk can hold: every voxel showing all six faces. The output buffers are sized for it, because
 *  a storage array's length is baked into the kernel (a per-capacity rebuild would compile a pipeline per chunk). */
const MAX_FACES = CHUNK_VOLUME * 6;

/** ONE FACE of the shared table, in the form both halves need: the neighbour's offset in the PADDED block (a
 *  constant, because the pad makes every neighbour one step away), the look KIND the mesher assigns it, its index
 *  in `FACES` (kept for the census/probe reports) and its own corner/UV constants. */
interface MesherFace {
  readonly step: number;
  readonly kind: number;
  readonly index: number;
  readonly corners: readonly (readonly [number, number, number])[];
  readonly uvs: readonly (readonly [number, number])[];
}

const MESHER_FACES: readonly MesherFace[] = FACES.map((face, index) => ({
  step: (face.dir[0] + face.dir[1] * PAD_W + face.dir[2] * PAD_W * PAD_W) >>> 0,
  kind: face.dir[1] === 1 ? 0 : face.dir[1] === -1 ? 1 : 2,
  index,
  corners: face.corners,
  uvs: CORNER_UVS,
}));

/** A chunk's geometry, packed per look: the shape `meshChunk` returns, with the slots in ASCENDING KEY ORDER
 *  (the CPU's is first-seen order). The engine carries each slot's key with it, so the order is not a contract —
 *  but it does have to be the SAME on both sides, which is what lets the gate and the probe compare slot by slot. */
export interface PackedGeometry {
  readonly faces: number;
  readonly slots: readonly MeshSlot[];
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  /** The SLICE TABLE the kernels used, kept so it can be checked on its own: `starts[key]` must be the prefix sum of
   *  `counts` below it, and the last prefix must be `faces`. That check exists because the first GPU run produced
   *  every look's count correctly and every slice's CONTENT one key late — a broken table is much easier to read than
   *  the geometry difference it causes. */
  readonly counts: Uint32Array;
  readonly starts: Uint32Array;
}

/** The per-key counts of a padded block, in the kernel's own walk (`census`). Split out because the gate drives it
 *  through `packFromPad` and the probe compares it against `meshChunk`'s slot counts. */
export function countFacesByPad(padded: Uint32Array): Uint32Array {
  const counts = new Uint32Array(KEYS);
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const center = padIndex(lx, ly, lz);
        const value = padded[center];
        if (value === AIR) continue;
        for (const face of MESHER_FACES) {
          if (padded[center + (face.step | 0)] !== 0) continue;
          counts[value * 4 + face.kind]++;
        }
      }
    }
  }
  return counts;
}

/** THE KERNELS' WALK, ON THE CPU — `census` + `scan` + `emit` in one function, with the same padded block, the same
 *  face offsets, the same ascending-key slices and the same walk order inside each slice. It exists so the gate can
 *  hold the kernels' logic to `meshChunk` without a device, and it is deliberately a SEPARATE implementation from
 *  anything that reads `meshChunk`'s output: this one walks the input data.
 *
 *  **THE WALK ORDER IS `meshChunk`'s, AND IT IS NOT THE STORAGE ORDER.** `meshChunk` nests `ly` outer, `lz` middle,
 *  `lx` inner while a voxel's storage index is `lx + ly*32 + lz*1024`, so the two disagree: the kernel's flat loop
 *  counter must therefore be decoded as `lx = i % 32`, `lz = (i / 32) % 32`, `ly = i / 1024` (see `walkXyz`), or a
 *  slice's faces come out in a different order than the CPU's. That is invisible to a per-look count and only shows
 *  up when the geometry is compared face by face — which is exactly what the probe and the gate do. */
export function packFromPad(padded: Uint32Array, capacity = MAX_FACES): PackedGeometry {
  const counts = countFacesByPad(padded);
  const starts = new Uint32Array(KEYS);
  const cursor = new Uint32Array(KEYS);
  let total = 0;
  for (let key = 0; key < KEYS; key++) {
    starts[key] = total;
    cursor[key] = total;
    total += counts[key];
  }
  if (total > capacity) throw new Error(`GPU mesher: ${total} faces exceed the ${capacity}-face capacity`);
  const positions = new Float32Array(total * 4 * 3);
  const normals = new Float32Array(total * 4 * 3);
  const uvs = new Float32Array(total * 4 * 2);
  const indices = new Uint32Array(total * 6);
  const slots: MeshSlot[] = [];
  for (let key = 0; key < KEYS; key++) {
    if (counts[key] === 0) continue;
    const value = key >>> 2;
    const kind = key & 3;
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const center = padIndex(lx, ly, lz);
          if (padded[center] !== value) continue;
          for (const face of MESHER_FACES) {
            if (face.kind !== kind) continue;
            if (padded[center + (face.step | 0)] !== 0) continue;
            writeFace(positions, normals, uvs, indices, cursor[key]++, lx, ly, lz, face);
          }
        }
      }
    }
    slots.push({ key, start: starts[key], count: counts[key] });
  }
  return { faces: total, slots, positions, normals, uvs, indices, counts, starts };
}

/** The walk ordinal of a voxel, in `meshChunk`'s nest order: `ly` outer, `lz` middle, `lx` inner. Returns the flat
 *  ordinal a kernel's `Loop` counter carries. */
export function walkOrdinal(lx: number, ly: number, lz: number): number {
  return lx + lz * CHUNK_SIZE + ly * CHUNK_SIZE * CHUNK_SIZE;
}

/** One face into the typed arrays, exactly as `meshChunk`'s `writeFace` does it (same corner table, same UVs, same
 *  two-triangle index pattern). The face index is GIVEN: the slice hands them out in walk order. */
function writeFace(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  indices: Uint32Array,
  faceIndex: number,
  lx: number,
  ly: number,
  lz: number,
  face: MesherFace,
): void {
  const first = faceIndex * 4;
  for (let c = 0; c < 4; c++) {
    const corner = face.corners[c];
    const p = first * 3 + c * 3;
    positions[p] = lx + corner[0];
    positions[p + 1] = ly + corner[1];
    positions[p + 2] = lz + corner[2];
    const u = first * 2 + c * 2;
    uvs[u] = face.uvs[c][0];
    uvs[u + 1] = face.uvs[c][1];
    // The normal is the face's, for all four corners (the CPU writes it the same way).
    for (let axis = 0; axis < 3; axis++) normals[p + axis] = MESHER_NORMALS[face.index][axis];
  }
  const io = faceIndex * 6;
  indices[io] = first;
  indices[io + 1] = first + 1;
  indices[io + 2] = first + 2;
  indices[io + 3] = first;
  indices[io + 4] = first + 2;
  indices[io + 5] = first + 3;
}

/** The face normals, straight from the shared table (the CPU twin writes them, and the kernel emits the same
 *  literals). */
const MESHER_NORMALS: readonly (readonly [number, number, number])[] = FACES.map((face) => face.normal);

/** The GPU mesher: one padded block in, one packed geometry out (on the device — `run` reads it back only because
 *  the probe compares it). The buffers live as long as the mesher does, so a second chunk costs three dispatches. */
export class GpuChunkMesher {
  private readonly renderer: WebGPURenderer;
  private readonly paddedAttr: StorageBufferAttribute;
  private readonly countAttr: StorageBufferAttribute;
  private readonly startAttr: StorageBufferAttribute;
  private readonly totalAttr: StorageBufferAttribute;
  private readonly positionAttr: StorageBufferAttribute;
  private readonly normalAttr: StorageBufferAttribute;
  private readonly uvAttr: StorageBufferAttribute;
  private readonly indexAttr: StorageBufferAttribute;
  private readonly census: { count: number };
  private readonly scan: { count: number };
  private readonly emit: { count: number };

  constructor(renderer: WebGPURenderer) {
    this.renderer = renderer;
    this.paddedAttr = new StorageBufferAttribute(new Uint32Array(PAD_CELLS), 1);
    this.countAttr = new StorageBufferAttribute(new Uint32Array(KEYS), 1);
    this.startAttr = new StorageBufferAttribute(new Uint32Array(KEYS), 1);
    this.totalAttr = new StorageBufferAttribute(new Uint32Array(1), 1);
    this.positionAttr = new StorageBufferAttribute(new Float32Array(MAX_FACES * 4 * 3), 1);
    this.normalAttr = new StorageBufferAttribute(new Float32Array(MAX_FACES * 4 * 3), 1);
    this.uvAttr = new StorageBufferAttribute(new Float32Array(MAX_FACES * 4 * 2), 1);
    this.indexAttr = new StorageBufferAttribute(new Uint32Array(MAX_FACES * 6), 1);
    // The kernels are built ONCE: a per-call build would compile a pipeline per chunk, and the capacity is baked
    // into the storage array lengths anyway.
    this.census = buildCensusKernel(this.paddedAttr, this.countAttr);
    this.scan = buildScanKernel(this.countAttr, this.startAttr, this.totalAttr);
    this.emit = buildEmitKernel(this.paddedAttr, this.countAttr, this.startAttr, {
      position: this.positionAttr,
      normal: this.normalAttr,
      uv: this.uvAttr,
      index: this.indexAttr,
    });
  }

  /** Mesh one chunk on the GPU and read the geometry back (the probe's half; the drawing side will not read it). */
  async run(input: ChunkMeshInput): Promise<PackedGeometry> {
    (this.paddedAttr.array as Uint32Array).set(buildPaddedVoxels(input));
    this.paddedAttr.needsUpdate = true;
    for (const attr of [this.countAttr, this.totalAttr]) {
      (attr.array as Uint32Array).fill(0);
      attr.needsUpdate = true;
    }
    await this.renderer.computeAsync(this.census as never);
    await this.renderer.computeAsync(this.scan as never);
    await this.renderer.computeAsync(this.emit as never);
    const counts = new Uint32Array(await this.renderer.getArrayBufferAsync(this.countAttr));
    const starts = new Uint32Array(await this.renderer.getArrayBufferAsync(this.startAttr));
    const total = new Uint32Array(await this.renderer.getArrayBufferAsync(this.totalAttr))[0];
    if (total > MAX_FACES) {
      throw new Error(`GPU mesher: the kernel reported ${total} faces, past the ${MAX_FACES}-face capacity`);
    }
    const slots: MeshSlot[] = [];
    for (let key = 0; key < KEYS; key++) if (counts[key] > 0) slots.push({ key, start: starts[key], count: counts[key] });
    if (total === 0) {
      return {
        faces: 0,
        slots,
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        uvs: new Float32Array(0),
        indices: new Uint32Array(0),
        counts,
        starts,
      };
    }
    const read = async (attr: StorageBufferAttribute, elements: number): Promise<ArrayBuffer> =>
      this.renderer.getArrayBufferAsync(attr, null, 0, elements * 4);
    const positions = new Float32Array(await read(this.positionAttr, total * 4 * 3));
    const normals = new Float32Array(await read(this.normalAttr, total * 4 * 3));
    const uvs = new Float32Array(await read(this.uvAttr, total * 4 * 2));
    const indices = new Uint32Array(await read(this.indexAttr, total * 6));
    return { faces: total, slots, positions, normals, uvs, indices, counts, starts };
  }
}

/** 1. COUNT: one thread per voxel, all six faces, `atomicAdd` per emitted face. The atomics are STATEMENTS, which
 *  is all a census needs — and `.toAtomic()` is load-bearing: `storage(attr, "uint", n)` declares
 *  `ptr<storage, u32, read_write>`, WGSL has no `atomicAdd` for that, the pipeline then fails to compile and the
 *  dispatch silently writes nothing (the round M0/M1a lost to exactly this). */
function buildCensusKernel(padded: StorageBufferAttribute, countAttr: StorageBufferAttribute): { count: number } {
  const pad = storage(padded, "uint", PAD_CELLS);
  const counts = storage(countAttr, "uint", KEYS).toAtomic();
  return Fn(() => {
    const center = padCenter(instanceIndex);
    const value = pad.element(center);
    If(notEqual(value, uint(AIR)), () => {
      for (const face of MESHER_FACES) {
        const neighbour = pad.element(add(center, uint(face.step)));
        If(equal(neighbour, uint(0)), () => {
          atomicAdd(counts.element(add(mul(value, uint(4)), uint(face.kind))), uint(1));
        });
      }
    });
  })().compute(CHUNK_VOLUME) as unknown as { count: number };
}

/** 2. SCAN: ONE thread, 1024 iterations, the exclusive prefix sum of the counts into `starts` (the slice table).
 *  Sequential by construction, so it is deterministic; 1024 iterations on one thread is nothing next to the work
 *  after it.
 *
 *  THE ACCUMULATOR IS A `Var` (a mutable LOCAL, i.e. a WGSL `var`), NOT A STORAGE CELL — and that is a fixed bug,
 *  not a preference. The first version kept the running total in a one-element storage buffer
 *  (`total.element(uint(0)).assign(...)`) and read it back with `const here = total.element(uint(0))`; TSL nodes are
 *  lazy, so the read was re-evaluated after the assignment and the whole slice table came out one key late. The
 *  probe's run showed what that looks like: every look's COUNT was right and every slice's CONTENT belonged to its
 *  neighbour (the top slice held the bottom's faces, and the last slice's data fell off the end of the buffer). */
function buildScanKernel(
  countAttr: StorageBufferAttribute,
  startAttr: StorageBufferAttribute,
  totalAttr: StorageBufferAttribute,
): { count: number } {
  // The counts are read as a PLAIN value here (a different shader, so the buffer is bound twice in two passes):
  // an atomic binding cannot be read as a value in WGSL, and `atomicLoad` is a statement in TSL.
  const counts = storage(countAttr, "uint", KEYS);
  const starts = storage(startAttr, "uint", KEYS);
  const total = storage(totalAttr, "uint", 1);
  return Fn(() => {
    const running = Var(uint(0));
    Loop(KEYS, ({ i }) => {
      const key = n(i).toUint();
      starts.element(key).assign(n(running));
      running.assign(n(add(n(running), counts.element(key))));
    });
    total.element(uint(0)).assign(n(running));
  })().compute(1) as unknown as { count: number };
}

/** 3. EMIT: ONE THREAD PER KEY. Each thread walks the whole chunk in `meshChunk`'s order and appends the faces of
 *  ITS key with a counter of its own — no atomics, no fetch-add (which TSL cannot give, see the header), and the
 *  slice comes out in walk order. The first guard is the one that makes it cheap: a key with no faces returns at
 *  once.
 *
 *  TWO `Var`s AND THEIR ORDER ARE THE POINT: the rank inside the slice and the destination being written are mutable
 *  LOCALS (WGSL `var`), the destination is SNAPSHOT BEFORE the rank is incremented, and the writes read the
 *  snapshot. Keeping either of them in a storage cell (the first version kept the rank in a `cursor` buffer and
 *  derived the destination from it) is what shifted every face by one: the destination was re-derived after the
 *  increment, so nothing landed where the slice table said it would. */
function buildEmitKernel(
  padded: StorageBufferAttribute,
  countAttr: StorageBufferAttribute,
  startAttr: StorageBufferAttribute,
  out: {
    readonly position: StorageBufferAttribute;
    readonly normal: StorageBufferAttribute;
    readonly uv: StorageBufferAttribute;
    readonly index: StorageBufferAttribute;
  },
): { count: number } {
  const pad = storage(padded, "uint", PAD_CELLS);
  const counts = storage(countAttr, "uint", KEYS);
  const starts = storage(startAttr, "uint", KEYS);
  const positions = storage(out.position, "float", MAX_FACES * 4 * 3);
  const normals = storage(out.normal, "float", MAX_FACES * 4 * 3);
  const uvs = storage(out.uv, "float", MAX_FACES * 4 * 2);
  const indices = storage(out.index, "uint", MAX_FACES * 6);
  return Fn(() => {
    const key = instanceIndex;
    const value = div(key, uint(4));
    const kind = mod(key, uint(4));
    const rank = Var(uint(0));
    const destination = Var(uint(0));
    // THE WALK'S COORDINATES ARE SNAPSHOTTED PER ITERATION, for the same reason the destination is: a
    // counter-derived expression read at two different points is NOT the same value in a node graph. The tests and
    // the writes must agree about WHICH VOXEL is being meshed — and the second live run showed exactly what happens
    // when they do not: the per-look COUNTS stayed right (they come from the census kernel) while a few faces per
    // slice carried another voxel's coordinates, so the slice's content was right in shape and wrong in detail. The
    // assignments are explicit statements at the TOP of the iteration, so they run once per iteration whatever three
    // decides about where the declaration lives.
    const walkX = Var(uint(0));
    const walkY = Var(uint(0));
    const walkZ = Var(uint(0));
    const center = Var(uint(0));
    If(notEqual(value, uint(AIR)), () => {
      If(notEqual(counts.element(key), uint(0)), () => {
        // ONE FLAT LOOP, and its counter IS the walk ordinal: `meshChunk` nests `ly` outer, `lz` middle, `lx` inner,
        // so the ordinal decodes the other way round from the storage index (see `packFromPad`). (A nested `Loop`
        // cannot be used here: three names every counter `i` by default, so the inner one shadows the outer and the
        // walk visits only a diagonal — M0 lost a round to that.)
        Loop(CHUNK_VOLUME, ({ i }) => {
          const ordinal = n(i).toUint();
          walkX.assign(n(mod(n(ordinal), uint(CHUNK_SIZE))));
          walkZ.assign(n(mod(n(div(n(ordinal), uint(CHUNK_SIZE))), uint(CHUNK_SIZE))));
          walkY.assign(n(div(n(ordinal), uint(CHUNK_SIZE * CHUNK_SIZE))));
          center.assign(n(padCenter(n(ordinal))));
          If(equal(pad.element(n(center)), value), () => {
            for (const face of MESHER_FACES) {
              If(equal(uint(face.kind), kind), () => {
                If(equal(pad.element(n(add(n(center), uint(face.step)))), uint(0)), () => {
                  // Snapshot, THEN advance: the writes below must use the position this face owns.
                  destination.assign(n(add(n(starts.element(key)), n(rank))));
                  rank.assign(n(add(n(rank), uint(1))));
                  writeFaceNodes(positions, normals, uvs, indices, n(destination), n(walkX), n(walkY), n(walkZ), face);
                });
              });
            }
          });
        });
      });
    });
  })().compute(KEYS) as unknown as { count: number };
}

/** The padded address of a CENTER voxel, from the flat WALK ordinal (`meshChunk`'s nest order: `ly` outer, `lz`
 *  middle, `lx` inner — see `packFromPad`). Shared by the kernels so the three of them cannot disagree about the
 *  numbering. Every step is erased with `n()` (see `writeFaceNodes`): `div(any, uint)` resolves to a FLOAT overload
 *  by inference, and feeding that float into `mod` fails to typecheck even though the emitted WGSL is u32 math. */
function padCenter(ordinal: U32Node): U32Node {
  const lx = n(mod(n(ordinal), uint(CHUNK_SIZE)));
  const lz = n(mod(n(div(n(ordinal), uint(CHUNK_SIZE))), uint(CHUNK_SIZE)));
  const ly = n(div(n(ordinal), uint(CHUNK_SIZE * CHUNK_SIZE)));
  return n(
    add(add(add(lx, uint(1)), mul(add(ly, uint(1)), uint(PAD_W))), mul(add(lz, uint(1)), uint(PAD_W * PAD_W))),
  );
}

/** One face into the output buffers, as TSL: the same four corners, normals, UVs and index pattern as `writeFace`
 *  above, with every constant taken from the shared tables (`MESHER_FACES`, `MESHER_NORMALS`). Every node goes
 *  through `n()`, the codebase's type eraser, for the reason `lod-gpu-field.ts` documents: TSL's typings are precise
 *  per overload and a port that mixes u32 indices with f32 positions would otherwise be steered into the wrong
 *  overload (uvec4) by inference alone. */
function writeFaceNodes(
  positions: unknown,
  normals: unknown,
  uvs: unknown,
  indices: unknown,
  faceIndex: U32Node,
  lx: U32Node,
  ly: U32Node,
  lz: U32Node,
  face: MesherFace,
): void {
  const slot = (buffer: unknown, index: unknown): { assign(value: unknown): void } =>
    (buffer as { element(i: unknown): { assign(value: unknown): void } }).element(index);
  const first = n(mul(faceIndex, uint(4)));
  for (let c = 0; c < 4; c++) {
    const corner = face.corners[c];
    const p = n(add(n(mul(first, uint(3))), uint(c * 3)));
    const axisValues = [lx, ly, lz];
    for (let axis = 0; axis < 3; axis++) {
      slot(positions, n(add(p, uint(axis)))).assign(n(float(n(add(axisValues[axis], n(float(corner[axis])))))));
      slot(normals, n(add(p, uint(axis)))).assign(n(float(MESHER_NORMALS[face.index][axis])));
    }
    const u = n(add(n(mul(first, uint(2))), uint(c * 2)));
    slot(uvs, u).assign(n(float(face.uvs[c][0])));
    slot(uvs, n(add(u, uint(1)))).assign(n(float(face.uvs[c][1])));
  }
  const io = n(mul(faceIndex, uint(6)));
  const pattern = [0, 1, 2, 0, 2, 3];
  for (let t = 0; t < 6; t++) {
    slot(indices, n(add(io, uint(t)))).assign(n(add(first, uint(pattern[t]))));
  }
}
