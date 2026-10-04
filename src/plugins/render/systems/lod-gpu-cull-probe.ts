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
import type { IndirectStorageBufferAttribute, StorageBufferAttribute, WebGPURenderer } from "three/webgpu";import { ShowToast } from "../../../data/globals/commands";
import { CAMERA3D, RENDERER3D, SCENE3D } from "../../../data/globals/gfx";
import { KEY_EVENTS, LOCAL_PLAYER, VOXEL, KeyEdgeReader } from "../../../data/globals/resources";
import { CHUNK_SIZE } from "../../../data/world/chunk";
import { WORLD_SURFACE_Y, nearestWrap } from "../../../data/world/world";
import { CHUNK_Y_COUNT, MIN_CHUNK_Y } from "../../../data/world/world";
import { gatherChunkMeshInput, meshChunk, type ChunkMeshInput } from "../../../data/world/mesh";
import type { Chunk } from "../../../data/world/chunk";
import { createMesherOutput, DRAWN_STRIDE, GpuChunkMesher, MESHER_SLOTS, VERTS_PER_FACE, type MesherOutput } from "./lod-gpu-mesher";
import { createCompactedDraw, GpuGeometryCompactor, type CompactedDraw } from "./lod-gpu-draw";
import { DEFAULT_LOD, inTierCoverage, lodLadder } from "../../../data/world/lod";
import { worldChunksX, worldChunksZ } from "../../../data/world/size";
import { POSITION } from "../../player/components";
import { entityIndex, type SystemAccess, type World } from "../../../core/world";
import { CLUSTER_CAPACITY, GpuClusterCuller, createClusterSet, cullClustersCpu, sphereInside, type ClusterSet, type FrustumPlanes } from "./lod-gpu-cull";

/** The probe touches the GPU and the camera (to build the planes) and adds its own boxes to the scene; it owns its
 *  own buffers. */
export const CULL_PROBE_ACCESS: SystemAccess = {
  readsExternal: ["renderer3d", "camera3d"],
  writesExternal: ["scene3d", "gpuCullBuffers"],
};

/** How many survivor boxes are drawn. The far ring's ladder is a few hundred cells and every survivor gets a box, so
 *  this is a guard against a pathological set, not a normal limit. */
const BOX_CAP = 1500;

/** The arena the draw probe meshes into, in FACES. It is also the compaction's budget: a cluster past it is
 *  truncated by the mesher's own capacity check rather than by the draw. */
const ARENA_FACES = 8192;

/** Height of a far chunk's super-voxel column, in blocks: the ladder scales a chunk by `(step, 1, step)`, so its
 *  vertical extent stays 32 blocks while its footprint grows. */
const FAR_CHUNK_HEIGHT = CHUNK_SIZE;

/** WHERE A FAR CELL'S GEOMETRY SITS VERTICALLY. The far ring's own mesh input is built around the surface, so its
 *  chunk is placed at the terrain band's base — the probe's clusters use the same level, which is what makes the
 *  spheres (and a later compaction) sit where the ring actually draws. */
const FAR_CHUNK_BASE_Y = WORLD_SURFACE_Y;

/** RENDER lane. `N` starts the probe; everything else about it is reported, never acted on. */
export class GpuCullProbeSystem {
  private readonly keys: KeyEdgeReader;
  private readonly renderer: WebGPURenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world: World;
  private readonly log: (line: string) => void;
  private readonly playerIndex: number;
  private culler: GpuClusterCuller | null = null;
  private compactor: GpuGeometryCompactor | null = null;
  private compacted: CompactedDraw | null = null;
  private drawGeometry: THREE.BufferGeometry | null = null;
  private drawBuffer: CompactedDraw | null = null;
  private drawn: THREE.Mesh | null = null;
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
    let draws = 0;
    let all = 0;
    this.keys.drain((edge) => {
      if (!edge.down || edge.repeat) return;
      if (edge.code === "KeyN") presses++;
      if (edge.code === "KeyO") draws++;
      if (edge.code === "KeyP") all++;
    });
    if (presses > 0 && !this.busy) void this.run();
    else if (draws > 0 && !this.busy) void this.runDraw(false);
    // `P`: THE SAME DRAW WITH CULLING SWITCHED OFF — every cluster visible. It exists so the two questions stay
    // separable: `O` answers "does the GPU draw what it decided to draw", and `P` answers "is the geometry itself
    // right", with nothing culled in between. Comparing the two is how «外观不对» and «剔除太狠» are told apart.
    else if (all > 0 && !this.busy) void this.runDraw(true);
  }

  /** `O`: THE WHOLE GPU-DRIVEN DRAW, end to end, on ONE batch of real chunks.
   *
   *  It is the smallest thing that exercises every part of the route at once: the mesher fills an ARENA, the cull
   *  keeps what the camera sees, the compaction copies those clusters into a dense buffer, and the DRAW reads its
   *  vertex count out of an indirect buffer THE DEVICE WROTE. Nothing about what is drawn comes back to this thread
   *  — the readbacks below exist only to REPORT.
   *
   *  The copy floats 40 blocks up (`place.y`), so it cannot be confused with the chunk it came from: an identical
   *  silhouette 40 blocks higher IS the proof, and a scrambled or empty copy is a failure of the placement, the
   *  offsets or the indirect count. */
  private async runDraw(ignoreCull: boolean): Promise<void> {
    this.busy = true;
    const started = performance.now();
    const backend = (this.renderer as { backend?: { isWebGPUBackend?: boolean } }).backend;
    if (backend?.isWebGPUBackend !== true) {
      this.log("CULLPROBE draw off: this backend is not WebGPU, so there is no compute queue to draw from");
      this.busy = false;
      return;
    }
    try {
      const batch = this.realChunks();
      if (batch.length === 0) {
        this.log("CULLPROBE draw: no real chunk with faces in the player's column (nothing to draw)");
      } else {
        // 1. THE ARENA: one kernel build, `batch.length` chunks, offsets decided on the device.
        const output = createMesherOutput(ARENA_FACES);
        const mesher = new GpuChunkMesher(this.renderer, output, batch.length);
        const packed = await mesher.run(batch.map((entry) => entry.input));
        // 2. THE CLUSTERS: one per (chunk, look slice) — the arena offsets the mesher reported, the chunk's origin
        //    as the placement, and the slice's own bounding box lifted 40 blocks.
        const set = createClusterSet(CLUSTER_CAPACITY);
        let arenaFaces = 0;
        for (let chunk = 0; chunk < packed.length; chunk++) {
          const geometry = packed[chunk];
          const origin = batch[chunk].origin;
          arenaFaces += geometry.faces;
          for (const slice of geometry.slots) {
            const at = set.count * 4;
            // PER-CLUSTER BOUNDS, from the slice's OWN vertices — and that is what makes the copy look right when it
            // is only partly on screen. Giving every slice of a chunk the CHUNK's sphere made visibility
            // all-or-nothing per chunk, so standing on the ground (where the lower chunk of the column falls out of
            // the frustum) the copy drew half a chunk and read as «还是有点问题». These bounds come from the arena's
            // own vertices, so a cluster is exactly as big as the geometry it stands for.
            const bounds = sliceBounds(geometry, slice.start, slice.count, origin[0], origin[1] + 40, origin[2], 1);
            set.bounds[at] = bounds[0];
            set.bounds[at + 1] = bounds[1];
            set.bounds[at + 2] = bounds[2];
            set.bounds[at + 3] = bounds[3];
            set.info[at] = geometry.base + slice.start;
            set.info[at + 1] = slice.count;
            set.info[at + 2] = slice.key;
            set.info[at + 3] = 1;
            set.place[at] = origin[0];
            set.place[at + 1] = origin[1] + 40;
            set.place[at + 2] = origin[2];
            set.place[at + 3] = 1;
            set.count++;
          }
        }
        // 3. CULL, then 4. COMPACT — the first pass decides what exists, the second copies it.
        this.culler ??= new GpuClusterCuller(this.renderer, CLUSTER_CAPACITY);
        const planes = ignoreCull ? everythingVisible() : this.frustumPlanes();
        const gpuStart = performance.now();
        const visible = await this.culler.cull(set, planes);
        let visibleFaces = 0;
        for (const cluster of visible) visibleFaces += set.info[cluster * 4 + 1];
        const compacted = this.compacted ?? createCompactedDraw(ARENA_FACES);
        this.compacted = compacted;
        this.compactor ??= new GpuGeometryCompactor(this.renderer, this.culler, output, compacted, CLUSTER_CAPACITY);
        await this.compactor.run();
        const gpuMs = performance.now() - gpuStart;
        // 5. THE DRAW: an ordinary Mesh whose attributes are the COMPACTED buffers and whose vertex count is the
        //    buffer the device wrote. No `drawRange`, no count from here — `setIndirect` is the whole mechanism.
        const indirectAttr = this.culler.clusterBuffers.indirect;
        const compactProblem = await this.checkCompaction(output, compacted, set, visible);
        this.showDraw(compacted, indirectAttr, visibleFaces);
        const indirect = new Uint32Array(await this.renderer.getArrayBufferAsync(indirectAttr));
        this.log(
          `CULLPROBE draw: arena ${arenaFaces} face(s) in ${packed.length} chunk(s), ${set.count} cluster(s) — ` +
            `${visible.length} visible = ${visibleFaces} face(s) of ${compacted.faceCapacity}; the DEVICE's own draw call is ` +
            `vertexCount ${indirect[0]} (= ${visibleFaces * 6} expected), instanceCount ${indirect[1]}, firstVertex ${indirect[2]}`,
        );
        this.log(
          `CULLPROBE draw RESULT: ${
            compactProblem === "" && indirect[0] === visibleFaces * 6 && indirect[1] === 1
              ? "OK — the indirect buffer holds exactly the visible geometry and ONE instance, and every compacted vertex is its arena source placed"
              : `MISMATCH — ${compactProblem !== "" ? compactProblem : "the device's draw call disagrees with the visible set"}`
          }; cull + compact took ${gpuMs.toFixed(2)}ms (3 cull dispatches + 2 compaction passes, and the readbacks here are this report's)`,
        );
        this.world.commands.send(ShowToast, {
          key:
            "GPU 间接绘制探针: " +
            (compactProblem === "" && indirect[0] === visibleFaces * 6 ? `已画出 ${visibleFaces} 个面 ✓` : `不一致! 见 debug.log`),
          raw: true,
        });
      }
    } catch (err) {
      this.log(`CULLPROBE draw FAILED: ${String((err as Error)?.message ?? err)}`);
      this.world.commands.send(ShowToast, { key: `GPU 间接绘制失败: ${String((err as Error)?.message ?? err)}`, raw: true });
    } finally {
      this.log(`CULLPROBE draw done in ${(performance.now() - started).toFixed(0)}ms`);
      this.busy = false;
    }
  }

  /** THE REAL CHUNKS this probe may draw: the player's own column, top down, the ones with faces — the same choice
   *  the mesher probe makes, because an arena with nothing in it proves nothing. */
  private realChunks(): { input: ChunkMeshInput; origin: [number, number, number] }[] {
    const out: { input: ChunkMeshInput; origin: [number, number, number] }[] = [];
    const periodX = worldChunksX();
    const periodZ = worldChunksZ();
    const wrap = (value: number, period: number): number => ((value % period) + period) % period;
    const playerChunkX = Math.floor(POSITION.x[this.playerIndex] / CHUNK_SIZE);
    const playerChunkZ = Math.floor(POSITION.z[this.playerIndex] / CHUNK_SIZE);
    const cx = wrap(playerChunkX, periodX);
    const cz = wrap(playerChunkZ, periodZ);
    // The nearest torus representation, so the copy lands next to the player rather than a lap away (the M2c probe
    // reported that exact mistake once).
    const atX = nearestWrap(cx, playerChunkX, periodX) * CHUNK_SIZE;
    const atZ = nearestWrap(cz, playerChunkZ, periodZ) * CHUNK_SIZE;
    const voxel = this.world.resource(VOXEL);
    for (let cy = MIN_CHUNK_Y + CHUNK_Y_COUNT - 1; cy >= MIN_CHUNK_Y && out.length < MESHER_SLOTS; cy--) {
      const chunk: Chunk | null = voxel.getChunk(cx, cy, cz);
      if (chunk === null) continue;
      const input = gatherChunkMeshInput(voxel, chunk, cx, cy, cz);
      if (meshChunk(input).faces === 0) continue;
      out.push({ input, origin: [atX, cy * CHUNK_SIZE, atZ] });
    }
    return out;
  }

  /** THE COMPACTION, CHECKED BY VALUE — the detector for «侧面跑到别的位置». The selection can be perfect (and the
   *  `vertexCount` proves it) while the COPY writes the wrong bytes: a `Loop` that runs past its cluster reads another
   *  chunk's faces out of the arena and overwrites the next cluster's region, so faces from elsewhere turn up inside
   *  the copy while every count stays right. No count can see that, so this reads the COMPACTED buffer back and
   *  compares every vertex against its arena source placed by `place` — component by component, normals included —
   *  and reports the FIRST difference with its cluster, face and vertex. */
  private async checkCompaction(
    arena: MesherOutput,
    draw: CompactedDraw,
    set: ClusterSet,
    visible: Uint32Array,
  ): Promise<string> {
    const read = async (attr: StorageBufferAttribute, elements: number): Promise<Float32Array> =>
      new Float32Array(await this.renderer.getArrayBufferAsync(attr, null, 0, elements * 4));
    const arenaPositions = await read(arena.position, arena.capacity * VERTS_PER_FACE * DRAWN_STRIDE);
    const arenaNormals = await read(arena.normal, arena.capacity * VERTS_PER_FACE * DRAWN_STRIDE);
    const compactPositions = await read(draw.position, draw.faceCapacity * VERTS_PER_FACE * DRAWN_STRIDE);
    const compactNormals = await read(draw.normal, draw.faceCapacity * VERTS_PER_FACE * DRAWN_STRIDE);
    const slots = this.culler?.clusterBuffers.faceSlot;
    const faceSlots =
      slots === undefined ? new Uint32Array(0) : new Uint32Array(await this.renderer.getArrayBufferAsync(slots));
    let vertices = 0;
    let wrong = 0;
    let first = "";
    for (const cluster of Array.from(visible)) {
      const base = set.info[cluster * 4];
      const count = set.info[cluster * 4 + 1];
      const origin = [set.place[cluster * 4], set.place[cluster * 4 + 1], set.place[cluster * 4 + 2]];
      const step = set.place[cluster * 4 + 3];
      const destination = faceSlots[cluster];
      for (let face = 0; face < count; face++) {
        for (let v = 0; v < VERTS_PER_FACE; v++) {
          const src = ((base + face) * VERTS_PER_FACE + v) * DRAWN_STRIDE;
          const dst = ((destination + face) * VERTS_PER_FACE + v) * DRAWN_STRIDE;
          vertices++;
          for (let axis = 0; axis < 3; axis++) {
            const want = axis === 1 ? arenaPositions[src + 1] + origin[1] : arenaPositions[src + axis] * step + origin[axis];
            if (compactPositions[dst + axis] !== want) {
              wrong++;
              if (first === "") {
                first =
                  `cluster ${cluster} face ${face} vertex ${v} position[${axis}]: got ${compactPositions[dst + axis]}, ` +
                  `expected ${want} (arena ${arenaPositions[src + axis]} + origin ${origin[axis]}, step ${step})`;
              }
            }
            if (compactNormals[dst + axis] !== arenaNormals[src + axis]) {
              wrong++;
              if (first === "") {
                first =
                  `cluster ${cluster} face ${face} vertex ${v} normal[${axis}]: got ${compactNormals[dst + axis]}, ` +
                  `expected ${arenaNormals[src + axis]}`;
              }
            }
          }
        }
      }
    }
    this.log(
      `CULLPROBE compact: ${visible.length} cluster(s), ${vertices} vertex/vertices checked against the arena — ` +
        `${wrong === 0 ? "every position and normal is its arena source, placed" : `${wrong} component(s) WRONG; first: ${first}`}`,
    );
    return wrong === 0 ? "" : first;
  }

  /** Put the compacted buffer in the scene as an ordinary `Mesh`, drawn by the DEVICE's indirect call.
   *
   *  THE GEOMETRY AND THE MATERIAL ARE BUILT ONCE AND REUSED, and that is a FIXED BUG: the first version built a
   *  fresh geometry per run and disposed the previous one, but `BufferGeometry.dispose()` DESTROYS THE ATTRIBUTES'
   *  GPU BUFFERS — and those buffers are the compute-written compacted triple plus the cull's INDIRECT buffer, which
   *  the next run's passes still write into. `renderer.log` said it plainly:
   *  `[Buffer (unlabeled)] used in submit while destroyed. While calling [Queue].Submit(... computeGroup_...)`.
   *  A probe may own a geometry; it may NOT own buffers the kernels own. So: the mesh is removed and re-added, the
   *  BUFFERS live on, and only the tiny JS-side geometry wrapper is replaced when the draw buffer changes. */
  private showDraw(draw: CompactedDraw, indirect: IndirectStorageBufferAttribute, visibleFaces: number): void {
    if (this.drawGeometry === null || this.drawBuffer !== draw) {
      this.drawGeometry = new THREE.BufferGeometry();
      this.drawGeometry.setAttribute("position", draw.position);
      this.drawGeometry.setAttribute("normal", draw.normal);
      this.drawGeometry.setAttribute("uv", draw.uv);
      // THE ONLY NEW CONCEPT: the draw's size comes from a buffer the compute pass wrote. No `drawRange`, no count.
      this.drawGeometry.setIndirect(indirect);
      this.drawGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      this.drawBuffer = draw;
    }
    const material = new THREE.MeshLambertMaterial({ color: 0x7fd4ff });
    const mesh = new THREE.Mesh(this.drawGeometry, material);
    mesh.name = "gpu-indirect-draw-probe";
    mesh.frustumCulled = false;
    this.removeDrawMesh();
    this.world.resource(SCENE3D).add(mesh);
    this.drawn = mesh;
    this.log(
      `CULLPROBE draw: a floating copy of ${visibleFaces} visible face(s), drawn by the DEVICE's indirect call — it ` +
        `must look EXACTLY like the chunk 40 blocks below it (same silhouette, same holes). An empty or scrambled ` +
        `copy means the placement, the arena offsets or the indirect count is wrong.`,
    );
  }

  /** Take the MESH out of the scene and dispose only the MATERIAL. The geometry's attributes are the kernels'
   *  buffers — see `showDraw` — so they are never disposed here. */
  private removeDrawMesh(): void {
    const mesh = this.drawn;
    if (mesh === null) return;
    this.world.resource(SCENE3D).remove(mesh);
    const material = mesh.material;
    if (Array.isArray(material)) for (const one of material) one.dispose();
    else material.dispose();
    this.drawn = null;
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
  private clusterSet(): { count: number; bounds: Float32Array; info: Uint32Array; place: Float32Array } {
    const capacity = CLUSTER_CAPACITY;
    const bounds = new Float32Array(capacity * 4);
    const info = new Uint32Array(capacity * 4);
    const place = new Float32Array(capacity * 4);
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
          // WHERE THE CELL'S GEOMETRY WOULD GO, at the rung's own scale — the same numbers the stream places meshes
          // with, so a compaction of this set would land exactly on the terrain the ring draws.
          place[at] = nearX * cell;
          place[at + 1] = FAR_CHUNK_BASE_Y;
          place[at + 2] = nearZ * cell;
          place[at + 3] = tier.step;
          count++;
        }
      }
    }
    return { count, bounds, info, place };
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

  /** A SLICE'S OWN BOUNDING SPHERE, in world space: the min/max of its vertices in the arena's drawn layout, placed by
 *  the cluster's origin and step (X/Z scaled, Y not — `(step, 1, step)`, the far ring's own scale), plus a small
 *  margin so a face lying exactly on the boundary is never culled away. Exported for the gate. */
export function sliceBounds(
  geometry: { positions: Float32Array },
  start: number,
  faces: number,
  originX: number,
  originY: number,
  originZ: number,
  step: number,
): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let face = 0; face < faces; face++) {
    for (let v = 0; v < VERTS_PER_FACE; v++) {
      const at = ((start + face) * VERTS_PER_FACE + v) * DRAWN_STRIDE;
      const x = geometry.positions[at] * step + originX;
      const y = geometry.positions[at + 1] + originY;
      const z = geometry.positions[at + 2] * step + originZ;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) return [originX, originY, originZ, 0];
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  // The sphere CONTAINS the slice's box, plus one block of margin: a cull must never drop a cluster the frustum
  // touches, and the margin keeps a face lying exactly on a plane from falling through a float comparison.
  const radius = Math.hypot(maxX - cx, maxY - cy, maxZ - cz) + 1;
  return [cx, cy, cz, radius];
}

/** A frustum that CONTAINS EVERYTHING, for `P`: six inward normals with a constant no coordinate can reach. It is a
 *  real frustum as far as the kernel is concerned — the same test, the same code path — so `P` measures the geometry
 *  and nothing else. */
function everythingVisible(): FrustumPlanes {
  const huge = 1e9;
  return new Float32Array([
    1, 0, 0, huge,
    -1, 0, 0, huge,
    0, 1, 0, huge,
    0, -1, 0, huge,
    0, 0, 1, huge,
    0, 0, -1, huge,
  ]);
}
