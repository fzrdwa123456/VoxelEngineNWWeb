// ===== M2 OF THE GPU ROUTE: THE CHUNK MESHER, ON THE GPU =====
// WHY. The chunk pipeline is CPU-bound — measured with the frame probe (`gpu=` 2-4 ms inside a 20-30 ms frame) and
// visible in `RENDER meshing: 11 worker(s)`: eleven cores meshing the fine ring while the MAIN THREAD meshes the far
// ring at ~0.83 ms per chunk. M0 proved the field can be sampled on the GPU (`K`), M1 moved the far ring's sampling
// there, and this file is the mesher: voxel data in, geometry out, all of it on the GPU.
//
// IT IS PROVEN AGAINST THE PRODUCTION MESHER, and that is not a formality. `meshChunk` (data/world/mesh.ts) is the
// reference the whole engine draws with, so this file has THREE halves that must agree:
//   * the KERNELS (below), which run on the device;
//   * `packBatchFromPad` (+ its single-slot wrapper `packFromPad`), the same walk on the CPU, which is what lets
//     `check:ecs` hold the kernel's logic to `meshChunk` with no device at all (a GPU-less test of a GPU mesher is
//     only possible if the logic exists on both sides);
//   * the `M` probe, which runs the kernel over synthetic patterns and the player's own chunks and compares the
//     RESULT — every face's drawn vertices, normals and UVs, in order — against `meshChunk`.
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
// THE KERNELS, and why they cannot be fewer:
//   1. `census` — one thread per (slot, voxel), testing all six faces and `atomicAdd`ing this key's count. The counts
//      are what the slices are cut from, and the atomics are statements here, which is all a count needs.
//   2. `scan` — one thread PER SLOT, 1024 iterations: the exclusive prefix sum of that slot's counts, written into
//      its `starts` and summed into its total.
//   3. `bases` — ONE thread over the slots: the exclusive prefix sum of the per-slot totals, i.e. where each slot
//      begins in the shared ARENA (M2c step 2a). This is what lets the CPU stay ignorant of the face counts.
//   4. `emit` — one thread per (slot, key), as above. It reads the counts NON-atomically (a different shader, so the
//      buffer is simply bound twice in two passes — an atomic binding cannot be read as a plain value in WGSL, which
//      is why the counts are declared `.toAtomic()` in `census` and plain here).
//
// WHAT IT DELIBERATELY DOES NOT DO: in production, nothing is read back. The geometry stays in GPU buffers, and the
// arena means ONE kernel build (not one per chunk) lands MANY chunks in it at offsets the device chose itself. The
// `M` probe reads it only to VERIFY it, and the drawing side is M2c step 2b/2c. The measurement that makes this
// non-negotiable is in ROADMAP: a dispatch+readback round trip costs 20-30 ms on the user's machine, so anything
// per-chunk that comes back to the CPU would be slower than the CPU mesher it replaces.
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
/** HOW MANY CHUNKS ONE ARENA SERVES (M2c step 2a). A storage array's length is baked into a kernel, so a per-chunk
 *  output set means a pipeline build per chunk (~200 ms) — the arena exists to make it ONE build for many chunks.
 *  The slot is DECODED FROM THE THREAD ID (`slot = instanceIndex / <per-slot threads>`), never passed in as state:
 *  a uniform per chunk would have to be re-uploaded between dispatches inside one frame, and three's upload timing
 *  there is not something to bet a silent-corruption bug on. */
export const MESHER_SLOTS = 4;

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
  /** WHERE THIS SLOT'S FIRST FACE SITS IN THE ARENA (M2c step 2a). The `positions`/`normals`/`uvs` below are this
   *  slot's own slice, so their indices start at 0 for face 0 of THIS chunk; `base` is the absolute face index in the
   *  buffer every slot of the batch shares. One slot in one output set is `base === 0`, and the drawing side needs
   *  `base` for exactly one thing: `drawRange`/`groups` are arena offsets, not slice offsets. */
  readonly base: number;
  readonly slots: readonly MeshSlot[];
  /** The DRAWN vertex layout: `VERTS_PER_FACE` vertices per face (non-indexed), `DRAWN_STRIDE` floats each. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
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

/** ONE SLOT'S SLICE TABLE: the per-key counts, their EXCLUSIVE PREFIX SUM (`starts`, relative to the slot) and where
 *  the slot begins in the ARENA. The kernels build exactly this in two passes (`census` then `scan`), and the CPU
 *  twin exists so the gate can hold both to `meshChunk` with no device at all. */
interface SlotTable {
  readonly counts: Uint32Array;
  readonly starts: Uint32Array;
  readonly faces: number;
  readonly base: number;
}

/** The scan of ONE slot: `starts` is the prefix sum of `counts`, `base` is the slot's first face in the arena, so the
 *  absolute destination of a face is `base + starts[key] + rank` — the same expression the emit kernel evaluates. */
function scanSlot(counts: Uint32Array, base: number): SlotTable {
  const starts = new Uint32Array(KEYS);
  let running = 0;
  for (let key = 0; key < KEYS; key++) {
    starts[key] = running;
    running += counts[key];
  }
  return { counts, starts, faces: running, base };
}

/** ONE SLOT'S FACES INTO THE ARENA, in the kernels' walk order and layout. The cursor is absolute (`base +
 *  starts[key]`), which is the whole difference between one output set per chunk and one arena for a batch.
 *  (Not named `emitSlot`: that is the KERNEL-side slot decode, and the two live in the same file.) */
function writeSlot(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  padded: Uint32Array,
  table: SlotTable,
): void {
  const cursor = new Uint32Array(KEYS);
  for (let key = 0; key < KEYS; key++) cursor[key] = table.base + table.starts[key];
  for (let key = 0; key < KEYS; key++) {
    if (table.counts[key] === 0) continue;
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
            writeFace(positions, normals, uvs, cursor[key]++, lx, ly, lz, face);
          }
        }
      }
    }
  }
}

/** THE KERNELS' WALK, ON THE CPU — `census` + `scan` + `bases` + `emit` in one function, over a BATCH of chunks that
 *  share one arena, with the same padded blocks, the same face offsets, the same ascending-key slices and the same
 *  walk order inside each slice. It exists so the gate can hold the kernels' logic to `meshChunk` without a device,
 *  and it is deliberately a SEPARATE implementation from anything that reads `meshChunk`'s output: this one walks the
 *  input data.
 *
 *  **THE WALK ORDER IS `meshChunk`'s, AND IT IS NOT THE STORAGE ORDER.** `meshChunk` nests `ly` outer, `lz` middle,
 *  `lx` inner while a voxel's storage index is `lx + ly*32 + lz*1024`, so the two disagree: the kernel's flat loop
 *  counter must therefore be decoded as `lx = i % 32`, `lz = (i / 32) % 32`, `ly = i / 1024` (see `padCenter`), or a
 *  slice's faces come out in a different order than the CPU's. That is invisible to a per-look count and only shows
 *  up when the geometry is compared face by face — which is exactly what the probe and the gate do.
 *
 *  **THE ARENA IS THE POINT (M2c step 2a).** Slot `k`'s faces land at `bases[k] + starts[k][key] + rank`, where
 *  `bases` is the exclusive prefix sum of the slots' face totals — computed on the DEVICE by a fourth kernel, so the
 *  CPU never has to know how many faces a chunk produced before it can be meshed. `capacity` is the arena's size in
 *  faces and is the caller's budget (the probe and the gate pass exactly what they need; the rollout's allocator is
 *  a later step). */
export function packBatchFromPad(paddeds: readonly Uint32Array[], capacity = MAX_FACES): PackedGeometry[] {
  const tables: SlotTable[] = [];
  let total = 0;
  for (const padded of paddeds) {
    const table = scanSlot(countFacesByPad(padded), total);
    total += table.faces;
    tables.push(table);
  }
  if (total > capacity) throw new Error(`GPU mesher: ${total} faces exceed the ${capacity}-face arena`);
  const vertices = total * VERTS_PER_FACE;
  const positions = new Float32Array(vertices * DRAWN_STRIDE);
  const normals = new Float32Array(vertices * DRAWN_STRIDE);
  const uvs = new Float32Array(vertices * 2);
  const out: PackedGeometry[] = [];
  for (let slot = 0; slot < paddeds.length; slot++) {
    const table = tables[slot];
    writeSlot(positions, normals, uvs, paddeds[slot], table);
    const slots: MeshSlot[] = [];
    for (let key = 0; key < KEYS; key++) {
      // `start` is RELATIVE TO THIS SLOT (which is what `geometry.addGroup` wants for the slot's own geometry, and
      // what `compareGeometry` indexes the slot's slice with); `base` is the arena offset, and the two are added
      // together only when the whole arena is drawn as one geometry.
      if (table.counts[key] > 0) slots.push({ key, start: table.starts[key], count: table.counts[key] });
    }
    // THE SLOT SEES ITS OWN SLICE, starting at its own face 0 — that is what makes it comparable to `meshChunk` and
    // drawable on its own — while `base` carries where it really is in the shared buffer.
    const from = table.base * VERTS_PER_FACE * DRAWN_STRIDE;
    const to = (table.base + table.faces) * VERTS_PER_FACE * DRAWN_STRIDE;
    out.push({
      faces: table.faces,
      base: table.base,
      slots,
      positions: positions.subarray(from, to),
      normals: normals.subarray(from, to),
      uvs: uvs.subarray(table.base * VERTS_PER_FACE * 2, (table.base + table.faces) * VERTS_PER_FACE * 2),
      counts: table.counts,
      starts: table.starts,
    });
  }
  return out;
}

/** ONE chunk, `base === 0` (the shape everything before M2c step 2a used). A thin wrapper: the batch packer with a
 *  single slot, so the two can never disagree about the walk or the layout. */
export function packFromPad(padded: Uint32Array, capacity = MAX_FACES): PackedGeometry {
  return packBatchFromPad([padded], capacity)[0];
}

/** The walk ordinal of a voxel, in `meshChunk`'s nest order: `ly` outer, `lz` middle, `lx` inner. Returns the flat
 *  ordinal a kernel's `Loop` counter carries. */
export function walkOrdinal(lx: number, ly: number, lz: number): number {
  return lx + lz * CHUNK_SIZE + ly * CHUNK_SIZE * CHUNK_SIZE;
}

/** One face into the typed arrays, in the SAME DRAWN LAYOUT the kernel writes: `VERTS_PER_FACE` vertices in the
 *  two-triangle corner order, `DRAWN_STRIDE` floats each, with `meshChunk`'s corner table and UVs. The face index is
 *  GIVEN: the slice hands them out in walk order. */
function writeFace(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  faceIndex: number,
  lx: number,
  ly: number,
  lz: number,
  face: MesherFace,
): void {
  for (let v = 0; v < VERTS_PER_FACE; v++) {
    const corner = face.corners[FACE_CORNERS[v]];
    const at = (faceIndex * VERTS_PER_FACE + v) * DRAWN_STRIDE;
    positions[at] = lx + corner[0];
    positions[at + 1] = ly + corner[1];
    positions[at + 2] = lz + corner[2];
    positions[at + 3] = 1;
    for (let axis = 0; axis < 3; axis++) normals[at + axis] = MESHER_NORMALS[face.index][axis];
    normals[at + 3] = 0;
    const u = (faceIndex * VERTS_PER_FACE + v) * 2;
    uvs[u] = face.uvs[FACE_CORNERS[v]][0];
    uvs[u + 1] = face.uvs[FACE_CORNERS[v]][1];
  }
}

/** The face normals, straight from the shared table (the CPU twin writes them, and the kernel emits the same
 *  literals). */
const MESHER_NORMALS: readonly (readonly [number, number, number])[] = FACES.map((face) => face.normal);

/** VERTICES PER FACE IN THE DRAWN LAYOUT — SIX, i.e. the geometry is NOT indexed, and that is a WebGPU usage rule
 *  rather than a preference. **A buffer's usages are fixed when it is first created, and whichever binding asks first
 *  wins.** A `StorageBufferAttribute` used as an INDEX buffer is first bound by the COMPUTE kernel — which creates it
 *  with `STORAGE | VERTEX | COPY_SRC | COPY_DST` and NO `INDEX` (`WebGPUBackend.createStorageAttribute`) — and the
 *  draw then fails validation for ever after: `Buffer usage (CopySrc|CopyDst|Vertex|Storage) doesn't include
 *  BufferUsage::Index`, once per frame, with the render pass's whole command buffer invalid. That is exactly what a
 *  live run showed: 2665 repetitions in `renderer.log` and a world that stopped drawing. `createIndexAttribute` DOES
 *  add `STORAGE` to `INDEX` when a storage attribute gets there first, so an indexed layout is possible — with a
 *  priming draw before the first dispatch — but the non-indexed form cannot hit the trap at all, and a chunk mesh
 *  loses nothing by repeating a face's four corners into two triangles (voxel meshes share no vertices across faces
 *  anyway; the cost is 6 vertices per face instead of 4). */
export const VERTS_PER_FACE = 6;
/** The two-triangle corner order of one face: corners 0,1,2 then 0,2,3. Exported because the `M` probe reads the CPU
 *  mesher's INDEXED vertices through it to compare against these drawn ones. */
export const FACE_CORNERS: readonly number[] = [0, 1, 2, 0, 2, 3];

/** FLOATS PER VERTEX IN THE DRAWN LAYOUT — FOUR, not three, and that is not padding for its own sake.
 *  `WebGPUAttributeUtils.createAttribute` pads a STORAGE attribute with `itemSize === 3` to `vec4` ("WGSL does not
 *  support packed vec3 data in storage buffers"), and it does so by REPLACING the attribute's array with a padded
 *  copy before the GPU buffer is created. A kernel that wrote a packed `vec3` layout would then be writing into a
 *  vec4 buffer, and the drawn vertex layout would read four floats per vertex — so the mesher writes the padded
 *  layout itself (`w = 1` for positions, `w = 0` for normals) and the two cannot disagree. The comparison against
 *  `meshChunk` reads it with this stride; the CPU mesher's own arrays stay packed at three. */
export const DRAWN_STRIDE = 4;

/** WHERE THE KERNELS WRITE, and why it is injectable (M2c). The first version owned its buffers, which was enough for a
 *  probe that only compared them; the DRAWING side needs the geometry to live exactly where three will bind it, and
 *  three gives a compute-written buffer the usages a VERTEX buffer needs (`createStorageAttribute` = `STORAGE |
 *  VERTEX`) — so the same buffer the kernels fill can be drawn from, with nothing coming back to the CPU.
 *  `capacity` is baked into the kernels (a storage array's length is compile-time), so one output set = one kernel
 *  build; the production rollout will want ONE set shared by a whole rung with a per-chunk base offset, which is
 *  what this parameter exists to make possible. */
export interface MesherOutput {
  readonly capacity: number;
  readonly position: StorageBufferAttribute;
  readonly normal: StorageBufferAttribute;
  readonly uv: StorageBufferAttribute;
}

/** A fresh output set: zero-initialised (a WebGPU buffer is, by definition), which the draw path relies on — an
 *  unwritten vertex reads as the origin, i.e. a degenerate triangle, so a region that is only partly used cannot be
 *  seen. */
export function createMesherOutput(capacity: number = MAX_FACES): MesherOutput {
  const vertices = capacity * VERTS_PER_FACE;
  return {
    capacity,
    position: new StorageBufferAttribute(new Float32Array(vertices * DRAWN_STRIDE), DRAWN_STRIDE),
    normal: new StorageBufferAttribute(new Float32Array(vertices * DRAWN_STRIDE), DRAWN_STRIDE),
    uv: new StorageBufferAttribute(new Float32Array(vertices * 2), 2),
  };
}

/** The GPU mesher: a batch of padded blocks in, one ARENA of packed geometry out. With the default output the
 *  geometry never leaves the device except when `run` reads it back for the probe's comparison; with an injected one
 *  it lands in buffers the caller owns, which is how the drawing side consumes it. */
export class GpuChunkMesher {
  private readonly renderer: WebGPURenderer;
  /** How many chunks one run meshes into the arena — baked into all four kernels (see `MESHER_SLOTS`). */
  private readonly slots: number;
  private readonly paddedAttr: StorageBufferAttribute;
  private readonly countAttr: StorageBufferAttribute;
  private readonly startAttr: StorageBufferAttribute;
  /** One total per slot, and the exclusive prefix sum of them PLUS the grand total in the last cell (`slots + 1`) —
   *  which is why the base buffer is one longer than the others. */
  private readonly totalAttr: StorageBufferAttribute;
  private readonly baseAttr: StorageBufferAttribute;
  private readonly output: MesherOutput;
  private readonly census: { count: number };
  private readonly scan: { count: number };
  private readonly bases: { count: number };
  private readonly emit: { count: number };

  constructor(renderer: WebGPURenderer, output: MesherOutput = createMesherOutput(), slots = MESHER_SLOTS) {
    this.renderer = renderer;
    this.output = output;
    this.slots = slots;
    this.paddedAttr = new StorageBufferAttribute(new Uint32Array(slots * PAD_CELLS), 1);
    this.countAttr = new StorageBufferAttribute(new Uint32Array(slots * KEYS), 1);
    this.startAttr = new StorageBufferAttribute(new Uint32Array(slots * KEYS), 1);
    this.totalAttr = new StorageBufferAttribute(new Uint32Array(slots), 1);
    this.baseAttr = new StorageBufferAttribute(new Uint32Array(slots + 1), 1);
    // The kernels are built ONCE per (output set, slot count): a per-call build would compile a pipeline per chunk,
    // and both the capacity and the slot count are baked into the storage array lengths anyway.
    this.census = buildCensusKernel(this.paddedAttr, this.countAttr, slots);
    this.scan = buildScanKernel(this.countAttr, this.startAttr, this.totalAttr, slots);
    this.bases = buildBaseKernel(this.totalAttr, this.baseAttr, slots);
    this.emit = buildEmitKernel(this.paddedAttr, this.countAttr, this.startAttr, this.baseAttr, output, slots);
  }

  /** The buffers the geometry went into — the drawing side binds them (a `BufferGeometry` whose attributes ARE these
   *  is drawn straight out of the compute output). */
  get mesherOutput(): MesherOutput {
    return this.output;
  }

  /** Mesh up to `slots` chunks into ONE arena and read the result back (the probe's half; the drawing side will not
   *  read it — it draws the arena with the bases and the tables the kernels wrote). ONE `PackedGeometry` per input,
   *  each seeing its OWN slice of the arena plus the `base` it really starts at. */
  async run(inputs: readonly ChunkMeshInput[]): Promise<PackedGeometry[]> {
    if (inputs.length > this.slots) {
      throw new Error(`GPU mesher: ${inputs.length} chunk(s) do not fit a ${this.slots}-slot arena`);
    }
    const pads = this.paddedAttr.array as Uint32Array;
    for (let i = 0; i < inputs.length; i++) pads.set(buildPaddedVoxels(inputs[i]), i * PAD_CELLS);
    // AN UNUSED SLOT MUST BE ZEROED, not left over from the previous batch: AIR is 0 and the census skips it, so a
    // stale pad would silently emit a chunk that is no longer in the batch.
    pads.fill(0, inputs.length * PAD_CELLS);
    this.paddedAttr.needsUpdate = true;
    for (const attr of [this.countAttr, this.startAttr, this.totalAttr, this.baseAttr]) {
      (attr.array as Uint32Array).fill(0);
      attr.needsUpdate = true;
    }
    await this.renderer.computeAsync(this.census as never);
    await this.renderer.computeAsync(this.scan as never);
    await this.renderer.computeAsync(this.bases as never);
    await this.renderer.computeAsync(this.emit as never);
    const countsAll = new Uint32Array(await this.renderer.getArrayBufferAsync(this.countAttr));
    const startsAll = new Uint32Array(await this.renderer.getArrayBufferAsync(this.startAttr));
    const bases = new Uint32Array(await this.renderer.getArrayBufferAsync(this.baseAttr));
    const total = bases[this.slots];
    if (total > this.output.capacity) {
      throw new Error(`GPU mesher: the kernels reported ${total} faces, past the ${this.output.capacity}-face arena`);
    }
    const read = async (attr: StorageBufferAttribute, elements: number): Promise<ArrayBuffer> =>
      this.renderer.getArrayBufferAsync(attr, null, 0, elements * 4);
    const vertices = total * VERTS_PER_FACE;
    const arenaPositions =
      total === 0 ? new Float32Array(0) : new Float32Array(await read(this.output.position, vertices * DRAWN_STRIDE));
    const arenaNormals =
      total === 0 ? new Float32Array(0) : new Float32Array(await read(this.output.normal, vertices * DRAWN_STRIDE));
    const arenaUvs = total === 0 ? new Float32Array(0) : new Float32Array(await read(this.output.uv, vertices * 2));
    const out: PackedGeometry[] = [];
    for (let slot = 0; slot < inputs.length; slot++) {
      const counts = countsAll.subarray(slot * KEYS, (slot + 1) * KEYS);
      const starts = startsAll.subarray(slot * KEYS, (slot + 1) * KEYS);
      const base = bases[slot];
      const faces = bases[slot + 1] - base;
      const slots: MeshSlot[] = [];
      // The slice's `start` is what `geometry.addGroup` wants for THIS slot's own geometry, so it is rebased to the
      // slot; `base` is the arena offset the drawing side adds when it draws the whole arena instead.
      for (let key = 0; key < KEYS; key++) {
        if (counts[key] > 0) slots.push({ key, start: starts[key], count: counts[key] });
      }
      const from = base * VERTS_PER_FACE * DRAWN_STRIDE;
      const to = (base + faces) * VERTS_PER_FACE * DRAWN_STRIDE;
      out.push({
        faces,
        base,
        slots,
        positions: arenaPositions.subarray(from, to),
        normals: arenaNormals.subarray(from, to),
        uvs: arenaUvs.subarray(base * VERTS_PER_FACE * 2, (base + faces) * VERTS_PER_FACE * 2),
        counts,
        starts,
      });
    }
    return out;
  }
}

/** 1. COUNT: one thread per (slot, voxel), all six faces, `atomicAdd` per emitted face. The atomics are STATEMENTS,
 *  which is all a census needs — and `.toAtomic()` is load-bearing: `storage(attr, "uint", n)` declares
 *  `ptr<storage, u32, read_write>`, WGSL has no `atomicAdd` for that, the pipeline then fails to compile and the
 *  dispatch silently writes nothing (the round M0/M1a lost to exactly this).
 *
 *  THE SLOT COMES OUT OF THE THREAD ID, and that is the arena's whole mechanism: `i / CHUNK_VOLUME` is the slot and
 *  `i % CHUNK_VOLUME` the walk ordinal, so a whole batch is meshed by ONE dispatch with nothing to re-upload between
 *  chunks (see `censusPad`/`censusKey`). A per-chunk uniform would have to be re-sent between dispatches inside one
 *  frame, which is exactly the kind of state a node graph gives no promise about. */
function buildCensusKernel(
  padded: StorageBufferAttribute,
  countAttr: StorageBufferAttribute,
  slots: number,
): { count: number } {
  const pad = storage(padded, "uint", slots * PAD_CELLS);
  const counts = storage(countAttr, "uint", slots * KEYS).toAtomic();
  return Fn(() => {
    const center = n(add(censusPad(instanceIndex), padCenter(censusOrdinal(instanceIndex))));
    const key = censusKey(instanceIndex);
    const value = pad.element(n(center));
    If(notEqual(value, uint(AIR)), () => {
      for (const face of MESHER_FACES) {
        const neighbour = pad.element(n(add(n(center), uint(face.step))));
        If(equal(neighbour, uint(0)), () => {
          atomicAdd(counts.element(n(add(key, add(mul(value, uint(4)), uint(face.kind))))), uint(1));
        });
      }
    });
  })().compute(slots * CHUNK_VOLUME) as unknown as { count: number };
}

/** 2. SCAN: ONE THREAD PER SLOT, 1024 iterations, the exclusive prefix sum of that slot's counts into its `starts`.
 *  Sequential by construction, so it is deterministic; 1024 iterations per thread is nothing next to the work after
 *  it, and the slot dimension costs `slots` threads instead of one. The per-slot TOTAL it leaves behind is what the
 *  next kernel turns into an arena offset.
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
  slots: number,
): { count: number } {
  // The counts are read as a PLAIN value here (a different shader, so the buffer is bound twice in two passes):
  // an atomic binding cannot be read as a value in WGSL, and `atomicLoad` is a statement in TSL.
  const counts = storage(countAttr, "uint", slots * KEYS);
  const starts = storage(startAttr, "uint", slots * KEYS);
  const totals = storage(totalAttr, "uint", slots);
  return Fn(() => {
    const slot = instanceIndex;
    const at = scanKey(instanceIndex);
    const running = Var(uint(0));
    Loop(KEYS, ({ i }) => {
      const key = n(i).toUint();
      starts.element(n(add(at, key))).assign(n(running));
      running.assign(n(add(n(running), counts.element(n(add(at, key))))));
    });
    totals.element(slot).assign(n(running));
  })().compute(slots) as unknown as { count: number };
}

/** 3. BASES: ONE thread over the slots — the exclusive prefix sum of the per-slot totals, i.e. where each slot begins
 *  in the ARENA, with the grand total in the last cell of the buffer. THIS IS THE KERNEL THAT MAKES THE ARENA WORK:
 *  the CPU does not know how many faces a chunk will produce, and with this pass it does not have to — the offsets
 *  are decided on the device, per batch, with no round trip to ask.
 *
 *  The same `Var` rule as the scan, for the same reason (this would be the third place the same bug was available). */
function buildBaseKernel(
  totalAttr: StorageBufferAttribute,
  baseAttr: StorageBufferAttribute,
  slots: number,
): { count: number } {
  const totals = storage(totalAttr, "uint", slots);
  const bases = storage(baseAttr, "uint", slots + 1);
  return Fn(() => {
    const running = Var(uint(0));
    Loop(slots, ({ i }) => {
      const slot = n(i).toUint();
      bases.element(slot).assign(n(running));
      running.assign(n(add(n(running), totals.element(slot))));
    });
    bases.element(uint(slots)).assign(n(running));
  })().compute(1) as unknown as { count: number };
}

/** 4. EMIT: ONE THREAD PER (slot, key). Each thread walks ITS chunk in `meshChunk`'s order and appends the faces of
 *  ITS key with a counter of its own — no atomics, no fetch-add (which TSL cannot give, see the header), and the
 *  slice comes out in walk order. The first guard is the one that makes it cheap: a key with no faces returns at
 *  once.
 *
 *  TWO `Var`s AND THEIR ORDER ARE THE POINT: the rank inside the slice and the destination being written are mutable
 *  LOCALS (WGSL `var`), the destination is SNAPSHOT BEFORE the rank is incremented, and the writes read the
 *  snapshot. Keeping either of them in a storage cell (the first version kept the rank in a `cursor` buffer and
 *  derived the destination from it) is what shifted every face by one: the destination was re-derived after the
 *  increment, so nothing landed where the slice table said it would.
 *
 *  AND THE DESTINATION IS ARENA-ABSOLUTE — `bases[slot] + starts[slot][key] + rank` — which is the whole difference
 *  between one output set per chunk and one arena for a batch. `bases` is read from the buffer the previous kernel
 *  wrote, so the emit pass never has to be told where its chunk goes. */
function buildEmitKernel(
  padded: StorageBufferAttribute,
  countAttr: StorageBufferAttribute,
  startAttr: StorageBufferAttribute,
  baseAttr: StorageBufferAttribute,
  out: MesherOutput,
  slots: number,
): { count: number } {
  const pad = storage(padded, "uint", slots * PAD_CELLS);
  const counts = storage(countAttr, "uint", slots * KEYS);
  const starts = storage(startAttr, "uint", slots * KEYS);
  const bases = storage(baseAttr, "uint", slots + 1);
  // `VERTS_PER_FACE` vertices per face, not four: the storage array's LENGTH is what TSL types the accessor from, and
  // it has to agree with the attribute three binds and pads (a length left at the old indexed size is exactly the kind
  // of quiet disagreement this whole file is written against).
  const positions = storage(out.position, "float", out.capacity * VERTS_PER_FACE * DRAWN_STRIDE);
  const normals = storage(out.normal, "float", out.capacity * VERTS_PER_FACE * DRAWN_STRIDE);
  const uvs = storage(out.uv, "float", out.capacity * VERTS_PER_FACE * 2);
  return Fn(() => {
    const slot = emitSlot(instanceIndex);
    const key = emitKey(instanceIndex);
    const at = emitKeyBase(instanceIndex);
    const value = n(div(key, uint(4)));
    const kind = n(mod(key, uint(4)));
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
      If(notEqual(counts.element(at), uint(0)), () => {
        // ONE FLAT LOOP, and its counter IS the walk ordinal: `meshChunk` nests `ly` outer, `lz` middle, `lx` inner,
        // so the ordinal decodes the other way round from the storage index (see `packBatchFromPad`). (A nested `Loop`
        // cannot be used here: three names every counter `i` by default, so the inner one shadows the outer and the
        // walk visits only a diagonal — M0 lost a round to that.)
        Loop(CHUNK_VOLUME, ({ i }) => {
          const ordinal = n(i).toUint();
          walkX.assign(n(mod(n(ordinal), uint(CHUNK_SIZE))));
          walkZ.assign(n(mod(n(div(n(ordinal), uint(CHUNK_SIZE))), uint(CHUNK_SIZE))));
          walkY.assign(n(div(n(ordinal), uint(CHUNK_SIZE * CHUNK_SIZE))));
          center.assign(n(add(emitPad(instanceIndex), padCenter(n(ordinal)))));
          If(equal(pad.element(n(center)), value), () => {
            for (const face of MESHER_FACES) {
              If(equal(uint(face.kind), kind), () => {
                If(equal(pad.element(n(add(n(center), uint(face.step)))), uint(0)), () => {
                  // Snapshot, THEN advance: the writes below must use the position this face owns.
                  destination.assign(n(add(add(bases.element(slot), starts.element(at)), n(rank))));
                  rank.assign(n(add(n(rank), uint(1))));
                  writeFaceNodes(positions, normals, uvs, n(destination), n(walkX), n(walkY), n(walkZ), face);
                });
              });
            }
          });
        });
      });
    });
  })().compute(slots * KEYS) as unknown as { count: number };
}

/** HOW A BATCH IS ADDRESSED — in ONE place, PER DISPATCH SHAPE, so the kernels cannot mix the two strides up.
 *
 *  THERE ARE TWO THREAD LAYOUTS AND THEY DO NOT SHARE A STRIDE, which is exactly the mistake this comment exists to
 *  prevent: `census` is dispatched over `slots * CHUNK_VOLUME` (one thread per VOXEL) while `scan` and `emit` are
 *  dispatched over `slots` and `slots * KEYS` (one thread per SLOT and per (slot, key)). A slot is therefore
 *  `i / CHUNK_VOLUME` in one and `i / KEYS` in the other, and the FIRST LIVE RUN OF THE ARENA MIXED THEM: the census
 *  took its walk ordinal from `i % CHUNK_VOLUME` and its pad base from `(i / KEYS) * PAD_CELLS`, so most threads
 *  addressed memory past the batch (out of range reads answer 0, i.e. AIR), the counts came out a fraction of the
 *  truth (`uniform-solid` reported 1152 faces against the CPU's 6144, `one-block` reported NONE at all) and the
 *  slice table was still SELF-CONSISTENT — `slice table ok`, `keys 3` — so nothing but a face-by-face comparison
 *  could see it. Hence the naming: the `census*` helpers and the `emit*` helpers never appear in the same kernel,
 *  and the two strides are each written down exactly once. */
function censusSlot(thread: U32Node): U32Node {
  return n(div(thread, uint(CHUNK_VOLUME)));
}
/** The walk ordinal of the thread's voxel, INSIDE ITS OWN chunk. */
function censusOrdinal(thread: U32Node): U32Node {
  return n(mod(thread, uint(CHUNK_VOLUME)));
}
/** The slot's base in the padded blocks. */
function censusPad(thread: U32Node): U32Node {
  return n(mul(censusSlot(thread), uint(PAD_CELLS)));
}
/** The slot's base in the per-slot key tables (`counts`/`starts`). */
function censusKey(thread: U32Node): U32Node {
  return n(mul(censusSlot(thread), uint(KEYS)));
}
/** The slot's base in the per-slot key tables, for the SCAN dispatch — `slots` threads, so the slot IS the thread and
 *  there is no stride to get wrong. Written out for the same reason the other two are: a kernel asks for the family it
 *  belongs to, and `censusKey`/`emitKeyBase` in a `slots`-thread dispatch would both be silently wrong. */
function scanKey(thread: U32Node): U32Node {
  return n(mul(thread, uint(KEYS)));
}
/** Which chunk of the batch the thread belongs to, for the emit dispatch (`slots * KEYS` threads). */
function emitSlot(thread: U32Node): U32Node {
  return n(div(thread, uint(KEYS)));
}
/** The thread's key INSIDE ITS OWN slot. */
function emitKey(thread: U32Node): U32Node {
  return n(mod(thread, uint(KEYS)));
}
/** The slot's base in the per-slot key tables. */
function emitKeyBase(thread: U32Node): U32Node {
  return n(mul(emitSlot(thread), uint(KEYS)));
}
/** The slot's base in the padded blocks. */
function emitPad(thread: U32Node): U32Node {
  return n(mul(emitSlot(thread), uint(PAD_CELLS)));
}

/** The padded address of a CENTER voxel INSIDE ONE CHUNK, from the flat WALK ordinal (`meshChunk`'s nest order: `ly`
 *  outer, `lz` middle, `lx` inner — see `packBatchFromPad`). Shared by the kernels, so they cannot disagree about the
 *  numbering; the slot's own base is added by the caller (`censusPad`/`emitPad`). Every step is erased with `n()` (see
 *  `writeFaceNodes`): `div(any, uint)` resolves to a FLOAT overload by inference, and feeding that float into `mod`
 *  fails to typecheck even though the emitted WGSL is u32 math. */
function padCenter(ordinal: U32Node): U32Node {
  const lx = n(mod(n(ordinal), uint(CHUNK_SIZE)));
  const lz = n(mod(n(div(n(ordinal), uint(CHUNK_SIZE))), uint(CHUNK_SIZE)));
  const ly = n(div(n(ordinal), uint(CHUNK_SIZE * CHUNK_SIZE)));
  return n(
    add(add(add(lx, uint(1)), mul(add(ly, uint(1)), uint(PAD_W))), mul(add(lz, uint(1)), uint(PAD_W * PAD_W))),
  );
}

/** One face into the output buffers, as TSL: `VERTS_PER_FACE` vertices in the two-triangle corner order, the same
 *  corners, normals and UVs as `writeFace`, with every constant taken from the shared tables (`MESHER_FACES`,
 *  `MESHER_NORMALS`). Every node goes through `n()`, the codebase's type eraser, for the reason `lod-gpu-field.ts`
 *  documents: TSL's typings are precise per overload and a port that mixes u32 indices with f32 positions would
 *  otherwise be steered into the wrong overload (uvec4) by inference alone. */
function writeFaceNodes(
  positions: unknown,
  normals: unknown,
  uvs: unknown,
  faceIndex: U32Node,
  lx: U32Node,
  ly: U32Node,
  lz: U32Node,
  face: MesherFace,
): void {
  const slot = (buffer: unknown, index: unknown): { assign(value: unknown): void } =>
    (buffer as { element(i: unknown): { assign(value: unknown): void } }).element(index);
  for (let v = 0; v < VERTS_PER_FACE; v++) {
    const corner = face.corners[FACE_CORNERS[v]];
    // The vertex's base in the DRAWN layout (DRAWN_STRIDE floats each: xyz + a w).
    const base = n(mul(n(add(n(mul(faceIndex, uint(VERTS_PER_FACE))), uint(v))), uint(DRAWN_STRIDE)));
    const axisValues = [lx, ly, lz];
    for (let axis = 0; axis < 3; axis++) {
      slot(positions, n(add(base, uint(axis)))).assign(n(float(n(add(axisValues[axis], n(float(corner[axis])))))));
      slot(normals, n(add(base, uint(axis)))).assign(n(float(MESHER_NORMALS[face.index][axis])));
    }
    // The unused fourth component: 1 for a position (a plain `vec4` transform expects it) and 0 for a normal.
    slot(positions, n(add(base, uint(3)))).assign(n(float(1)));
    slot(normals, n(add(base, uint(3)))).assign(n(float(0)));
    const u = n(add(n(mul(n(add(n(mul(faceIndex, uint(VERTS_PER_FACE))), uint(v))), uint(2))), uint(0)));
    slot(uvs, u).assign(n(float(face.uvs[FACE_CORNERS[v]][0])));
    slot(uvs, n(add(u, uint(1)))).assign(n(float(face.uvs[FACE_CORNERS[v]][1])));
  }
}
