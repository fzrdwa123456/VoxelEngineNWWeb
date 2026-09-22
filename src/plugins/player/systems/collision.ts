// ===== Player collision: AABB vs the voxel grid, resolved one axis at a time =====
// Runs in the FIXED lane AFTER the movement system. movement.ts integrates the tick
// provisionally; this system re-integrates that same displacement in sub-steps and resolves
// each axis against the blocks, so it is tunneling-safe even at the test-only sprint speed
// (105 units/s = 0.875 blocks per tick).
//
// THE SWEEP ORIGIN IS COMPONENT DATA. It used to be a private Map<EntityId, Vector3> inside this
// system, and the camera system kept a second copy of the same quantity for render interpolation.
// Both now read PREV_POSITION, which the `motion.snapshot` system fills for EVERY entity that has
// one — see snapshot.ts for why that had to stop being a local-player-only write.
//
// PREV_POSITION IS PART OF THE QUERY, so it is an explicit dependency: an entity without one is not
// swept at all and falls through the world. That is deliberately the loud failure — the alternative
// (sweeping from an unwritten origin) produces an entity that jitters backwards and lags.
//
// THE BODY BOX IS COMPONENT DATA TOO (BODY). The half width, height and eye height are read per
// entity, so this system no longer assumes every collidable thing is player-sized.
//
// This system OWNS two pieces of MOTION that nothing else writes:
//   - motion.onGround — previously never set to true, which made jumping unreachable;
//   - motion.vy       — zeroed on contact so gravity does not accumulate into the floor.
//
// Spectator mode is noclip and is skipped entirely (movement.ts documents the same intent).
//
// The pose is a single point at BODY.eyeHeight, so the body AABB is:
//   x/z: pos +/- BODY.halfWidth
//   y  : [pos.y - eyeHeight, pos.y - eyeHeight + height]
import {
  BODY,
  CONTROL,
  MOTION,
  POSITION,
  PREV_POSITION,
  type MotionC,
} from "../components";
import { VOXEL } from "../../../data/globals/resources";
import type { SystemAccess, World } from "../../../core/world";
import type { VoxelWorld } from "../../../data/world/world";

/** Declared access. Reads PREV_POSITION (the sweep origin) and writes POSITION/MOTION, so it both
 *  depends on and conflicts with movement's access — the schedule needs an edge, and movement's
 *  declaration supplies it. */
export const COLLISION_ACCESS: SystemAccess = {
  reads: [CONTROL, PREV_POSITION, BODY],
  writes: [POSITION, MOTION],
};

/** Largest displacement resolved in one sub-step (blocks). Comfortably below one voxel. */
const MAX_SUBSTEP = 0.25;
/** Keeps a resolved body just clear of the surface it hit, so it does not re-collide every step */
const SKIN = 1e-3;

/** Scratch body dimensions for the entity being resolved (avoids 5-argument calls) */
const dims = { halfWidth: 0, height: 0, eyeHeight: 0 };

export class CollisionSystem {
  private readonly voxel: VoxelWorld;

  constructor(private readonly world: World) {
    this.voxel = world.resource(VOXEL);
  }

  step(): void {
    const rows = this.world.query(CONTROL, POSITION, MOTION, BODY, PREV_POSITION).indices;
    for (let row = 0; row < rows.length; row++) {
      const index = rows[row];
      if (CONTROL.data[index]!.mode === "spectator") continue;
      dims.halfWidth = BODY.halfWidth[index];
      dims.height = BODY.height[index];
      dims.eyeHeight = BODY.eyeHeight[index];
      this.resolve(index, MOTION.data[index]!, dims);
    }
  }

  /** Re-apply this tick's displacement in sub-steps, resolving each axis against the blocks */
  private resolve(index: number, motion: MotionC, body: typeof dims): void {
    const dx = POSITION.x[index] - PREV_POSITION.x[index];
    const dy = POSITION.y[index] - PREV_POSITION.y[index];
    const dz = POSITION.z[index] - PREV_POSITION.z[index];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const steps = Math.max(1, Math.ceil(distance / MAX_SUBSTEP));
    const stepX = dx / steps;
    const stepY = dy / steps;
    const stepZ = dz / steps;

    // Back to the sweep origin and walk forward again. PREV_POSITION is re-filled by the camera
    // snapshot system at the start of the next fixed step, so nothing has to be copied back here.
    POSITION.x[index] = PREV_POSITION.x[index];
    POSITION.y[index] = PREV_POSITION.y[index];
    POSITION.z[index] = PREV_POSITION.z[index];
    motion.onGround = false;

    for (let i = 0; i < steps; i++) {
      if (stepX !== 0) {
        POSITION.x[index] += stepX;
        this.resolveX(index, stepX, body);
      }
      if (stepZ !== 0) {
        POSITION.z[index] += stepZ;
        this.resolveZ(index, stepZ, body);
      }
      if (stepY !== 0) {
        POSITION.y[index] += stepY;
        this.resolveY(index, motion, stepY, body);
      }
    }
  }

  private resolveX(index: number, delta: number, body: typeof dims): void {
    const feet = POSITION.y[index] - body.eyeHeight;
    const y0 = Math.floor(feet + SKIN);
    const y1 = Math.floor(feet + body.height - SKIN);
    const z0 = Math.floor(POSITION.z[index] - body.halfWidth + SKIN);
    const z1 = Math.floor(POSITION.z[index] + body.halfWidth - SKIN);
    const column =
      delta > 0
        ? Math.floor(POSITION.x[index] + body.halfWidth)
        : Math.floor(POSITION.x[index] - body.halfWidth);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        if (!this.voxel.isSolid(column, y, z)) continue;
        POSITION.x[index] =
          delta > 0 ? column - body.halfWidth - SKIN : column + 1 + body.halfWidth + SKIN;
        return;
      }
    }
  }

  private resolveZ(index: number, delta: number, body: typeof dims): void {
    const feet = POSITION.y[index] - body.eyeHeight;
    const y0 = Math.floor(feet + SKIN);
    const y1 = Math.floor(feet + body.height - SKIN);
    const x0 = Math.floor(POSITION.x[index] - body.halfWidth + SKIN);
    const x1 = Math.floor(POSITION.x[index] + body.halfWidth - SKIN);
    const column =
      delta > 0
        ? Math.floor(POSITION.z[index] + body.halfWidth)
        : Math.floor(POSITION.z[index] - body.halfWidth);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!this.voxel.isSolid(x, y, column)) continue;
        POSITION.z[index] =
          delta > 0 ? column - body.halfWidth - SKIN : column + 1 + body.halfWidth + SKIN;
        return;
      }
    }
  }

  private resolveY(index: number, motion: MotionC, delta: number, body: typeof dims): void {
    const x0 = Math.floor(POSITION.x[index] - body.halfWidth + SKIN);
    const x1 = Math.floor(POSITION.x[index] + body.halfWidth - SKIN);
    const z0 = Math.floor(POSITION.z[index] - body.halfWidth + SKIN);
    const z1 = Math.floor(POSITION.z[index] + body.halfWidth - SKIN);

    if (delta < 0) {
      // Falling: the feet layer is what we land on
      const layer = Math.floor(POSITION.y[index] - body.eyeHeight);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          if (!this.voxel.isSolid(x, layer, z)) continue;
          POSITION.y[index] = layer + 1 + body.eyeHeight + SKIN;
          motion.vy = 0;
          motion.onGround = true;
          return;
        }
      }
      return;
    }

    // Rising: the head layer blocks
    const layer = Math.floor(POSITION.y[index] - body.eyeHeight + body.height);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        if (!this.voxel.isSolid(x, layer, z)) continue;
        POSITION.y[index] = layer - body.height + body.eyeHeight - SKIN;
        motion.vy = 0;
        return;
      }
    }
  }
}
