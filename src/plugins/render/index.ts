// ===== Plugin: render =====
// Everything that draws: the camera, the block outline, the menu background, the chunk material and the
// GPU objects the render lane needs. It owns the GPU RESOURCES (the tokens live in `data/globals/gfx.ts`
// because they are values; this plugin is what claims them).
import type { World } from "../../core/world";
import { SLOT_RESOURCES } from "../../core/extension/slots";
import { CameraViewSystem } from "./systems/camera";
import { ChunkStreamSystem, type ChunkMeshFactory } from "./systems/chunk-stream";
import { MenuBackgroundSystem } from "./systems/menu-background";
import { BlockOutlineSystem } from "./systems/outline";
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

export const renderPlugin = definePlugin({
  id: "render",
  deps: ["world", "player", "ui"],
  setup(api) {
    api.contribute(SLOT_RESOURCES, [
      SCENE3D, CAMERA3D, RENDERER3D, CANVAS_HOST, CHUNK_MESHES, CHUNK_MATERIAL, BLOCK_OUTLINE,
      MENU_BACKGROUND, ICON_BAKE,
    ]);
  },
});
