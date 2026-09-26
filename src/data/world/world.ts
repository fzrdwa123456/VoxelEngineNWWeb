// ===== VoxelWorld: the block grid — chunk storage, toroidal wrapping, bounded Y =====
//
// TOPOLOGY (deliberate — read before changing anything here)
//   X/Z : a TORUS. Chunk coordinates wrap modulo WORLD_CHUNKS_X/Z, so travelling far in one
//         direction brings you back to where you started. Seamlessness is achieved in the
//         renderer, not by teleporting the player: rendering/chunkstream.ts draws each chunk
//         at the representation NEAREST the player (see nearestWrap). The player's own
//         position is NEVER wrapped, so there is no discontinuity to see.
//   Y   : BOUNDED, and split in two. [WORLD_MIN_Y, TERRAIN_TOP_Y) is generated TERRAIN (solid in
//         the default flat world) and [TERRAIN_TOP_Y, WORLD_MAX_Y) is generated AIR — the BUILD
//         SPACE. Both are real writable chunks, which is what lets you place blocks above the
//         surface. Below WORLD_MIN_Y everything is treated as BEDROCK (solid, so the floor can
//         never be punched through and the underside needs no faces); at/above WORLD_MAX_Y
//         everything reads as air but is NOT writable.
//
// GENERATION is a LAYER CAKE, and it is still the ONE place that decides what the ground is: grass on the
// surface, a few layers of dirt under it, stone below that (the palette in data/world/palette.ts names the
// ids). Every value is a palette index, so the mesher draws each layer with its own texture; an install whose
// packs define no `dirt` simply gets the engine checker for that layer. Deep chunks stay UNIFORM (one value,
// no array allocated), which is what keeps a tall build range cheap.
//
// READS DO NOT GENERATE. getBlock() on a chunk that was never ensured returns AIR. Callers that
// need a populated neighbourhood (the mesher) must ensure it first — chunkstream.ts does that.
import { AIR, CHUNK_SIZE, Chunk, SOLID } from "./chunk";
import { FALLBACK_PALETTE, idIn, valueIn } from "./palette";

/** Torus period along X/Z, in chunks: 32 * 32 = 1024 blocks before the world repeats */
export const WORLD_CHUNKS_X = 32;
export const WORLD_CHUNKS_Z = 32;
/** Bounded vertical extent: chunk Y in [MIN_CHUNK_Y, MIN_CHUNK_Y + CHUNK_Y_COUNT).
 *  8 chunks = 256 blocks: 128 of ground plus 128 of build space above it. Air chunks are
 *  uniformly filled and therefore allocation-free (see chunk.ts), so the extra height is cheap. */
export const MIN_CHUNK_Y = 0;
export const CHUNK_Y_COUNT = 8;

/** First generated block layer (below this = bedrock) */
export const WORLD_MIN_Y = MIN_CHUNK_Y * CHUNK_SIZE;
/** End of the writable volume (at/above this = sky, readable but not writable) */
export const WORLD_MAX_Y = (MIN_CHUNK_Y + CHUNK_Y_COUNT) * CHUNK_SIZE;
/** Flat generator surface: the FIRST AIR LAYER. Solid below, air above. Deliberately a chunk
 *  boundary so every chunk of the default world is uniformly filled. */
export const TERRAIN_TOP_Y = 128;
/** Where a body stands, and therefore the spawn height (feet) */
export const WORLD_SURFACE_Y = TERRAIN_TOP_Y;

/** How many layers the surface band covers: 1 grass + (this - 1) dirt, stone below. */
const SURFACE_LAYERS = 4;

/** Block coordinate -> local coordinate inside its chunk (negative-safe) */
function localOf(block: number): number {
  return ((block % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
}

/** Chunk coordinate -> chunk coordinate on the torus (negative-safe) */
export function wrapChunkX(cx: number): number {
  return ((cx % WORLD_CHUNKS_X) + WORLD_CHUNKS_X) % WORLD_CHUNKS_X;
}
export function wrapChunkZ(cz: number): number {
  return ((cz % WORLD_CHUNKS_Z) + WORLD_CHUNKS_Z) % WORLD_CHUNKS_Z;
}

/** The representation of wrapped chunk coordinate `c` that lies closest to `pc`.
 *  This is what makes a torus drawable in flat space: chunk 31 sits at -1 when the player is
 *  at chunk 0, i.e. immediately to their left, instead of a whole world away. */
export function nearestWrap(c: number, pc: number, period: number): number {
  return c + Math.round((pc - c) / period) * period;
}

/** THE generator. Flat, single-block — replace this when real terrain lands.
 *  Everything strictly below TERRAIN_TOP_Y is SOLID, everything at/above it is AIR. Because
 *  TERRAIN_TOP_Y sits on a chunk boundary the default world is made only of uniform chunks,
 *  which allocate nothing until edited. */
function generateChunk(chunk: Chunk, palette: readonly string[]): void {
  const bottom = chunk.cy * CHUNK_SIZE;
  const top = bottom + CHUNK_SIZE;
  // The layer values in the palette IN FORCE. An install that names none of them falls back to 1 ? the first
  // block of any palette ? rather than to 0, because 0 is AIR and a generator that writes air leaves a hole.
  const stone = valueIn(palette, "stone") || 1;
  const dirt = valueIn(palette, "dirt") || stone;
  const grass = valueIn(palette, "grass") || dirt;
  if (bottom >= TERRAIN_TOP_Y) {
    chunk.fill(AIR); // entirely build space
    return;
  }
  if (top <= TERRAIN_TOP_Y - SURFACE_LAYERS) {
    chunk.fill(stone); // entirely deep ground: ONE value, so this chunk allocates nothing
    return;
  }
  // The surface band: grass on top, dirt under it, stone below. Only chunks in this band materialise.
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    const y = bottom + ly;
    if (y >= TERRAIN_TOP_Y) continue; // above the surface is air
    const value = y === TERRAIN_TOP_Y - 1 ? grass : y >= TERRAIN_TOP_Y - SURFACE_LAYERS ? dirt : stone;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) chunk.set(lx, ly, lz, value);
    }
  }
}

export class VoxelWorld {
  /** Wrapped chunk key -> chunk. Bounded: at most WORLD_CHUNKS_X * WORLD_CHUNKS_Z * CHUNK_Y_COUNT */
  private readonly chunks = new Map<string, Chunk>();
  /** Chunk identities whose MESH is stale because a block was written (see setBlock).
   *  The render layer drains this with takeDirty(); the voxel layer never touches meshes. */
  private readonly dirty = new Set<string>();

  /** The block ids a voxel value names, in value order (1..N). DERIVED: the composition root hands the block
   *  registry ids in right after it builds them (P1.47), so every block an install ships is both placeable and
   *  drawable. Until that call (a gate test, a world without the content plugin) it is FALLBACK_PALETTE. */
  private palette: readonly string[] = FALLBACK_PALETTE;

  /** Install the palette in force. The root calls this during boot: chunks generated before it keep the values
   *  they were built with, and there are none before the world is entered. */
  setPalette(ids: readonly string[]): void {
    if (ids.length > 0) this.palette = [...ids];
  }

  /** The value a block id has in the palette in force: 0 when it is not named there (place nothing). */
  valueOf(id: string): number {
    return valueIn(this.palette, id);
  }

  /** The block id a voxel value names, or null for air and for a value the palette does not cover. */
  idOf(value: number): string | null {
    return idIn(this.palette, value);
  }

  static key(cx: number, cy: number, cz: number): string {
    return `${cx},${cy},${cz}`;
  }

  get loadedChunkCount(): number {
    return this.chunks.size;
  }

  /** Chunk at wrapped X/Z and bounded Y, or null when Y is outside the generated range */
  getChunk(cx: number, cy: number, cz: number): Chunk | null {
    if (!inYRange(cy)) return null;
    return this.chunks.get(VoxelWorld.key(wrapChunkX(cx), cy, wrapChunkZ(cz))) ?? null;
  }

  /** Generate a chunk if it is not in the store yet. Idempotent; null outside the Y range. */
  ensureChunk(cx: number, cy: number, cz: number): Chunk | null {
    if (!inYRange(cy)) return null;
    const wx = wrapChunkX(cx);
    const wz = wrapChunkZ(cz);
    const k = VoxelWorld.key(wx, cy, wz);
    let chunk = this.chunks.get(k);
    if (!chunk) {
      chunk = new Chunk(wx, cy, wz);
      generateChunk(chunk, this.palette);
      this.chunks.set(k, chunk);
    }
    return chunk;
  }

  /** Block value at a world-space block coordinate. Air outside the generated volume;
   *  bedrock below it (which is why the world has no bottom hole to fall through). */
  getBlock(x: number, y: number, z: number): number {
    if (y < WORLD_MIN_Y) return SOLID;
    if (y >= WORLD_MAX_Y) return AIR;
    const chunk = this.getChunk(
      Math.floor(x / CHUNK_SIZE),
      Math.floor(y / CHUNK_SIZE),
      Math.floor(z / CHUNK_SIZE),
    );
    if (!chunk) return AIR;
    return chunk.get(localOf(x), localOf(y), localOf(z));
  }

  isSolid(x: number, y: number, z: number): boolean {
    return this.getBlock(x, y, z) !== AIR;
  }

  /** Write one block. Returns false when the coordinate is outside the generated volume
   *  (below WORLD_MIN_Y = bedrock, at/above WORLD_MAX_Y = sky) — that is what stops anyone
   *  digging through the world floor. Generates the owning chunk on demand: a write is an
   *  explicit request, unlike a read. */
  setBlock(x: number, y: number, z: number, value: number): boolean {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return false;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const chunk = this.ensureChunk(cx, cy, cz);
    if (!chunk) return false;

    const lx = localOf(x);
    const ly = localOf(y);
    const lz = localOf(z);
    chunk.set(lx, ly, lz, value);

    // The owning chunk is always stale. A block on a chunk border also changes the NEIGHBOUR
    // chunk's culled faces, so that one is stale as well.
    this.markDirty(cx, cy, cz);
    if (lx === 0) this.markDirty(cx - 1, cy, cz);
    if (lx === CHUNK_SIZE - 1) this.markDirty(cx + 1, cy, cz);
    if (ly === 0) this.markDirty(cx, cy - 1, cz);
    if (ly === CHUNK_SIZE - 1) this.markDirty(cx, cy + 1, cz);
    if (lz === 0) this.markDirty(cx, cy, cz - 1);
    if (lz === CHUNK_SIZE - 1) this.markDirty(cx, cy, cz + 1);
    return true;
  }

  /** Take the chunks whose mesh is stale and clear the set (consume-and-reset: a caller that
   *  fails to rebuild them loses that rebuild rather than repeating it every frame). */
  takeDirty(): Set<string> {
    const out = new Set(this.dirty);
    this.dirty.clear();
    return out;
  }

  private markDirty(cx: number, cy: number, cz: number): void {
    if (!inYRange(cy)) return;
    this.dirty.add(VoxelWorld.key(wrapChunkX(cx), cy, wrapChunkZ(cz)));
  }

  /** Top surface height of the highest solid block in column (x, z) at or below `fromY`,
   *  i.e. the y coordinate a body standing there would rest on. null when the column is air. */
  topSolidY(x: number, z: number, fromY: number): number | null {
    const start = Math.min(Math.floor(fromY), WORLD_MAX_Y - 1);
    for (let y = start; y >= WORLD_MIN_Y; y--) {
      if (this.isSolid(x, y, z)) return y + 1;
    }
    return null;
  }
}

function inYRange(cy: number): boolean {
  return cy >= MIN_CHUNK_Y && cy < MIN_CHUNK_Y + CHUNK_Y_COUNT;
}
