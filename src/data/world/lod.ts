// ===== LOD: the FAR RING (P1.93) =====
//
// WHAT THIS IS. The streamed window used to be ONE ring of fine 32³ chunks. It is two now: an inner ring of
// real chunks (unchanged — the edits, the collision, the mesher's fast paths) and an OUTER ring drawn from the
// same terrain at a COARSER resolution, so the world reaches further without the geometry growing with it.
// A coarse chunk is `policy.step` fine chunks wide (2 by default), so it is still a 32³ array — of super
// voxels — and it goes through the SAME mesher with the same input contract. `chunk-stream` scales the mesh
// by `(step, 1, step)` on placement, which is what turns a 32×32 super-voxel face into a 64×64 block face;
// nothing in `mesh.ts` had to change.
//
// WHY IT IS SAMPLED FROM THE HEIGHT FIELD, NOT DIGESTED FROM THE WORLD. Two reasons, and both are about the
// numbers measured in P1.92:
//   * SPEED. `gatherChunkMeshInput` on the main thread is the warm-up's dominant cost (0.73–0.92 ms per fine
//     chunk, ~1.8 s for one window), and a coarse chunk built by OR-ing four fine chunks would cost ~4× that.
//     Sampling the height field is a pure function of (x, z): one small grid per chunk, no world reads, no
//     `isSolid` string-key lookups, ~0.3 ms — cheap enough to build the whole far ring on the main thread as
//     it streams in.
//   * SEAMS. A coarse chunk's own blocks AND its six neighbour planes come from the SAME sampled grid, so they
//     agree by construction — including with the FINE ring, whose chunks were generated from the same field.
// THE PRICE, stated plainly: a coarse chunk is PROCEDURAL. A block a player edits out in the far ring is not
// reflected there (the fine ring takes over as they approach, so the edit is correct where they can reach it).
// That is the documented cost of this first LOD, and the reason `chunk-stream` never routes an edit into it.
//
// CONSERVATIVE, SO THERE ARE NO HOLES. Each super voxel takes the MAXIMUM height of the fine columns it
// covers (not an average), so the coarse surface is never BELOW the fine one: an LOD ring can bulge a block or
// two at the boundary, but it can never open a crack you can see the sky through. That is the one property
// this module must not lose, and the gate asserts it against the real generator.
import { AIR, CHUNK_SIZE } from "./chunk";
import type { ChunkMeshInput } from "./mesh";
import { TERRAIN_MAX_Y, TERRAIN_MIN_Y, TERRAIN_PERIOD, terrainHeight } from "./terrain";
import { SURFACE_LAYERS, terrainLayerValue } from "./world";

/** Where the six neighbour planes live in `ChunkMeshInput.planes` — the gatherer's order (see mesh.ts). */
const PLANE = { PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 } as const;

/** How the far ring is configured. Data, so the composition root picks it and the gate can drive a tiny one. */
export interface LodPolicy {
  /** Fine chunks per coarse chunk, per horizontal axis (the vertical stays 1 — see below) */
  readonly step: number;
  /** Radius of the FINE ring, in COARSE columns: the fine ring covers coarse columns [-r, r] */
  readonly fineRadius: number;
  /** Radius of the FAR ring, in coarse columns, measured from the player's coarse column */
  readonly farRadius: number;
}

/** The shipped shape: 2× coarse, a 14×14 fine ring (448 blocks) and a far ring out to coarse ±7, i.e. fine
 *  columns ±15 = 480 blocks — just inside the 1024-block torus lap, so the world does not visibly repeat. */
export const DEFAULT_LOD: LodPolicy = { step: 2, fineRadius: 3, farRadius: 7 };

/** The vertical is NOT decimated (a coarse chunk is still 32 blocks tall): the terrain is a 96..160 band in a
 *  256-block world, so a second coarse axis would buy little geometry and cost the Y alignment that makes a
 *  coarse chunk's key, placement and ring boundary identical in shape to a fine one's. */

/** Is the FINE chunk column (cx, cz) inside the fine ring? The fine ring covers coarse columns [-r, r], i.e.
 *  fine columns [-2r, 2r+1]: an EVEN span, which is exactly what makes the two rings meet without a gap and
 *  without an overlap (an odd span would leave one column covered by neither). */
export function isFineColumn(policy: LodPolicy, cx: number, cz: number): boolean {
  const r = policy.fineRadius;
  return cx >= -2 * r && cx <= 2 * r + 1 && cz >= -2 * r && cz <= 2 * r + 1;
}

/** Is the COARSE chunk column (cx, cz — in coarse units) in the far ring? The ring is everything inside
 *  `farRadius` that the fine ring does NOT already own, so no column is drawn twice. */
export function isFarColumn(policy: LodPolicy, cx: number, cz: number): boolean {
  const reach = Math.max(Math.abs(cx), Math.abs(cz));
  return reach <= policy.farRadius && reach > policy.fineRadius;
}

/** Wrap a block coordinate into the torus: the height field is periodic over one lap (see terrain.ts), and
 *  the far ring's border cells reach one super voxel OUTSIDE the chunk, which is negative at the origin. */
function wrapBlock(v: number): number {
  return ((v % TERRAIN_PERIOD) + TERRAIN_PERIOD) % TERRAIN_PERIOD;
}

/** The sampled grid of the LAST column asked for — a ONE-ENTRY MEMO, and the difference between a far ring
 *  that costs a frame and one that does not. A column's 8 chunks need the SAME grid, and the stream walks a
 *  column's chunks back to back (`farKeys` is near-first, top Y first), so this removes ~7/8 of the terrain
 *  sampling: 176 grid builds for the whole ring instead of 1408 (measured 2091 ms → ~450 ms).
 *  A cache of a DETERMINISTIC function of (cx, cz) cannot go stale — the field never changes — which is what
 *  makes module-level state safe here (the generator keeps its own scratch grid for the same reason). */
let memoSampledKey = "";
let memoSampled: Int16Array | null = null;

/** The (S+2)² grid of sampled heights for one coarse column: one height per super voxel, plus one cell of
 *  border on every side, because the ±X/±Z planes ARE the solidity of the neighbouring coarse cells. */
function sampledGrid(policy: LodPolicy, cx: number, cz: number): Int16Array {
  const key = `${cx},${cz}`;
  if (memoSampledKey === key && memoSampled !== null) return memoSampled;
  const S = CHUNK_SIZE;
  const step = policy.step;
  const W = S + 2;
  const gx0 = cx * S * step;
  const gz0 = cz * S * step;
  const grid = new Int16Array(W * W);
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const bx = gx0 + (i - 1) * step;
      const bz = gz0 + (j - 1) * step;
      let h = 0;
      for (let dz = 0; dz < step; dz++) {
        for (let dx = 0; dx < step; dx++) {
          // MAX over the covered fine columns: the conservative choice (see the header) — never lower.
          const t = terrainHeight(wrapBlock(bx + dx), wrapBlock(bz + dz));
          if (t > h) h = t;
        }
      }
      grid[j * W + i] = h;
    }
  }
  memoSampledKey = key;
  memoSampled = grid;
  return grid;
}

/** Build the mesh input for ONE coarse chunk: the whole 32³ array plus the six neighbour planes, all from a
 *  single sampled height grid. The layout is the fine gatherer's (the same `meshChunk` reads either). */
export function buildLodMeshInput(
  policy: LodPolicy,
  cx: number,
  cy: number,
  cz: number,
  stone: number,
  dirt: number,
  grass: number,
): ChunkMeshInput {
  const S = CHUNK_SIZE;
  const bottom = cy * S;
  const top = bottom + S;
  const grid = sampledGrid(policy, cx, cz);
  const W = S + 2;
  const cellAt = (i: number, j: number): number => grid[j * W + i];

  // The bounds of the CHUNK's own cells (a border cell that is solid above/below is there to cull a face, and
  // must not turn a uniform chunk into a materialised one).
  let lowest = TERRAIN_MAX_Y + 1;
  let highest = TERRAIN_MIN_Y - 1;
  for (let j = 1; j <= S; j++) {
    for (let i = 1; i <= S; i++) {
      const h = grid[j * W + i];
      if (h < lowest) lowest = h;
      if (h > highest) highest = h;
    }
  }

  const planes = new Uint8Array(6 * S * S);
  /** One plane cell: SOLID iff the terrain of that coarse column reaches y — the same `y < h` the world's
   *  `isSolid` gives for a generated column, which is what keeps the rings culling each other correctly. */
  const at = (plane: number, a: number, b: number, i: number, j: number, y: number): void => {
    planes[plane * S * S + a * S + b] = y < cellAt(i, j) ? 1 : 0;
  };
  for (let ly = 0; ly < S; ly++) {
    const y = bottom + ly;
    for (let lz = 0; lz < S; lz++) {
      at(PLANE.PX, ly, lz, S + 1, lz + 1, y); // the coarse cell just east of this chunk
      at(PLANE.NX, ly, lz, 0, lz + 1, y); //     …just west
    }
    for (let lx = 0; lx < S; lx++) {
      at(PLANE.PZ, lx, ly, lx + 1, S + 1, y); // …just south
      at(PLANE.NZ, lx, ly, lx + 1, 0, y); //     …just north
    }
  }
  for (let lz = 0; lz < S; lz++) {
    for (let lx = 0; lx < S; lx++) {
      at(PLANE.PY, lx, lz, lx + 1, lz + 1, top); //      the first block of the chunk above
      at(PLANE.NY, lx, lz, lx + 1, lz + 1, bottom - 1); // the last block of the chunk below
    }
  }

  // The uniform fast paths, exactly as the generator has them: the far ring's top and bottom layers are
  // mostly one value, and a uniform chunk allocates nothing and takes the mesher's shell path.
  if (highest <= bottom) return { uniform: true, uniformValue: AIR, blocks: null, planes };
  if (lowest - SURFACE_LAYERS >= top) return { uniform: true, uniformValue: stone, blocks: null, planes };

  const blocks = new Uint8Array(S * S * S);
  for (let lz = 0; lz < S; lz++) {
    for (let lx = 0; lx < S; lx++) {
      const h = cellAt(lx + 1, lz + 1);
      const solidTop = h - 1 < top - 1 ? h - 1 : top - 1; // clipped to this chunk
      for (let y = bottom; y <= solidTop; y++) {
        // THE MESH INPUT'S OWN LAYOUT, which is NOT `chunk.ts`'s `voxelIndex`: `meshChunk` reads
        // `lx + ly*S + lz*S*S` (the gatherer writes the same — see mesh.ts). Using the chunk's index here
        // transposes the array, which the mesher then reads as a different world: the far ring came out two
        // blocks low with holes in it, and the gate's "every solid fine voxel is solid in the coarse one"
        // assertion is what caught it.
        blocks[lx + (y - bottom) * S + lz * S * S] = terrainLayerValue(h, y, stone, dirt, grass);
      }
    }
  }
  return { uniform: false, uniformValue: 0, blocks, planes };
}
