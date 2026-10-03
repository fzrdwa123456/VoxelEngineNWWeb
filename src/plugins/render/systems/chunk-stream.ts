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
import { buildLodMeshInput, fineBase, inTierAnnulus, inTierHole, lodLadder, tierOfStep, tierTint, type LodPolicy, type LodTier } from "../../../data/world/lod";
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
/** FAR-RING build budget per frame (P1.93), in COST UNITS rather than chunks, because the two kinds of far
 *  chunk cost 10× different amounts (measured: 0.33 ms for a uniform one — the sampler plus the mesher's
 *  shell early-out — against 3.0 ms for one that produces a mesh). A uniform chunk costs 1 unit, a
 *  materialised one `LOD_MESH_COST` units, so the frame is capped at roughly 6 ms either way: 18 uniform
 *  chunks, or 2 of the expensive ones, or a mix. The whole far ring is ~1.1 s of work, so it fills in as the
 *  player looks around instead of during the loading screen. */
const LOD_BUDGET_PER_FRAME = 18;
/** What a far chunk that produces geometry counts against that budget (see above). */
const LOD_MESH_COST = 9;
/** How long a chunk that APPEARS takes to fade in (P1.98). ~13 frames at 60fps: long enough to read as a fade
 *  rather than a pop, short enough that a walking player never sees a translucent wall. */
export const FADE_IN_MS = 220;
/** How long a chunk that LEAVES the window takes to fade out (P1.99). A little LONGER than the fade in on
 *  purpose: where the two meet (a coarse chunk leaving as the fine one that replaces it arrives) the leaving
 *  mesh must still be there while the arriving one is still nearly invisible, or the seam shows a one-frame
 *  gap of sky between them. */
export const FADE_OUT_MS = 260;
/** How many meshes may be fading OUT at once. A NORMAL move retires a whole STRIP of the window rather than a
 *  handful — the window is a square, so crossing one chunk column drops ~15 columns × 8 Y chunks, measured at
 *  ~250 meshes with both rings — so this cap sits above that and is there for the MASS unload: a teleport into a
 *  world (the whole previous window, thousands of meshes) would otherwise hold every one of those GPU buffers
 *  alive for a fade nobody can see, since they are all hundreds of blocks away and behind the camera. Past this
 *  many, the rest are removed at once, exactly as they always were. */
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

/** The chunk mesher, INJECTED rather than imported (the layer rule in check:ecs): a chunk geometry owns
 *  three.js buffers and the material is a GPU object, so the PLATFORM builds them and the composition root
 *  hands the factory in. The geometry's type comes from the data side (`ChunkMeshEntry`), which is what
 *  keeps this file free of a host import. */
export interface ChunkMeshFactory {
  createGeometry(): ChunkMeshEntry["geom"];
  /** `tint` is the DEBUG VIEW's colour for this mesh's LOD tier (null = the real look). A host that ignores
   *  it draws the world normally, which is what a test factory does. */
  getMaterial(state: ChunkMaterialState, spec?: ChunkFaceSpec, tint?: string | null): THREE.Material;
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
  /** Column offsets ordered near-first, so the ground under the player appears first. With no LOD this is the
   *  whole window and never changes; with LOD it is REBUILT per window position (`buildLadder`), because rung 1's
   *  range is cropped onto the second rung's grid. */
  private offsets: ReadonlyArray<readonly [number, number]>;
  /** THE LADDER IN FORCE (P2.03): one entry per rung the world's lap can hold, with the cells it draws and the
   *  ones it only builds (its reserve). REBUILT whenever the window moves (`buildLadder`): the cells are aligned
   *  to the WORLD so they never shift under the player, but the ranges that cover the window are measured from
   *  the window's own centre, and a rung's two ends fall asymmetrically whenever that centre is off its grid. */
  private tiers: ReadonlyArray<{
    readonly step: number;
    readonly hole: number;
    readonly reach: number;
    readonly draw: ReadonlyArray<readonly [number, number]>;
    readonly reserve: ReadonlyArray<readonly [number, number]>;
  }>;
  /** The SAME ladder as `tiers`, in `lod.ts`'s own shape: the ranges the visibility test and the reserve logic
   *  ask about (a rung's hole, its coverage, whether a cell is inside them). Kept beside the key lists because
   *  the keys are what the build budget walks and the ranges are what a frame QUERIES. */
  private ladder: readonly LodTier[] = [];
  /** The window centre `ladder`/`offsets` were built for, so a query about a DIFFERENT position (the entry's
   *  `needsWarmUp` asks about the spawn before anything has stepped) builds it rather than reading an empty
   *  window — an empty window answers "nothing to build", which would enter a world with no loading screen and
   *  no primed chunks (`prime` lives inside that branch). */
  private ladderCentre: readonly [number, number] | null = null;
  /** The palette values the far ring writes, resolved once: a coarse chunk is procedural, so it is handed the
   *  layer values instead of asking the world for them (see data/world/lod.ts). */
  private readonly layers: { readonly stone: number; readonly dirt: number; readonly grass: number };
  /** The LOD VIEW (P1.94): `G` tints every mesh by its tier. Its own cursor into the key-edge log, like every
   *  other consumer of a global chord (ui.picker, ui.navigation) — the DOM listeners are `player.input`'s. */
  private readonly keys: KeyEdgeReader;
  private lodTint = false;
  /** `H` draws the meshes as TRIANGLE WIREFRAME (P1.96) — the same material switch, one flag further. */
  private wireframe = false;
  /** THE FAR RING'S LOOK QUEUE (P1.97). A chain change cannot mark the far ring through the WORLD: it is
   *  procedural and holds no chunk in the voxel map (P1.93), so `VoxelWorld.markAllStale()` never names it and
   *  every already-loaded far chunk kept the previous chain's materials — new textures only appeared once a
   *  far chunk was built or rebuilt. `markFarStale()` fills this from the MESH CACHE instead, and the same
   *  budgeted restyle pass drains it. */
  private readonly farStale = new Set<string>();
  /** THE APPEARANCE FADES (P1.98/P1.99): the chunks that are fading in or out right now.
   *
   *  IN: a chunk that APPEARS (a first build — never an edit, see `rebuild`) gets a per-chunk copy of its
   *  material, transparent at 0 opacity, and the copy is ramped to 1 and swapped back for the SHARED one.
   *  OUT: a chunk that LEAVES the window keeps its mesh in the scene and is ramped 1 → 0, and only then are
   *  the mesh, its geometry and the copies taken down — removing it on the frame it left is exactly the pop
   *  the fade exists to hide (and at the ring boundary it left on the same frame the fine chunk replacing it
   *  started fading in).
   *
   *  Per-chunk copies are needed because the chunk materials are shared per (look, tier) by the material
   *  cache, and there are only ever a bounded number of these alive. `key` is kept so a chunk that comes
   *  BACK while it is still fading out can take its own dying mesh down (`killDying`) instead of leaving two
   *  meshes for one chunk in the scene for the length of a fade. */
  private readonly fading: Array<{ key: string; entry: ChunkMeshEntry; clones: THREE.Material[]; elapsed: number; out: boolean }> =
    [];
  /** `J` switches the fade off (P1.98) — for A/B comparing "pop" against "fade", and for a machine where the
   *  blending costs something. SESSION-ONLY: it is the master switch over both tiers and never writes the
   *  settings file (the `lod`/`chunks` options in the settings panel are the persisted choice — P2.01). */
  private fadeEnabled = true;
  /** The persisted per-tier fade choice, read every step (a RESOURCE, because the tick reads it — P2.01). */
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
  /** The far ring's wanted keys (P1.93). null when LOD is off, which is the single-fine-window shape. */
  private get farWanted(): Set<string> | null {
    return this.cache.farKeys;
  }
  private set farWanted(v: Set<string> | null) {
    this.cache.farKeys = v;
  }

  constructor(
    private readonly world: World,
    /** The platform's mesher (see ChunkMeshFactory). */
    private readonly mesh: ChunkMeshFactory = NO_MESH,
    /** The worker pool, when the platform has one (P1.18h). Absent = every mesh is built on this thread,
     *  which is exactly what the engine did before, and what the Node gate still does. */
    private readonly pool: MeshWorkerPool | null = null,
    /** THE FAR RING (P1.93 — data/world/lod.ts): absent = the engine's original single FINE window, which is
     *  the shape the worker/streaming tests drive. Present = the window becomes a fine ring plus a coarse ring
     *  drawn from the same terrain at `step` fine chunks per coarse one. Injected like the pool is: "does this
     *  install do LOD" is a capability of the composition, not something a system decides for itself. */
    private readonly lod: LodPolicy | null = null,
  ) {
    this.index = entityIndex(world.resource(LOCAL_PLAYER));
    this.voxel = world.resource(VOXEL);
    this.cache = world.resource(CHUNK_MESHES);
    this.material = world.resource(CHUNK_MATERIAL);
    // The per-tier fade choice (P2.01): a resource, because this system reads it every step.
    this.fadeOptions = world.resource(FADE_OPTIONS);
    // THE FINE WINDOW when there is no LOD at all: the original square, built once.
    const offsets: Array<[number, number]> = [];
    if (this.lod === null) {
      for (let dx = -RENDER_RADIUS_CHUNKS; dx <= RENDER_RADIUS_CHUNKS; dx++) {
        for (let dz = -RENDER_RADIUS_CHUNKS; dz <= RENDER_RADIUS_CHUNKS; dz++) {
          offsets.push([dx, dz]);
        }
      }
      offsets.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1])));
    }
    this.offsets = offsets;
    this.tiers = [];

    // The layer values in the palette IN FORCE, read once (the palette only changes at boot and on a reload).
    const stone = this.voxel.valueOf("stone") || 1;
    const dirt = this.voxel.valueOf("dirt") || stone;
    this.layers = { stone, dirt, grass: this.voxel.valueOf("grass") || dirt };
    this.keys = new KeyEdgeReader(world.resource(KEY_EVENTS));
  }

  /** Generate (without meshing) every chunk in the window around a world position. Called once
   *  before the loop starts, so collision has real blocks on the very first tick. */
  prime(x: number, z: number): void {
    // …and the SAME alignment: `prime` fills the world for the window `step()` will mesh, so a raw column here
    // would generate one set of chunks and mesh another (with LOD, every odd column did exactly that).
    const pcx = fineBase(this.lod, Math.floor(x / CHUNK_SIZE));
    const pcz = fineBase(this.lod, Math.floor(z / CHUNK_SIZE));
    for (const [dx, dz] of this.offsets) {
      for (let cy = MIN_CHUNK_Y; cy < MIN_CHUNK_Y + CHUNK_Y_COUNT; cy++) {
        this.voxel.ensureChunk(pcx + dx, cy, pcz + dz);
      }
    }
  }

  /** REBUILD THE LADDER for the window at `(pcx, pcz)` (fine chunk columns — the window's own centre).
   *
   *  Why this is not just a constructor's job (P2.03): a rung's cells are aligned to the WORLD (a coarse cell
   *  must not move as the player walks, or the far terrain would crawl), but the RANGES that cover the window
   *  are measured from the window's centre, and the two ends of a rung fall asymmetrically whenever that centre
   *  is not on the rung's own grid. Those ranges change as the player crosses a column, so they are recomputed
   *  here — a handful of integers per rung, next to the key sets the move already builds. */
  private buildLadder(pcx: number, pcz: number): void {
    if (this.lod === null) {
      this.tiers = [];
      this.ladder = [];
      return;
    }
    const ladder = lodLadder(this.lod, worldChunksX(), pcx * CHUNK_SIZE, pcz * CHUNK_SIZE);
    this.ladder = ladder;
    this.ladderCentre = [pcx, pcz];
    const nearFirst = (a: readonly [number, number], b: readonly [number, number]) =>
      Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1]));
    const tiers: Array<{
      step: number;
      hole: number;
      reach: number;
      draw: ReadonlyArray<readonly [number, number]>;
      reserve: ReadonlyArray<readonly [number, number]>;
    }> = [];
    for (const tier of ladder) {
      const draw: Array<[number, number]> = [];
      const reserve: Array<[number, number]> = [];
      // RUNG 1 IS THE FINE RING: its cells are `wanted` (real 32³ chunks), not coarse keys — a `1:` key would
      // be a procedural copy of a chunk the world already has, drawn in the same place.
      if (tier.step === 1) {
        tiers.push({ step: tier.step, hole: tier.hole, reach: tier.reach, draw, reserve });
        continue;
      }
      // The cells are the two ranges INTERSECTED (a rung with a hole on one axis only cannot happen — the
      // recursion crops both axes together — but intersecting keeps the loop honest whatever the ladder says).
      for (let cx = tier.x.lo; cx < tier.x.hi; cx++) {
        for (let cz = tier.z.lo; cz < tier.z.hi; cz++) {
          if (inTierAnnulus(tier, cx, cz)) draw.push([cx, cz]);
          else if (inTierHole(tier, cx, cz)) reserve.push([cx, cz]);
        }
      }
      draw.sort(nearFirst);
      reserve.sort(nearFirst);
      tiers.push({ step: tier.step, hole: tier.hole, reach: tier.reach, draw, reserve });
    }
    this.tiers = tiers;
    // THE FINE RING is rung 1: its own ranges, so the fine window and the coarse rings cannot disagree about
    // where the window ends (that boundary is where the P1.94 empty column lived).
    const fine = ladder[0];
    const offsets: Array<[number, number]> = [];
    for (let dx = fine.x.lo; dx < fine.x.hi; dx++) {
      for (let dz = fine.z.lo; dz < fine.z.hi; dz++) {
        offsets.push([dx, dz]);
      }
    }
    offsets.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1])));
    this.offsets = offsets;
  }

  /** Make sure the ladder and the window's `offsets` describe the window at `(pcx, pcz)`. Cheap when they
   *  already do (two integer comparisons), so every reader may ask. */
  private ensureLadder(pcx: number, pcz: number): void {
    if (this.lod === null) return;
    if (this.ladderCentre !== null && this.ladderCentre[0] === pcx && this.ladderCentre[1] === pcz) return;
    this.buildLadder(pcx, pcz);
  }

  /** Chunks in the window whose mesh has not been DECIDED yet — neither built nor known to be empty
   *  (a uniform chunk has no visible face and is never retried, so "no mesh" is a real answer). */
  pendingCount(): number {
    if (this.wanted === null) {
      // BEFORE the first step there is no window yet — and with LOD the OFFSETS are built per position too
      // (`ensureLadder`), so answering from an empty window would tell every caller "there is no work": a
      // driver's load bar, `warmUp` and the gate's fill loops all ask this question first, and a false "nothing
      // to do" is a world that streams in over the next hundred frames instead of behind the screen.
      this.ensureLadder(
        fineBase(this.lod, Math.floor(POSITION.x[this.index] / CHUNK_SIZE)),
        fineBase(this.lod, Math.floor(POSITION.z[this.index] / CHUNK_SIZE)),
      );
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
    // The same ALIGNMENT the window builder uses (see step): a warm-up asked about a different column set than
    // the one it will build would answer "everything is decided" and skip the screen for a cold window.
    const pcx = fineBase(this.lod, Math.floor(x / CHUNK_SIZE));
    const pcz = fineBase(this.lod, Math.floor(z / CHUNK_SIZE));
    this.ensureLadder(pcx, pcz); // …and the ladder/offsets that answer it must be THIS window's
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

    // G, H AND J: THE DEBUG VIEWS (P1.94/P1.96/P1.98). The edges are published by `player.input` and every
    // consumer keeps its own cursor, so a second consumer costs the log nothing. Handled HERE because this
    // system owns the meshes and their materials — the toggles ARE material changes, and no other system may
    // touch a mesh. One drain for all three, and an ODD number of presses flips (a repeat or a key release is
    // ignored).
    let tintPresses = 0;
    let wirePresses = 0;
    let fadePresses = 0;
    this.keys.drain((edge) => {
      if (!edge.down || edge.repeat) return;
      if (edge.code === "KeyG") tintPresses++;
      else if (edge.code === "KeyH") wirePresses++;
      else if (edge.code === "KeyJ") fadePresses++;
    });
    if ((tintPresses & 1) === 1) {
      this.lodTint = !this.lodTint;
      this.refreshMaterials();
    }
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

    // THE FINE WINDOW IS COARSE-ALIGNED (P1.94 — measured bug). `fineBase` rounds the player's column DOWN to
    // the coarse grid the far ring's inner hole is built on; without it every odd column left one fine column
    // owned by neither ring (a 32-block-wide, full-depth hole) and one owned by both. With no LOD it is the
    // identity, so the single-window path is unchanged.
    const pcx = fineBase(this.lod, Math.floor(POSITION.x[this.index] / CHUNK_SIZE));
    const pcz = fineBase(this.lod, Math.floor(POSITION.z[this.index] / CHUNK_SIZE));
    const moved = pcx !== this.lastPcx || pcz !== this.lastPcz;
    this.lastPcx = pcx;
    this.lastPcz = pcz;

    // …and THE LADDER follows the window: the rungs' cells do not move, but which of them cover the window do
    // (see `buildLadder`). Before the key sets, because they are built FROM it.
    this.ensureLadder(pcx, pcz);

    if (moved || this.wanted === null) {
      this.wanted = this.wantedKeys(pcx, pcz);
      this.farWanted = this.farKeys(pcx, pcz);
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

    // THE FAR RING (P1.93): a separate budget, spent in COST UNITS (see LOD_BUDGET_PER_FRAME), and it NEVER
    // goes to the pool — a coarse chunk is procedural (data/world/lod.ts samples the height field; the world
    // is not read at all), so there is nothing to hand a worker and nothing to transfer back. It also costs
    // the world NOTHING: no chunk is generated for it, so a far ring 3× the fine ring's width adds no voxel
    // memory at all.
    if (this.farWanted !== null) {
      let far = LOD_BUDGET_PER_FRAME;
      for (const key of this.farWanted) {
        if (far <= 0) break;
        if (this.cache.meshes.has(key) || this.cache.empty.has(key)) continue;
        far -= this.buildFar(key);
      }
    }

    if (moved) {
      for (const entry of this.cache.meshes.values()) this.place(entry);
    }

    // …and decide which of the coarse chunks under the fine ring are needed THIS frame (P2.00). Last, because it
    // reads the state the whole step produced: the window (which columns the fine ring owns now), whether the
    // fine chunks of a covered column are all there (the build loops above may have finished them) and whether
    // any of them is still fading (a fade is a translucent chunk — the reserve must stay visible under it, or
    // the player would look through the fading fine mesh at the sky).
    this.refreshFarVisibility();
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
        entry.mesh.material = this.materialsFor(entry.geom, entry.step);
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
    const mesh = new THREE.Mesh(geom.geometry, this.materialsFor(geom, 1));
    mesh.matrixAutoUpdate = false;
    // A POOL result is always a FINE chunk: the far ring is procedural and never goes to a worker.
    const fresh: ChunkMeshEntry = {
      mesh,
      geom,
      cx: Number(parts[0]),
      cy: Number(parts[1]),
      cz: Number(parts[2]),
      step: 1,
    };
    this.cache.group.add(mesh);
    this.cache.meshes.set(key, fresh);
    this.place(fresh);
    this.beginFade(key, fresh); // a chunk that APPEARED fades in (P1.98)
  }

  /** How many rungs the ladder in force has (P2.03) — the LAP caps it (`lodLadder`), so the entry can report
   *  the truth instead of the number the policy asked for. */
  get lodTiers(): number {
    return this.tiers.length;
  }

  /** THE WORLD SIZE CHANGED (P2.02): drop every mesh, every "decided" answer and the window bookkeeping.
   *
   *  Called by the world-entry driver, before the new world is primed, and only when the size actually moved.
   *  It is the render half of `VoxelWorld.reset`: a mesh belongs to the OLD lap (its key is a wrapped identity,
   *  its geometry was generated from the old period), so nothing here may survive — the next `step()` decides
   *  the whole window again and the warm-up rebuilds it behind the loading screen.
   *
   *  `wanted = null` is what makes `needsWarmUp` answer "yes, there is work": the driver asks it BEFORE it
   *  builds, so this is also what puts the loading screen up for the new world instead of showing the old
   *  terrain for a frame. */
  resetForNewWorld(): void {
    for (const entry of this.cache.meshes.values()) {
      this.cache.group.remove(entry.mesh);
      entry.geom.dispose();
    }
    this.cache.meshes.clear();
    this.cache.empty.clear();
    this.cache.inFlight.clear();
    for (const fade of this.fading) for (const clone of fade.clones) clone.dispose();
    this.fading.length = 0;
    this.farStale.clear();
    this.wanted = null;
    this.farWanted = null;
    // The LADDER goes too: the lap decides how many rungs fit, so the one built for the old world is not even
    // the right SHAPE any more, and `ladderCentre = null` is what makes the next query rebuild it.
    this.ladderCentre = null;
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
    entry.mesh.material = this.materialsFor(entry.geom, entry.step);
  }

  /** Re-resolve up to `limit` of the chunks a chain change marked STALE, and answer how many the queue handed
   *  back (0 = nothing left). THE SYNC CORE OF THE RELOAD, shared by its two callers: the render lane takes one
   *  batch per frame (`step`) and the reload driver takes as many as it can behind the loading screen
   *  (`restyleStale`). Public for the same reason `prime`/`warmUp` are: the gate drives it directly.
   *
   *  It meshes NOTHING and asks the pool for NOTHING — that is the whole point of the restyle path (P1.18i) —
   *  so the only cost is one look resolution per material group of a chunk that is already on screen.
   *
   *  BOTH QUEUES, ONE BUDGET (P1.97): the world's stale chunks (the fine ring) AND this system's own far-ring
   *  queue. They are two independent sources of meshes, and a chain change invalidates both. */
  restyleNext(limit: number = RESTYLE_BUDGET_PER_FRAME): number {
    const batch = this.voxel.takeStale(limit);
    for (const key of batch) this.restyle(key);
    // The far ring's queue, with whatever is left of the budget. Deleting from a Set while iterating it is safe.
    for (const key of this.farStale) {
      if (batch.length >= limit) break;
      this.farStale.delete(key);
      this.restyle(key);
      batch.push(key);
    }
    return batch.length;
  }

  /** EVERYTHING a chain change invalidated: the world's chunks plus the far ring. The reload's invariant is
   *  "every mesh in CHUNK_MESHES has its looks re-resolved", and the far ring is the second source of meshes in
   *  there — the one the world knows nothing about. */
  get restylePending(): number {
    return this.voxel.staleCount + this.farStale.size;
  }

  /** Mark every FAR-RING mesh for a look re-resolution (P1.97 — the pack reload calls this next to
   *  `VoxelWorld.markAllStale`). Answers how many. A far entry's mesh is re-resolved by the same `restyle` the
   *  fine ring uses: the geometry keeps its `(value, kind)` slots, so only the look → material list changes —
   *  nothing is meshed, nothing is generated, nothing is handed to a worker. */
  markFarStale(): number {
    let n = 0;
    for (const [key, entry] of this.cache.meshes) {
      if (entry.step <= 1) continue; // 1 = a real chunk, which the WORLD's queue already covers
      this.farStale.add(key);
      n++;
    }
    return n;
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
    const total = this.restylePending; // the world's chunks AND the far ring (P1.97)
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

  /** THE LADDER's wanted keys (P1.93/P2.03), in each rung's COARSE columns, ordered rung by rung and
   *  near-first inside a rung.
   *
   *  The key is `"<step>:<cx>,<cy>,<cz>"`: the prefix is what keeps a coarse identity from EVER being confused
   *  with a finer one. That matters because every rung lives in the same `meshes`/`empty` maps, while the
   *  world's dirty keys (`takeDirty`, `markDirty`) are fine keys in fine units — an edit must never be able to
   *  name a coarse entry, because a coarse chunk is procedural and has nothing to rebuild (see lod.ts).
   *
   *  Empty when LOD is off, which is what keeps the single-window path byte-for-byte what it was.
   *
   *  INSIDE A RUNG, THE DRAWN ANNULUS COMES FIRST, THEN THE RESERVE (P2.00). Both are in the same set and the
   *  build budget walks it in order, so a world entry fills the ring the player can SEE first (the reserve is
   *  invisible and only needed once the window starts to move — and a column spends the whole width of its rung
   *  in the reserve before it is needed). */
  private farKeys(pcx: number, pcz: number): Set<string> {
    const out = new Set<string>();
    if (this.lod === null) return out;
    for (const tier of this.tiers) {
      if (tier.draw.length === 0) continue; // rung 1 IS the fine ring: it has no coarse keys
      const period = worldChunksX() / tier.step; // the torus in this rung's columns
      const ccx = Math.floor(pcx / tier.step);
      const ccz = Math.floor(pcz / tier.step);
      const wrap = (v: number): number => ((v % period) + period) % period;
      for (const offsets of [tier.draw, tier.reserve]) {
        for (const [dx, dz] of offsets) {
          const cx = wrap(ccx + dx);
          const cz = wrap(ccz + dz);
          for (let cy = MIN_CHUNK_Y + CHUNK_Y_COUNT - 1; cy >= MIN_CHUNK_Y; cy--) {
            out.add(`${tier.step}:${cx},${cy},${cz}`);
          }
        }
      }
    }
    return out;
  }

  private unloadOutside(wanted: Set<string>): void {
    const far = this.farWanted;
    for (const [key, entry] of this.cache.meshes) {
      if (wanted.has(key) || (far !== null && far.has(key))) continue;
      this.cache.meshes.delete(key);
      this.cache.empty.delete(key);
      // A job for a chunk that left the window is dropped when it comes back (`drain` checks this set).
      this.cache.inFlight.delete(key);
      // THE MESH IS NOT REMOVED HERE (P1.99): it leaves the CACHE (so nothing treats the chunk as loaded, and
      // the streaming budget may rebuild it) while it stays in the SCENE, fading out. Removing it on this frame
      // is the pop the fade exists to hide — and at the ring boundary the mesh that leaves is the coarse one the
      // fine chunk replacing it has only just started to fade in behind.
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
        entry.mesh.material = this.materialsFor(entry.geom, entry.step);
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

  /** A FINE chunk's mesh, built on this thread. (Fine keys only: `rebuild`/`queueBuild`/`drain` all speak in
   *  fine identities, while a far entry is `"<step>:cx,cy,cz"` and never reaches this path.) */
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

    const mesh = new THREE.Mesh(geom.geometry, this.materialsFor(geom, 1));
    mesh.matrixAutoUpdate = false;
    const entry: ChunkMeshEntry = { mesh, geom, cx, cy, cz, step: 1 };
    this.cache.group.add(mesh);
    this.cache.meshes.set(key, entry);
    this.place(entry);
    this.beginFade(key, entry); // a chunk that APPEARED fades in (P1.98)
  }

  /** A COARSE chunk's mesh (P1.93/P2.03 — any rung of the ladder). Procedural and main-thread:
   *  `buildLodMeshInput` samples the height field for the whole chunk plus its six planes, so this reads NO world
   *  chunk, allocates no voxel data and hands nothing to a worker. The result is applied through the same
   *  geometry path a worker's result takes, so a coarse mesh and a fine one are indistinguishable to the draw —
   *  the only difference is `step` (read from the KEY, so one function serves every rung), which the placement
   *  turns into the mesh's scale and the material factory into the tier's tint.
   *  Returns what the chunk cost the frame's far budget: `LOD_MESH_COST` when it produced geometry, 1 when it
   *  was uniform (or produced no face), which is the 10× difference the budget is spent in. */
  private buildFar(key: string): number {
    if (this.lod === null) return 0;
    const colon = key.indexOf(":");
    const step = Number(key.slice(0, colon));
    const parts = key.slice(colon + 1).split(",");
    const cx = Number(parts[0]);
    const cy = Number(parts[1]);
    const cz = Number(parts[2]);

    this.killDying(key); // a coarse chunk that came back while its ghost was still fading out (P1.99)

    const input = buildLodMeshInput(
      step,
      cx,
      cy,
      cz,
      this.layers.stone,
      this.layers.dirt,
      this.layers.grass,
    );
    const result = meshChunk(input);
    const geom = this.mesh.createGeometry();
    if (geom.apply(this.voxel, result) === 0) {
      geom.dispose();
      this.cache.empty.add(key);
      return 1;
    }
    const mesh = new THREE.Mesh(geom.geometry, this.materialsFor(geom, step));
    mesh.matrixAutoUpdate = false;
    const entry: ChunkMeshEntry = { mesh, geom, cx, cy, cz, step };
    this.cache.group.add(mesh);
    this.cache.meshes.set(key, entry);
    this.place(entry);
    this.beginFade(key, entry); // a coarse chunk that APPEARED fades in too (P1.98)
    return LOD_MESH_COST;
  }

  /** The materials this chunk needs, one per LOOK group (P1.46). No specs means the geometry was built with
   *  the engine checker (the mesher emits groups only when it knows a block). Shared per spec key by the
   *  CHUNK_MATERIAL resource, so chunks showing the same blocks reuse the same GPU materials.
   *  `step` is the chunk's LOD tier: with the debug view on, the tier's colour is handed to the factory (which
   *  keys its cache by it), so a tinted world costs one extra material per (look, tier) — not one per chunk. */
  private materialsFor(geom: ChunkMeshEntry["geom"], step: number): THREE.Material | THREE.Material[] {
    const tint = this.lodTint ? tierTint(step) : null;
    if (geom.specs.length === 0) {
      return this.debugged(this.mesh.getMaterial(this.material, undefined, tint));
    }
    return geom.specs.map((spec) => this.debugged(this.mesh.getMaterial(this.material, spec, tint)));
  }

  /** Apply the debug view's material switches. They are set on the material the CACHE hands back — shared per
   *  (look, tier), which is what makes ONE key press switch every chunk at once — and they are applied on
   *  EVERY resolution rather than only on the key press, so a pack reload (which drops that cache and builds
   *  fresh materials) cannot silently lose the view. `wireframe` is three.js's triangle wireframe: the mesher
   *  emits triangles, so what you see is the mesh's real triangle edges, not the block grid. */
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
      entry.mesh.material = this.materialsFor(entry.geom, entry.step);
    }
  }

  /** START A CHUNK'S FADE IN (P1.98). Called when a mesh is created for the first time — NEVER from `rebuild`,
   *  which is the edit the player is watching (a dug block must change instantly, P1.18i).
   *
   *  The chunk's materials are shared per (look, tier), so a per-chunk opacity needs a COPY: the copies are made
   *  from the very materials `materialsFor` just resolved (so a `G` tint or an `H` wireframe comes along), given
   *  `transparent` + 0 opacity, and swapped back for the shared ones when the fade ends. `depthWrite` stays ON:
   *  the chunk keeps occluding itself correctly (depth-tested), so a fading chunk never shows its own back
   *  faces — the only thing it blends with is what is already drawn behind it. */
  private beginFade(key: string, entry: ChunkMeshEntry): void {
    if (!this.fadeOn(entry.step)) return;
    this.pushFade(key, entry, false);
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
    if (!this.fadeOn(entry.step)) return false;
    let leaving = 0;
    for (const fade of this.fading) if (fade.out) leaving++;
    if (leaving >= FADE_OUT_MAX) return false;
    return this.pushFade(key, entry, true);
  }

  /** Does this chunk fade right now? ONE answer for EVERY chunk (P2.05 — the user's request, and it retires the
   *  per-rung rule of P2.01/P2.04): a mesh that APPEARS fades in and one that LEAVES fades out, whether it is a
   *  real 32³ chunk of the fine ring or a coarse cell of any LOD rung. Which rung a chunk belongs to is an
   *  implementation detail of the window, not something the player should have to reason about — and the reserve
   *  (P2.00) makes it safe: a coarse cell stays drawn until the finer chunks over it are BUILT AND OPAQUE, so a
   *  translucent chunk never uncovers the sky, it only lets the coarser level show through while it arrives.
   *
   *  `fadeEnabled` is the `J` key's SESSION-ONLY master switch (it never writes the file) and `lod` is the
   *  persisted switch; an edit never fades (see `beginFade`, P1.18i). */
  private fadeOn(_step: number): boolean {
    return this.fadeEnabled && this.fadeOptions.lod;
  }

  /** The shared half of both directions: the per-chunk copies, `transparent`, and the fade entry. */
  private pushFade(key: string, entry: ChunkMeshEntry, out: boolean): boolean {
    const resolved = this.materialsFor(entry.geom, entry.step);
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
    else if (keepMaterial) fade.entry.mesh.material = this.materialsFor(fade.entry.geom, fade.entry.step);
    for (const clone of fade.clones) clone.dispose();
  }

  /** End every fade at once (the `J` switch turning the effect off): the ones that were arriving reach full
   *  opacity now, and the ones that were leaving are taken down now. */
  private finishAllFades(): void {
    for (let i = this.fading.length - 1; i >= 0; i--) this.dropFade(i, true);
  }

  /** Geometry is chunk-local, so the mesh sits at the chunk origin of its nearest copy.
   *
   *  A FAR entry is placed in COARSE units — its `cx`/`cz` count `step` fine chunks each, its geometry's
   *  super voxels are `step` blocks across — so the origin is scaled by `step` in X/Z AND the mesh gets
   *  `scale = (step, 1, step)`. That one scale is what turns a 32×32 super-voxel face into a `32·step`-block
   *  face; every normal stays axis-aligned, so nothing else has to know. Y is never decimated, so `cy` and the
   *  vertical extent are the same units in both rings. */
  private place(entry: ChunkMeshEntry): void {
    const step = entry.step;
    const pcx = step === 1 ? this.lastPcx : Math.floor(this.lastPcx / step);
    const pcz = step === 1 ? this.lastPcz : Math.floor(this.lastPcz / step);
    const rx = nearestWrap(entry.cx, pcx, worldChunksX() / step);
    const rz = nearestWrap(entry.cz, pcz, worldChunksZ() / step);
    entry.mesh.position.set(rx * CHUNK_SIZE * step, entry.cy * CHUNK_SIZE, rz * CHUNK_SIZE * step);
    entry.mesh.scale.set(step, 1, step);
    entry.mesh.updateMatrix();
  }

  /** WHICH COARSE CHUNKS ARE DRAWN (P2.00). A coarse chunk the fine ring covers is the READY RESERVE: it is
   *  drawn only while the fine chunks of its column are not all there yet, and hidden the moment they are.
   *
   *  The swap is what removes the seam flash. Walking, the fine ring's trailing column leaves and its coarse
   *  chunk — built long before, while it was still hidden — is drawn in the SAME frame; the reverse at the
   *  leading edge is a coarse chunk staying up a little longer, until the fine chunks that replace it are
   *  built AND opaque. Both directions keep terrain on screen the whole time, which is the property three
   *  reference implementations get from nesting their levels (see `isFarBuildColumn`).
   *
   *  Cheap enough to run every frame: only the covered columns need the test (a column outside the fine ring is
   *  always drawn), and the answer is memoised per column, so one column costs 4 × `CHUNK_Y_COUNT` lookups plus
   *  four fade-set probes. */
  private refreshFarVisibility(): void {
    if (this.lod === null || this.tiers.length <= 1) return;
    // The COLUMN identities with a chunk mid-FADE-IN, in ONE pass over the fades and keyed BY THE RUNG the
    // chunk belongs to: a rung's reserve must stay on screen while the FINER chunk that covers it is still
    // translucent, or the player looks through the fading mesh at the sky. Keyed by rung because the answer is
    // always asked of the rung immediately inside (`finerColumnFading`) — a chunk's own fade never holds its
    // OWN reserve up, which is the difference between a hidden reserve and a coarse surface drawn over real
    // terrain for the length of a fade (the gate's "NONE of them is drawn" assertion caught exactly that).
    const fading = new Map<number, Set<string>>();
    for (const fade of this.fading) {
      if (fade.out) continue;
      const colon = fade.key.indexOf(":");
      const step = colon >= 0 ? Number(fade.key.slice(0, colon)) : 1;
      const parts = (colon >= 0 ? fade.key.slice(colon + 1) : fade.key).split(",");
      let columns = fading.get(step);
      if (columns === undefined) {
        columns = new Set<string>();
        fading.set(step, columns);
      }
      columns.add(`${parts[0]},${parts[2]}`);
    }
    const decided = new Map<string, boolean>();
    for (const entry of this.cache.meshes.values()) {
      if (entry.step <= 1) continue;
      const tier = tierOfStep(this.ladder, entry.step);
      if (tier === null) continue;
      const period = worldChunksX() / entry.step;
      const ccx = Math.floor(this.lastPcx / entry.step);
      const ccz = Math.floor(this.lastPcz / entry.step);
      const rx = nearestWrap(entry.cx, ccx, period);
      const rz = nearestWrap(entry.cz, ccz, period);
      // OUTSIDE ITS HOLE the rung is simply drawn: nothing finer covers it.
      if (!inTierHole(tier, rx - ccx, rz - ccz)) {
        entry.mesh.visible = true;
        continue;
      }
      // INSIDE IT, the chunk is the READY RESERVE (P2.00): drawn only while the chunks of the rung INSIDE this
      // one are missing — and until they are opaque, because a translucent chunk over nothing is the sky showing
      // through it. One memo per column covers all `CHUNK_Y_COUNT` chunks of it.
      const memoKey = `${entry.step}:${rx},${rz}`;
      let ready = decided.get(memoKey);
      if (ready === undefined) {
        ready = !this.finerColumnFading(entry.step, rx, rz, fading) && this.finerColumnDecided(entry.step, rx, rz);
        decided.set(memoKey, ready);
      }
      entry.mesh.visible = !ready;
    }
  }

  /** Is a chunk of the rung IMMEDIATELY INSIDE this one — the 2×2 cells of the next finer rung that cover
   *  `(ccx, ccz)` — still FADING IN? A fade is a translucent chunk, so the coarser chunk under it must stay on
   *  screen; hiding the reserve the moment the finer geometry exists would show the sky through it. */
  private finerColumnFading(step: number, ccx: number, ccz: number, fading: Map<number, Set<string>>): boolean {
    const finer = step > 2 ? step / 2 : 1;
    const columns = fading.get(finer);
    if (columns === undefined) return false;
    const [fx, fz] = this.finerCells(finer, ccx, ccz);
    for (let dx = 0; dx < 2; dx++) {
      for (let dz = 0; dz < 2; dz++) {
        if (columns.has(`${fx[dx]},${fz[dz]}`)) return true;
      }
    }
    return false;
  }

  /** The 2×2 cells of the rung INSIDE `step` that cover the cell `(ccx, ccz)`, as WRAPPED identities in that
   *  rung's own cell space. A coarse cell is twice as wide on each axis, so its children are the cells
   *  `2·cc` and `2·cc + 1` — measured in the FINER rung's space and wrapped by the FINER rung's period, which
   *  is what a key holds (wrapping by the fine period instead left the ring's children unmatchable at the torus
   *  seam: a rung-3 reserve stayed drawn for ever just outside the wrap). */
  private finerCells(finer: number, ccx: number, ccz: number): [number[], number[]] {
    const wrap = (v: number): number => {
      const period = worldChunksX() / finer;
      return ((v % period) + period) % period;
    };
    return [
      [wrap(ccx * 2), wrap(ccx * 2 + 1)],
      [wrap(ccz * 2), wrap(ccz * 2 + 1)],
    ];
  }

  /** Are the chunks of the RUNGS INSIDE this one — the 2×2 cells of the next finer rung that cover
   *  `(ccx, ccz)`, over the whole Y range — all DECIDED (built, or known to be empty: the cache's own contract,
   *  and an empty chunk never becomes a mesh later)? `false` means the area still has a hole in it, so the
   *  coarser chunk that covers it must stay on screen. */
  private finerColumnDecided(step: number, ccx: number, ccz: number): boolean {
    const finer = step > 2 ? step / 2 : 1;
    const [fx, fz] = this.finerCells(finer, ccx, ccz);
    for (let dx = 0; dx < 2; dx++) {
      for (let dz = 0; dz < 2; dz++) {
        for (let cy = MIN_CHUNK_Y; cy < MIN_CHUNK_Y + CHUNK_Y_COUNT; cy++) {
          const key = finer === 1 ? `${fx[dx]},${cy},${fz[dz]}` : `${finer}:${fx[dx]},${cy},${fz[dz]}`;
          if (this.cache.meshes.has(key) || this.cache.empty.has(key)) continue;
          return false;
        }
      }
    }
    return true;
  }
}
