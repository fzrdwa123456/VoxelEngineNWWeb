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
import { StorageBufferAttribute, type WebGPURenderer } from "three/webgpu";
import { n } from "./lod-gpu-field";

/** HOW MANY CLUSTERS ONE PASS CAN CULL — a compile-time constant because it is a storage array's length and a
 *  `Loop`/`compute` count. The far ring's ladder measures a few thousand cells; the padding's flags stay zero,
 *  which is exactly what "not visible" means, so the cost of padding is one pass over zeros. */
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
}

/** THE SIX PLANES as `(nx, ny, nz, d)`, normals INWARD — 24 floats, three's own convention. */
export type FrustumPlanes = Float32Array;

/** A zeroed cluster set sized for `capacity`. */
export function createClusterSet(capacity: number = CLUSTER_CAPACITY): {
  count: number;
  bounds: Float32Array;
  info: Uint32Array;
} {
  return { count: 0, bounds: new Float32Array(capacity * 4), info: new Uint32Array(capacity * 4) };
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
  private readonly planeAttr: StorageBufferAttribute;
  private readonly flagAttr: StorageBufferAttribute;
  private readonly slotAttr: StorageBufferAttribute;
  private readonly listAttr: StorageBufferAttribute;
  private readonly countAttr: StorageBufferAttribute;
  private readonly visibility: { count: number };
  private readonly compact: { count: number };
  private readonly gather: { count: number };

  constructor(renderer: WebGPURenderer, capacity: number = CLUSTER_CAPACITY) {
    this.renderer = renderer;
    this.capacity = capacity;
    this.boundsAttr = new StorageBufferAttribute(new Float32Array(capacity * 4), 4);
    this.infoAttr = new StorageBufferAttribute(new Uint32Array(capacity * 4), 4);
    this.planeAttr = new StorageBufferAttribute(new Float32Array(24), 4);
    this.flagAttr = new StorageBufferAttribute(new Uint32Array(capacity), 1);
    this.slotAttr = new StorageBufferAttribute(new Uint32Array(capacity), 1);
    this.listAttr = new StorageBufferAttribute(new Uint32Array(capacity), 1);
    this.countAttr = new StorageBufferAttribute(new Uint32Array(1), 1);
    // Built ONCE: the capacity is baked into all three kernels' storage lengths, the same rule the mesher follows
    // (a per-call build would compile a pipeline per frame).
    this.visibility = buildVisibilityKernel(this.planeAttr, this.boundsAttr, this.flagAttr, capacity);
    this.compact = buildCompactKernel(this.flagAttr, this.slotAttr, this.countAttr, capacity);
    this.gather = buildGatherKernel(this.flagAttr, this.slotAttr, this.listAttr, capacity);
  }

  /** The buffers a DRAW binds: `list` is the compacted visible-cluster index list, and `info`/`bounds` describe the
   *  clusters it names (an indirect draw reads its instance count from the same kind of buffer). */
  get clusterBuffers(): {
    list: StorageBufferAttribute;
    info: StorageBufferAttribute;
    bounds: StorageBufferAttribute;
  } {
    return { list: this.listAttr, info: this.infoAttr, bounds: this.boundsAttr };
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
    (this.planeAttr.array as Float32Array).set(planes.subarray(0, 24));
    this.boundsAttr.needsUpdate = true;
    this.infoAttr.needsUpdate = true;
    this.planeAttr.needsUpdate = true;
    for (const attr of [this.flagAttr, this.slotAttr, this.countAttr]) {
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
 *  unrolled form makes the plane count a compile-time fact the shader cannot disagree about. */
function buildVisibilityKernel(
  planeAttr: StorageBufferAttribute,
  boundsAttr: StorageBufferAttribute,
  flagAttr: StorageBufferAttribute,
  capacity: number,
): { count: number } {
  const planes = storage(planeAttr, "float", 24);
  const bounds = storage(boundsAttr, "float", capacity * 4);
  const flags = storage(flagAttr, "uint", capacity);
  return Fn(() => {
    const at = n(mul(instanceIndex, uint(4)));
    const cx = bounds.element(at);
    const cy = bounds.element(n(add(at, uint(1))));
    const cz = bounds.element(n(add(at, uint(2))));
    const radius = bounds.element(n(add(at, uint(3))));
    const inside = Var(uint(1));
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
    flags.element(instanceIndex).assign(n(inside));
  })().compute(capacity) as unknown as { count: number };
}

/** 2. COMPACT: ONE thread, `capacity` iterations — the exclusive prefix sum of the flags, plus the count. It is the
 *  mesher's scan kernel with `1` in place of a key's face count, and the `Var` rule is the same FIXED BUG: an
 *  accumulator kept in a STORAGE CELL is an expression TSL re-evaluates after the assignment, which once shifted a
 *  whole slice table by one key. */
function buildCompactKernel(
  flagAttr: StorageBufferAttribute,
  slotAttr: StorageBufferAttribute,
  countAttr: StorageBufferAttribute,
  capacity: number,
): { count: number } {
  const flags = storage(flagAttr, "uint", capacity);
  const slots = storage(slotAttr, "uint", capacity);
  const total = storage(countAttr, "uint", 1);
  return Fn(() => {
    const running = Var(uint(0));
    Loop(capacity, ({ i }) => {
      const cluster = n(i).toUint();
      slots.element(cluster).assign(n(running));
      running.assign(n(add(n(running), flags.element(cluster))));
    });
    total.element(uint(0)).assign(n(running));
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
