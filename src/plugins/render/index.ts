// ===== Plugin: render =====
// Everything that draws: the camera, the block outline, the menu background, the chunk material and the
// GPU objects the render lane needs. It owns the GPU RESOURCES (the tokens live in `data/globals/gfx.ts`
// because they are values; this plugin is what claims them).
import { SLOT_RESOURCES } from "../../core/extension/slots";
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
