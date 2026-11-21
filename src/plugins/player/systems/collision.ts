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

/** The Rust/WASM kernel, as this side needs it. Structural on purpose: a plugin may not import `host/`.
 *  DATA IN, DATA OUT: one call per tick carries every body and the block grid they are resolved against. */
export interface WasmCollisionKernel {
  resolveBatch(
    poses: Float64Array,
    ox: number,
    oy: number,
    oz: number,
    nx: number,
    ny: number,
    nz: number,
    solid: Uint8Array,
  ): Float64Array | null;
}

/** A mutable box the composition root fills when the async kernel lands. `kernel = null` = the TS path. */
export interface CollisionKernelHolder {
  kernel: WasmCollisionKernel | null;
}

/** Bodies as the kernel packs them: start xyz, target xyz, half, height, eye, vy (see wasm/collision/src/lib.rs). */
const POSE_STRIDE = 10;
/** Results per body: x, y, z, vy, onGround. */
const RESULT_STRIDE = 5;
/** Blocks of margin around the swept AABBs: the skin can push a body one block past the segment's box. */
const REGION_MARGIN = 2;
/** Largest block grid handed to the kernel in one tick. Above it the TS sweep runs instead — only a teleport,
 *  or bodies scattered across the map, can get there, and copying a huge box to answer a few queries would be
 *  the slow way round. */
const REGION_MAX_VOXELS = 1 << 18;

export class CollisionSystem {
  private readonly voxel: VoxelWorld;
  /** THE BATCH SCRATCH: rows being resolved, their packed poses and the block grid. Reused every tick and only
   *  ever grown (one buffer, no per-tick garbage — the point of the data-in/data-out shape). */
  private readonly batchRows: number[] = [];
  private poses = new Float64Array(0);
  private grid = new Uint8Array(0);

  constructor(
    private readonly world: World,
    /** The WASM kernel, when the platform has one. Absent/null = the TS implementation below, which the
     *  Node gate and a failed WASM load both use. */
    private readonly kernel: CollisionKernelHolder | null = null,
  ) {
    this.voxel = world.resource(VOXEL);
  }

  step(): void {
    const rows = this.world.query(CONTROL, POSITION, MOTION, BODY, PREV_POSITION).indices;
    const kernel = this.kernel?.kernel ?? null;
    if (kernel !== null && this.resolveBatch(kernel, rows)) return;
    for (let row = 0; row < rows.length; row++) {
      const index = rows[row];
      if (CONTROL.data[index]!.mode === "spectator") continue;
      dims.halfWidth = BODY.halfWidth[index];
      dims.height = BODY.height[index];
      dims.eyeHeight = BODY.eyeHeight[index];
      this.resolve(index, MOTION.data[index]!, dims);
    }
  }

  /** THE DOD PATH — gather, one call, scatter.
   *
   *  GATHER: every non-spectator body's swept AABB, unioned into ONE block region, and that region copied out of
   *  the voxel world into a flat byte grid. CALL: the kernel resolves all bodies against that grid in a single
   *  crossing (two typed arrays in, one out — no callback, no per-body call). SCATTER: the 5 numbers per body go
   *  back into the SoA columns.
   *
   *  Returns false when this tick cannot take the path — the region is larger than the budget (a teleport, or
   *  bodies spread across the map) or the kernel rejected the answer — and the caller then runs the TS sweep,
   *  which is the same algorithm, so behaviour does not depend on which path served the tick. */
  private resolveBatch(kernel: WasmCollisionKernel, rows: readonly number[]): boolean {
    const batch = this.batchRows;
    batch.length = 0;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let z0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    let z1 = Number.NEGATIVE_INFINITY;
    for (let r = 0; r < rows.length; r++) {
      const index = rows[r];
      if (CONTROL.data[index]!.mode === "spectator") continue;
      batch.push(index);
      const half = BODY.halfWidth[index];
      const height = BODY.height[index];
      const eye = BODY.eyeHeight[index];
      // The sweep spans start -> target; the body box and the skin can reach one block past either end.
      const loX = Math.min(PREV_POSITION.x[index], POSITION.x[index]) - half;
      const hiX = Math.max(PREV_POSITION.x[index], POSITION.x[index]) + half;
      const loY = Math.min(PREV_POSITION.y[index], POSITION.y[index]) - eye;
      const hiY = Math.max(PREV_POSITION.y[index], POSITION.y[index]) - eye + height;
      const loZ = Math.min(PREV_POSITION.z[index], POSITION.z[index]) - half;
      const hiZ = Math.max(PREV_POSITION.z[index], POSITION.z[index]) + half;
      if (loX < x0) x0 = loX;
      if (hiX > x1) x1 = hiX;
      if (loY < y0) y0 = loY;
      if (hiY > y1) y1 = hiY;
      if (loZ < z0) z0 = loZ;
      if (hiZ > z1) z1 = hiZ;
    }
    const n = batch.length;
    if (n === 0) return true;

    const bx0 = Math.floor(x0) - REGION_MARGIN;
    const by0 = Math.floor(y0) - REGION_MARGIN;
    const bz0 = Math.floor(z0) - REGION_MARGIN;
    const nx = Math.floor(x1) - bx0 + 1 + REGION_MARGIN;
    const ny = Math.floor(y1) - by0 + 1 + REGION_MARGIN;
    const nz = Math.floor(z1) - bz0 + 1 + REGION_MARGIN;
    const voxels = nx * ny * nz;
    if (voxels <= 0 || voxels > REGION_MAX_VOXELS) return false;

    if (this.poses.length < n * POSE_STRIDE) this.poses = new Float64Array(n * POSE_STRIDE);
    if (this.grid.length < voxels) this.grid = new Uint8Array(voxels);
    const poses = this.poses;
    for (let k = 0; k < n; k++) {
      const index = batch[k];
      const o = k * POSE_STRIDE;
      poses[o] = PREV_POSITION.x[index];
      poses[o + 1] = PREV_POSITION.y[index];
      poses[o + 2] = PREV_POSITION.z[index];
      poses[o + 3] = POSITION.x[index];
      poses[o + 4] = POSITION.y[index];
      poses[o + 5] = POSITION.z[index];
      poses[o + 6] = BODY.halfWidth[index];
      poses[o + 7] = BODY.height[index];
      poses[o + 8] = BODY.eyeHeight[index];
      poses[o + 9] = MOTION.data[index]!.vy;
    }

    const grid = this.grid;
    this.voxel.fillSolidRegion(bx0, by0, bz0, nx, ny, nz, grid);
    const answer = kernel.resolveBatch(
      poses.subarray(0, n * POSE_STRIDE),
      bx0,
      by0,
      bz0,
      nx,
      ny,
      nz,
      grid.subarray(0, voxels),
    );
    if (answer === null || answer.length !== n * RESULT_STRIDE) return false;

    for (let k = 0; k < n; k++) {
      const index = batch[k];
      const o = k * RESULT_STRIDE;
      POSITION.x[index] = answer[o];
      POSITION.y[index] = answer[o + 1];
      POSITION.z[index] = answer[o + 2];
      const motion = MOTION.data[index]!;
      motion.vy = answer[o + 3];
      motion.onGround = answer[o + 4] !== 0;
    }
    return true;
  }

  /** Re-apply this tick's displacement in sub-steps, resolving each axis against the blocks.
   *  THE FALLBACK: the Node gate (no WebAssembly host), a failed kernel load, or a region too large for the
   *  data-in/data-out path. Same algorithm as the kernel — change both together. */
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
