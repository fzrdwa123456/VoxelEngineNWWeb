// ===== THE GPU-DRIVEN DRAW (the Nanite route, step 2): geometry compacted on the device, drawn by an indirect call
// =====
// WHAT IS DIFFERENT FROM EVERY DRAW THIS ENGINE HAS DONE. Until now the CPU decided which chunks were drawn and
// `BatchedMesh` kept a per-instance list on this thread to do it. Here the CPU hands over three things and then
// stops: WHERE the clusters are (`lod-gpu-cull.ts`'s visibility pass and prefix sums), WHICH of them survived (its
// compacted list) and HOW MANY VERTICES the result has (its indirect buffer). This file turns the first two into
// the third: it COPIES the surviving clusters' vertices out of the arena into a dense draw buffer.
//
// ===== WHY A COPY, WHEN INSTANCING WOULD AVOID IT =====
// The alternative is one instance per cluster with a custom vertex shader that re-indexes the arena from the
// instance id. It avoids the copy, and it costs three things this engine cannot pay for cheaply:
//   * a hand-written node material (the position must be fetched out of a storage buffer, and the per-instance
//     transform applied in the shader);
//   * a FIXED vertex count per instance, because one draw has one `vertexCount` — clusters have different face
//     counts, so every instance would run to the largest one and collapse the leftovers into degenerate triangles,
//     burning vertex work proportional to the WORST cluster instead of the average one;
//   * the placement work the compaction bakes in for free.
// The copy is bounded by WHAT IS VISIBLE rather than by what exists (a culled cluster copies nothing), it is a pure
// memcpy on the GPU, and it makes the draw an ORDINARY `Mesh` with ordinary materials. For voxel chunks, whose
// faces are uniform quads, that trade is not close.
//
// ===== WHAT IT WRITES =====
// A dense `position`/`normal`/`uv` triple in the mesher's own drawn layout (`DRAWN_STRIDE` floats per vertex, six
// vertices per face), with each cluster's CHUNK-LOCAL vertices placed by its `place` vector — `local * (step, 1,
// step) + origin` — so one buffer serves a fine chunk and a far rung alike.
import { Break, Fn, If, Loop, add, greaterThanEqual, instanceIndex, lessThan, mul, storage, uint } from "three/tsl";
import { StorageBufferAttribute, type WebGPURenderer } from "three/webgpu";
import { DRAWN_STRIDE, VERTS_PER_FACE, type MesherOutput } from "./lod-gpu-mesher";
import { n } from "./lod-gpu-field";
import type { GpuClusterCuller } from "./lod-gpu-cull";

/** The buffers a compacted draw binds. All three vertex buffers are written by the GPU and read by the draw — and
 *  the `indirect` buffer that says WHERE TO STOP belongs to the CULL (its compact pass is what computes the totals),
 *  so a draw binds `culler.clusterBuffers.indirect` rather than one of its own. That is deliberate: ONE buffer is
 *  written by the pass that knows the count and read by the draw, with nothing in between. */
export interface CompactedDraw {
  readonly position: StorageBufferAttribute;
  readonly normal: StorageBufferAttribute;
  readonly uv: StorageBufferAttribute;
  /** Faces the buffer can hold: the draw budget, not a measurement. */
  readonly faceCapacity: number;
}

/** A fresh draw buffer, zeroed (an unwritten vertex reads as the origin, i.e. a degenerate triangle, so the part of
 *  the buffer past the visible geometry cannot be seen). */
export function createCompactedDraw(faceCapacity: number): CompactedDraw {
  const vertices = faceCapacity * VERTS_PER_FACE;
  return {
    faceCapacity,
    position: new StorageBufferAttribute(new Float32Array(vertices * DRAWN_STRIDE), DRAWN_STRIDE),
    normal: new StorageBufferAttribute(new Float32Array(vertices * DRAWN_STRIDE), DRAWN_STRIDE),
    uv: new StorageBufferAttribute(new Float32Array(vertices * 2), 2),
  };
}

/** The device half: TWO kernels over the same visible list, and the split is a hard platform limit rather than a
 *  design choice — **WebGPU's `maxStorageBuffersPerShaderStage` defaults to 8**, and one kernel doing the whole copy
 *  binds ten (list, info, place, faceSlot, and the arena's and the draw's three buffers each). The first live run
 *  failed exactly there:
 *  `The number of storage buffers (10) in the Compute stage exceeds the maximum per-stage limit (8)` →
 *  `Compute pipeline creation failed` → an invalid command buffer, which takes more than itself down. The adapter
 *  advertised 16, so requesting a higher limit would have worked ON THIS MACHINE — but a default limit is what a
 *  portable engine should fit, so the copy is SPLIT instead: the POSITION pass binds six, the SHADE pass (normal +
 *  UV, neither of which the placement touches) binds seven. Two dispatches over the same list cost one extra pass
 *  over the visible clusters and nothing else. */
export class GpuGeometryCompactor {
  private readonly renderer: WebGPURenderer;
  private readonly draw: CompactedDraw;
  private readonly positions: { count: number };
  private readonly shade: { count: number };

  constructor(
    renderer: WebGPURenderer,
    culler: GpuClusterCuller,
    arena: MesherOutput,
    draw: CompactedDraw,
    clusterCapacity: number,
  ) {
    this.renderer = renderer;
    this.draw = draw;
    this.positions = buildCompactionKernel(culler, arena, draw, clusterCapacity, "position");
    this.shade = buildCompactionKernel(culler, arena, draw, clusterCapacity, "shade");
  }

  get drawBuffers(): CompactedDraw {
    return this.draw;
  }

  /** Run it. NO READBACK AND NO RESULT: the CPU does not need to know what happened — the indirect buffer the DRAW
   *  reads is written by the cull's own pass, and these two only fill the vertices. The `await`s are the renderer's
   *  dispatch submissions, not copies back to this thread. */
  async run(): Promise<void> {
    await this.renderer.computeAsync(this.positions as never);
    await this.renderer.computeAsync(this.shade as never);
  }
}

/** ONE THREAD PER CLUSTER SLOT, and the LIST decides which slots do anything: a culled cluster is not in the list,
 *  so a thread whose slot is past the visible count reads index `0` (the padding) — which is why the walk below is
 *  bounded by the cluster's OWN face count and not by a count the shader does not have.
 *
 *  THE MAPPING FROM FACE TO CLUSTER IS THE REASON THIS IS ONE THREAD PER CLUSTER rather than one per face: a face's
 *  cluster is only known on the device (`list` + `faceSlot`), while a thread that owns a cluster already knows both
 *  of its endpoints — the arena run `base .. base + faces` and the compacted run `faceSlot[cluster] ..`.
 *
 *  `Break` IS LOAD-BEARING. A `Loop` bound is a compile-time number, so the obvious shape is "iterate a fixed budget
 *  and guard every iteration" — which costs `capacity × budget` iterations for `visible faces` of real work. TSL can
 *  emit a `break` (it is a loop-context node, not a shader macro), so the loop stops at the cluster's own face count
 *  and the kernel is proportional to what is actually drawn. */
function buildCompactionKernel(
  culler: GpuClusterCuller,
  arena: MesherOutput,
  draw: CompactedDraw,
  capacity: number,
  what: "position" | "shade",
): { count: number } {
  const buffers = culler.clusterBuffers;
  const list = storage(buffers.list, "uint", capacity);
  const info = storage(buffers.info, "uint", capacity * 4);
  const faceSlots = storage(buffers.faceSlot, "uint", capacity);
  const srcPosition = storage(arena.position, "float", arena.capacity * VERTS_PER_FACE * DRAWN_STRIDE);
  const srcNormal = storage(arena.normal, "float", arena.capacity * VERTS_PER_FACE * DRAWN_STRIDE);
  const srcUv = storage(arena.uv, "float", arena.capacity * VERTS_PER_FACE * 2);
  const dstPosition = storage(draw.position, "float", draw.faceCapacity * VERTS_PER_FACE * DRAWN_STRIDE);
  const dstNormal = storage(draw.normal, "float", draw.faceCapacity * VERTS_PER_FACE * DRAWN_STRIDE);
  const dstUv = storage(draw.uv, "float", draw.faceCapacity * VERTS_PER_FACE * 2);
  // `place` is bound by the POSITION pass only: the placement moves a vertex and scales X/Z, and neither a normal nor
  // a UV depends on it. That is also what keeps each pass under the binding limit.
  const place = what === "position" ? storage(buffers.place, "float", capacity * 4) : null;
  return Fn(() => {
    const cluster = list.element(instanceIndex);
    const at = n(mul(cluster, uint(4)));
    const base = info.element(at);
    const faces = info.element(n(add(at, uint(1))));
    const faceSlot = faceSlots.element(cluster);
    // The cluster's PLACE: where its chunk-local vertices belong in the world, and the rung's step. X and Z are
    // scaled, Y is not — a far chunk's super voxel is `step` blocks wide and one block tall, which is exactly how the
    // stream scales its own meshes (`(step, 1, step)`).
    const originX = place === null ? null : place.element(at);
    const originY = place === null ? null : place.element(n(add(at, uint(1))));
    const originZ = place === null ? null : place.element(n(add(at, uint(2))));
    const step = place === null ? null : place.element(n(add(at, uint(3))));
    Loop(draw.faceCapacity, ({ i }) => {
      const face = n(i).toUint();
      // THE GUARD IS WHAT MAKES THE COPY CORRECT; THE `Break` IS ONLY A FAST EXIT. The loop bound is a compile-time
      // number (the draw budget) and every cluster stops at its OWN face count — and the first version relied on
      // `Break` alone to do that, which is what the `O` probe's report («侧面跑到别的位置»: faces from elsewhere
      // appearing inside the copy) pointed at: a `Loop` that runs the full budget reads PAST its cluster in the arena
      // and writes PAST its own region in the compacted buffer, so neighbours overwrite each other and the winner is
      // whatever ran last. With the guard, the writes are bounded by `faces` whether the `break` is emitted or not —
      // and the budget is never smaller than a cluster, so nothing is truncated either.
      If(greaterThanEqual(face, faces), () => {
        Break();
      });
      If(lessThan(face, faces), () => {
      const source = n(add(base, face));
      const destination = n(add(faceSlot, face));
      for (let v = 0; v < VERTS_PER_FACE; v++) {
        // The vertex's place in each buffer, in the DRAWN layout (`DRAWN_STRIDE` floats per vertex).
        const fromVertex = n(add(n(mul(source, uint(VERTS_PER_FACE))), uint(v)));
        const toVertex = n(add(n(mul(destination, uint(VERTS_PER_FACE))), uint(v)));
        if (what === "position") {
          const from = n(mul(fromVertex, uint(DRAWN_STRIDE)));
          const to = n(mul(toVertex, uint(DRAWN_STRIDE)));
          for (let axis = 0; axis < 3; axis++) {
            const src = n(add(from, uint(axis)));
            const dst = n(add(to, uint(axis)));
            const local = n(srcPosition.element(src));
            const scaled = axis === 1 ? local : n(mul(local, n(step)));
            const origin = n(axis === 0 ? originX : axis === 1 ? originY : originZ);
            dstPosition.element(dst).assign(n(add(scaled, origin)));
          }
          // The unused fourth component: `w = 1` for a position (a plain `vec4` transform expects it), the mesher's
          // own convention, carried through so the draw's layout is identical to its arena's.
          dstPosition.element(n(add(to, uint(3)))).assign(n(1));
        } else {
          const from = n(mul(fromVertex, uint(DRAWN_STRIDE)));
          const to = n(mul(toVertex, uint(DRAWN_STRIDE)));
          for (let axis = 0; axis < 3; axis++) {
            const src = n(add(from, uint(axis)));
            const dst = n(add(to, uint(axis)));
            // The normal is copied, NOT scaled: a far chunk's faces stay axis-aligned, and its normals are already the
            // six unit axes the mesher wrote.
            dstNormal.element(dst).assign(srcNormal.element(src));
          }
          dstNormal.element(n(add(to, uint(3)))).assign(n(0));
          const fromUv = n(mul(fromVertex, uint(2)));
          const toUv = n(mul(toVertex, uint(2)));
          for (let axis = 0; axis < 2; axis++) {
            dstUv.element(n(add(toUv, uint(axis)))).assign(srcUv.element(n(add(fromUv, uint(axis)))));
          }
        }
      }
      });
    });
  })().compute(capacity) as unknown as { count: number };
}
