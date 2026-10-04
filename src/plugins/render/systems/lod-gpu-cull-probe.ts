// ===== THE `N` PROBE: DOES THE GPU CULL THE FAR RING THE WAY THE CPU WOULD? =====
// The first step of the Nanite route (`lod-gpu-cull.ts`) inverts who decides what is drawn, so the question this
// probe answers is not "is it fast" but "is it RIGHT" — a cull that drops a visible cluster is a hole in the world,
// and a cull that keeps everything is a regression that looks like a success. It therefore does three things in one
// run, and all three are needed:
//
//   1. builds a REAL cluster set — the actual rung ladder's cells around the player, at the same steps and the same
//      nearest-torus placement the stream uses, with a bounding sphere per cell. Nothing here is invented except
//      the sphere, which the far ring will take from its chunk extents once the geometry is in an arena;
//   2. pushes the camera's own six frustum planes through the GPU's three passes and compares the resulting list
//      against TWO CPU references: `cullClustersCpu` (the same three steps) and three's `Frustum.intersectsSphere`
//      (an independent implementation, which is what makes the comparison worth anything);
//   3. DRAWS THE SURVIVORS as wireframe boxes, additively — because "the GPU kept the boxes I can see and dropped
//      the ones behind me" is checkable by eye in one second, and a count is not.
//
// IT IS A DEBUG PROBE: it owns no component, changes no streaming state, and does nothing unless `N` is pressed.
import * as THREE from "three/webgpu";
import type { WebGPURenderer } from "three/webgpu";
import { ShowToast } from "../../../data/globals/commands";
import { CAMERA3D, RENDERER3D, SCENE3D } from "../../../data/globals/gfx";
import { KEY_EVENTS, LOCAL_PLAYER, KeyEdgeReader } from "../../../data/globals/resources";
import { CHUNK_SIZE } from "../../../data/world/chunk";
import { DEFAULT_LOD, inTierCoverage, lodLadder } from "../../../data/world/lod";
import { worldChunksX, worldChunksZ } from "../../../data/world/size";
import { nearestWrap } from "../../../data/world/world";
import { POSITION } from "../../player/components";
import { entityIndex, type SystemAccess, type World } from "../../../core/world";
import { CLUSTER_CAPACITY, GpuClusterCuller, cullClustersCpu, sphereInside, type ClusterSet, type FrustumPlanes } from "./lod-gpu-cull";

/** The probe touches the GPU and the camera (to build the planes) and adds its own boxes to the scene; it owns its
 *  own buffers. */
export const CULL_PROBE_ACCESS: SystemAccess = {
  readsExternal: ["renderer3d", "camera3d"],
  writesExternal: ["scene3d", "gpuCullBuffers"],
};

/** How many survivor boxes are drawn. The far ring's ladder is a few hundred cells and every survivor gets a box, so
 *  this is a guard against a pathological set, not a normal limit. */
const BOX_CAP = 1500;

/** Height of a far chunk's super-voxel column, in blocks: the ladder scales a chunk by `(step, 1, step)`, so its
 *  vertical extent stays 32 blocks while its footprint grows. */
const FAR_CHUNK_HEIGHT = CHUNK_SIZE;

/** RENDER lane. `N` starts the probe; everything else about it is reported, never acted on. */
export class GpuCullProbeSystem {
  private readonly keys: KeyEdgeReader;
  private readonly renderer: WebGPURenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world: World;
  private readonly log: (line: string) => void;
  private readonly playerIndex: number;
  private culler: GpuClusterCuller | null = null;
  private boxes: THREE.LineSegments | null = null;
  /** One probe at a time: a second `N` while it runs is ignored (it awaits the GPU). */
  private busy = false;

  constructor(world: World, log: (line: string) => void) {
    this.world = world;
    this.renderer = world.resource(RENDERER3D);
    this.camera = world.resource(CAMERA3D);
    this.keys = new KeyEdgeReader(world.resource(KEY_EVENTS));
    this.playerIndex = entityIndex(world.resource(LOCAL_PLAYER));
    this.log = log;
  }

  step(): void {
    let presses = 0;
    this.keys.drain((edge) => {
      if (edge.down && !edge.repeat && edge.code === "KeyN") presses++;
    });
    if (presses > 0 && !this.busy) void this.run();
  }

  /** Build the cluster set, cull it on the GPU, compare it against both CPU references, and draw the survivors. */
  private async run(): Promise<void> {
    this.busy = true;
    const started = performance.now();
    const backend = (this.renderer as { backend?: { isWebGPUBackend?: boolean } }).backend;
    if (backend?.isWebGPUBackend !== true) {
      this.log("CULLPROBE off: this backend is not WebGPU, so there is no compute queue to cull on");
      this.busy = false;
      return;
    }
    try {
      const set = this.clusterSet();
      const planes = this.frustumPlanes();
      if (set.count === 0) {
        this.log("CULLPROBE: the ladder produced no cells around the player (nothing to cull)");
      } else {
        this.culler ??= new GpuClusterCuller(this.renderer, CLUSTER_CAPACITY);
        const gpuStart = performance.now();
        const gpu = await this.culler.cull(set, planes);
        const gpuMs = performance.now() - gpuStart;
        const cpu = cullClustersCpu(set, planes);
        // THE INDEPENDENT REFERENCE: three's own sphere/frustum test, on the same planes. If `cullClustersCpu` and
        // this ever disagreed, the CPU twin would be the thing that is wrong — so both are checked.
        const frustum = this.frustumOf(planes);
        const sphere = new THREE.Sphere();
        let threeVisible = 0;
        let sphereDisagrees = 0;
        let firstSphereProblem = "";
        for (let i = 0; i < set.count; i++) {
          sphere.set(
            new THREE.Vector3(set.bounds[i * 4], set.bounds[i * 4 + 1], set.bounds[i * 4 + 2]),
            set.bounds[i * 4 + 3],
          );
          const inside = frustum.intersectsSphere(sphere);
          if (inside) threeVisible++;
          if (inside !== sphereInside(set, planes, i)) {
            sphereDisagrees++;
            if (firstSphereProblem === "") firstSphereProblem = `cluster ${i}: the CPU twin and THREE disagree`;
          }
        }
        // THE LIST ITSELF: same length, and the same cluster at every position (the order is part of the contract —
        // the scan gives survivors their slots in cluster order, on both sides).
        let listProblem = "";
        if (gpu.length > set.count) {
          // IMPOSSIBLE, AND SAID SO FIRST: a list longer than the set is the padding leaking in (the first live run
          // reported `7324` of `897`, i.e. the whole rest of the buffer — see `CLUSTER_CAPACITY`). Reporting "the GPU
          // kept more than exists" is the diagnosis; comparing elements would have buried it in a negative cull count.
          listProblem = `the GPU kept ${gpu.length} cluster(s) but the set has only ${set.count}`;
        } else if (gpu.length !== cpu.length) {
          listProblem = `the GPU kept ${gpu.length} cluster(s) and the CPU ${cpu.length}`;
        } else {
          for (let i = 0; i < gpu.length; i++) {
            if (gpu[i] !== cpu[i]) {
              listProblem = `position ${i}: gpu ${gpu[i]} vs cpu ${cpu[i]}`;
              break;
            }
          }
        }
        const bad = sphereDisagrees > 0 ? firstSphereProblem : listProblem;
        this.log(
          `CULLPROBE set: ${set.count} cluster(s) around the player, ${this.rungCount()} rung(s) of the ladder — ` +
            `${gpu.length} visible on the GPU, ${cpu.length} on the CPU, ${threeVisible} by three's Frustum`,
        );
        this.log(
          `CULLPROBE RESULT: ${bad === "" ? "OK" : `MISMATCH — ${bad}`} — the GPU's compacted list is ` +
            `${bad === "" ? "identical to the CPU's, in the same order" : "NOT the CPU's"}; ` +
            `${Math.max(0, set.count - gpu.length)} of ${set.count} cluster(s) culled, gpu ${gpuMs.toFixed(2)}ms (3 dispatches + readback)`,
        );
        this.draw(set, gpu);
        this.world.commands.send(ShowToast, {
          key:
            "剔除 GPU 探针: " +
            (bad === "" ? `与 CPU 一致 ✓ (${gpu.length}/${set.count} 可见)` : `不一致! ${bad} (见 debug.log)`),
          raw: true,
        });
      }
    } catch (err) {
      this.log(`CULLPROBE FAILED: ${String((err as Error)?.message ?? err)}`);
      this.world.commands.send(ShowToast, { key: `剔除 GPU 探针失败: ${String((err as Error)?.message ?? err)}`, raw: true });
    } finally {
      this.log(`CULLPROBE done in ${(performance.now() - started).toFixed(0)}ms`);
      this.busy = false;
    }
  }

  /** THE CLUSTER SET: the ladder in force around the player, one cluster per BUILT cell (drawn annulus AND reserve —
   *  everything that would be resident), placed at its nearest torus representation exactly as the stream places its
   *  meshes. The bounding sphere is the cell's extent: `32 * step` wide in X/Z (the mesh is scaled by `(step, 1,
   *  step)`) and one chunk tall in Y. */
  private clusterSet(): { count: number; bounds: Float32Array; info: Uint32Array } {
    const capacity = CLUSTER_CAPACITY;
    const bounds = new Float32Array(capacity * 4);
    const info = new Uint32Array(capacity * 4);
    const playerX = POSITION.x[this.playerIndex];
    const playerZ = POSITION.z[this.playerIndex];
    const playerY = POSITION.y[this.playerIndex];
    const ladder = lodLadder(DEFAULT_LOD, worldChunksX(), playerX, playerZ);
    let count = 0;
    for (let rung = 0; rung < ladder.length && count < capacity; rung++) {
      const tier = ladder[rung];
      const cell = CHUNK_SIZE * tier.step;
      const period = Math.floor(worldChunksX() / tier.step);
      const periodZ = Math.floor(worldChunksZ() / tier.step);
      const pcx = Math.floor(playerX / cell);
      const pcz = Math.floor(playerZ / cell);
      for (let dx = tier.x.lo; dx < tier.x.hi && count < capacity; dx++) {
        for (let dz = tier.z.lo; dz < tier.z.hi && count < capacity; dz++) {
          if (!inTierCoverage(tier, dx, dz)) continue;
          const nearX = nearestWrap(pcx + dx, pcx, period);
          const nearZ = nearestWrap(pcz + dz, pcz, periodZ);
          const at = count * 4;
          bounds[at] = nearX * cell + cell / 2;
          bounds[at + 1] = playerY;
          bounds[at + 2] = nearZ * cell + cell / 2;
          // The half-diagonal of the cell's box, so the sphere CONTAINS the chunk it stands for: a cull that used a
          // tighter sphere would drop chunks whose corners are still on screen.
          bounds[at + 3] = Math.hypot(cell / 2, cell / 2, FAR_CHUNK_HEIGHT / 2);
          // THE ARENA FIELDS ARE PLACEHOLDERS for this step: the far ring does not mesh into an arena yet, and the
          // cull does not read them. `look`/`lod` are real (the rung is the ladder's index).
          info[at] = 0;
          info[at + 1] = 0;
          info[at + 2] = 0;
          info[at + 3] = rung + 1;
          count++;
        }
      }
    }
    return { count, bounds, info };
  }

  private rungCount(): number {
    return lodLadder(DEFAULT_LOD, worldChunksX(), POSITION.x[this.playerIndex], POSITION.z[this.playerIndex]).length;
  }

  /** The camera's own six planes, flattened into the 24 floats the kernel reads. */
  private frustumPlanes(): FrustumPlanes {
    this.camera.updateMatrixWorld();
    return float32Of(this.frustumOf());
  }

  private frustumOf(planes?: FrustumPlanes): THREE.Frustum {
    if (planes !== undefined) {
      const frustum = new THREE.Frustum();
      for (let p = 0; p < 6; p++) {
        frustum.planes[p].set(
          new THREE.Vector3(planes[p * 4], planes[p * 4 + 1], planes[p * 4 + 2]),
          planes[p * 4 + 3],
        );
      }
      return frustum;
    }
    this.camera.updateMatrixWorld();
    const viewProjection = new THREE.Matrix4().multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    );
    return new THREE.Frustum().setFromProjectionMatrix(viewProjection);
  }

  /** THE SURVIVORS, as wireframe boxes. Purely additive: the boxes are a new object added to the scene, and the
   *  previous run's are removed and disposed first — nothing in the live world reads them. */
  private draw(set: ClusterSet, visible: Uint32Array): void {
    const shown = Math.min(visible.length, BOX_CAP);
    const positions = new Float32Array(shown * 24 * 3);
    // The twelve edges of a box, as index pairs into its eight corners, so a box is 24 vertices of a line list.
    const edges = [
      [0, 1], [1, 3], [3, 2], [2, 0],
      [4, 5], [5, 7], [7, 6], [6, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    for (let b = 0; b < shown; b++) {
      const cluster = visible[b];
      const cx = set.bounds[cluster * 4];
      const cy = set.bounds[cluster * 4 + 1];
      const cz = set.bounds[cluster * 4 + 2];
      const r = set.bounds[cluster * 4 + 3] * 0.5;
      const corners: [number, number, number][] = [];
      for (const sy of [-1, 1]) for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
        corners.push([cx + sx * r, cy + sy * r, cz + sz * r]);
      }
      for (let e = 0; e < 12; e++) {
        for (let end = 0; end < 2; end++) {
          const corner = corners[edges[e][end]];
          const at = (b * 24 + e * 2 + end) * 3;
          positions[at] = corner[0];
          positions[at + 1] = corner[1];
          positions[at + 2] = corner[2];
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: 0x4ad9ff });
    const lines = new THREE.LineSegments(geometry, material);
    lines.name = "gpu-cull-probe-boxes";
    lines.frustumCulled = false;
    this.disposeBoxes();
    this.world.resource(SCENE3D).add(lines);
    this.boxes = lines;
    this.log(
      `CULLPROBE draw: ${shown} wireframe box(es) at the cluster centres the GPU KEPT${
        visible.length > shown ? ` (of ${visible.length}; the rest are not drawn)` : ""
      } — they must all be in front of you, and turning around must empty the screen.`,
    );
  }

  private disposeBoxes(): void {
    const lines = this.boxes;
    if (lines === null) return;
    this.world.resource(SCENE3D).remove(lines);
    lines.geometry.dispose();
    const material = lines.material;
    if (Array.isArray(material)) for (const one of material) one.dispose();
    else material.dispose();
    this.boxes = null;
  }
}

/** The six planes of a frustum as the kernel's 24 floats. Exported shape is the point: the kernel and the CPU test
 *  read the SAME numbers, so a disagreement is never about which plane was meant. */
function float32Of(frustum: THREE.Frustum): FrustumPlanes {
  const out = new Float32Array(24);
  for (let p = 0; p < 6; p++) {
    const plane = frustum.planes[p];
    out[p * 4] = plane.normal.x;
    out[p * 4 + 1] = plane.normal.y;
    out[p * 4 + 2] = plane.normal.z;
    out[p * 4 + 3] = plane.constant;
  }
  return out;
}
