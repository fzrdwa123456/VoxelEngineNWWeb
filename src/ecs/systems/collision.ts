// ===== Player collision: AABB vs the voxel grid, resolved one axis at a time =====
// Runs in the FIXED lane AFTER the movement system. movement.ts integrates the tick
// provisionally; this system re-integrates that same displacement in sub-steps and resolves
// each axis against the blocks. Keeping it that way means the existing registration order
// (beginStep -> controller -> movement) is untouched, and it is tunneling-safe even at the
// test-only sprint speed (105 units/s = 0.875 blocks per tick).
//
// This system OWNS two pieces of MOTION that nothing wrote before:
//   - motion.onGround — previously never set to true, which made jumping unreachable;
//   - motion.vy       — zeroed on contact so gravity does not accumulate into the floor.
//
// Spectator mode is noclip and is skipped entirely (movement.ts documents the same intent).
//
// The player pose is a single point at EYE_HEIGHT, so the body AABB is:
//   x/z: pos +/- PLAYER_HALF_WIDTH
//   y  : [pos.y - EYE_HEIGHT, pos.y - EYE_HEIGHT + PLAYER_HEIGHT]
import * as THREE from "three/webgpu";
import { CONTROL, EYE_HEIGHT, MOTION, PLAYER_HALF_WIDTH, PLAYER_HEIGHT, POSITION, type MotionC } from "../components/Player";
import type { EntityId } from "../store";
import type { World } from "../World";
import type { VoxelWorld } from "../../voxel/world";

/** Largest displacement resolved in one sub-step (blocks). Comfortably below one voxel. */
const MAX_SUBSTEP = 0.25;
/** Keeps a resolved body just clear of the surface it hit, so it does not re-collide every step */
const SKIN = 1e-3;

export class CollisionSystem {
  /** Pre-movement position per entity: the sub-step sweep runs from here */
  private readonly prev = new Map<EntityId, THREE.Vector3>();

  constructor(
    private readonly world: World,
    private readonly voxel: VoxelWorld,
  ) {}

  step(_dt: number): void {
    for (const id of this.world.entities.query(CONTROL, POSITION, MOTION)) {
      const control = this.world.entities.get(id, CONTROL)!;
      const pos = this.world.entities.get(id, POSITION)!;
      const motion = this.world.entities.get(id, MOTION)!;

      if (control.mode === "spectator") {
        this.prev.delete(id);
        continue;
      }

      let previous = this.prev.get(id);
      if (!previous) {
        previous = pos.clone();
        this.prev.set(id, previous);
      }
      this.resolve(pos, motion, previous);
    }
  }

  /** Re-apply this tick's displacement in sub-steps, resolving each axis against the blocks */
  private resolve(pos: THREE.Vector3, motion: MotionC, previous: THREE.Vector3): void {
    const dx = pos.x - previous.x;
    const dy = pos.y - previous.y;
    const dz = pos.z - previous.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const steps = Math.max(1, Math.ceil(distance / MAX_SUBSTEP));
    const stepX = dx / steps;
    const stepY = dy / steps;
    const stepZ = dz / steps;

    pos.copy(previous);
    motion.onGround = false;

    for (let i = 0; i < steps; i++) {
      if (stepX !== 0) {
        pos.x += stepX;
        this.resolveX(pos, stepX);
      }
      if (stepZ !== 0) {
        pos.z += stepZ;
        this.resolveZ(pos, stepZ);
      }
      if (stepY !== 0) {
        pos.y += stepY;
        this.resolveY(pos, motion, stepY);
      }
    }

    previous.copy(pos);
  }

  private resolveX(pos: THREE.Vector3, delta: number): void {
    const feet = pos.y - EYE_HEIGHT;
    const y0 = Math.floor(feet + SKIN);
    const y1 = Math.floor(feet + PLAYER_HEIGHT - SKIN);
    const z0 = Math.floor(pos.z - PLAYER_HALF_WIDTH + SKIN);
    const z1 = Math.floor(pos.z + PLAYER_HALF_WIDTH - SKIN);
    const column = delta > 0 ? Math.floor(pos.x + PLAYER_HALF_WIDTH) : Math.floor(pos.x - PLAYER_HALF_WIDTH);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        if (!this.voxel.isSolid(column, y, z)) continue;
        pos.x = delta > 0 ? column - PLAYER_HALF_WIDTH - SKIN : column + 1 + PLAYER_HALF_WIDTH + SKIN;
        return;
      }
    }
  }

  private resolveZ(pos: THREE.Vector3, delta: number): void {
    const feet = pos.y - EYE_HEIGHT;
    const y0 = Math.floor(feet + SKIN);
    const y1 = Math.floor(feet + PLAYER_HEIGHT - SKIN);
    const x0 = Math.floor(pos.x - PLAYER_HALF_WIDTH + SKIN);
    const x1 = Math.floor(pos.x + PLAYER_HALF_WIDTH - SKIN);
    const column = delta > 0 ? Math.floor(pos.z + PLAYER_HALF_WIDTH) : Math.floor(pos.z - PLAYER_HALF_WIDTH);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!this.voxel.isSolid(x, y, column)) continue;
        pos.z = delta > 0 ? column - PLAYER_HALF_WIDTH - SKIN : column + 1 + PLAYER_HALF_WIDTH + SKIN;
        return;
      }
    }
  }

  private resolveY(pos: THREE.Vector3, motion: MotionC, delta: number): void {
    const x0 = Math.floor(pos.x - PLAYER_HALF_WIDTH + SKIN);
    const x1 = Math.floor(pos.x + PLAYER_HALF_WIDTH - SKIN);
    const z0 = Math.floor(pos.z - PLAYER_HALF_WIDTH + SKIN);
    const z1 = Math.floor(pos.z + PLAYER_HALF_WIDTH - SKIN);

    if (delta < 0) {
      // Falling: the feet layer is what we land on
      const layer = Math.floor(pos.y - EYE_HEIGHT);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          if (!this.voxel.isSolid(x, layer, z)) continue;
          pos.y = layer + 1 + EYE_HEIGHT + SKIN;
          motion.vy = 0;
          motion.onGround = true;
          return;
        }
      }
      return;
    }

    // Rising: the head layer blocks
    const layer = Math.floor(pos.y - EYE_HEIGHT + PLAYER_HEIGHT);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        if (!this.voxel.isSolid(x, layer, z)) continue;
        pos.y = layer - PLAYER_HEIGHT + EYE_HEIGHT - SKIN;
        motion.vy = 0;
        return;
      }
    }
  }
}
