// ===== The torus PERIOD: how far you walk before the world repeats (P2.02) =====
//
// The world wraps in X and Z (`data/world/world.ts`), and until P2.02 that lap was a hard-coded 32 chunks =
// 1024 blocks. It is a CHOICE now, because it is the one number that decides how far a distance LOD may reach:
// a ring at radius R is only unambiguous while `R < period/2` (past that the far edge starts showing the
// terrain that is closer the OTHER way round — the same hill twice on screen). 1024 blocks therefore caps this
// engine at two tiers (448 blocks), while the five or six tiers a "planet-like" world wants need 8192/16384.
//
// WHY A SEPARATE, DEPENDENCY-FREE MODULE: the period is read by the voxel world (`wrapChunkX`), the terrain
// noise (`terrainPeriod` — the field MUST repeat exactly on the lap or the seam is a cliff), the LOD sampler and
// the chunk stream (`nearestWrap`, the far ring's torus). `world.ts` already imports `terrain.ts`, so a value
// living in either of them could not be shared without a cycle; this leaf module is imported by both.
//
// IT IS BOOT/WORLD-ENTRY STATE, NOT PER-FRAME STATE: `setWorldChunks` is called by the world-entry driver
// BEFORE a world is built (and only when the choice actually changed), and everything downstream is reset with
// it — the voxel map and every mesh belong to the old period, so both caches are cleared in the same breath
// (`VoxelWorld.reset`, `chunk-stream.resetForNewWorld`). Nothing may call it while a world is streaming.
//
// THE STEP IS 8 CHUNKS, and that is not arbitrary: the LOD rings are powers of two (a fine ring that is a whole
// number of coarse columns, a far ring that is a whole number of ITS columns — see lod.ts), so a period that is
// not a multiple of the tier steps would put the wrap on a column boundary the rings cannot align to. 8 chunks
// is one `step = 8` tier cell, which is as coarse as this engine goes today.

/** The lap every world used before the size was a choice: 32 × 32 = 1024 blocks */
export const DEFAULT_WORLD_CHUNKS = 32;
/** 32 chunks = 1024 blocks (the historical lap, and the smallest world the first two rungs fit in).
 *  The ladder decides how many rungs a lap can hold (`lodLadder`): 32 chunks → 2, 64 → 3, 128 → 4, 256 → 5,
 *  512 → 6, which is the whole point of this being a setting. */
export const WORLD_CHUNKS_MIN = 32;
/** 512 chunks = 16384 blocks: the lap the SIX-rung ladder wants (its outermost rung reaches ±6144 blocks, which
 *  must stay inside the half-lap). */
export const WORLD_CHUNKS_MAX = 512;
/** Legal sizes land on this multiple: 16 chunks = 512 blocks. TWO things need it — the terrain's coarsest
 *  noise octave is 512 blocks per lattice cell and every octave's cell size must DIVIDE the lap (terrain.ts),
 *  and the LOD rings are powers of two (a fine ring that is a whole number of coarse columns), so the wrap has
 *  to land on a grid both can align to. So a "custom" size is a custom multiple of 16, not any number. */
export const WORLD_CHUNKS_STEP = 16;

let chunksX = DEFAULT_WORLD_CHUNKS;
let chunksZ = DEFAULT_WORLD_CHUNKS;

/** The period along X, in chunks (the value IN FORCE — the torus, the noise and the LOD rings all read it) */
export function worldChunksX(): number {
  return chunksX;
}
/** The period along Z, in chunks */
export function worldChunksZ(): number {
  return chunksZ;
}
/** The lap in BLOCKS (what the terrain noise repeats on, and what the player's coordinates run to) */
export function worldPeriodBlocks(): number {
  return chunksX * 32;
}

/** The sizes the world-type panel offers as buttons, in chunks per side: 1024 / 2048 / 4096 / 8192 / 16384
 *  blocks. They are the laps the LOD LADDER wants — 2 rungs need 1024 (the historical world), 3 need 2048, 4
 *  need 4096, 5 need 8192 and the shipped 6 need 16384 — because a rung at radius R repeats itself once
 *  `R ≥ lap/2` (see lod.ts `lodLadder`, which drops the rungs that do not fit). A "custom" size is the slider
 *  next to them, on the SAME grid (`WORLD_CHUNKS_STEP`). */
export const WORLD_SIZE_PRESETS: readonly number[] = [32, 64, 128, 256, 512];

/** Clamp a hand-edited or dragged value into the legal domain, SNAPPING it onto the step: a slider can only
 *  express these, and the value in force must always be one the UI can show (the same rule `sanitizeFrameCap`
 *  follows). Non-finite input means the smallest legal world. */
export function sanitizeWorldChunks(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return WORLD_CHUNKS_MIN;
  const stepped = WORLD_CHUNKS_MIN + Math.round((n - WORLD_CHUNKS_MIN) / WORLD_CHUNKS_STEP) * WORLD_CHUNKS_STEP;
  return Math.min(WORLD_CHUNKS_MAX, Math.max(WORLD_CHUNKS_MIN, stepped));
}

/** Set the period in force. Returns whether it CHANGED — the caller resets the caches only when it did, and the
 *  return value is what makes "entering a world of the same size" free. */
export function setWorldChunks(x: unknown, z: unknown = x): boolean {
  const nx = sanitizeWorldChunks(x);
  const nz = sanitizeWorldChunks(z);
  if (nx === chunksX && nz === chunksZ) return false;
  chunksX = nx;
  chunksZ = nz;
  return true;
}

/** IS THIS SIZE LEGAL for the ladder in force? The LADDER owns that rule now (`lodLadder` drops the rungs that
 *  would reach past the half-lap), so this module only carries the values; the gate sweeps the ladder against
 *  every legal size. */
