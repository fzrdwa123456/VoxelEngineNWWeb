// ===== Plugin: render =====
// Everything that draws: the camera, the block outline, the menu background, the chunk material and the
// GPU objects the render lane needs. It owns the GPU RESOURCES (the tokens live in `data/globals/gfx.ts`
// because they are values; this plugin is what claims them).
import type { World } from "../../core/world";
import { SLOT_RESOURCES } from "../../core/extension/slots";
import { CameraViewSystem, CAMERA_VIEW_ACCESS } from "./systems/camera";
import { ChunkStreamSystem, type ChunkMeshFactory, type MeshWorkerPool, CHUNK_STREAM_ACCESS } from "./systems/chunk-stream";
// The far ring's POLICY is data (`data/world/lod.ts`), and the plugin is where the shipped choice is made: the
// stream's own default is "no LOD" (the shape the tests drive), the game gets the ring.
import { DEFAULT_LOD, type LodPolicy } from "../../data/world/lod";
// The host builds the mesher (it is a `host/` object), so it needs the factory type: re-exported here rather
// than reached for through `./systems/...`, which is this plugin own business.
export type { ChunkMeshFactory, MeshWorkerPool };
import { MenuBackgroundSystem } from "./systems/menu-background";
import { BlockOutlineSystem, OUTLINE_ACCESS } from "./systems/outline";
// M0 of the GPU route: the sampler probe (`K`), a debug tool that compares a GPU port of the terrain field
// against the CPU reference. It changes no streaming state — it reports.
import { LodGpuProbeSystem, LOD_PROBE_ACCESS } from "./systems/lod-gpu-probe";
// M1 of the GPU route: the PRODUCTION sampler. The stream asks it for a far column's height grids; it answers from
// a GPU batch (or from the CPU when the backend has no compute), so the far ring stops costing 71 s of main thread.
import { LodGpuSamplerSystem, LOD_SAMPLE_ACCESS } from "./systems/lod-gpu-sampler";
import { definePlugin } from "../../core/plugin/descriptor";
import {
  BLOCK_OUTLINE,
  CAMERA3D,
  CANVAS_HOST,
  CHUNK_MATERIAL,
  CHUNK_MESHES,
  ICON_BAKE,
  MENU_BACKGROUND,
  RENDERER3D,
  SCENE3D,
} from "../../data/globals/gfx";

/** The platform half this plugin cannot import (see ChunkMeshFactory) plus the world. */
export interface RenderWiring {
  readonly world: World;
  readonly mesh: ChunkMeshFactory;
  /** The platform's meshing WORKER POOL (P1.18h), when it has one: absent = mesh on this thread, which is
   *  what the gate and a worker-less environment do. */
  readonly pool?: MeshWorkerPool | null;
  /** THE FAR RING (P1.93). Omitted = the plugin's own default (`DEFAULT_LOD`): the shipped game draws a fine
   *  ring plus a coarse one. `null` = the single fine window the engine had before, which is what a test that
   *  wants the old window shape passes. */
  readonly lod?: LodPolicy | null;
  /** Where the LOD probe writes its report (`host/` owns the log file, so the root hands the sink in — the same
   *  shape the boot drivers use). Absent = the probe still runs and reports through the toast only. */
  readonly log?: (line: string) => void;
}

/** The render lane's systems, constructed here. */
export function createRenderSystems(w: RenderWiring) {
  // M1: the sampler is built FIRST because the chunk stream takes it as its grid source (`LodGridSource`), and it
  // has to exist before the stream can ask for a column. It resolves the renderer itself (iron rule 6), so the
  // order here is about the dependency, not about the GPU.
  const lodSampler = new LodGpuSamplerSystem(w.world, w.log ?? (() => {}));
  return {
    chunkStream: new ChunkStreamSystem(
      w.world,
      w.mesh,
      w.pool ?? null,
      w.lod === undefined ? DEFAULT_LOD : w.lod,
      lodSampler.source,
    ),
    cameraView: new CameraViewSystem(w.world),
    outline: new BlockOutlineSystem(w.world),
    menuBg: new MenuBackgroundSystem(w.world),
    lodProbe: new LodGpuProbeSystem(w.world, w.log ?? (() => {})),
    lodSampler,
  };
}

/** The plugin, built with the wiring the root owns (the world and the platform's mesher): it CONSTRUCTS
 *  its four systems and DECLARES them, so `boot/main.ts` no longer knows their names, stages, edges or
 *  access sets. The systems are handed back too — the boot driver primes the chunk stream by hand. */
export function createRenderPlugin(w: RenderWiring) {
  const world = w.world;
  const s = createRenderSystems(w);
  const plugin = definePlugin({
  id: "render",
  deps: ["world", "player", "ui"],
  setup(api) {
    api.contribute(SLOT_RESOURCES, [
      SCENE3D, CAMERA3D, RENDERER3D, CANVAS_HOST, CHUNK_MESHES, CHUNK_MATERIAL, BLOCK_OUTLINE,
      MENU_BACKGROUND, ICON_BAKE,
    ]);
    api.system({
  name: "cameraView.render",
  stage: "render",
  ...CAMERA_VIEW_ACCESS,
  run: (ctx) => s.cameraView.render(ctx.alpha),
    });
    api.system({
  name: "chunk.stream",
  stage: "render",
  ...CHUNK_STREAM_ACCESS,
  // The lane's delta goes in: the appearance fade (P1.98) is advanced by the DRAWN frame interval, so it is the
  // same fraction of a second whatever the frame rate is (`ctx.dt` is the render lane's delta, in seconds).
  run: (ctx) => s.chunkStream.step(ctx.dt * 1000),
    });
    api.system({
  // The block target wireframe: it reads the TARGET_HIT component `player.interaction` wrote in the fixed
  // lane and moves the mesh. It touches no component the other render producers touch and writes a target
  // of its own (`blockOutline`), so the schedule puts it in their batch — any order is correct, because
  // the mesh is only read by the draw at the END of the lane (it is in the scene).
  name: "block.outline",
  stage: "render",
  ...OUTLINE_ACCESS,
  run: () => s.outline.render(),
    });
    api.system({
  // M1 of the GPU route: the production sampler. One pump per frame — it walks the stream's far key set (which it
  // READS, so the schedule places it after `chunk.stream`, the system that publishes it) and fires one dispatch.
  name: "lod.gpu.sample",
  stage: "render",
  ...LOD_SAMPLE_ACCESS,
  // DECLARED, because the two share a target (`chunkMeshes`) and the conflict rule refuses to guess: the sampler's
  // work list IS the key set the stream writes, so it must run AFTER it (registration order is not a dependency).
  after: ["chunk.stream"],
  run: () => s.lodSampler.step(),
    });
    api.system({
  // M0 of the GPU route: `K` starts the sampler probe. Registered AFTER the stream so the schedule's snapshot
  // of the render batch stays stable, and it shares no component with anything — it reads the renderer and
  // writes its own buffers, so it lands beside the other producers.
  name: "lod.gpu.probe",
  stage: "render",
  ...LOD_PROBE_ACCESS,
  run: () => s.lodProbe.step(),
    });
    api.system({
  // Ordered by what it READS: it consumes the camera and the chunk meshes, so the schedule itself
  // keeps it after their producers.
  name: "renderer.draw",
  stage: "render",
  after: ["cameraView.render", "chunk.stream"],
  readsExternal: ["camera3d", "chunkMeshes"],
  writesExternal: ["framebuffer"],
  // It reads the three objects it draws with from the WORLD, not from wiring variables: they are
  // resources now (SCENE3D / CAMERA3D / RENDERER3D — see ecs/presentation.ts). The declared targets
  // above stay as they are: the schedule models those NAMES, not the resource handles.
  // It does NOT resize the canvas: that belongs to the FRAME, not to this lane (see applyViewportSize).
  run: () => world.resource(RENDERER3D).render(world.resource(SCENE3D), world.resource(CAMERA3D)),
    });
  },
  });
  return { plugin, systems: s };
}
