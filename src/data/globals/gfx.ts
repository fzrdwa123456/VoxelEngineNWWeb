// ===== Presentation DATA: the three.js / GPU / DOM objects the WORLD owns =====
// This module is the TOKENS and the SHAPES only — no factory, no `document`, no three.js at runtime, so
// it is pure data like every other file under `data/`. The functions that BUILD these objects live in
// `logic/host/presentation.ts` (they touch the DOM/GPU, which is the boundary's job), and the composition
// root inserts the objects here so every system resolves them from the world.
//
// Why the objects are resources at all: they used to be CONSTRUCTOR DEPENDENCIES — main.ts built the
// scene, the camera, the renderer, the frame-time sampler, the chunk-mesh group and the UI mount element,
// then handed each one to the system that needed it, so the objects written every frame were the only
// shared state in the process with no owner. As resources they have ONE owner, a test can drive a render
// system by inserting a stub (with no GPU and no DOM — `check:ecs` does exactly that), and a system's
// dependency is greppable: `world.resource(CAMERA3D)`.
// One thing it does NOT change: the SCHEDULE. The conflict model is keyed by the DECLARED TARGET NAMES
// (`camera3d`, `chunkMeshes`, `framebuffer`, …), not by resource handles, so the access declarations stay
// exactly as they are — see the "Component or resource?" rule in AGENTS.md.
import type * as THREE from "three/webgpu";
import type { PerfSampler } from "../../core/services/perf";
import type { ChunkGeometry } from "../../host/browser/chunkmesh";
import { defineResource, type Resource } from "../../core/world";

/** The game's three.js scene. The composition root fills it during wiring (the lights, the chunk group,
 *  the block outline) and `renderer.draw` renders it. */
export const SCENE3D: Resource<THREE.Scene> = defineResource<THREE.Scene>("scene3d");

/** The player's camera. WRITTEN every frame by logic/render/camera.ts (the interpolated pose from
 *  PREV_POSITION -> POSITION plus the orientation quaternion) and READ by the draw and by the
 *  menu-background step. */
export const CAMERA3D: Resource<THREE.PerspectiveCamera> =
  defineResource<THREE.PerspectiveCamera>("camera3d");

/** The WebGPU renderer. `renderer.draw` renders through it, diagnostics reads its last render timestamp
 *  back into the sampler, and the DEVICE layer takes the canvas from `domElement` — that element is what
 *  the pointer-lock listeners belong to, so "the canvas" is this one object, not a second wiring path.
 *
 *  CONSTRUCTED during wiring, INITIALISED in the boot flow (`await renderer.init()` is the longest step of
 *  the startup and runs behind the loading screen) — see main.ts. */
export const RENDERER3D: Resource<THREE.WebGPURenderer> =
  defineResource<THREE.WebGPURenderer>("renderer3d");

/** The frame-time sampler (logic/host/window/perf.ts). Diagnostics samples it once per window and feeds
 *  the GPU time back into it, so it is shared state rather than a per-system object. */
export const PERF_SAMPLER: Resource<PerfSampler> = defineResource<PerfSampler>("perfSampler");

/** The element the renderer's canvas is attached to (index.html's `#app`). Read by the boot flow. */
export const CANVAS_HOST: Resource<HTMLElement> = defineResource<HTMLElement>("canvasHost");

/** The UI MOUNT ROOT: every widget root the reconciler creates is appended here. The composition root
 *  builds it with `createUiMount()` (logic/host/presentation.ts) and the reconciler reads it from the
 *  world instead of receiving it as a dependency — so "where does the UI live" is world state too. */
export const UI_MOUNT: Resource<HTMLElement> = defineResource<HTMLElement>("uiMount");

/** One chunk's GPU mesh plus the geometry it REFILLS across rebuilds (a rebuild never disposes and
 *  reallocates: see logic/host/gpu/chunkmesh.ts). This is presentation state the streaming system owns. */
export interface ChunkMeshEntry {
  readonly mesh: THREE.Mesh;
  /** The chunk's reusable geometry — a rebuild refills this instead of replacing the mesh */
  readonly geom: ChunkGeometry;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
}

/** The chunk-mesh CACHE: one mesh per visible chunk, keyed by wrapped chunk identity. It used to be
 *  private fields of the streaming system (plus its own THREE.Group passed in as an argument); the cache
 *  is GPU state that outlives a frame, so the world holds it and the system reads it. */
export interface ChunkMeshCache {
  /** The parent every chunk mesh is added to (added to the scene during wiring) */
  readonly group: THREE.Group;
  /** Wrapped chunk key ("cx,cy,cz") -> its mesh */
  readonly meshes: Map<string, ChunkMeshEntry>;
  /** Keys that produced NO geometry (a uniform chunk has no visible face) kept so they are not retried
   *  every frame. Invalidated on a block write, exactly like the meshes themselves. */
  readonly empty: Set<string>;
  /** The window's WANTED key set, rebuilt only when the player crosses a chunk boundary (null until the
   *  first build): "which chunks does this window want" is state of the cache, so it is readable here. */
  wantedKeys: Set<string> | null;
  /** The player column the wanted set was built for (NaN = never built) */
  lastPcx: number;
  lastPcz: number;
}

export const CHUNK_MESHES: Resource<ChunkMeshCache> = defineResource<ChunkMeshCache>("chunkMeshes");

/** The MAIN-MENU background's three.js state: the panorama scene and the camera that spins inside it,
 *  plus the two numbers that drive the spin. Those objects used to be four module-level `let`s in
 *  main.ts with a free function next to them, which is the one shape this codebase treats as "state with
 *  no owner": the scene is built lazily by the DRAW, nobody can inspect it, and the menu frame could only
 *  reach it through a closure.
 *
 *  It is a resource now, and `logic/render/menu-background.ts` READS it. That system is deliberately NOT
 *  registered in a lane: the schedule has no run conditions, and the only caller is the MENU frame (which
 *  never runs the render lane — see the loop in main.ts), so registering it would make it a no-op in the
 *  one mode it exists for. */
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

/** The ITEM-ICON BAKE: a SECOND offscreen WebGPURenderer (the main one is RENDERER3D) plus its two
 *  caches. They used to be four module-level `let`s inside the icon baker — more GPU state with no owner,
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

/** The ONE material every chunk mesh shares. It used to be a module-level `let` in the mesher (a GPU
 *  object, so by the rule above it belongs to the world) and is created on first use, because the pack
 *  chain must be installed before the checker texture can be resolved. */
export interface ChunkMaterialState {
  material: THREE.MeshLambertMaterial | null;
}

export const CHUNK_MATERIAL: Resource<ChunkMaterialState> =
  defineResource<ChunkMaterialState>("chunkMaterial");

/** The BLOCK TARGET OUTLINE: the wireframe box around the block the local player's ray hits. It used to be
 *  a field of the interaction system, which meant the FIXED lane wrote a three.js object every tick
 *  (`writesExternal: ["voxelBlocks", "outline"]`). Now the hit is COMPONENT data (TARGET_HIT) and
 *  `logic/render/outline.ts` paints the mesh in the RENDER lane. */
export interface BlockOutlineState {
  readonly mesh: THREE.LineSegments;
}

export const BLOCK_OUTLINE: Resource<BlockOutlineState> = defineResource<BlockOutlineState>("blockOutline");

// ===== The GPU layer's tuning CONSTANTS =====
// Numbers a mechanism READS but does not own: how much geometry a chunk starts out able to hold and how far
// it may double, and how big the icon bake's view is and what sizes it clamps to. They are data, so they
// live with the graphics state instead of inside the two files that read them.
/** Faces a chunk geometry starts out able to hold: one 32x32 layer, which is exactly what the default
 *  world needs for a column's top face — so the common case never has to grow. */
export const CHUNK_FACES_INITIAL = 1024;
/** Doubling stops here; beyond it the capacity is rounded straight up to what is needed. */
export const CHUNK_FACES_MAX_DOUBLING = 8192;
/** Half-extent of the icon bake's orthographic camera. */
export const ICON_VIEW_HALF = 0.85;
/** The icon bake's size clamp, in device pixels (the cache key is `type@size`). */
export const ICON_SIZE_MIN = 32;
export const ICON_SIZE_MAX = 256;
