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
  /** How far IN the far ring's BUILD set reaches (coarse columns). `0` = the far ring builds every coarse chunk
   *  within `farRadius`, including the ones under the fine ring — the READY RESERVE (`farReserveOffsets`), which
   *  it does not DRAW. That reserve is what closes the seam: a fine chunk that leaves the window always has
   *  coarse geometry that was built while it was still hidden, so the handover is a swap and never a hole.
   *  Raising this shrinks the reserve (less work, less memory) at the cost of that guarantee. */
  readonly farBuildInner: number;
}

/** The shipped shape: 2× coarse, a 14×14 fine ring (448 blocks) and a far ring out to coarse ±7, i.e. fine
 *  columns ±15 = 480 blocks — just inside the 1024-block torus lap, so the world does not visibly repeat. */
export const DEFAULT_LOD: LodPolicy = { step: 2, fineRadius: 3, farRadius: 7, farBuildInner: 0 };

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

/** Is the COARSE chunk column (cx, cz) in the far ring's BUILD set? That is the DRAWN ring plus the READY
 *  RESERVE — the coarse chunks under the fine ring (`farBuildInner` = 0 builds all of them), which exist so a
 *  fine chunk that leaves always has coarse geometry already behind it.
 *
 *  WHY THE RESERVE (P2.00 — how Voxy/Cubyz/DH avoid the seam. «E:\voxy-263你看看这个怎么实现的lod»). The two
 *  rings TILE: the far ring owns everything the fine ring does not, so the moment the window moves, a column
 *  that leaves the fine ring is a NEW far column — it had no coarse mesh at all, and until the far budget
 *  reached it there was nothing behind the fine mesh but sky. Fading the fine chunk out only shortens that
 *  hole (measured: the sky still flashed). Both reference projects keep the coarse level COVERING the fine one
 *  — Voxy mips every section up through 4 levels and only DRAWS the level a node's children do not already
 *  cover; Cubyz draws a parent node until all 8 of its children are meshed; DH keeps the LOD image and blends
 *  it under the vanilla one. The reserve is the same idea at the smallest scale that works here: coarse
 *  geometry that is present, hidden while the fine chunks are there, and visible the moment they are not. */
export function isFarBuildColumn(policy: LodPolicy, cx: number, cz: number): boolean {
  const reach = Math.max(Math.abs(cx), Math.abs(cz));
  return reach <= policy.farRadius && reach >= policy.farBuildInner;
}

/** Is this coarse column one the fine ring COVERS? Such a column's coarse chunk is the reserve: drawn only
 *  while the fine chunks that cover it are not all there yet. The fine ring is a whole number of coarse
 *  columns on every side (see `fineBase`), so a coarse chunk is never half covered. */
export function isFineCoveredColumn(policy: LodPolicy, cx: number, cz: number): boolean {
  return Math.max(Math.abs(cx), Math.abs(cz)) <= policy.fineRadius;
}

/** THE FINE RING'S ALIGNMENT (P1.94 — measured bug). The fine window must be built around a COARSE-ALIGNED
 *  column, not around the player's own one.
 *
 *  WHY: the fine ring is a whole number of COARSE columns on each side of its base (offsets [-2r, 2r+1]), and
 *  the far ring's inner hole is a whole number of coarse columns around `floor(pc/step)`. Those two agree
 *  only when the base column IS `floor(pc/step)*step` — i.e. only for an EVEN `pc` with step 2. Built around
 *  the player's raw column, every ODD column produced exactly: one fine column owned by BOTH rings
 *  (two meshes in the same place, z-fighting) and one owned by NEITHER — a 32-block-wide, full-depth column
 *  with no geometry at all, whose neighbours' walls are culled (their planes read the world, which does have
 *  terrain there), so you look straight through the ground. The gate asserts the tiling for every parity.
 *
 *  `fineBase(null, pc) === pc`, so a world with no LOD is untouched. */
export function fineBase(policy: LodPolicy | null, pc: number): number {
  if (policy === null) return pc;
  return Math.floor(pc / policy.step) * policy.step;
}

/** THE DEBUG VIEW'S TIER COLOURS (P1.94): `G` tints every chunk mesh by the tier it belongs to, so "which
 *  part of the world is coarse" is something you can see instead of infer. Index = the tier (the entry's
 *  `step`, 1 = the fine ring, 2 = the far ring); a colour MULTIPLIES the material, so a textured block keeps
 *  its texture and takes the hue. Deliberately not theme tokens: these tint 3D materials, not UI. */
export const LOD_TIER_TINT: readonly string[] = ["#7dffb0", "#6aa9ff"];

/** The tint for one tier (an unknown tier gets the brightest debug colour rather than nothing). */
export function tierTint(step: number): string {
  return LOD_TIER_TINT[step - 1] ?? "#ff5ad0";
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
let memoSampled: { readonly max: Int16Array; readonly min: Int16Array } | null = null;

/** The (S+2)² grids of sampled heights for one coarse column, plus one cell of border on every side, because
 *  the ±X/±Z planes ARE the solidity of the neighbouring coarse cells.
 *
 *  TWO GRIDS, and the difference is the P1.95 fix: `max` is the MAXIMUM height over the `step × step` fine
 *  columns a super voxel covers (conservative — the coarse surface is never BELOW the fine one, so the BODY
 *  cannot leave a crack), and `min` is the MINIMUM (cull-safe — a face is only culled when the WHOLE covered
 *  area is solid). They are used for different things: the body and the ±Y planes take `max` (the vertical
 *  neighbour is always the same level, so max is exact there), while the ±X/±Z planes take `min`, because the
 *  neighbour on those sides may be the FINE ring, whose geometry is per BLOCK. Culling a 2×2-wide quad with
 *  `max` while the fine side is per block deleted the wall wherever the terrain stepped inside the cell — a
 *  one-block hole you could see into (measured: 3 of 1024 cells on one wall, 2 of them showing the interior). */
function sampledGrid(
  policy: LodPolicy,
  cx: number,
  cz: number,
): { readonly max: Int16Array; readonly min: Int16Array } {
  const key = `${cx},${cz}`;
  if (memoSampledKey === key && memoSampled !== null) return memoSampled;
  const S = CHUNK_SIZE;
  const step = policy.step;
  const W = S + 2;
  const gx0 = cx * S * step;
  const gz0 = cz * S * step;
  const maxGrid = new Int16Array(W * W);
  const minGrid = new Int16Array(W * W);
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const bx = gx0 + (i - 1) * step;
      const bz = gz0 + (j - 1) * step;
      let hi = 0;
      let lo = TERRAIN_MAX_Y;
      for (let dz = 0; dz < step; dz++) {
        for (let dx = 0; dx < step; dx++) {
          const t = terrainHeight(wrapBlock(bx + dx), wrapBlock(bz + dz));
          if (t > hi) hi = t;
          if (t < lo) lo = t;
        }
      }
      maxGrid[j * W + i] = hi;
      minGrid[j * W + i] = lo;
    }
  }
  memoSampled = { max: maxGrid, min: minGrid };
  memoSampledKey = key;
  return memoSampled;
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
  const cellAt = (i: number, j: number): number => grid.max[j * W + i];
  const cellFloor = (i: number, j: number): number => grid.min[j * W + i];

  // The bounds of the CHUNK's own cells (a border cell that is solid above/below is there to cull a face, and
  // must not turn a uniform chunk into a materialised one).
  let lowest = TERRAIN_MAX_Y + 1;
  let highest = TERRAIN_MIN_Y - 1;
  for (let j = 1; j <= S; j++) {
    for (let i = 1; i <= S; i++) {
      const h = grid.max[j * W + i];
      if (h < lowest) lowest = h;
      if (h > highest) highest = h;
    }
  }

  const planes = new Uint8Array(6 * S * S);
  /** The ±Y planes: SOLID iff the coarse column's terrain reaches y. `max` is EXACT here — the chunk above or
   *  below a far chunk is always a far chunk (the rings are split by COLUMN, so all 8 Y chunks of a column
   *  belong to the same ring), i.e. the vertical neighbour has the very same super-voxel granularity. */
  const atVertical = (plane: number, a: number, b: number, i: number, j: number, y: number): void => {
    planes[plane * S * S + a * S + b] = y < cellAt(i, j) ? 1 : 0;
  };
  /** The ±X/±Z planes: SOLID only if the WHOLE `step × step` area the quad covers is solid (`min`, not `max`),
   *  because that neighbour may be the FINE ring, whose geometry is per block. It costs a few extra quads —
   *  measured 3 of 1024 cells on a boundary wall, hidden behind the neighbour's own body — and it is what
   *  closes the one-block holes. Between two FAR chunks `max` would be exact, so `min` only over-draws there,
   *  which is cheaper than making the rule depend on where the player happens to stand. */
  const atSide = (plane: number, a: number, b: number, i: number, j: number, y: number): void => {
    planes[plane * S * S + a * S + b] = y < cellFloor(i, j) ? 1 : 0;
  };
  for (let ly = 0; ly < S; ly++) {
    const y = bottom + ly;
    for (let lz = 0; lz < S; lz++) {
      atSide(PLANE.PX, ly, lz, S + 1, lz + 1, y); // the coarse cell just east of this chunk
      atSide(PLANE.NX, ly, lz, 0, lz + 1, y); //     …just west
    }
    for (let lx = 0; lx < S; lx++) {
      atSide(PLANE.PZ, lx, ly, lx + 1, S + 1, y); // …just south
      atSide(PLANE.NZ, lx, ly, lx + 1, 0, y); //     …just north
    }
  }
  for (let lz = 0; lz < S; lz++) {
    for (let lx = 0; lx < S; lx++) {
      atVertical(PLANE.PY, lx, lz, lx + 1, lz + 1, top); //      the first block of the chunk above
      atVertical(PLANE.NY, lx, lz, lx + 1, lz + 1, bottom - 1); // the last block of the chunk below
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
