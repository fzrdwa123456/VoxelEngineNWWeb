// ===== THE FAR RING, DRAWN AS A HANDFUL OF BATCHES (M3a) =====
// WHY. A 512-chunk lap with the full six-rung ladder puts ~1250 chunk meshes in the scene, and each of them
// draws one call PER LOOK (a far chunk shows grass on top, dirt under it and stone below: up to three). Measured
// on the user's machine: `calls` peaks at 3785 and averages ~2520 per frame, with `attrs` ~3775 — i.e. ~2 draw
// calls per mesh. The frame still holds 60 fps there, but that is a 60 Hz screen with a 60 fps cap: the calls are
// the headroom being eaten, and they are the one per-frame cost that is O(chunks drawn).
//
// WHAT THIS DOES. Every settled far chunk's geometry is cut into its LOOK SLICES (the mesher lays a slot's faces
// out contiguously, so a slice is an index range plus its own vertex range) and each slice becomes ONE INSTANCE
// in a `THREE.BatchedMesh` keyed by (look key, tier). A batch is one material and one draw call, so the whole far
// ring collapses from ~2500 calls to one per (look, tier) — ~20-40.
//
// WHY `BatchedMesh` AND NOT A MERGED BUFFER. The far ring changes CONSTANTLY (every window move adds and retires
// whole strips), and a merged buffer would mean re-uploading megabytes per move. `BatchedMesh` keeps per-instance
// metadata, so adding, hiding (`setVisibleAt`, which the reserve handover needs) and removing an instance are
// O(1) and the vertex buffer is written once per chunk.
//
// WHAT IT DELIBERATELY DOES NOT DO. There is no per-instance OPACITY, so a chunk that is fading in or out is NOT
// batched: the stream keeps it as an ordinary mesh for the length of its fade and hands it over when the fade
// ends (`promoteFar`), taking it back before a fade-out (`demoteFar`). That keeps P1.98/P1.99 exactly as they are.
//
// CAPACITY. `addGeometry`/`addInstance` THROW when a batch is full, so every bucket grows itself before it is
// asked to: vertices/indices by doubling through `setGeometrySize`, instances through `setInstanceCount` (both
// reallocate and copy, which is why this happens once per doubling rather than per chunk).
import * as THREE from "three/webgpu";
import type { ChunkFaceSpec } from "../../../data/globals/gfx";

/** Starting capacity of a bucket, in vertices / indices / instances. Small: buckets are grown on demand, and a
 *  lap's rungs differ by orders of magnitude in what they hold. */
const START_VERTICES = 4096;
const START_INDICES = 6144;
const START_INSTANCES = 32;
/** Faces a slice holds, from its index range (6 indices per face, and the mesher lays a slot out contiguously). */
const FACES_PER_INDEX = 6;

/** One (look, tier) bucket: ONE batched mesh, ONE material, and as many instances as that look has chunks. */
interface Bucket {
  readonly batch: THREE.BatchedMesh;
  readonly spec: ChunkFaceSpec;
  readonly step: number;
  material: THREE.Material;
  /** Live instances (so `setInstanceCount` can be grown before `addInstance` throws). */
  live: number;
  /** Instances ever handed out, the high-water mark the capacity is compared against. */
  allocated: number;
  /** Buffer capacity, and how much of it the slices handed to `addGeometry` have taken. Tracked here because
   *  `BatchedMesh` exposes `unusedVertexCount`/`unusedIndexCount` but not the capacities behind them, and
   *  `addGeometry` THROWS once a request exceeds the reserve. Space is only reclaimed by `optimize()`, which this
   *  class deliberately never calls (a repack of a multi-megabyte batch costs more than the space it frees); the
   *  buckets are torn down and rebuilt wholesale when the world size changes. */
  capacityVertices: number;
  capacityIndices: number;
  usedVertices: number;
  usedIndices: number;
}

/** Where one chunk's slices live: an instance per look, in that look's bucket. */
export interface FarBatchHandle {
  readonly instances: ReadonlyArray<{ readonly bucket: Bucket; readonly id: number; readonly geometryId: number }>;
}

/** A fresh batched mesh for one (look, tier), added to the chunk group (it holds no transform of its own: every
 *  instance carries its chunk's world matrix, which is what makes the torus wrap work per chunk). */
function makeBucket(spec: ChunkFaceSpec, step: number, material: THREE.Material): Bucket {
  const batch = new THREE.BatchedMesh(START_INSTANCES, START_VERTICES, START_INDICES, material);
  batch.name = `far-batch ${spec.key.slice(0, 24)}@${step}`;
  // Per-instance culling stays ON (three culls each instance against its own bounding sphere), and the object
  // itself is never culled as a whole: its box covers the entire ring, so a whole-object test would only ever
  // be false for the frame the player looks away from everything.
  batch.frustumCulled = false;
  return {
    batch,
    spec,
    step,
    material,
    live: 0,
    allocated: 0,
    capacityVertices: START_VERTICES,
    capacityIndices: START_INDICES,
    usedVertices: 0,
    usedIndices: 0,
  };
}

export class FarBatches {
  private readonly buckets = new Map<string, Bucket>();
  /** Scratch, so a window move does not allocate per chunk (see `setMatrix`). */
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();

  constructor(private readonly group: THREE.Group) {}

  /** How many buckets and live instances are in flight — reported by the FRAME line's `batches=`/`batched=`. */
  get stats(): { readonly buckets: number; readonly instances: number } {
    let instances = 0;
    for (const bucket of this.buckets.values()) instances += bucket.live;
    return { buckets: this.buckets.size, instances };
  }

  /** Put one chunk's looks into its buckets. `geometry` is the chunk's own geometry (its `groups` are the look
   *  slices, `materialIndex` the index into `specs`/`materials`). Returns null when there is nothing to batch
   *  (no groups, or a geometry that cannot be sliced). */
  add(
    step: number,
    geometry: THREE.BufferGeometry,
    specs: readonly ChunkFaceSpec[],
    materials: readonly THREE.Material[],
    place: (out: THREE.Matrix4) => void,
  ): FarBatchHandle | null {
    // A geometry that cannot be sliced is not batched: the gate drives this system with stub geometries (a plain
    // object with `groups`/`specs` and no attributes), and a chunk whose mesh is a stub is simply drawn the way it
    // always was. Same for "nothing to batch".
    if (typeof (geometry as { getAttribute?: unknown }).getAttribute !== "function") return null;
    const position = geometry.getAttribute("position");
    const index = geometry.getIndex();
    if (position === undefined || index === null || geometry.groups.length === 0) return null;
    const normal = geometry.getAttribute("normal");
    const uv = geometry.getAttribute("uv");
    const instances: Array<{ bucket: Bucket; id: number; geometryId: number }> = [];
    place(this.matrix);
    for (const group of geometry.groups) {
      const slot = group.materialIndex ?? 0;
      const spec = specs[slot];
      const material = materials[slot];
      const faces = Math.floor(group.count / FACES_PER_INDEX);
      if (spec === undefined || material === undefined || faces <= 0) continue;
      const key = `${spec.key}\u0000${step}`;
      let bucket = this.buckets.get(key);
      if (bucket === undefined) {
        bucket = makeBucket(spec, step, material);
        this.group.add(bucket.batch);
        this.buckets.set(key, bucket);
      }
      const slice = sliceLook(position, normal, uv, index, group.start, faces);
      if (slice === null) continue;
      this.growFor(bucket, slice.vertexCount, slice.indexCount);
      const geometryId = bucket.batch.addGeometry(slice.geometry);
      const id = bucket.batch.addInstance(geometryId);
      bucket.batch.setMatrixAt(id, this.matrix);
      bucket.batch.setVisibleAt(id, true);
      bucket.live++;
      bucket.allocated++;
      instances.push({ bucket, id, geometryId });
    }
    return instances.length > 0 ? { instances } : null;
  }

  setVisible(handle: FarBatchHandle, visible: boolean): void {
    for (const instance of handle.instances) instance.bucket.batch.setVisibleAt(instance.id, visible);
  }

  /** Move one chunk's instances (the same matrix for every slice: they are the same chunk). */
  setMatrix(handle: FarBatchHandle, place: (out: THREE.Matrix4) => void): void {
    place(this.matrix);
    for (const instance of handle.instances) instance.bucket.batch.setMatrixAt(instance.id, this.matrix);
  }

  /** Re-resolve every bucket's material through the stream's own look resolution (the `G`/`H` toggles and a pack
   *  reload go through here: a bucket is one material, so a tinted world is one material per (look, tier) — which
   *  is exactly what the untinted world already does). */
  refreshMaterials(lookup: (step: number, spec: ChunkFaceSpec) => THREE.Material): void {
    for (const bucket of this.buckets.values()) {
      const material = lookup(bucket.step, bucket.spec);
      if (material === bucket.material) continue;
      bucket.material = material;
      bucket.batch.material = material;
    }
  }

  /** Take one chunk's instances out again (its own mesh — which the stream kept — draws it from here on). */
  remove(handle: FarBatchHandle): void {
    for (const instance of handle.instances) {
      instance.bucket.batch.deleteInstance(instance.id);
      instance.bucket.batch.deleteGeometry(instance.geometryId);
      instance.bucket.live--;
    }
  }

  /** Free every bucket (a world-size change resets the whole window). */
  dispose(): void {
    for (const bucket of this.buckets.values()) {
      this.group.remove(bucket.batch);
      bucket.batch.dispose();
    }
    this.buckets.clear();
  }

  /** Grow a bucket until the slice fits — BEFORE `addGeometry`, which throws rather than shrinking the request. */
  private growFor(bucket: Bucket, vertexCount: number, indexCount: number): void {
    const batch = bucket.batch;
    let vertices = bucket.capacityVertices;
    let indices = bucket.capacityIndices;
    let grow = false;
    while (vertices - bucket.usedVertices < vertexCount) {
      vertices = Math.max(vertices * 2, vertices + vertexCount);
      grow = true;
    }
    while (indices - bucket.usedIndices < indexCount) {
      indices = Math.max(indices * 2, indices + indexCount);
      grow = true;
    }
    if (grow) batch.setGeometrySize(vertices, indices);
    bucket.capacityVertices = vertices;
    bucket.capacityIndices = indices;
    bucket.usedVertices += vertexCount;
    bucket.usedIndices += indexCount;
    if (bucket.allocated + 1 > batch.maxInstanceCount) {
      batch.setInstanceCount(Math.max(batch.maxInstanceCount * 2, bucket.allocated + 1));
    }
  }
}

/** One look's faces, as a self-contained geometry: its own vertex range (the mesher lays a slot's faces out
 *  contiguously, so a slot's vertices are `firstVertex .. firstVertex + faces·4`) with its indices rebased to 0.
 *  Copying is the point: `addGeometry` copies whatever it is handed into the batch's buffer, so handing it the
 *  chunk's FULL attribute arrays would store every look's vertices once per look. */
function sliceLook(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  normal: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined,
  uv: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined,
  index: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  indexStart: number,
  faces: number,
): { readonly geometry: THREE.BufferGeometry; readonly vertexCount: number; readonly indexCount: number } | null {
  const firstVertex = index.getX(indexStart) as number;
  const vertexCount = faces * 4;
  const indexCount = faces * FACES_PER_INDEX;
  const read = (
    attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined,
    itemSize: number,
  ): Float32Array | null => {
    if (attribute === undefined) return null;
    const out = new Float32Array(vertexCount * itemSize);
    for (let v = 0; v < vertexCount; v++) {
      const at = firstVertex + v;
      if (itemSize >= 3) out[v * itemSize + 2] = attribute.getZ(at) as number;
      if (itemSize >= 2) out[v * itemSize + 1] = attribute.getY(at) as number;
      out[v * itemSize] = attribute.getX(at) as number;
    }
    return out;
  };
  const positions = read(position, 3);
  if (positions === null) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const normals = read(normal, 3);
  if (normals !== null) geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  const uvs = read(uv, 2);
  if (uvs !== null) geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  const indices = new Uint32Array(indexCount);
  for (let i = 0; i < indexCount; i++) indices[i] = (index.getX(indexStart + i) as number) - firstVertex;
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return { geometry, vertexCount, indexCount };
}
