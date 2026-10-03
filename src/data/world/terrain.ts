// ===== THE TERRAIN FIELD: a PURE, deterministic, TORUS-PERIODIC height function =====
//
// WHAT THIS IS. The world used to be a flat layer cake: every column's surface sat at `TERRAIN_TOP_Y`.
// This module is the replacement half of that: a 2D height field `terrainHeight(x, z)` — the FIRST AIR
// layer of the column at world block (x, z) — built from value noise. `generateChunk` (data/world/world.ts)
// is its only consumer in the engine; everything else still asks `isSolid()`.
//
// WHY IT IS PURE AND WHY THAT MATTERS. Two chunks generated at different times, in different orders, or in
// different processes must agree about the blocks they share, or the mesher draws walls inside the ground and
// collision disagrees with what is drawn. So: no state, no clock, no `Math.random`, no cached chunk, and no
// dependency on the chunk being generated. The same (x, z) answers identically for ever — the gate asserts it
// on two independently built worlds.
//
// TORUS-PERIODIC BY CONSTRUCTION (this is the part that is easy to get wrong). X/Z is a torus whose lap is
// `terrainPeriod()` blocks (P2.02: it used to be a hard-coded 1024 and is now the world-size setting — see
// data/world/size.ts), so block (0, z) and block (lap, z) are THE SAME PLACE. A height field sampled from a
// plain (unwrapped) hash would put a cliff there: the renderer draws the far side of the torus next to the near
// side (`nearestWrap`), so the seam is visible, not theoretical. The lattice index of every noise octave is
// therefore taken MODULO the number of cells in one lap, which makes the field exactly periodic —
// `terrainHeight(x) === terrainHeight(x + lap)` holds analytically, not approximately. Every octave's cell size
// must DIVIDE the lap for that to work, which is why they are powers of two and why a legal world size is a
// multiple of 512 blocks (size.ts: the coarsest octave is 512 blocks); the gate asserts both facts — including
// for a non-default size.
//
// COST. One height per 32x32 column grid per chunk in the surface band, and the band is bounded
// (TERRAIN_MIN_Y..TERRAIN_MAX_Y), so a chunk above or below it is filled UNIFORMLY and this module is never
// called for it — that is what keeps a tall build range cheap (see generateChunk's fast paths).
import { worldPeriodBlocks } from "./size";

/** The noise's lattice period in BLOCKS: one lap of the torus. It IS the world's period now (P2.02), read from
 *  `data/world/size.ts` — the one number both this module and world.ts agree on, without either importing the
 *  other (`world.ts` imports THIS one). `check:ecs` asserts the field is periodic over exactly this lap for
 *  every legal world size, and that every octave's cell size divides it. */
export function terrainPeriod(): number {
  return worldPeriodBlocks();
}

/** The seed. A constant, so a world is reproducible; change it and the whole torus is a different world. */
export const TERRAIN_SEED = 1337;

/** The flat world's old surface height, kept as the noise's BASE level: terrain rolls around it. */
export const TERRAIN_BASE_Y = 128;

/** How far the coarse "region" term moves a whole area up or down (blocks). */
const REGION_AMPLITUDE = 12;
/** The REGION term's lattice cell, in blocks: the coarsest thing in the field (a whole area rises or falls
 *  together). It is the reason a legal world size is a multiple of 512 blocks (`data/world/size.ts`), and it is
 *  part of `TERRAIN_NOISE` below because the GPU copy of the field needs it too. */
const REGION_CELL = 512;
/** How far the octave stack makes the ground roll around that level (blocks). */
const HILL_AMPLITUDE = 20;

/** Hard bounds of `terrainHeight`. The generator's uniform fast paths are built on these two numbers: *  a chunk starting at or above TERRAIN_MAX_Y is all air, a chunk ending at or below
 *  TERRAIN_MIN_Y - SURFACE_LAYERS is all stone. Both are computed from the amplitudes above, so they
 *  cannot drift away from the field. */
export const TERRAIN_MIN_Y = TERRAIN_BASE_Y - REGION_AMPLITUDE - HILL_AMPLITUDE;
export const TERRAIN_MAX_Y = TERRAIN_BASE_Y + REGION_AMPLITUDE + HILL_AMPLITUDE;

/** The octaves: cell size in blocks -> weight. Cell sizes are powers of two so each DIVIDES the period
 *  (a lap is a whole number of cells for every octave — that is what the periodic wrap needs), and the
 *  weights halve per octave, which is the classic smooth-hills fBm. */
const OCTAVES: readonly (readonly [number, number])[] = [
  [128, 1],
  [64, 0.5],
  [32, 0.25],
];
const OCTAVE_WEIGHT = 1.75; // 1 + 0.5 + 0.25: what the weights add up to, so the result stays in [0, 1)

/** THE FIELD, AS DATA (M0 of the GPU route, `plugins/render/systems/lod-gpu-probe.ts`). A second implementation of
 *  this function — the GPU sampler that the LOD's sampling cost needs — must be BUILT from these numbers rather
 *  than typed out again, or the two drift and the coarse surface stops agreeing with the real chunks it has to
 *  meet. The probe's TSL reads THIS object, and the gate asserts it is the only place those numbers come from. */
export const TERRAIN_NOISE = {
  seed: TERRAIN_SEED,
  baseY: TERRAIN_BASE_Y,
  regionAmplitude: REGION_AMPLITUDE,
  hillAmplitude: HILL_AMPLITUDE,
  octaveWeight: OCTAVE_WEIGHT,
  octaves: OCTAVES,
  regionCell: REGION_CELL,
  minY: TERRAIN_MIN_Y,
  maxY: TERRAIN_MAX_Y,
} as const;

/** 2^32 as a reciprocal: an integer hash's low 32 bits -> [0, 1) with one multiply. */
const INV_U32 = 2.3283064365386963e-10;

/** Integer hash of a lattice cell -> [0, 1). `Math.imul` keeps every product exact 32-bit, so the value is
 *  identical on every engine and every platform (a float multiply would round differently). */
function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) * INV_U32;
}

/** Smoothstep: without it the lattice shows as a grid of creases (linear interpolation of value noise has a
 *  discontinuous first derivative at every cell boundary). */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 2D value noise at `cell` blocks per lattice step, periodic over `terrainPeriod()` blocks.
 *  `x`/`z` are world block coordinates and must be non-negative (they always are: chunk coordinates are
 *  wrapped into [0, the lap) before use). */
function noise2(x: number, z: number, cell: number, seed: number): number {
  const cells = terrainPeriod() / cell; // whole number: `cell` divides the lap (see OCTAVES and size.ts)
  const fx = x / cell;
  const fz = z / cell;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = smooth(fx - ix);
  const tz = smooth(fz - iz);
  // THE WRAP: one lap is `cells` lattice steps, so the cell index repeats and so does the noise.
  const x0 = ix % cells;
  const z0 = iz % cells;
  const x1 = x0 + 1 === cells ? 0 : x0 + 1;
  const z1 = z0 + 1 === cells ? 0 : z0 + 1;
  const a = hash2(x0, z0, seed);
  const b = hash2(x1, z0, seed);
  const c = hash2(x0, z1, seed);
  const d = hash2(x1, z1, seed);
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * tz;
}

/** The octave stack, normalised back into [0, 1). */
function hills(x: number, z: number, seed: number): number {
  let sum = 0;
  for (let i = 0; i < OCTAVES.length; i++) {
    const octave = OCTAVES[i];
    sum += noise2(x, z, octave[0], seed + i * 0x9e3779b1) * octave[1];
  }
  return sum / OCTAVE_WEIGHT;
}

/** The FIRST AIR LAYER of the column at world block (x, z): the y a body standing there rests at.
 *  This is the whole "what is the ground" answer the generator fills chunks from — and it is the same
 *  query `VoxelWorld.topSolidY` answers by scanning, so a chunk that is generated and a chunk that is
 *  read agree by construction. */
export function terrainHeight(x: number, z: number): number {
  const region = (noise2(x, z, REGION_CELL, TERRAIN_SEED) - 0.5) * 2 * REGION_AMPLITUDE;
  const hill = (hills(x, z, TERRAIN_SEED + 0x51ed270b) - 0.5) * 2 * HILL_AMPLITUDE;
  const y = Math.round(TERRAIN_BASE_Y + region + hill);
  // The bounds are what the generator's fast paths trust, so they are ENFORCED here rather than hoped for:
  // a field that overshot them would put solid blocks in a chunk the generator filled as air.
  return y < TERRAIN_MIN_Y ? TERRAIN_MIN_Y : y > TERRAIN_MAX_Y ? TERRAIN_MAX_Y : y;
}
