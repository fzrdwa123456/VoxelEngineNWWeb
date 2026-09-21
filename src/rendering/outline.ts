// ===== The block target outline: the wireframe box around the block you are aiming at =====
// RENDER lane. It reads TARGET_HIT (the hit result `player.interaction` wrote in the FIXED lane) and
// writes the three.js mesh.
//
// WHY IT IS ITS OWN SYSTEM. The mesh used to be a field of BlockInteractionSystem, so the fixed lane
// owned and moved a three.js object — the one place left where a simulation tick touched presentation
// state (`writesExternal: ["outline"]` on a fixed-lane system). Splitting it is not cosmetic: the
// schedule's whole model is "which lane may touch what", and an external write from the sim lane is
// exactly the kind of undeclarable coupling the DECLARED ACCESS design exists to remove. Now the lanes
// exchange DATA — a component — and the mesh has one writer, in the lane that draws.
//
// ONE WIREFRAME, ONE ENTITY. Only the local player carries TARGET_HIT (spawnPlayer inserts it), because
// there is one playable view; this system resolves the LOCAL_PLAYER row once in its constructor, like
// the camera and the chunk stream do. The mesh itself is the BLOCK_OUTLINE resource
// (ecs/presentation.ts) — created and added to the scene by the composition root, because a three.js
// object is wiring, not world state a system may create.
import type * as THREE from "three/webgpu";
import { TARGET_HIT } from "../ecs/components/Player";
import { BLOCK_OUTLINE } from "../ecs/presentation";
import { LOCAL_PLAYER } from "../ecs/resources";
import { entityIndex, type SystemAccess, type World } from "../ecs/World";

/** Declared access: TARGET_HIT in, the wireframe mesh out. */
export const OUTLINE_ACCESS: SystemAccess = {
  reads: [TARGET_HIT],
  writesExternal: ["blockOutline"],
};

export class BlockOutlineSystem {
  private readonly mesh: THREE.LineSegments;
  /** The local player's row, or -1 when the world has no player carrying TARGET_HIT */
  private readonly index: number;

  constructor(world: World) {
    this.mesh = world.resource(BLOCK_OUTLINE).mesh;
    const index = entityIndex(world.resource(LOCAL_PLAYER));
    this.index = index >= 0 && TARGET_HIT.sparse[index] >= 0 ? index : -1;
  }

  render(): void {
    const index = this.index;
    if (index < 0 || !TARGET_HIT.active[index]) {
      this.mesh.visible = false;
      return;
    }
    // The mesh is a unit box, so its ORIGIN sits at the block's centre: voxel (x,y,z) spans
    // [x, x+1), and the box is drawn 0.002 larger so it does not z-fight with the block's faces.
    this.mesh.position.set(
      TARGET_HIT.x[index] + 0.5,
      TARGET_HIT.y[index] + 0.5,
      TARGET_HIT.z[index] + 0.5,
    );
    // matrixAutoUpdate is off (set by the composition root): the write above is only visible after this.
    this.mesh.updateMatrix();
    this.mesh.visible = true;
  }
}
