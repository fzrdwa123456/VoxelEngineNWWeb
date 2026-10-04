// ===== THE GPU VISIBILITY PASS (the Nanite route, step 1) =====
// WHY THIS EXISTS. Every GPU step this engine has taken so far still ended the same way: the CPU decided WHAT TO
// DRAW (which chunks, which rung, which of them are in front of the camera) and the GPU only drew it. That is the
// classic LOD shape, and it is why the main thread is the wall — the far ring is a few thousand chunks and every
// one of them costs the CPU a decision plus a `BatchedMesh` instance to maintain. A Nanite-shaped pipeline inverts
// that: geometry is a set of CLUSTERS resident on the GPU, and the GPU decides which clusters survive the frame
// and hands the draw a LIST. The CPU stops choosing anything.
//
// THIS FILE IS THE FIRST HALF: the cluster list and a three-pass visibility test that compacts it. It deliberately
// does NOT draw yet (that is the indirect-draw step) and it is ADDITIVE — nothing in the live scene reads it.
//
// ===== WHY THREE PASSES AND NOT AN ATOMIC APPEND =====
// The obvious implementation is "test the cluster, `atomicAdd` a counter, write the index at the slot it returned"
// — a fetch-add. **TSL has no fetch-add**: `atomicAdd` is built by `atomicFunc`, which wraps the node in
// `.toStack()`, so it is a STATEMENT and its value cannot appear in an expression. That is the wall the mesher's
// emit kernel hit, and it is answered the same way — by computing the position instead of asking hardware for it:
//
//   1. `visibility` — ONE THREAD PER CLUSTER: test the bounding sphere against the six frustum planes, write 0/1.
//      The only pass that does real per-cluster work.
//   2. `compact`    — ONE THREAD, `capacity` iterations: the EXCLUSIVE PREFIX SUM of those flags. `slots[i]` is
//      where cluster `i` goes IF it survives; the running total is the count. (The mesher's scan kernel with `1`
//      where a key's face count was — a prefix sum over a fixed buffer is a loop on one thread, and deterministic
//      by construction.)
//   3. `gather`     — ONE THREAD PER CLUSTER: a survivor writes its own index at `list[slots[i]]`.
//
// The list comes out in CLUSTER ORDER, which is a property worth having: the same camera gives the same list frame
// to frame, which a fetch-add order would not.
//
// ===== WHAT A CLUSTER IS HERE =====
// One contiguous run of faces in the geometry ARENA (`lod-gpu-mesher.ts`) plus what it takes to cull it: a
// world-space bounding sphere. `base`/`faces` are the arena offsets the mesher's `bases` kernel already computes,
// and `look`/`lod` are what a draw buckets by — so a cluster is not a new concept in this engine, it is the unit
// the arena already produces plus the two fields (`bounds`, `look`/`lod`) it was missing.
//
// THE PLANES COME FROM THE CPU, deliberately, for this step: the kernel has to be VERIFIABLE, so the gate and the
// probe push the identical 24 floats through three's own `Frustum`. The convention is three's (`Frustum.
// setFromProjectionMatrix` gives INWARD normals; a point is inside when `n·p + d >= 0`), so the CPU reference can
// be `intersectsSphere` itself rather than a second implementation of the same idea.
import { Fn, If, Loop, add, equal, float, instanceIndex, lessThan, mul, storage, uint, Var } from "three/tsl";
import { IndirectStorageBufferAttribute, StorageBufferAttribute, type WebGPURenderer } from "three/webgpu";
import { n } from "./lod-gpu-field";
import { VERTS_PER_FACE } from "./lod-gpu-mesher";

/** HOW MANY CLUSTERS ONE PASS CAN CULL — a compile-time constant because it is a storage array's length and a
 *  `Loop`/`compute` count. The far ring's ladder measures a few thousand cells.
 *
 *  **THE PADDING IS BOUNDED BY THE COUNT, NOT BY ITS OWN CONTENTS, AND THAT IS A FIXED BUG.** The obvious way to
 *  make the padding harmless is to zero it — but a zeroed bounding sphere is `(0, 0, 0)` with radius `0`, i.e. a
 *  perfectly visible cluster sitting at the WORLD ORIGIN, and the six plane tests say "inside" whenever the origin is
 *  in front of the camera. The first live run of `N` reported exactly that:
 *  `897 cluster(s) … 7324 visible on the GPU, 29 on the CPU`, and `7324 - 29 = 7295 = 8192 - 897` — the whole
 *  padding, admitted the moment the player looked towards the origin. It worked in every other run, which is what a
 *  bug in a boundary looks like. The kernel therefore reads the real `count` and flags anything past it invisible. */
export const CLUSTER_CAPACITY = 8192;

/** ONE CLUSTER: where its faces are in the arena (`base`, `faces`), what a draw buckets it by (`look`, `lod`) and a
 *  WORLD-space bounding sphere. Integers and floats live in two buffers — a `vec4` of floats cannot hold a face
 *  offset without a bit-cast, and the arena offset is exactly what a draw wants as an integer. */
export interface ClusterSet {
  /** How many entries are real; the rest are padding and must be zero. */
  readonly count: number;
  /** `vec4(centerX, centerY, centerZ, radius)` per cluster. */
  readonly bounds: Float32Array;
  /** `(base, faces, look, lod)` per cluster. */
  readonly info: Uint32Array;
  /** WHERE THE CLUSTER'S GEOMETRY GOES WHEN IT IS DRAWN: `vec4(offsetX, offsetY, offsetZ, step)`. The mesher writes
   *  CHUNK-LOCAL vertices (`0..32`), so a cluster is only placeable with its chunk's origin — and the far ring
   *  scales a chunk by `(step, 1, step)`, which is what the fourth component carries. This is the per-instance
   *  TRANSFORM a draw needs, and it is the third field the arena does not produce by itself. */
  readonly place: Float32Array;
}

/** THE SIX PLANES as `(nx, ny, nz, d)`, normals INWARD — 24 floats, three's own convention. */
export type FrustumPlanes = Float32Array;

/** A zeroed cluster set sized for `capacity`. `count` is what bounds the set: the kernels only ever classify the
 *  first `count` entries, and everything past it is invisible BY THE COUNT rather than by its contents (see
 *  `CLUSTER_CAPACITY` for the bug that rule comes from). */
export function createClusterSet(capacity: number = CLUSTER_CAPACITY): {
  count: number;
  bounds: Float32Array;
  info: Uint32Array;
  place: Float32Array;
} {
  return {
    count: 0,
    bounds: new Float32Array(capacity * 4),
    info: new Uint32Array(capacity * 4),
    place: new Float32Array(capacity * 4),
  };
}

/** IS ONE CLUSTER'S SPHERE INSIDE ALL SIX PLANES? Exported because the probe compares the GPU against it cluster
 *  by cluster, and "which cluster disagrees" is the only useful thing to report. */
export function sphereInside(set: ClusterSet, planes: FrustumPlanes, index: number): boolean {
  const cx = set.bounds[index * 4];
  const cy = set.bounds[index * 4 + 1];
  const cz = set.bounds[index * 4 + 2];
  const r = set.bounds[index * 4 + 3];
  for (let p = 0; p < 6; p++) {
    const distance =
      planes[p * 4] * cx + planes[p * 4 + 1] * cy + planes[p * 4 + 2] * cz + planes[p * 4 + 3];
    // A partial overlap counts as visible: a cull must never drop a sphere the frustum touches.
    if (distance < -r) return false;
  }
  return true;
}

/** THE CPU TWIN of the three passes, written as the SAME three steps (flag, prefix, gather) rather than as a
 *  filter, because the ORDER and the SLOT each survivor lands in are part of what must agree with the kernels. It
 *  exists for the same reason `packBatchFromPad` does: so the gate can hold the rules without a device. */
export function cullClustersCpu(set: ClusterSet, planes: FrustumPlanes): Uint32Array {
  const flags = new Uint8Array(set.count);
  const slots = new Uint32Array(set.count);
  let running = 0;
  for (let i = 0; i < set.count; i++) {
    flags[i] = sphereInside(set, planes, i) ? 1 : 0;
    slots[i] = running;
    running += flags[i];
  }
  const list = new Uint32Array(running);
  for (let i = 0; i < set.count; i++) if (flags[i] === 1) list[slots[i]] = i;
  return list;
}

/** The device half: upload a cluster set and six planes, run the three passes, read the visible list back. */
export class GpuClusterCuller {
  private readonly renderer: WebGPURenderer;
  private readonly capacity: number;
  private readonly boundsAttr: StorageBufferAttribute;
  private readonly infoAttr: StorageBufferAttribute;
  private readonly placeAttr: StorageBufferAttribute;
  private readonly planeAttr: StorageBufferAttribute;
  /** HOW MANY OF THE `capacity` SLOTS ARE REAL. One cell, read by the visibility kernel — see `CLUSTER_CAPACITY`
   *  for why "zero the padding" is not a substitute. */
  private readonly limitAttr: StorageBufferAttribute;
  private readonly flagAttr: StorageBufferAttribute;
  private readonly slotAttr: StorageBufferAttribute;
  private readonly listAttr: StorageBufferAttribute;
  private readonly countAttr: StorageBufferAttribute;
  /** WHERE A SURVIVOR'S FACES GO in a compacted draw buffer — the face-weighted prefix sum, i.e. the same scan
   *  weighted by `faces` instead of by 1. This is the number a GPU-driven draw needs and the reason the compaction
   *  can run without the CPU: the destination is a device-side value like every other offset in this pipeline. */
  private readonly faceSlotAttr: StorageBufferAttribute;
  /** THE INDIRECT DRAW PARAMETERS, written by the compact pass and read by the DRAW — four `u32`s
   *  (`vertexCount`, `instanceCount`, `firstVertex`, `firstInstance`), which is exactly what WebGPU's
   *  `drawIndirect` takes and what `geometry.setIndirect` binds. **This is the whole point of the step: the CPU
   *  never learns how many vertices are visible.** */
  private readonly indirectAttr: IndirectStorageBufferAttribute;
  private readonly visibility: { count: number };
  private readonly compact: { count: number };
  private readonly gather: { count: number };

  constructor(renderer: WebGPURenderer, capacity: number = CLUSTER_CAPACITY) {
    this.renderer = renderer;
    this.capacity = capacity;
    this.boundsAttr = new StorageBufferAttribute(new Float32Array(capacity * 4), 4);
    this.infoAttr = new StorageBufferAttribute(new Uint32Array(capacity * 4), 4);
    this.placeAttr = new StorageBufferAttribute(new Float32Array(capacity * 4), 4);
    this.planeAttr = new StorageBufferAttribute(new Float32Array(24), 4);
    this.limitAttr = new StorageBufferAttribute(new Uint32Array(1), 1);
    this.flagAttr = new StorageBufferAttribute(new Uint32Array(capacity), 1);
    this.slotAttr = new StorageBufferAttribute(new Uint32Array(capacity), 1);
    this.listAttr = new StorageBufferAttribute(new Uint32Array(capacity), 1);
    this.countAttr = new StorageBufferAttribute(new Uint32Array(1), 1);
    this.faceSlotAttr = new StorageBufferAttribute(new Uint32Array(capacity), 1);
    this.indirectAttr = new IndirectStorageBufferAttribute(new Uint32Array(4), 1);
    // Built ONCE: the capacity is baked into all three kernels' storage lengths, the same rule the mesher follows
    // (a per-call build would compile a pipeline per frame).
    this.visibility = buildVisibilityKernel(this.planeAttr, this.boundsAttr, this.limitAttr, this.flagAttr, capacity);
    this.compact = buildCompactKernel(this.flagAttr, this.infoAttr, this.slotAttr, this.faceSlotAttr, this.countAttr, this.indirectAttr, capacity);
    this.gather = buildGatherKernel(this.flagAttr, this.slotAttr, this.listAttr, capacity);
  }

  /** The buffers the DRAW binds: `list` names the surviving clusters in order, `info`/`place` describe them,
   *  `faceSlot` says where each cluster's faces go in a compacted buffer, and `indirect` is the draw call the
   *  device wrote for itself. NOTHING HERE COMES BACK TO THE CPU. */
  get clusterBuffers(): {
    list: StorageBufferAttribute;
    info: StorageBufferAttribute;
    bounds: StorageBufferAttribute;
    place: StorageBufferAttribute;
    faceSlot: StorageBufferAttribute;
    indirect: IndirectStorageBufferAttribute;
  } {
    return {
      list: this.listAttr,
      info: this.infoAttr,
      bounds: this.boundsAttr,
      place: this.placeAttr,
      faceSlot: this.faceSlotAttr,
      indirect: this.indirectAttr,
    };
  }

  /** Upload `set` and `planes`, cull, and read the list back. THE READBACK IS THE PROBE'S NEED, NOT THE DRAW'S: the
   *  draw consumes `clusterBuffers` and never asks the CPU — that is the whole point of the exercise. */
  async cull(set: ClusterSet, planes: FrustumPlanes): Promise<Uint32Array> {
    if (set.count > this.capacity) {
      throw new Error(`GPU cull: ${set.count} cluster(s) do not fit a ${this.capacity}-cluster pass`);
    }
    const bounds = this.boundsAttr.array as Float32Array;
    bounds.set(set.bounds.subarray(0, set.count * 4));
    bounds.fill(0, set.count * 4);
    (this.infoAttr.array as Uint32Array).set(set.info.subarray(0, set.count * 4));
    (this.placeAttr.array as Float32Array).set(set.place.subarray(0, set.count * 4));
    (this.planeAttr.array as Float32Array).set(planes.subarray(0, 24));
    (this.limitAttr.array as Uint32Array)[0] = set.count;
    this.boundsAttr.needsUpdate = true;
    this.infoAttr.needsUpdate = true;
    this.placeAttr.needsUpdate = true;
    this.planeAttr.needsUpdate = true;
    this.limitAttr.needsUpdate = true;
    for (const attr of [this.flagAttr, this.slotAttr, this.countAttr, this.faceSlotAttr, this.indirectAttr]) {
      (attr.array as Uint32Array).fill(0);
      attr.needsUpdate = true;
    }
    await this.renderer.computeAsync(this.visibility as never);
    await this.renderer.computeAsync(this.compact as never);
    await this.renderer.computeAsync(this.gather as never);
    const total = new Uint32Array(await this.renderer.getArrayBufferAsync(this.countAttr))[0];
    if (total === 0) return new Uint32Array(0);
    const raw = await this.renderer.getArrayBufferAsync(this.listAttr, null, 0, total * 4);
    return new Uint32Array(raw).subarray(0, total);
  }
}

/** 1. VISIBILITY: one thread per cluster, six plane tests, a 0/1 flag. The planes are UNROLLED in TypeScript (the
 *  loop is over six compile-time constants, like the mesher's face table): a runtime index would work, but the
 *  unrolled form makes the plane count a compile-time fact the shader cannot disagree about.
 *
 *  THE COUNT GUARD IS LOAD-BEARING, not tidiness: the dispatch covers the whole capacity, and a slot past the count
 *  holds a zeroed sphere — which is `(0, 0, 0)` with radius `0`, a VISIBLE cluster at the world origin. Leaving it
 *  out let 7295 padding slots into the list the moment the player looked towards the origin (see
 *  `CLUSTER_CAPACITY`). So `inside` starts at 0 and only a slot inside the count can become 1. */
function buildVisibilityKernel(
  planeAttr: StorageBufferAttribute,
  boundsAttr: StorageBufferAttribute,
  limitAttr: StorageBufferAttribute,
  flagAttr: StorageBufferAttribute,
  capacity: number,
): { count: number } {
  const planes = storage(planeAttr, "float", 24);
  const bounds = storage(boundsAttr, "float", capacity * 4);
  const limit = storage(limitAttr, "uint", 1);
  const flags = storage(flagAttr, "uint", capacity);
  return Fn(() => {
    const at = n(mul(instanceIndex, uint(4)));
    const cx = bounds.element(at);
    const cy = bounds.element(n(add(at, uint(1))));
    const cz = bounds.element(n(add(at, uint(2))));
    const radius = bounds.element(n(add(at, uint(3))));
    const inside = Var(uint(0));
    If(lessThan(instanceIndex, limit.element(uint(0))), () => {
      inside.assign(uint(1));
      for (let p = 0; p < 6; p++) {
        const plane = n(uint(p * 4));
        const distance = n(
          add(
            add(mul(planes.element(plane), cx), mul(planes.element(n(add(plane, uint(1)))), cy)),
            add(mul(planes.element(n(add(plane, uint(2)))), cz), planes.element(n(add(plane, uint(3))))),
          ),
        );
        If(lessThan(distance, n(mul(radius, float(-1)))), () => {
          inside.assign(uint(0));
        });
      }
    });
    flags.element(instanceIndex).assign(n(inside));
  })().compute(capacity) as unknown as { count: number };
}

/** 2. COMPACT: ONE thread, `capacity` iterations — TWO exclusive prefix sums in one pass, plus the indirect draw the
 *  device writes for itself.
 *
 *  It is the mesher's scan kernel, run twice over the same flags:
 *    * weighted by `1`, into `slots` — where a survivor's INDEX goes in the visible list (`gather` reads this), and
 *      the running total is the cluster count;
 *    * weighted by `faces`, into `faceSlot` — where a survivor's GEOMETRY goes in a compacted draw buffer. That
 *      second sum is what lets a draw be built with no CPU involvement at all: the destination of every vertex is a
 *      device-side number like every other offset in this pipeline.
 *
 *  AND THE TAIL IS THE MILESTONE: `vertexCount = faceTotal * VERTS_PER_FACE`, `instanceCount = 1`, and the two
 *  zeros, written into the INDIRECT buffer — i.e. the draw call describes itself, and the CPU never learns how much
 *  is visible. `geometry.setIndirect` binds exactly this buffer, and WebGPU's `drawIndirect` reads it.
 *
 *  The `Var` rule is the same FIXED BUG as everywhere else in this codebase: an accumulator kept in a STORAGE CELL
 *  is an expression TSL re-evaluates after the assignment, which once shifted a whole slice table by one key. */
function buildCompactKernel(
  flagAttr: StorageBufferAttribute,
  infoAttr: StorageBufferAttribute,
  slotAttr: StorageBufferAttribute,
  faceSlotAttr: StorageBufferAttribute,
  countAttr: StorageBufferAttribute,
  indirectAttr: StorageBufferAttribute,
  capacity: number,
): { count: number } {
  const flags = storage(flagAttr, "uint", capacity);
  const info = storage(infoAttr, "uint", capacity * 4);
  const slots = storage(slotAttr, "uint", capacity);
  const faceSlots = storage(faceSlotAttr, "uint", capacity);
  const total = storage(countAttr, "uint", 1);
  const indirect = storage(indirectAttr, "uint", 4);
  return Fn(() => {
    const running = Var(uint(0));
    const faces = Var(uint(0));
    Loop(capacity, ({ i }) => {
      const cluster = n(i).toUint();
      const flag = flags.element(cluster);
      // The exclusive prefixes: the slot is written BEFORE the running totals advance, or every survivor would be
      // shifted by its own contribution.
      slots.element(cluster).assign(n(running));
      faceSlots.element(cluster).assign(n(faces));
      running.assign(n(add(n(running), flag)));
      // `faces` is the cluster's face count in the arena (`info` is `(base, faces, look, lod)`), counted only when
      // the cluster survives — a culled cluster must contribute nothing to the compacted buffer's layout.
      faces.assign(n(add(n(faces), n(mul(flag, info.element(n(add(mul(cluster, uint(4)), uint(1)))))))));
    });
    total.element(uint(0)).assign(n(running));
    indirect.element(uint(0)).assign(n(mul(n(faces), uint(VERTS_PER_FACE)))); // vertexCount
    indirect.element(uint(1)).assign(uint(1)); // instanceCount: the whole compacted buffer is ONE draw
    indirect.element(uint(2)).assign(uint(0)); // firstVertex
    indirect.element(uint(3)).assign(uint(0)); // firstInstance
  })().compute(1) as unknown as { count: number };
}

/** 3. GATHER: one thread per cluster — a survivor writes its OWN index at the slot the scan gave it. Nothing has to
 *  be read back to place it, which is what makes the list compact and ordered without a fetch-add. */
function buildGatherKernel(
  flagAttr: StorageBufferAttribute,
  slotAttr: StorageBufferAttribute,
  listAttr: StorageBufferAttribute,
  capacity: number,
): { count: number } {
  const flags = storage(flagAttr, "uint", capacity);
  const slots = storage(slotAttr, "uint", capacity);
  const list = storage(listAttr, "uint", capacity);
  return Fn(() => {
    If(equal(flags.element(instanceIndex), uint(1)), () => {
      list.element(n(slots.element(instanceIndex))).assign(instanceIndex);
    });
  })().compute(capacity) as unknown as { count: number };
}
