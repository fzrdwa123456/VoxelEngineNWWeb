// ===== Chunk streaming: keep the chunks around the player generated, meshed and placed =====
// Runs in the RENDER lane (presentation only: it never touches entity state).
//
// DRAWING A TORUS IN FLAT SPACE. The world wraps in X/Z (voxel/world.ts), so the same chunk
// identity can be drawn at several positions. Each mesh is keyed by its WRAPPED identity and
// placed at the representation nearest the player (nearestWrap), which makes the horizon
// seamless in every direction without ever teleporting the player. The visible window is
// (2*RADIUS+1)^2 columns; keeping RADIUS < WORLD_CHUNKS/2 guarantees a visible chunk's nearest
// representation never flips on screen.
//
// The wanted-key set is rebuilt only when the player crosses a chunk boundary, and meshes are
// built under a per-frame budget so the initial fill spreads over a couple of seconds instead
// of stalling. Chunks whose mesh came out empty (uniform solid, which is what the default
// generator produces) are remembered in the cache's `empty` set and never retried — that cache assumes
// static terrain; an editable world must invalidate it on write. The cache itself (the parent group and
// both sets) is the CHUNK_MESHES resource rather than a private field: see ecs/presentation.ts.
import * as THREE from "three/webgpu";
import { CHUNK_SIZE } from "../../../data/world/chunk";
import {
  CHUNK_Y_COUNT,
  MIN_CHUNK_Y,
  WORLD_CHUNKS_X,
  WORLD_CHUNKS_Z,
  nearestWrap,
  wrapChunkX,
  wrapChunkZ,
  type VoxelWorld,
} from "../../../data/world/world";
import { POSITION } from "../../player/components";
import { CHUNK_MATERIAL, CHUNK_MESHES, type ChunkFaceSpec, type ChunkMaterialState, type ChunkMeshCache, type ChunkMeshEntry } from "../../../data/globals/gfx";
import { LOCAL_PLAYER, VOXEL } from "../../../data/globals/resources";
import { gatherChunkMeshInput, type ChunkMeshInput, type MeshResult } from "../../../data/world/mesh";
import { entityIndex, type SystemAccess, type World } from "../../../core/world";

/** Declared access. Reads the player's position and writes the block world plus the GPU meshes —
 *  all external targets the ECS does not model, which is why the render stage's other producers can
 *  still share its batch. */
export const CHUNK_STREAM_ACCESS: SystemAccess = {
  reads: [POSITION],
  writesExternal: ["voxelChunks", "chunkMeshes"],
};

/** Window radius in chunks: 8 -> 17x17 = 289 columns, i.e. ~256 blocks of visible world.
 *  Keep it below WORLD_CHUNKS/2 so a chunk's nearest representation never flips on screen. */
export const RENDER_RADIUS_CHUNKS = 8;
/** Meshes built per frame, so the initial fill spreads over frames instead of stalling.
 *  Air chunks bail out immediately, so a high value mostly costs cheap early-outs. */
const MESH_BUDGET_PER_FRAME = 24;
/** Looks re-resolved per frame after a PACK RELOAD (P1.18i). MUCH higher than the meshing budget because the
 *  work is not comparable: a re-mesh reads a 32^3 neighbourhood and rewrites every vertex buffer, while a
 *  restyle is one lookup per material group in a chunk that is already built. It is still budgeted, so the
 *  frame cannot grow with the size of the streamed window. */
const RESTYLE_BUDGET_PER_FRAME = 128;

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** The chunk mesher, INJECTED rather than imported (the layer rule in check:ecs): a chunk geometry owns
 *  three.js buffers and the material is a GPU object, so the PLATFORM builds them and the composition root
 *  hands the factory in. The geometry's type comes from the data side (`ChunkMeshEntry`), which is what
 *  keeps this file free of a host import. */
export interface ChunkMeshFactory {
  createGeometry(): ChunkMeshEntry["geom"];
  getMaterial(state: ChunkMaterialState, spec?: ChunkFaceSpec): THREE.Material;
}

/** ONE finished meshing job, as this lane sees it (P1.18h). Declared here for the same reason the factory is:
 *  the pool is a `host/` object, and a plugin may not import it — so the shape lives on this side and the
 *  host's pool satisfies it structurally. */
export interface MeshJobDone {
  readonly key: string;
  /** The mesh, or null when the worker failed or died: that chunk is then meshed on THIS thread, so a
   *  broken worker degrades into the old behaviour instead of leaving a hole in the world. */
  readonly result: MeshResult | null;
}

/** The main-thread half of the worker pool. `request` returning false means "saturated, ask again later". */
export interface MeshWorkerPool {
  request(key: string, input: ChunkMeshInput): boolean;
  take(): MeshJobDone[];
  readonly inFlight: number;
  readonly workers: number;
}

/** Default so a drive-by test — and the Node gate, which drives `prime`/`needsWarmUp` on a stub voxel —
 *  can construct this system without a GPU: a geometry that is never drawn and a material that never
 *  renders. The composition root always injects the real factory. */
const NO_MESH: ChunkMeshFactory = {
  // `rebuild` must RETURN the face count (the caller decides emptiness by `> 0`): a stub world is all air,
  // so it returns 0 — a no-op that returned undefined would look like "a mesh was built" and the gate's
  // "an all-air world builds no mesh" assertion would fail for the wrong reason.
  createGeometry: () =>
    ({
      geometry: new THREE.BufferGeometry(),
      faces: 0,
      rebuild: () => 0,
      apply: () => 0,
      restyle: () => 0,
      dispose: () => {},
    }) as unknown as ChunkMeshEntry["geom"],
  getMaterial: () => new THREE.MeshBasicMaterial(),
};

export class ChunkStreamSystem {
  /** The world's chunk-mesh cache (ecs/presentation.ts): the parent group every mesh is added to, the
   *  meshes themselves and the "no geometry" set. It used to be three private fields plus a THREE.Group
   *  handed in as a constructor argument — the cache is GPU state that outlives a frame, so the world
   *  owns it. Resolved in the constructor BODY (iron rule 6). */
  private readonly cache: ChunkMeshCache;
  /** The ONE material every chunk mesh shares (CHUNK_MATERIAL, ecs/presentation.ts): a GPU object, so the
   *  world owns it instead of chunkmesh.ts keeping a module-level `let` */
  private readonly material: ChunkMaterialState;
  /** Column offsets ordered near-first, so the ground under the player appears first */
  private readonly offsets: ReadonlyArray<readonly [number, number]>;
  /** Row of the local player in the POSITION columns (resolved once — the player is never respawned) */
  private readonly index: number;
  private readonly voxel: VoxelWorld;
  /** The streaming window's own bookkeeping: the wanted key set and the column it was built for. It is
   *  a field of the CHUNK_MESHES resource (`wantedKeys`/`lastPcx`/`lastPcz`) rather than of this system —
   *  "which chunks this window wants" is state of the world's chunk cache, and a second system (or a
   *  test) may now read it. */
  private get wanted(): Set<string> | null {
    return this.cache.wantedKeys;
  }
  private set wanted(v: Set<string> | null) {
    this.cache.wantedKeys = v;
  }
  private get lastPcx(): number {
    return this.cache.lastPcx;
  }
  private set lastPcx(v: number) {
    this.cache.lastPcx = v;
  }
  private get lastPcz(): number {
    return this.cache.lastPcz;
  }
  private set lastPcz(v: number) {
    this.cache.lastPcz = v;
  }

  constructor(
    private readonly world: World,
    /** The platform's mesher (see ChunkMeshFactory). */
    private readonly mesh: ChunkMeshFactory = NO_MESH,
    /** The worker pool, when the platform has one (P1.18h). Absent = every mesh is built on this thread,
     *  which is exactly what the engine did before, and what the Node gate still does. */
    private readonly pool: MeshWorkerPool | null = null,
  ) {
    this.index = entityIndex(world.resource(LOCAL_PLAYER));
    this.voxel = world.resource(VOXEL);
    this.cache = world.resource(CHUNK_MESHES);
    this.material = world.resource(CHUNK_MATERIAL);
    const offsets: Array<[number, number]> = [];
    for (let dx = -RENDER_RADIUS_CHUNKS; dx <= RENDER_RADIUS_CHUNKS; dx++) {
      for (let dz = -RENDER_RADIUS_CHUNKS; dz <= RENDER_RADIUS_CHUNKS; dz++) {
        offsets.push([dx, dz]);
      }
    }
    offsets.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1])));
    this.offsets = offsets;
  }

  /** Generate (without meshing) every chunk in the window around a world position. Called once
   *  before the loop starts, so collision has real blocks on the very first tick. */
  prime(x: number, z: number): void {
    const pcx = Math.floor(x / CHUNK_SIZE);
    const pcz = Math.floor(z / CHUNK_SIZE);
    for (const [dx, dz] of this.offsets) {
      for (let cy = MIN_CHUNK_Y; cy < MIN_CHUNK_Y + CHUNK_Y_COUNT; cy++) {
        this.voxel.ensureChunk(pcx + dx, cy, pcz + dz);
      }
    }
  }

  /** Chunks in the window whose mesh has not been DECIDED yet — neither built nor known to be empty
   *  (a uniform chunk has no visible face and is never retried, so "no mesh" is a real answer). */
  pendingCount(): number {
    if (this.wanted === null) return this.offsets.length * CHUNK_Y_COUNT;
    let pending = 0;
    for (const key of this.wanted) {
      if (!this.cache.meshes.has(key) && !this.cache.empty.has(key)) pending++;
    }
    return pending;
  }

  /** Would warming the window around (x, z) have anything to build?
   *
   *  The world-entry driver asks this BEFORE it puts a loading screen up: a first entry into a world
   *  has a whole window to generate and mesh, but a RE-entry into a window that is still built (the
   *  player walked around, went back to the main menu, and the world is still on screen behind it) has
   *  nothing to do — and a screen that appears for one frame and vanishes is worse than no screen.
   *  Asked about the POSITION being entered, not about the current window: `wanted` may still describe
   *  where the player stood last. */
  needsWarmUp(x: number, z: number): boolean {
    const wanted = this.wantedKeys(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE));
    for (const key of wanted) {
      if (!this.cache.meshes.has(key) && !this.cache.empty.has(key)) return true;
    }
    return false;
  }

  /** Boot warm-up: build the whole spawn window's meshes BEFORE the first frame is drawn.
   *
   *  Without it the per-frame budget (MESH_BUDGET_PER_FRAME) spreads the initial fill over ~100
   *  frames, which is why the world used to pop in over the first seconds — while the loading screen
   *  was up for exactly that stretch of time anyway. `yieldTo` is awaited between batches so the
   *  caller can keep that screen painting, and `onProgress` reports (decided, total) for the bar.
   *
   *  Bounded by a guard: with a generator that never makes progress the loop must stop rather than
   *  hang the startup. */
  async warmUp(
    yieldTo: () => Promise<void>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    this.step(); // the first step is what builds the wanted set
    const total = this.wanted?.size ?? this.offsets.length * CHUNK_Y_COUNT;
    let last = -1;
    for (let guard = 0; guard < 4096; guard++) {
      const pending = this.pendingCount();
      onProgress?.(total - pending, total);
      if (pending === 0) return;
      // The guard has to tell "no progress" apart from "progress is IN FLIGHT" (P1.18h): with a pool, the
      // count stands still for as many frames as the workers take, and the yield below is exactly what lets
      // their replies arrive. Only nothing-pending AND nothing-in-flight means the generator is stuck.
      if (pending === last && (this.pool === null || this.pool.inFlight === 0)) return;
      last = pending;
      this.step();
      await yieldTo();
    }
  }

  step(): void {
    // FINISHED WORK FIRST (P1.18h): a job that came back last frame is applied here, INSIDE the lane, so
    // the scene is never touched from a worker callback and the order stays deterministic.
    this.drain();

    const pcx = Math.floor(POSITION.x[this.index] / CHUNK_SIZE);
    const pcz = Math.floor(POSITION.z[this.index] / CHUNK_SIZE);
    const moved = pcx !== this.lastPcx || pcz !== this.lastPcz;
    this.lastPcx = pcx;
    this.lastPcz = pcz;

    if (moved || this.wanted === null) {
      this.wanted = this.wantedKeys(pcx, pcz);
      this.unloadOutside(this.wanted);
    }

    // Block edits are rebuilt FIRST and unbudgeted: the player must see the block they just
    // changed. One edit touches at most a handful of chunks (the owner plus any border
    // neighbour), and input is rate-limited in ecs/systems/interaction.ts, so this cannot flood
    // a frame. THEY STAY ON THIS THREAD even with a pool: a worker round trip would put the mesh a frame or
    // two behind the click, and this is the one path where the player is watching one block.
    for (const key of this.voxel.takeDirty()) this.rebuild(key);

    // A PACK RELOAD marks every loaded chunk stale (P1.49ab): the LOOKS a chunk resolves come from the block
    // table and the textures, so a new chain changes every mesh's material list. Budgeted, unlike a block
    // edit: the player is not waiting on any one chunk here, and rebuilding ~2000 of them in a single frame is
    // the hitch Minecraft avoids by invalidating the geometry and rebuilding over the following frames.
    //
    // RESTYLE, NOT RE-MESH (P1.18i). A reload only changes what a block LOOKS like, and a mesh's vertex data
    // depends on the VOXELS alone (every uv is a per-face constant), so the geometry is still correct — only
    // the look → material list it stores has to be resolved again, which is what ChunkGeometry.restyle does in
    // place. That is the difference between a reload costing a few thousand chunk meshes and costing a few
    // thousand lookups: the mesh, its buffers and its groups all stay exactly where they are. A non-bulk reason
    // to mark a chunk stale (a future change that moves vertices) must re-mesh instead — see ROADMAP P1.18i.
    let restyleBudget = RESTYLE_BUDGET_PER_FRAME;
    for (const key of this.voxel.takeStale(restyleBudget)) {
      restyleBudget--;
      this.restyle(key);
    }

    let budget = MESH_BUDGET_PER_FRAME;
    for (const key of this.wanted) {
      if (budget <= 0) break;
      if (this.cache.meshes.has(key) || this.cache.empty.has(key)) continue;
      budget--;
      if (!this.queueBuild(key)) break;
    }

    if (moved) {
      for (const entry of this.cache.meshes.values()) this.place(entry);
    }
  }

  /** Apply what the workers finished. The IN-FLIGHT SET IS THE VALIDITY TOKEN: a key that is no longer in it
   *  was rebuilt on this thread in the meantime (a block edit) or left the window, so its result is stale and
   *  is dropped rather than overwriting fresher geometry. */
  private drain(): void {
    if (!this.pool) return;
    for (const done of this.pool.take()) {
      if (!this.cache.inFlight.delete(done.key)) continue;
      if (done.result === null) {
        // A dead or failing worker: build this one here, so the failure costs a frame and not a hole.
        this.rebuild(done.key);
        continue;
      }
      this.applyResult(done.key, done.result);
    }
  }

  /** Put a finished mesh on screen: refill an existing chunk's geometry IN PLACE (no dispose, no new Mesh,
   *  no new GPU buffers) or build one for a chunk that had none. A result with no faces means the chunk is
   *  invisible — it goes into the `empty` set so it is never asked for again. */
  private applyResult(key: string, result: MeshResult): void {
    const entry = this.cache.meshes.get(key);
    if (entry) {
      if (entry.geom.apply(this.voxel, result) > 0) {
        // A dig or a place can change WHICH LOOKS this chunk shows, so the material list follows the rebuild.
        entry.mesh.material = this.materialsFor(entry.geom);
        return;
      }
      this.cache.group.remove(entry.mesh);
      entry.geom.dispose();
      this.cache.meshes.delete(key);
      this.cache.empty.add(key);
      return;
    }
    if (result.faces === 0) {
      this.cache.empty.add(key);
      return;
    }
    const geom = this.mesh.createGeometry();
    if (geom.apply(this.voxel, result) === 0) {
      geom.dispose();
      this.cache.empty.add(key);
      return;
    }
    const parts = key.split(",");
    const mesh = new THREE.Mesh(geom.geometry, this.materialsFor(geom));
    mesh.matrixAutoUpdate = false;
    const fresh: ChunkMeshEntry = {
      mesh,
      geom,
      cx: Number(parts[0]),
      cy: Number(parts[1]),
      cz: Number(parts[2]),
    };
    this.cache.group.add(mesh);
    this.cache.meshes.set(key, fresh);
    this.place(fresh);
  }

  /** Hand one chunk to a worker. False = the pool is saturated (or there is none): the caller stops asking
   *  this frame and comes back to that chunk later. */
  private requestMesh(key: string): boolean {
    if (!this.hasPool || this.cache.inFlight.has(key)) return false;
    const pool = this.pool!;
    const parts = key.split(",");
    const cx = Number(parts[0]);
    const cy = Number(parts[1]);
    const cz = Number(parts[2]);
    // Boundary faces are culled against neighbouring chunks, so those must exist first (the input's planes
    // are read from them).
    for (const [dx, dy, dz] of NEIGHBOURS) this.voxel.ensureChunk(cx + dx, cy + dy, cz + dz);
    const chunk = this.voxel.getChunk(cx, cy, cz);
    if (chunk === null) return false;
    if (!pool.request(key, gatherChunkMeshInput(this.voxel, chunk, cx, cy, cz))) return false;
    this.cache.inFlight.add(key);
    return true;
  }

  /** The reload path (a chain change): re-resolve this chunk's LOOKS in place. Nothing is meshed, so there is
   *  no pool to consult and nothing to fail — a chunk with no mesh has nothing to restyle (it is either in
   *  `empty`, or undecided and therefore already covered by the streaming budget below). */
  private restyle(key: string): void {
    const entry = this.cache.meshes.get(key);
    if (!entry) return;
    entry.geom.restyle(this.voxel);
    // The material CACHE was dropped by the reload (see the pack driver), so these come back from the new
    // chain's textures. `groups` is untouched: a slot index still means the same material index.
    entry.mesh.material = this.materialsFor(entry.geom);
  }

  /** The streaming path (a chunk the window wants that has not been decided yet). */
  private queueBuild(key: string): boolean {
    if (!this.hasPool) {
      this.build(key);
      return true;
    }
    if (this.cache.meshes.has(key) || this.cache.empty.has(key)) return true;
    return this.requestMesh(key);
  }

  /** Is there a worker to hand a job to RIGHT NOW? A pool that lost every worker answers "saturated" for ever,
   *  so it is treated as ABSENT and this lane meshes on its own thread — a broken worker degrades the world's
   *  speed, never its content. Asked again per chunk rather than cached, because a worker can die at any time
   *  and the pool reports the new count immediately (P1.18i). */
  private get hasPool(): boolean {
    return this.pool !== null && this.pool.workers > 0;
  }

  /** Wrapped chunk identities of the window, ordered near-first, top Y chunk first */
  private wantedKeys(pcx: number, pcz: number): Set<string> {
    const out = new Set<string>();
    for (const [dx, dz] of this.offsets) {
      const cx = wrapChunkX(pcx + dx);
      const cz = wrapChunkZ(pcz + dz);
      for (let cy = MIN_CHUNK_Y + CHUNK_Y_COUNT - 1; cy >= MIN_CHUNK_Y; cy--) {
        out.add(`${cx},${cy},${cz}`);
      }
    }
    return out;
  }

  private unloadOutside(wanted: Set<string>): void {
    for (const [key, entry] of this.cache.meshes) {
      if (wanted.has(key)) continue;
      this.cache.group.remove(entry.mesh);
      entry.geom.dispose();
      this.cache.meshes.delete(key);
      this.cache.empty.delete(key);
      // A job for a chunk that left the window is dropped when it comes back (`drain` checks this set).
      this.cache.inFlight.delete(key);
    }
  }

  /** Re-mesh one chunk after a block write.
   *  If the chunk already has a mesh this refills its geometry IN PLACE — no dispose, no new Mesh,
   *  no new GPU buffers. That is what removes the per-click hitch: the mesh object and its buffers
   *  survive, only the vertex data inside them is rewritten.
   *  A chunk that had no mesh needs one built, and a chunk that just lost its last visible face
   *  must go back into the "empty" set. */
  private rebuild(key: string): void {
    const entry = this.cache.meshes.get(key);
    if (entry) {
      if (entry.geom.rebuild(this.voxel, entry.cx, entry.cy, entry.cz) > 0) {
        // A dig or a place can change WHICH LOOKS this chunk shows, so the material list follows the rebuild.
        entry.mesh.material = this.materialsFor(entry.geom);
        return;
      }
      this.cache.group.remove(entry.mesh);
      entry.geom.dispose();
      this.cache.meshes.delete(key);
      this.cache.empty.add(key);
      return;
    }
    this.cache.empty.delete(key);
    if (this.wanted?.has(key)) this.build(key);
  }

  private build(key: string): void {
    const parts = key.split(",");
    const cx = Number(parts[0]);
    const cy = Number(parts[1]);
    const cz = Number(parts[2]);

    // Boundary faces are culled against neighbouring chunks, so those must exist first
    for (const [dx, dy, dz] of NEIGHBOURS) this.voxel.ensureChunk(cx + dx, cy + dy, cz + dz);

    const geom = this.mesh.createGeometry();
    if (geom.rebuild(this.voxel, cx, cy, cz) === 0) {
      geom.dispose();
      this.cache.empty.add(key);
      return;
    }

    const mesh = new THREE.Mesh(geom.geometry, this.materialsFor(geom));
    mesh.matrixAutoUpdate = false;
    const entry: ChunkMeshEntry = { mesh, geom, cx, cy, cz };
    this.cache.group.add(mesh);
    this.cache.meshes.set(key, entry);
    this.place(entry);
  }

  /** The materials this chunk needs, one per LOOK group (P1.46). No specs means the geometry was built with
   *  the engine checker (the mesher emits groups only when it knows a block). Shared per spec key by the
   *  CHUNK_MATERIAL resource, so chunks showing the same blocks reuse the same GPU materials. */
  private materialsFor(geom: ChunkMeshEntry["geom"]): THREE.Material | THREE.Material[] {
    if (geom.specs.length === 0) return this.mesh.getMaterial(this.material);
    return geom.specs.map((spec) => this.mesh.getMaterial(this.material, spec));
  }

  /** Geometry is chunk-local, so the mesh sits at the chunk origin of its nearest copy */
  private place(entry: ChunkMeshEntry): void {
    const rx = nearestWrap(entry.cx, this.lastPcx, WORLD_CHUNKS_X);
    const rz = nearestWrap(entry.cz, this.lastPcz, WORLD_CHUNKS_Z);
    entry.mesh.position.set(rx * CHUNK_SIZE, entry.cy * CHUNK_SIZE, rz * CHUNK_SIZE);
    entry.mesh.updateMatrix();
  }
}
