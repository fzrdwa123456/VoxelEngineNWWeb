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
import { TERRAIN_MAX_Y, TERRAIN_MIN_Y, terrainHeight, terrainPeriod } from "./terrain";
import { SURFACE_LAYERS, terrainLayerValue } from "./world";

/** Where the six neighbour planes live in `ChunkMeshInput.planes` — the gatherer's order (see mesh.ts). */
const PLANE = { PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 } as const;

/** How the far ring is configured. Data, so the composition root picks it and the gate can drive a tiny one.
 *
 *  THE LADDER (P2.03): the window used to be exactly two rings. It is now a LADDER of `tiers` rungs, each one
 *  covering the annulus the rung inside it does not, and each rung twice as coarse as the one inside it:
 *    * tier 1 IS the fine ring (real 32³ chunks, `step` 1);
 *    * tier L has `step = 2^(L-1)` cells, each cell `32·step` blocks across, and its ANNULUS is `reach` of its
 *      own cells wide on every side;
 *    * its HOLE — what it only BUILDS and keeps hidden — is exactly the coverage of everything inside it.
 *  The radii therefore grow with the ladder: with the shipped `reach` 4 the rungs reach 128, 384, 896, 1792,
 *  3584 and 7168 blocks. The sixth one is what the biggest lap the world-size panel offers is for.
 *
 *  So the rungs TILE the plane: every fine column inside the outermost reach is covered exactly once, and the
 *  tiers are nested at the same time — which is what the READY RESERVE (P2.00) needs: a rung's hole is exactly
 *  the area the finer rungs cover, so the coarser chunk is already built (hidden) when a finer one leaves.
 *
 *  HOW MANY FIT IS THE WORLD'S LAP's BUSINESS (P2.02): a rung at radius R repeats itself once `R ≥ lap/2` — its
 *  far edge would show the terrain that is closer the other way round — so `lodLadder` returns only the rungs
 *  that fit the lap in force. That is the whole reason the world size became a setting. */
export interface LodPolicy {
  /** The most rungs the ladder may have (the lap decides how many FIT — see `lodLadder`) */
  readonly tiers: number;
  /** The REACH of the FINE ring (in fine chunks) and of every rung's ANNULUS (in that rung's own cells).
   *  MUST BE EVEN: the fine window has to be a whole number of the second rung's cells (`fineBase`, P1.94). */
  readonly reach: number;
}

/** The shipped shape: SIX rungs, the finest window 4 chunks (= 128 blocks) out and every annulus 4 of its own
 *  cells wide. The outer rung reaches 7168 blocks, so it needs a lap whose HALF is at least that: 16384 blocks,
 *  the biggest lap the world-size panel offers (512 chunks). A smaller world simply gets fewer rungs, and the
 *  entry says so. `reach` is 4 rather than 6 because a rung's hole is everything inside it: 6 would put the
 *  sixth rung at 12096 blocks and need a lap this engine does not have. */
export const DEFAULT_LOD: LodPolicy = { tiers: 6, reach: 4 };

/** The step of the SECOND rung. It is also the FINE ring's alignment (`fineBase`): the fine window must be a
 *  whole number of the next rung's cells, or the two would meet on half a cell (that was the P1.94 empty
 *  column — the gate still tiles every parity). */
export const LOD_BASE_STEP = 2;

/** ONE AXIS of a rung, as CELL INDICES relative to `floor(centre / step)` — the rung's cell that holds the
 *  window's centre. `[lo, hi)` is everything the rung knows about (its drawn annulus AND its reserve); the part
 *  of it that is `[holeLo, holeHi)` is the reserve.
 *
 *  A RANGE RATHER THAN A RADIUS, and per axis, because the cells are aligned to the WORLD (they must not move
 *  as the player walks) while the ranges are centred on the window: whenever the centre is not on a rung's own
 *  grid, its two ends fall out asymmetrically. That asymmetry is not cosmetic — a symmetric range is what left
 *  a see-through gap and a z-fighting overlap at every rung boundary (the P1.94 bug, generalised — caught by
 *  the gate's tiling sweep). */
export interface LodSpan {
  readonly lo: number;
  readonly hi: number;
  readonly holeLo: number;
  readonly holeHi: number;
}

/** One rung of the ladder. `reach`/`hole` are in this rung's own cells (what the lap test measures and what the
 *  reports print); `x`/`z` are the ranges the stream iterates. */
export interface LodTier {
  /** Blocks per super voxel side: `2^(L-1)` */
  readonly step: number;
  /** The annulus half-width, in this rung's own cells (`policy.reach`) */
  readonly reach: number;
  /** How many of this rung's cells the hole spans, on the WIDER axis (0 for the fine ring). The two axes can
   *  differ by one cell — a rung's coverage is a rectangle whenever the window's two centres are not on the
   *  same alignment — and the lap test has to answer for the wider one. */
  readonly hole: number;
  readonly x: LodSpan;
  readonly z: LodSpan;
}

/** Does a rung fit inside a lap of `lapChunks` chunks? The rung's outer edge in BLOCKS is
 *  `(reach + hole/2)·32·step` and it must stay inside the HALF-lap, or it starts showing the terrain that is
 *  closer the other way round (the same hill twice on screen — see data/world/size.ts). The extra half-cell is
 *  the alignment wobble: a rung whose centre is not on its own grid reaches up to half a cell further on one
 *  side, and the answer must not change as the player walks (a rung that appeared and disappeared would
 *  rebuild the outer ring). */
export function lodTierFits(tier: Pick<LodTier, "step" | "reach" | "hole">, lapChunks: number): boolean {
  return (tier.hole + 2 * tier.reach + 1) * tier.step <= lapChunks;
}

/** THE LADDER IN FORCE around `(centreX, centreZ)` (absolute BLOCK coordinates — the window's fine base), cut
 *  off where the lap can no longer hold a rung.
 *
 *  THE TILING, in one line: rung L's HOLE is the rung inside's coverage CROPPED to rung L's own cells. A coarse
 *  cell that is only half covered by the finer coverage cannot be owned by both — a gap between them is a
 *  see-through hole and an overlap is z-fighting — so the rung INSIDE gives the cell up, which is why its
 *  annulus can end up one cell thinner than `reach`. Nothing else has to be adjusted: the crop leaves the hole
 *  exactly equal to the inner coverage, which is what the reserve (P2.00) and the handover rest on. */
export function lodLadder(
  policy: LodPolicy,
  lapChunks: number,
  centreX: number,
  centreZ: number,
): readonly LodTier[] {
  const half = policy.reach * 32;
  // The recursion's working state: absolute edges (the covered range) plus the hole it starts from.
  interface Rung {
    step: number;
    reach: number;
    hole: number;
    lo: number;
    hi: number;
    holeLo: number;
    holeHi: number;
    zlo: number;
    zhi: number;
    zHoleLo: number;
    zHoleHi: number;
  }
  const out: Rung[] = [
    {
      step: 1,
      reach: policy.reach,
      hole: 0,
      lo: centreX - half,
      hi: centreX + half,
      holeLo: 0,
      holeHi: 0, // the fine ring has no reserve: nothing is inside it
      zlo: centreZ - half,
      zhi: centreZ + half,
      zHoleLo: 0,
      zHoleHi: 0,
    },
  ];

  for (let index = 2; index <= policy.tiers; index++) {
    const step = 2 ** (index - 1);
    const size = 32 * step; // one cell of this rung, in blocks
    const inner = out[index - 2];
    // The hole: this rung's cells that the inner coverage FILLS (the inner edges rounded inward onto this grid).
    const holeLo = Math.ceil(inner.lo / size) * size;
    const holeHi = Math.floor(inner.hi / size) * size;
    const zHoleLo = Math.ceil(inner.zlo / size) * size;
    const zHoleHi = Math.floor(inner.zhi / size) * size;
    if (holeLo >= holeHi || zHoleLo >= zHoleHi) break; // nothing left to reserve: the rung is degenerate
    const tier: Rung = {
      step,
      reach: policy.reach,
      hole: Math.max(holeHi - holeLo, zHoleHi - zHoleLo) / size,
      lo: holeLo - policy.reach * size,
      hi: holeHi + policy.reach * size,
      holeLo,
      holeHi,
      zlo: zHoleLo - policy.reach * size,
      zhi: zHoleHi + policy.reach * size,
      zHoleLo,
      zHoleHi,
    };
    // THE FIT IS DECIDED FIRST, because keeping the rung is what makes the crop safe: the cells the rung inside
    // gives up are covered by THIS rung, so cropping for a rung that is then dropped would open a hole.
    if (!lodTierFits(tier, lapChunks)) break; // the radii only grow, so no bigger rung fits either
    inner.lo = holeLo;
    inner.hi = holeHi;
    inner.zlo = zHoleLo;
    inner.zhi = zHoleHi;
    out.push(tier);
  }

  // …and the absolute edges become CELL OFFSETS from each rung's own `floor(centre / step)`, which is what the
  // systems iterate and what `inTierCoverage`/`inTierHole` test.
  return out.map((rung) => {
    const cell = 32 * rung.step;
    const cx = Math.floor(centreX / cell);
    const cz = Math.floor(centreZ / cell);
    const span = (lo: number, hi: number, holeLo: number, holeHi: number, c: number): LodSpan => ({
      lo: lo / cell - c,
      hi: hi / cell - c,
      holeLo: holeLo / cell - c,
      holeHi: holeHi / cell - c,
    });
    return {
      step: rung.step,
      reach: rung.reach,
      hole: rung.hole,
      x: span(rung.lo, rung.hi, rung.holeLo, rung.holeHi, cx),
      z: span(rung.zlo, rung.zhi, rung.zHoleLo, rung.zHoleHi, cz),
    };
  });
}
/** The rung a `step` names, out of a ladder (the chunk stream keeps keys, not rung indices). */
export function tierOfStep(ladder: readonly LodTier[], step: number): LodTier | null {
  for (const tier of ladder) if (tier.step === step) return tier;
  return null;
}

/** Is this cell (delta in TIER cells) inside the rung's COVERAGE — what it builds, drawn annulus AND reserve? */
export function inTierCoverage(tier: LodTier, dx: number, dz: number): boolean {
  return dx >= tier.x.lo && dx < tier.x.hi && dz >= tier.z.lo && dz < tier.z.hi;
}

/** Is this cell (delta in TIER cells) one the rung DRAWS? The drawn part is its COVERAGE minus its HOLE —
 *  everything the rungs inside it do not own. */
export function inTierAnnulus(tier: LodTier, dx: number, dz: number): boolean {
  return inTierCoverage(tier, dx, dz) && !inTierHole(tier, dx, dz);
}

/** Is this cell (delta in TIER cells) inside the rung's HOLE — which is exactly the coverage of the rung INSIDE
 *  this one? Such a chunk is the READY RESERVE (P2.00): built, and drawn only while the finer chunks over it
 *  are missing. Both ends are the CROPPED inner coverage, so the two boundaries coincide exactly rather than
 *  nearly. */
export function inTierHole(tier: LodTier, dx: number, dz: number): boolean {
  return dx >= tier.x.holeLo && dx < tier.x.holeHi && dz >= tier.z.holeLo && dz < tier.z.holeHi;
}

/** A lap no rung can reach. The lap only decides how many rungs FIT, and the two-rung predicates below are about
 *  the geometry of the first two rungs around a window that sits on its own alignment. */
const ANY_LAP = 1 << 24;

/** The FIRST rung of a policy: the fine ring around a window at the origin. (Its reach can be a cell NARROWER
 *  than `policy.reach` when `reach` is odd, because the second rung's grid crops it — see `lodLadder`.) */
function firstRung(policy: LodPolicy): LodTier {
  return lodLadder(policy, ANY_LAP, 0, 0)[0];
}

/** The SECOND rung of a policy, whatever the lap. `tiers: 2` is what guarantees it exists. */
function secondRung(policy: LodPolicy): LodTier {
  return lodLadder({ tiers: 2, reach: policy.reach }, ANY_LAP, 0, 0)[1];
}

/** Is the FINE chunk column (cx, cz — in fine chunks, relative to the window's base) inside the fine ring? The
 *  fine window is rung 1, a whole number of the SECOND rung's cells exactly because `reach` is even and the base
 *  is even (`fineBase`). */
export function isFineColumn(policy: LodPolicy, cx: number, cz: number): boolean {
  return inTierCoverage(firstRung(policy), cx, cz);
}

/** Is the SECOND rung's cell (cx, cz — in tier-2 cells, relative to the window's base) in its DRAWN annulus?
 *  Kept as the named predicate the gate tiles with. */
export function isFarColumn(policy: LodPolicy, cx: number, cz: number): boolean {
  return inTierAnnulus(secondRung(policy), cx, cz);
}

/** Is the SECOND rung's cell in its BUILD set (the drawn annulus PLUS the hole, which is the reserve)? */
export function isFarBuildColumn(policy: LodPolicy, cx: number, cz: number): boolean {
  return inTierCoverage(secondRung(policy), cx, cz);
}

/** Is this coarse cell one the FINE ring covers? (The first rung's reserve; the general rule is `inTierHole`.) */
export function isFineCoveredColumn(policy: LodPolicy, cx: number, cz: number): boolean {
  return inTierHole(secondRung(policy), cx, cz);
}

/** THE FINE RING'S ALIGNMENT (P1.94 — measured bug). The fine window must be built around a column that is a
 *  whole number of the SECOND rung's columns, not around the player's own one.
 *
 *  WHY: the fine ring is `[-reach, reach)` fine columns, which is a whole number of tier-2 columns only when its
 *  base is even — and the tier-2 hole is measured from `floor(pc/2)`. Built around a raw (odd) column, every
 *  ODD column produced exactly: one fine column owned by BOTH rings (two meshes in the same place, z-fighting)
 *  and one owned by NEITHER — a 32-block-wide, full-depth column with no geometry whose neighbours' walls are
 *  culled (their planes read the world, which does have terrain there), so you look straight through the ground.
 *  The gate asserts the tiling for every parity. `fineBase(null, pc) === pc`, so the no-LOD path is untouched. */
export function fineBase(policy: LodPolicy | null, pc: number): number {
  if (policy === null) return pc;
  return Math.floor(pc / LOD_BASE_STEP) * LOD_BASE_STEP;
}

/** THE DEBUG VIEW'S TIER COLOURS (P1.94/P2.03): `G` tints every chunk mesh by the rung it belongs to, so "which
 *  part of the world is coarse" is something you can see instead of infer. Indexed by the RUNG (`log2(step)`),
 *  one entry per rung the shipped ladder can have (six); a colour MULTIPLIES the material, so a textured block
 *  keeps its texture and takes the hue. Deliberately not theme tokens: these tint 3D materials, not UI. */
export const LOD_TIER_TINT: readonly string[] = [
  "#7dffb0", // rung 1 — the fine ring (real chunks)
  "#6aa9ff", // rung 2 — step 2
  "#c58cff", // rung 3 — step 4
  "#ffd166", // rung 4 — step 8
  "#ff8f6b", // rung 5 — step 16
  "#5fe3d0", // rung 6 — step 32
];

/** The tint for one rung (an unknown rung gets the brightest debug colour rather than nothing). */
export function tierTint(step: number): string {
  return LOD_TIER_TINT[Math.round(Math.log2(step))] ?? "#ff5ad0";
}

/** Wrap a block coordinate into the torus: the height field is periodic over one lap (see terrain.ts, and
 *  `data/world/size.ts` — the lap is the world-size setting now, so this reads the value IN FORCE rather than
 *  a constant), and the far ring's border cells reach one super voxel OUTSIDE the chunk, which is negative at
 *  the origin. */
function wrapBlock(v: number): number {
  const period = terrainPeriod();
  return ((v % period) + period) % period;
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
  step: number,
  cx: number,
  cz: number,
): { readonly max: Int16Array; readonly min: Int16Array } {
  const key = `${step}:${cx},${cz}`;
  if (memoSampledKey === key && memoSampled !== null) return memoSampled;
  const S = CHUNK_SIZE;
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

/** Build the mesh input for ONE coarse chunk of a rung: the whole 32³ array plus the six neighbour planes, all
 *  from a single sampled height grid. The layout is the fine gatherer's (the same `meshChunk` reads either).
 *  `step` is the RUNG's step (the caller has it in the key), so one function serves every rung. */
export function buildLodMeshInput(
  step: number,
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
  const grid = sampledGrid(step, cx, cz);
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
