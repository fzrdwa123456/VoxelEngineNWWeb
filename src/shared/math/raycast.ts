// ===== Voxel raycast (Amanatides & Woo grid traversal) =====
// Walks a ray through the block grid one voxel at a time and returns the first SOLID voxel it
// enters, together with the face it came in through. The face normal is what block placement
// needs: the new block goes at (hit + normal), never inside the block that was hit.
//
// Pure maths over VoxelWorld.isSolid — no three.js, no ECS.
import type { VoxelWorld } from "../../data/world/world";

export interface RayHit {
  /** Block coordinate of the solid voxel that was hit */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Face normal pointing back toward the ray origin; one component is ±1.
   *  All zero means the ray STARTED inside a solid voxel — no placement is possible then. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Distance along the (unit) ray at which the hit happened */
  readonly distance: number;
}

/** Hard cap on traversed voxels. At the reach distances used here the real count is < 20;
 *  this only exists so a degenerate direction can never spin forever. */
const MAX_STEPS = 1024;

export function raycastVoxel(
  voxel: VoxelWorld,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
): RayHit | null {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);

  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const stepZ = Math.sign(dz);

  // Distance along the ray for one full voxel of travel on each axis (Infinity = never crosses)
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;

  // Distance along the ray to the first voxel boundary on each axis
  let tMaxX = stepX !== 0 ? (stepX > 0 ? x + 1 - ox : ox - x) * tDeltaX : Infinity;
  let tMaxY = stepY !== 0 ? (stepY > 0 ? y + 1 - oy : oy - y) * tDeltaY : Infinity;
  let tMaxZ = stepZ !== 0 ? (stepZ > 0 ? z + 1 - oz : oz - z) * tDeltaZ : Infinity;

  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;

  for (let i = 0; i < MAX_STEPS; i++) {
    if (voxel.isSolid(x, y, z)) return { x, y, z, nx, ny, nz, distance: t };

    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      nx = -stepX;
      ny = 0;
      nz = 0;
    } else if (tMaxY <= tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      nx = 0;
      ny = -stepY;
      nz = 0;
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      nx = 0;
      ny = 0;
      nz = -stepZ;
    }

    if (t > maxDistance) return null;
  }
  return null;
}
