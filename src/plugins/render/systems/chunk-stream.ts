// ===== Chunk streaming: keep the chunks around the player generated, meshed and placed =====
// Runs in the RENDER lane (presentation only: it never touches entity state).
//
// DRAWING A TORUS IN FLAT SPACE. The world wraps in X/Z (data/world/world.ts), so the same chunk
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
// both sets) is the CHUNK_MESHES resource rather than a private field: see data/globals/gfx.ts.
import * as THREE from "three/webgpu";
import { CHUNK_SIZE } from "../../../data/world/chunk";
import {
  CHUNK_Y_COUNT,
  MIN_CHUNK_Y,
  nearestWrap,
  wrapChunkX,
  wrapChunkZ,
  worldChunksX,
  worldChunksZ,
  type VoxelWorld,
} from "../../../data/world/world";
import { POSITION } from "../../player/components";
import { CHUNK_MATERIAL, CHUNK_MESHES, type ChunkFaceSpec, type ChunkMaterialState, type ChunkMeshCache, type ChunkMeshEntry } from "../../../data/globals/gfx";
import { FADE_OPTIONS, LOCAL_PLAYER, VOXEL, type FadeOptions } from "../../../data/globals/resources";
import { gatherChunkMeshInput, meshChunk, type ChunkMeshInput, type MeshResult } from "../../../data/world/mesh";
import { KEY_EVENTS, KeyEdgeReader } from "../../../data/globals/resources";
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
/** How long a chunk that APPEARS takes to fade in (P1.98). ~13 frames at 60fps: long enough to read as a fade
 *  rather than a pop, short enough that a walking player never sees a translucent wall. */
export const FADE_IN_MS = 220;
/** How long a chunk that LEAVES the window takes to fade out (P1.99). A little LONGER than the fade in on
 *  purpose: where the two meet the leaving mesh must still be there while the arriving one is still nearly
 *  invisible, or the seam shows a one-frame gap of sky. */
export const FADE_OUT_MS = 260;
/** How many meshes may be fading OUT at once. A NORMAL move retires a whole STRIP of the window rather than a
 *  handful — the window is a square, so crossing one chunk column drops ~15 columns × 8 Y chunks, measured at
 *  ~250 meshes — so this cap sits above that and is there for the MASS unload: a teleport into a world (the
 *  whole previous window, thousands of meshes) would otherwise hold every one of those GPU buffers alive for a
 *  fade nobody can see, since they are all hundreds of blocks away and behind the camera. Past this many, the
 *  rest are removed at once, exactly as they always were. */
const FADE_OUT_MAX = 512;
/** Looks re-resolved per frame after a PACK RELOAD (P1.18i). MUCH higher than the meshing budget because the
 *  work is not comparable: a re-mesh reads a 32^3 neighbourhood and rewrites every vertex buffer, while a
 *  restyle is one lookup per material group in a chunk that is already built. It is still budgeted, so the
 *  frame cannot grow with the size of the streamed window. */
const RESTYLE_BUDGET_PER_FRAME = 128;
/** Batches one SCREEN-DRIVEN drain may take (`restyleStale`): 256 × 128 = 32768 chunks, four times the whole
 *  chunk map this engine can hold (32 × 32 × 8 = 8192), so it is a runaway guard and not a limit the working
 *  case can reach (~24 batches for a 3000-chunk world). Anything left over is drained by ordinary game
 *  frames, which is what keeps a reload's screen from ever being wedged by the size of the world. */
const RESTYLE_DRAIN_BATCHES = 256;

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Scratch transform, so placing the whole window (a `place` per chunk on every column crossing) allocates
 *  nothing: `Matrix4.compose` reads them immediately. */
const _placePosition = new THREE.Vector3();

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
  /** The world's chunk-mesh cache (data/globals/gfx.ts): the parent group every mesh is added to, the
   *  meshes themselves and the "no geometry" set. It used to be three private fields plus a THREE.Group
   *  handed in as a constructor argument — the cache is GPU state that outlives a frame, so the world
   *  owns it. Resolved in the constructor BODY (iron rule 6). */
  private readonly cache: ChunkMeshCache;
  /** The material cache (CHUNK_MATERIAL): a GPU object, so the world owns it instead of chunkmesh.ts
   *  keeping a module-level `let` */
  private readonly material: ChunkMaterialState;
  /** Column offsets ordered near-first, so the ground under the player appears first. The window is a
   *  fixed square around the player's column, so this is built ONCE. */
  private offsets: ReadonlyArray<readonly [number, number]>;
  /** The debug view's key reader (H/J): its own cursor into the key-edge log, like every other consumer of
   *  a global chord — the DOM listeners are `player.input`'s. */
  private readonly keys: KeyEdgeReader;
  /** `H` draws the meshes as TRIANGLE WIREFRAME (P1.96) — the material switch. */
  private wireframe = false;
  /** THE APPEARANCE FADES (P1.98/P1.99): the chunks that are fading in or out right now.
   *
   *  IN: a chunk that APPEARS (a first build — never an edit, see `rebuild`) gets a per-chunk copy of its
   *  material, transparent at 0 opacity, and the copy is ramped to 1 and swapped back for the SHARED one.
   *  OUT: a chunk that LEAVES the window keeps its mesh in the scene and is ramped 1 → 0, and only then are
   *  the mesh, its geometry and the copies taken down — removing it on the frame it left is exactly the pop
   *  the fade exists to hide.
   *
   *  Per-chunk copies are needed because the chunk materials are shared per look by the material cache, and
   *  there are only ever a bounded number of these alive. `key` is kept so a chunk that comes BACK while it
   *  is still fading out can take its own dying mesh down (`killDying`) instead of leaving two meshes for one
   *  chunk in the scene for the length of a fade. */
  private readonly fading: Array<{ key: string; entry: ChunkMeshEntry; clones: THREE.Material[]; elapsed: number; out: boolean }> =
    [];
  /** `J` switches the fade off (P1.98) — for A/B comparing "pop" against "fade", and for a machine where the
   *  blending costs something. SESSION-ONLY: it never writes the settings file (the `fadeLod` option in the
   *  settings panel is the persisted choice — P2.01). */
  private fadeEnabled = true;
  /** The persisted fade choice, read every step (a RESOURCE, because the tick reads it — P2.01). */
  private readonly fadeOptions: FadeOptions;
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
    // The per-tier fade choice (P2.01): a resource, because this system reads it every step.
    this.fadeOptions = world.resource(FADE_OPTIONS);
    // The window: a fixed square around the player's column, ordered near-first, built once.
    const offsets: Array<[number, number]> = [];
    for (let dx = -RENDER_RADIUS_CHUNKS; dx <= RENDER_RADIUS_CHUNKS; dx++) {
      for (let dz = -RENDER_RADIUS_CHUNKS; dz <= RENDER_RADIUS_CHUNKS; dz++) {
        offsets.push([dx, dz]);
      }
    }
    offsets.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1])));
    this.offsets = offsets;

    this.keys = new KeyEdgeReader(world.resource(KEY_EVENTS));
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
    if (this.wanted === null) {
      return this.offsets.length * CHUNK_Y_COUNT;
    }
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
    const pcx = Math.floor(x / CHUNK_SIZE);
    const pcz = Math.floor(z / CHUNK_SIZE);
    const wanted = this.wantedKeys(pcx, pcz);
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

  step(deltaMs: number = 1000 / 60): void {
    // FINISHED WORK FIRST (P1.18h): a job that came back last frame is applied here, INSIDE the lane, so
    // the scene is never touched from a worker callback and the order stays deterministic.
    this.drain();
    // …and advance the appearance fades (P1.98) BEFORE this frame's builds, so a chunk built now starts at 0
    // opacity and is seen fading from the next frame on. The delta comes from the lane (the drawn-frame
    // interval), which is what makes the fade independent of the frame rate and testable in the gate.
    this.advanceFades(deltaMs);

    // H AND J: THE DEBUG VIEWS (P1.96/P1.98). The edges are published by `player.input` and every consumer
    // keeps its own cursor, so a second consumer costs the log nothing. Handled HERE because this system owns
    // the meshes and their materials — the toggles ARE material changes, and no other system may touch a
    // mesh. One drain for both, and an ODD number of presses flips (a repeat or a key release is ignored).
    let wirePresses = 0;
    let fadePresses = 0;
    this.keys.drain((edge) => {
      if (!edge.down || edge.repeat) return;
      if (edge.code === "KeyH") wirePresses++;
      else if (edge.code === "KeyJ") fadePresses++;
    });
    if ((wirePresses & 1) === 1) {
      this.wireframe = !this.wireframe;
      this.refreshMaterials();
    }
    if ((fadePresses & 1) === 1) {
      this.fadeEnabled = !this.fadeEnabled;
      // Turning it OFF ends the fades in flight at once, or the chunks that are mid-fade would stay
      // translucent for ever (nothing would ever finish them).
      if (!this.fadeEnabled) this.finishAllFades();
    }

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
    // neighbour), and input is rate-limited, so this cannot flood a frame. THEY STAY ON THIS THREAD even with
    // a pool: a worker round trip would put the mesh a frame or two behind the click, and this is the one
    // path where the player is watching one block.
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
    // thousand lookups: the mesh, its buffers and its groups all stay exactly where they are.
    //
    // The reload DRIVER normally drains this whole queue behind the loading screen (`restyleStale`), so this
    // batch is what is left for a reload that was not driven (a gate, or a world with no screen up).
    this.restyleNext();

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
    // …and the same ghost rule as `build`: whatever brings a key back, it may not leave the previous mesh
    // fading out beside the new one (P1.99). (`drain` already drops a result whose key left the window, so this
    // is the second line of defence rather than the only one.)
    this.killDying(key);
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
    this.beginFade(key, fresh); // a chunk that APPEARED fades in (P1.98)
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

  /** Re-resolve up to `limit` of the chunks a chain change marked STALE, and answer how many the queue handed
   *  back (0 = nothing left). THE SYNC CORE OF THE RELOAD, shared by its two callers: the render lane takes one
   *  batch per frame (`step`) and the reload driver takes as many as it can behind the loading screen
   *  (`restyleStale`). Public for the same reason `prime`/`warmUp` are: the gate drives it directly.
   *
   *  It meshes NOTHING and asks the pool for NOTHING — that is the whole point of the restyle path (P1.18i) —
   *  so the only cost is one look resolution per material group of a chunk that is already on screen. */
  restyleNext(limit: number = RESTYLE_BUDGET_PER_FRAME): number {
    const batch = this.voxel.takeStale(limit);
    for (const key of batch) this.restyle(key);
    return batch.length;
  }

  /** EVERYTHING a chain change invalidated: the world's stale chunks. The reload's invariant is
   *  "every mesh in CHUNK_MESHES has its looks re-resolved". */
  get restylePending(): number {
    return this.voxel.staleCount;
  }

  /** DRAIN THE WHOLE STALE QUEUE FOR A CALLER THAT CAN YIELD (P1.18i) — the pack reload driver, which runs this
   *  behind the loading screen exactly the way `enterWorld` runs `warmUp` behind it. Every batch is the same
   *  budgeted `restyleNext` the render lane uses, and `yieldTo` is the driver's `paint()`: one macrotask, so the
   *  screen stays alive (and its bar moves) while this runs.
   *
   *  WHY THE SCREEN IS THE RIGHT PLACE FOR IT: the alternative is paying it in the first game frames — 3016
   *  stale chunks at 128 a frame is ~24 frames in which the whole queue is still resolving, so the new textures
   *  appear a fraction of a second LATE and one of those frames carries the material rebuild. The reload is
   *  already an act the user waits on, and a screen that covers real work is honest.
   *
   *  BOUNDED (`RESTYLE_DRAIN_BATCHES`), so a world much larger than this one cannot wedge a reload's screen:
   *  whatever is left when the guard runs out is drained by ordinary game frames. */
  async restyleStale(
    yieldTo: () => Promise<void>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const total = this.restylePending;
    let last = -1;
    for (let guard = 0; guard < RESTYLE_DRAIN_BATCHES; guard++) {
      const left = this.restylePending;
      onProgress?.(total - left, total);
      if (left === 0) return;
      // No progress can only mean the queue is being re-marked as fast as we drain it (a second reload):
      // stop rather than spin, and let the game frames finish it.
      if (left === last) return;
      last = left;
      this.restyleNext();
      await yieldTo();
    }
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
      this.cache.meshes.delete(key);
      this.cache.empty.delete(key);
      // A job for a chunk that left the window is dropped when it comes back (`drain` checks this set).
      this.cache.inFlight.delete(key);
      // THE MESH IS NOT REMOVED HERE (P1.99): it leaves the CACHE (so nothing treats the chunk as loaded, and
      // the streaming budget may rebuild it) while it stays in the SCENE, fading out. Removing it on this frame
      // is the pop the fade exists to hide.
      if (!this.beginFadeOut(key, entry)) this.removeMesh(entry);
    }
  }

  /** Re-mesh one chunk after a block write.
   *  If the chunk already has a mesh this refills its geometry IN PLACE — no dispose, no new Mesh,
   *  no new GPU buffers. That is what removes the per-click hitch: the mesh object and its buffers
   *  survive, only the vertex data inside them is rewritten.
   *  A chunk that had no mesh needs one built, and a chunk that just lost its last visible face
   *  must go back into the "empty" set.
   *
   *  RETIRING THE IN-FLIGHT TOKEN IS PART OF THE JOB (P1.91 — measured bug). A worker result is applied only
   *  while its key is still in `cache.inFlight` (see `drain`), and the planes a job was gathered from are
   *  read BEFORE the edit: a job already out for this chunk was meshed from the world as it was, so applying
   *  it here would put the block's old geometry BACK — the face the player just exposed disappears a frame
   *  or two later. `drain`'s contract ("a key that is no longer in it was rebuilt on this thread") was
   *  documented but never implemented on this path; the edit is exactly the case that needs it. The job
   *  itself is not cancelled (a worker is told nothing): its result is simply dropped when it lands. */
  private rebuild(key: string): void {
    this.cache.inFlight.delete(key);
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

  /** A chunk's mesh, built on this thread. */
  private build(key: string): void {
    const parts = key.split(",");
    const cx = Number(parts[0]);
    const cy = Number(parts[1]);
    const cz = Number(parts[2]);

    // A chunk that is BACK while its previous mesh is still fading out: the ghost goes first, or the same
    // chunk is in the scene twice (P1.99).
    this.killDying(key);

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
    this.beginFade(key, entry); // a chunk that APPEARED fades in (P1.98)
  }

  /** The materials this chunk needs, one per LOOK group (P1.46). No specs means the geometry was built with
   *  the engine checker (the mesher emits groups only when it knows a block). Shared per spec key by the
   *  CHUNK_MATERIAL resource, so chunks showing the same blocks reuse the same GPU materials. */
  private materialsFor(geom: ChunkMeshEntry["geom"]): THREE.Material | THREE.Material[] {
    if (geom.specs.length === 0) {
      return this.debugged(this.mesh.getMaterial(this.material));
    }
    return geom.specs.map((spec) => this.debugged(this.mesh.getMaterial(this.material, spec)));
  }

  /** Apply the debug view's material switches. They are set on the material the CACHE hands back — shared per
   *  look, which is what makes ONE key press switch every chunk at once — and they are applied on EVERY
   *  resolution rather than only on the key press, so a pack reload (which drops that cache and builds fresh
   *  materials) cannot silently lose the view. `wireframe` is three.js's triangle wireframe: the mesher emits
   *  triangles, so what you see is the mesh's real triangle edges, not the block grid. */
  private debugged(material: THREE.Material): THREE.Material {
    // `wireframe` lives on the CONCRETE materials (lambert/basic), not on the `Material` base the factory is
    // typed with, so it is set through a cast and a material without one is simply left alone.
    const m = material as THREE.Material & { wireframe?: boolean };
    // THE FLAG MUST BE FOLLOWED BY A RECOMPILE. `wireframe` is not a draw-time-only setting: three.js picks the
    // pipeline's PRIMITIVE TOPOLOGY from it (triangle list vs line list) and caches a pipeline PER MATERIAL, so
    // the flag alone is not enough for the change to reach the GPU — the material has to be marked dirty. It is
    // only marked when the value actually CHANGES, or every resolution would rebuild every chunk's pipeline
    // every frame. (This is also why the gate asserts `needsUpdate` rather than only the flag.)
    if (m.wireframe !== this.wireframe) {
      m.wireframe = this.wireframe;
      m.needsUpdate = true;
    }
    return material;
  }

  /** Re-resolve every entry's material IN PLACE after a debug toggle: the geometry is untouched, so this is a
   *  material swap per chunk — exactly as cheap as the pack reload's restyle. */
  private refreshMaterials(): void {
    for (const entry of this.cache.meshes.values()) {
      entry.mesh.material = this.materialsFor(entry.geom);
    }
  }

  /** START A CHUNK'S FADE IN (P1.98). Called when a mesh is created for the first time — NEVER from `rebuild`,
   *  which is the edit the player is watching (a dug block must change instantly, P1.18i).
   *
   *  The chunk's materials are shared per look, so a per-chunk opacity needs a COPY: the copies are made from
   *  the very materials `materialsFor` just resolved (so an `H` wireframe comes along), given `transparent` +
   *  0 opacity, and swapped back for the shared ones when the fade ends. `depthWrite` stays ON: the chunk keeps
   *  occluding itself correctly (depth-tested), so a fading chunk never shows its own back faces — the only
   *  thing it blends with is what is already drawn behind it. */
  private beginFade(key: string, entry: ChunkMeshEntry): boolean {
    if (!this.fadeOn()) return false;
    return this.pushFade(key, entry, false);
  }

  /** START A CHUNK'S FADE OUT (P1.99), and answer whether the fade took the mesh over.
   *
   *  `false` means "remove it now, exactly as before": the effect is switched off (the `J` key), or so many
   *  chunks are leaving at once (a teleport's whole window) that fading them all would hold every one of their
   *  GPU buffers alive for nothing.
   *
   *  The mesh deliberately stays in the scene and the entry is ALREADY out of the cache when this is called
   *  (see `unloadOutside`): the chunk is no longer wanted, so nothing may treat it as loaded, while its pixels
   *  are still on screen for the length of the fade. `removeMesh` is the other half of the bargain. */
  private beginFadeOut(key: string, entry: ChunkMeshEntry): boolean {
    if (!this.fadeOn()) return false;
    let leaving = 0;
    for (const fade of this.fading) if (fade.out) leaving++;
    if (leaving >= FADE_OUT_MAX) return false;
    return this.pushFade(key, entry, true);
  }

  /** Does a chunk fade right now? `fadeEnabled` is the `J` key's SESSION-ONLY master switch (it never writes
   *  the file) and `fadeOptions.lod` is the persisted switch; an edit never fades (see `beginFade`, P1.18i). */
  private fadeOn(): boolean {
    return this.fadeEnabled && this.fadeOptions.lod;
  }

  /** The shared half of both directions: the per-chunk copies, `transparent`, and the fade entry. */
  private pushFade(key: string, entry: ChunkMeshEntry, out: boolean): boolean {
    const resolved = this.materialsFor(entry.geom);
    const shared = Array.isArray(resolved) ? resolved : [resolved];
    const clones = shared.map((material) => {
      const copy = material.clone();
      copy.transparent = true;
      copy.opacity = out ? 1 : 0;
      return copy;
    });
    entry.mesh.material = Array.isArray(resolved) ? clones : clones[0];
    this.fading.push({ key, entry, clones, elapsed: 0, out });
    return true;
  }

  /** TAKE A VISIBLE MESH DOWN: it is out of the scene and its geometry is freed. (The fade copies are freed by
   *  the caller, `dropFade`.) Only ever called for a mesh that has already left the cache. */
  private removeMesh(entry: ChunkMeshEntry): void {
    this.cache.group.remove(entry.mesh);
    entry.geom.dispose();
  }

  /** A chunk that left the window has COME BACK while it was still fading out: its dying mesh has to go, or the
   *  chunk would be drawn twice for the rest of that fade (once by the new mesh, once by the ghost at whatever
   *  opacity it had reached — and with the previous chain's look, if a pack reload happened in between). */
  private killDying(key: string): void {
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const fade = this.fading[i];
      if (!fade.out || fade.key !== key) continue;
      this.removeMesh(fade.entry);
      for (const clone of fade.clones) clone.dispose();
      this.fading.splice(i, 1);
    }
  }

  /** Ramp the fades in flight and finish the ones that are done. IN reaches full opacity and gets the SHARED
   *  material back; OUT reaches zero, and is then taken out of the scene.
   *
   *  A fade whose mesh no longer holds its own copies is DROPPED — that is what keeps this from needing a call
   *  in every other path — but an OUT fade is still RETIRED when that happens: its whole point is the removal,
   *  and dropping the entry without removing the mesh would leave a ghost in the scene for ever. */
  private advanceFades(deltaMs: number): void {
    if (this.fading.length === 0) return;
    // Wall-clock time is not used here: the LANE's delta is, so the fade is frame-rate independent and the gate
    // can finish one by stepping with a big delta (see `step`).
    const stepMs = Math.max(0, deltaMs);
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const fade = this.fading[i];
      const current = Array.isArray(fade.entry.mesh.material) ? fade.entry.mesh.material : [fade.entry.mesh.material];
      const mine = current[0] === fade.clones[0];
      if (!mine) {
        if (fade.out) {
          this.removeMesh(fade.entry);
          for (const clone of fade.clones) clone.dispose();
          this.fading.splice(i, 1);
        } else this.dropFade(i);
        continue;
      }
      fade.elapsed += stepMs;
      const t = fade.elapsed / (fade.out ? FADE_OUT_MS : FADE_IN_MS);
      if (t >= 1) {
        this.dropFade(i, !fade.out);
        continue;
      }
      const opacity = fade.out ? 1 - t : t;
      for (const clone of fade.clones) clone.opacity = opacity;
    }
  }

  /** End ONE fade: put the SHARED material back on the mesh (an IN fade), or take the mesh down (an OUT one),
   *  and free the copies either way. `keepMaterial` false leaves whatever the mesh holds — the caller used it
   *  when it already replaced or removed the material itself. */
  private dropFade(index: number, keepMaterial = false): void {
    const fade = this.fading[index];
    this.fading.splice(index, 1);
    if (fade.out) this.removeMesh(fade.entry);
    else if (keepMaterial) fade.entry.mesh.material = this.materialsFor(fade.entry.geom);
    for (const clone of fade.clones) clone.dispose();
  }

  /** End every fade at once (the `J` switch turning the effect off): the ones that were arriving reach full
   *  opacity now, and the ones that were leaving are taken down now. */
  private finishAllFades(): void {
    for (let i = this.fading.length - 1; i >= 0; i--) this.dropFade(i, true);
  }

  /** Geometry is chunk-local, so the mesh sits at the chunk origin of its nearest copy. */
  private place(entry: ChunkMeshEntry): void {
    const rx = nearestWrap(entry.cx, this.lastPcx, worldChunksX());
    const rz = nearestWrap(entry.cz, this.lastPcz, worldChunksZ());
    _placePosition.set(rx * CHUNK_SIZE, entry.cy * CHUNK_SIZE, rz * CHUNK_SIZE);
    entry.mesh.position.copy(_placePosition);
    entry.mesh.updateMatrix();
  }
}
