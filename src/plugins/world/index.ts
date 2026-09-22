// ===== Plugin: world =====
// The voxel world itself. It owns the VOXEL resource and the chunk pipeline: generation, meshing,
// streaming and the re-mesh of dirtied chunks. It depends on nothing — everything else reads the world.
import { SLOT_RESOURCES } from "../../core/extension/slots";
import { definePlugin } from "../../core/plugin/descriptor";
import { VOXEL } from "../../data/globals/resources";

export const worldPlugin = definePlugin({
  id: "world",
  deps: [],
  setup(api) {
    api.contribute(SLOT_RESOURCES, [VOXEL]);
  },
});
