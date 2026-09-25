// ===== Plugin: render =====
// Everything that draws: the camera, the block outline, the menu background, the chunk material and the
// GPU objects the render lane needs. It owns the GPU RESOURCES (the tokens live in `data/globals/gfx.ts`
// because they are values; this plugin is what claims them).
import type { World } from "../../core/world";
import { SLOT_RESOURCES } from "../../core/extension/slots";
import { CameraViewSystem, CAMERA_VIEW_ACCESS } from "./systems/camera";
import { ChunkStreamSystem, type ChunkMeshFactory, CHUNK_STREAM_ACCESS } from "./systems/chunk-stream";
// The host builds the mesher (it is a `host/` object), so it needs the factory type: re-exported here rather
// than reached for through `./systems/...`, which is this plugin own business.
export type { ChunkMeshFactory };
import { MenuBackgroundSystem } from "./systems/menu-background";
import { BlockOutlineSystem, OUTLINE_ACCESS } from "./systems/outline";
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
}

/** The render lane's systems, constructed here. */
export function createRenderSystems(w: RenderWiring) {
  return {
    chunkStream: new ChunkStreamSystem(w.world, w.mesh),
    cameraView: new CameraViewSystem(w.world),
    outline: new BlockOutlineSystem(w.world),
    menuBg: new MenuBackgroundSystem(w.world),
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
  run: () => s.chunkStream.step(),
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
