// ===== Presentation resources: the three.js / GPU / DOM objects the WORLD owns =====
// These used to be CONSTRUCTOR DEPENDENCIES: main.ts built the scene, the camera, the renderer, the
// frame-time sampler, the chunk-mesh group and the UI mount element, then handed each one to the system
// that needed it. The objects the systems write every frame were therefore the only shared state in the
// process with no owner: nothing named them, "who owns this camera" was answerable only by reading the
// composition root's wiring, and a system could not be driven without a GPU.
//
// They are RESOURCES now — the same shape as VOXEL / LOCAL_PLAYER / UI_THEME: the composition root
// creates the object, inserts it, and every system resolves it in its CONSTRUCTOR BODY (iron rule 6).
// Three things that buys:
//   * ONE owner — the world holds the objects, like every other singleton;
//   * the resource IS the seam: a test drives a render system by inserting a stub renderer or mount,
//     with no GPU and no DOM (`check:ecs` does exactly that);
//   * a system's dependency is greppable: `world.resource(CAMERA3D)` says what rendering/camera-view.ts
//     writes, instead of it arriving as an anonymous argument at a call site far away.
// One thing it does NOT change: the SCHEDULE. The conflict model is keyed by the DECLARED TARGET NAMES
// (`camera3d`, `chunkMeshes`, `framebuffer`, …), not by resource handles, so the access declarations
// stay exactly as they are — see the "Component or resource?" rule in AGENTS.md.
//
// THE IMPORTS ARE TYPE-ONLY, and that is load-bearing: the Node gate requires this module with no GPU
// and no browser, so nothing here may touch three.js at runtime. The factories take the objects the
// composition root built.
import type * as THREE from "three/webgpu";
import type { PerfSampler } from "../platform/perf";
import type { ChunkGeometry } from "../rendering/chunkmesh";
import { defineResource, type Resource } from "./World";

/** The game's three.js scene. The composition root fills it during wiring (the lights, the chunk group,
 *  the block outline) and `renderer.draw` renders it. */
export const SCENE3D: Resource<THREE.Scene> = defineResource<THREE.Scene>("scene3d");

/** The player's camera. WRITTEN every frame by rendering/camera-view.ts (the interpolated pose from
 *  PREV_POSITION -> POSITION plus the orientation quaternion) and READ by the draw and by the
 *  menu-background step. */
export const CAMERA3D: Resource<THREE.PerspectiveCamera> =
  defineResource<THREE.PerspectiveCamera>("camera3d");

/** The WebGPU renderer. `renderer.draw` renders through it, diagnostics reads its last render timestamp
 *  back into the sampler, and the DEVICE layer takes the canvas from `domElement` — that element is what
 *  the pointer-lock listeners belong to, so "the canvas" is this one object, not a second wiring path.
 *
 *  CONSTRUCTED during wiring, INITIALISED in the boot driver (`await renderer.init()` is the longest
 *  step of the startup and runs behind the loading screen) — see main.ts. */
export const RENDERER3D: Resource<THREE.WebGPURenderer> =
  defineResource<THREE.WebGPURenderer>("renderer3d");

/** The frame-time sampler (platform/perf.ts). Diagnostics samples it once per window and feeds the GPU
 *  time back into it, so it is shared state rather than a per-system object. */
export const PERF_SAMPLER: Resource<PerfSampler> = defineResource<PerfSampler>("perfSampler");

/** The element the renderer's canvas is attached to (index.html's `#app`). Read by the boot driver. */
export const CANVAS_HOST: Resource<HTMLElement> = defineResource<HTMLElement>("canvasHost");

/** The UI MOUNT ROOT: every widget root the reconciler creates is appended here. The composition root
 *  builds it with `createUiMount()` below and the reconciler reads it from the world instead of receiving
 *  it as a dependency — so "where does the UI live" is world state too. */
export const UI_MOUNT: Resource<HTMLElement> = defineResource<HTMLElement>("uiMount");

/** One chunk's GPU mesh plus the geometry it REFILLS across rebuilds (a rebuild never disposes and
 *  reallocates: see rendering/chunkmesh.ts). This is presentation state the streaming system owns. */
export interface ChunkMeshEntry {
  readonly mesh: THREE.Mesh;
  /** The chunk's reusable geometry — a rebuild refills this instead of replacing the mesh */
  readonly geom: ChunkGeometry;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
}

/** The chunk-mesh CACHE: one mesh per visible chunk, keyed by wrapped chunk identity. It used to be
 *  private fields of ecs/systems/chunkstream.ts (plus its own THREE.Group passed in as an argument);
 *  the cache is GPU state that outlives a frame, so the world holds it and the system reads it. */
export interface ChunkMeshCache {
  /** The parent every chunk mesh is added to (added to the scene during wiring) */
  readonly group: THREE.Group;
  /** Wrapped chunk key ("cx,cy,cz") -> its mesh */
  readonly meshes: Map<string, ChunkMeshEntry>;
  /** Keys that produced NO geometry (a uniform chunk has no visible face) kept so they are not retried
   *  every frame. Invalidated on a block write, exactly like the meshes themselves. */
  readonly empty: Set<string>;
  /** The window's WANTED key set, rebuilt only when the player crosses a chunk boundary (null until the
   *  first build). It was a private field of the streaming system; "which chunks does this window want"
   *  is state of the cache, so it is readable here. */
  wantedKeys: Set<string> | null;
  /** The player column the wanted set was built for (NaN = never built) */
  lastPcx: number;
  lastPcz: number;
}

export const CHUNK_MESHES: Resource<ChunkMeshCache> = defineResource<ChunkMeshCache>("chunkMeshes");

/** The cache is created around the group the composition root built (kept as an argument so this module
 *  never constructs a three.js object itself). */
export function createChunkMeshCache(group: THREE.Group): ChunkMeshCache {
  return {
    group,
    meshes: new Map(),
    empty: new Set(),
    wantedKeys: null,
    lastPcx: Number.NaN,
    lastPcz: Number.NaN,
  };
}

/** The MAIN-MENU background's three.js state: the panorama scene and the camera that spins inside it,
 *  plus the two numbers that drive the spin. Those objects used to be four module-level `let`s in
 *  main.ts with a free function next to them (`renderMenuBackground`), which is the one shape this
 *  codebase treats as "state with no owner": the scene is built lazily by the DRAW, nobody can inspect
 *  it, and the menu frame could only reach it through a closure.
 *
 *  It is a resource now, and a `rendering/menu-background.ts` system object READS it. That system is
 *  deliberately NOT registered in a lane: the schedule has no run conditions, and the only caller is the
 *  MENU frame (which never runs the render lane — see the loop in main.ts), so registering it would make
 *  it a no-op in the one mode it exists for. What matters is that its STATE is world state and its
 *  BEHAVIOUR is an object with one entry point. */
export interface MenuBackgroundState {
  /** Built lazily on the first step (a panorama costs a 64x32 sphere + a texture load, and most sessions
   *  never show the main menu's panorama at all) */
  scene: THREE.Scene | null;
  camera: THREE.PerspectiveCamera | null;
  /** Panning angle (rad) and the timestamp the last step measured its delta from */
  yaw: number;
  lastMs: number;
  /** The aspect last written into the menu camera, so a resize is applied once (NaN = nothing yet) */
  appliedAspect: number;
}

export const MENU_BACKGROUND: Resource<MenuBackgroundState> =
  defineResource<MenuBackgroundState>("menuBackground");

export function createMenuBackground(): MenuBackgroundState {
  return { scene: null, camera: null, yaw: 0, lastMs: 0, appliedAspect: Number.NaN };
}

/** THE UI MOUNT ROOT's factory. `ui/uiscale.ts` used to create the element and append it to `document.body`
 *  at IMPORT time (a DOM side effect of a config module); the mount point is world state like the canvas
 *  host, so the composition root creates it here and inserts it as UI_MOUNT. The styles are the ones the
 *  stage always had: fixed, filling the viewport, inside the root font size's rem base. */
export function createUiMount(): HTMLElement {
  const stage = document.createElement("div");
  stage.style.cssText = "position:fixed;inset:0;overflow:hidden;z-index:1;";
  document.body.appendChild(stage);
  return stage;
}

/** The ITEM-ICON BAKE: a SECOND offscreen WebGPURenderer (the main one is RENDERER3D) plus its two caches.
 *  They used to be four module-level `let`s inside rendering/blockicons.ts — more GPU state with no owner,
 *  and the one place left where a promise continuation wrote a COMPONENT (the UI image) outside a lane.
 *  The state is a resource now: the baker operates on it, and the inventory system reads the cache to
 *  decide whether it can draw a real icon this frame or the checker placeholder. */
export interface IconBakeState {
  /** The lazily created offscreen renderer (null until the first bake) */
  renderer: THREE.WebGPURenderer | null;
  /** Its in-flight init, so concurrent bakes share one GPU handshake */
  rendererReady: Promise<THREE.WebGPURenderer> | null;
  /** cache key -> baked PNG data URL */
  readonly cache: Map<string, string>;
  /** cache key -> the bake in flight (two slots asking for the same block share one bake) */
  readonly pending: Map<string, Promise<string | null>>;
}

export const ICON_BAKE: Resource<IconBakeState> = defineResource<IconBakeState>("iconBake");

export function createIconBake(): IconBakeState {
  return { renderer: null, rendererReady: null, cache: new Map(), pending: new Map() };
}

/** The ONE material every chunk mesh shares. It used to be a module-level `let` in chunkmesh.ts (a GPU
 *  object, so by the rule above it belongs to the world) and is created on first use, because the pack
 *  chain must be installed before the checker texture can be resolved. */
export interface ChunkMaterialState {
  material: THREE.MeshLambertMaterial | null;
}

export const CHUNK_MATERIAL: Resource<ChunkMaterialState> =
  defineResource<ChunkMaterialState>("chunkMaterial");

export function createChunkMaterial(): ChunkMaterialState {
  return { material: null };
}

/** The BLOCK TARGET OUTLINE: the wireframe box around the block the local player's ray hits. It used to
 *  be a field of the interaction system, which meant the FIXED lane wrote a three.js object every tick
 *  (`writesExternal: ["voxelBlocks", "outline"]`) — presentation state changed from the simulation lane.
 *  Now the hit is COMPONENT data (TARGET_HIT) and rendering/outline.ts paints the mesh in the RENDER lane. */
export interface BlockOutlineState {
  readonly mesh: THREE.LineSegments;
}

export const BLOCK_OUTLINE: Resource<BlockOutlineState> = defineResource<BlockOutlineState>("blockOutline");

/** The factory takes the MESH the composition root built and added to the scene, exactly like
 *  `createChunkMeshCache(group)`: this module stays free of runtime three.js so the Node gate can require
 *  it with no GPU. The mesh's flags are set by the caller (invisible until a hit, `matrixAutoUpdate`
 *  off because the outline write sets the matrix itself). */
export function createBlockOutline(mesh: THREE.LineSegments): BlockOutlineState {
  return { mesh };
}
