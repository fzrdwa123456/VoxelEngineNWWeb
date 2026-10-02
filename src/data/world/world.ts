// ===== VoxelWorld: the block grid — chunk storage, toroidal wrapping, bounded Y =====
//
// TOPOLOGY (deliberate — read before changing anything here)
//   X/Z : a TORUS. Chunk coordinates wrap modulo WORLD_CHUNKS_X/Z, so travelling far in one
//         direction brings you back to where you started. Seamlessness is achieved in the
//         renderer, not by teleporting the player: rendering/chunkstream.ts draws each chunk
//         at the representation NEAREST the player (see nearestWrap). The player's own
//         position is NEVER wrapped, so there is no discontinuity to see.
//   Y   : BOUNDED. The whole range is generated: a NOISE height field (data/world/terrain.ts) lays
//         grass/dirt/stone down and everything above the ground is air you may build in. Below
//         WORLD_MIN_Y everything is treated as BEDROCK (solid, so the floor can never be punched through
//         and the underside needs no faces); at/above WORLD_MAX_Y everything reads as air but is NOT writable.
//
// GENERATION is a NOISE HEIGHT FIELD, and it is still the ONE place that decides what the ground is: for
// every column, terrain.ts answers the first air layer, and this file writes grass on top of it, a few layers
// of dirt under that, stone below (the palette in data/world/palette.ts names the ids). Every value is a
// palette index, so the mesher draws each layer with its own texture; an install whose packs define no `dirt`
// simply gets the engine checker for that layer. The field is bounded, so chunks entirely above or entirely
// below the terrain are filled UNIFORMLY (one value, no array allocated) — that is what keeps a tall build
// range cheap even though the surface is no longer flat.
//
// READS DO NOT GENERATE. getBlock() on a chunk that was never ensured returns AIR. Callers that
// need a populated neighbourhood (the mesher) must ensure it first — chunkstream.ts does that.
import { AIR, CHUNK_SIZE, Chunk, SOLID, voxelIndex } from "./chunk";
import { FALLBACK_PALETTE, idIn, valueIn } from "./palette";
import { TERRAIN_BASE_Y, TERRAIN_MAX_Y, TERRAIN_MIN_Y, terrainHeight } from "./terrain";
import { worldChunksX, worldChunksZ } from "./size";

/** THE TORUS PERIOD IS A CHOICE NOW (P2.02) and lives in `data/world/size.ts`: 32 chunks = 1024 blocks by
 *  default, and the world-entry driver sets it from the world-size setting before it builds a world. Everything
 *  here reads it through `worldChunksX/Z()` — a hard-coded 32 would silently disagree with the noise's period
 *  the moment the setting moved (the terrain field MUST repeat exactly on the lap, see terrain.ts). */
export { DEFAULT_WORLD_CHUNKS, WORLD_CHUNKS_MAX, WORLD_CHUNKS_MIN, setWorldChunks, worldChunksX, worldChunksZ } from "./size";
/** Bounded vertical extent: chunk Y in [MIN_CHUNK_Y, MIN_CHUNK_Y + CHUNK_Y_COUNT).
 *  8 chunks = 256 blocks: 128 of ground plus 128 of build space above it. Air chunks are
 *  uniformly filled and therefore allocation-free (see chunk.ts), so the extra height is cheap. */
export const MIN_CHUNK_Y = 0;
export const CHUNK_Y_COUNT = 8;

/** First generated block layer (below this = bedrock) */
export const WORLD_MIN_Y = MIN_CHUNK_Y * CHUNK_SIZE;
/** End of the writable volume (at/above this = sky, readable but not writable) */
export const WORLD_MAX_Y = (MIN_CHUNK_Y + CHUNK_Y_COUNT) * CHUNK_SIZE;
/** The noise field's BASE level — where the ground rolls around. It used to be the flat world's exact
 *  surface height, so the name survives: a COLUMN's surface is `terrainHeight(x, z)`, not this. */
export const TERRAIN_TOP_Y = TERRAIN_BASE_Y;
/** Where a body stands in a flat world, and the level the spawn point is measured from. The real spawn Y is
 *  read from the generated column (`topSolidY`) — see boot/drivers/world-entry.ts. */
export const WORLD_SURFACE_Y = TERRAIN_BASE_Y;

/** How many layers the surface band covers: 1 grass + (this - 1) dirt, stone below. Exported because the LOD
 *  sampler (`data/world/lod.ts`) needs the same band when it decides a coarse chunk is uniformly stone. */
export const SURFACE_LAYERS = 4;

/** THE LAYER RULE, in ONE place: `h` is a column's FIRST AIR LAYER and `y` a block in it — grass on the
 *  surface block, dirt under it, stone below. The generator and the LOD sampler (`data/world/lod.ts`) both
 *  ask this, so a coarse chunk and the fine chunks it covers cannot disagree about what a layer is. */
export function terrainLayerValue(
  h: number,
  y: number,
  stone: number,
  dirt: number,
  grass: number,
): number {
  if (y < h - SURFACE_LAYERS) return stone;
  return y === h - 1 ? grass : dirt;
}

/** Block coordinate -> local coordinate inside its chunk (negative-safe) */
function localOf(block: number): number {
  return ((block % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
}

/** Chunk coordinate -> chunk coordinate on the torus (negative-safe). The period is the one in force
 *  (data/world/size.ts), so a bigger world simply wraps later. */
export function wrapChunkX(cx: number): number {
  const n = worldChunksX();
  return ((cx % n) + n) % n;
}
export function wrapChunkZ(cz: number): number {
  const n = worldChunksZ();
  return ((cz % n) + n) % n;
}

/** The representation of wrapped chunk coordinate `c` that lies closest to `pc`.
 *  This is what makes a torus drawable in flat space: chunk 31 sits at -1 when the player is
 *  at chunk 0, i.e. immediately to their left, instead of a whole world away. */
export function nearestWrap(c: number, pc: number, period: number): number {
  return c + Math.round((pc - c) / period) * period;
}

/** The generator's height grid for ONE chunk's columns (32x32, indexed [lz * CHUNK_SIZE + lx]). A module-level
 *  buffer because generation is MAIN-THREAD-ONLY — the mesh pool's workers are handed an input, they never
 *  touch the world — and because one 2 KB buffer beats 1024 numbers of garbage per chunk on the spawn window's
 *  ~800 in-band chunks. */
const heightGrid = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);

/** THE generator: the noise height field, filled as grass over dirt over stone.
 *
 *  WHAT IT GUARANTEES (every one of these is a thing the rest of the engine relies on):
 *   * a column is SOLID from the ground floor up to `terrainHeight(x, z) - 1` and AIR above it — no holes,
 *     no floating islands, so collision and the mesher agree with what is drawn;
 *   * the height is a pure function of the wrapped chunk coordinates, so it is identical across chunks, across
 *     frames and across runs, and exactly periodic on the torus (see terrain.ts);
 *   * a chunk the field cannot reach is filled UNIFORMLY, which keeps it allocation-free: above TERRAIN_MAX_Y
 *     it is all air, and a chunk whose whole range sits below the dirt band is all stone. A chunk that lands
 *     in the band but happens to contain no surface (every column either above or below it) is returned to
 *     the uniform form too, after the grid has been computed.
 *
 *  Order matters in the band: the array is materialised ONCE, ZERO-FILLED (air), and then each column is
 *  written from the chunk's floor up to its surface — so the write is exactly the solid voxels of the chunk
 *  and the sky above the ground is never touched. (Writing only the dirt band and pre-filling the rest with
 *  stone is the shape this had for one revision, and it left a ceiling of stone over the whole world.) */
function generateChunk(chunk: Chunk, palette: readonly string[]): void {
  const bottom = chunk.cy * CHUNK_SIZE;
  const top = bottom + CHUNK_SIZE;
  // The layer values in the palette IN FORCE. An install that names none of them falls back to 1 — the first
  // block of any palette — rather than to 0, because 0 is AIR and a generator that writes air leaves a hole.
  const stone = valueIn(palette, "stone") || 1;
  const dirt = valueIn(palette, "dirt") || stone;
  const grass = valueIn(palette, "grass") || dirt;
  if (bottom >= TERRAIN_MAX_Y) {
    chunk.fill(AIR); // entirely above the field: build space
    return;
  }
  if (top <= TERRAIN_MIN_Y - SURFACE_LAYERS) {
    chunk.fill(stone); // entirely below the surface band: ONE value, so this chunk allocates nothing
    return;
  }

  const gx0 = chunk.cx * CHUNK_SIZE;
  const gz0 = chunk.cz * CHUNK_SIZE;
  let lowest = TERRAIN_MAX_Y + 1;
  let highest = TERRAIN_MIN_Y - 1;
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const h = terrainHeight(gx0 + lx, gz0 + lz);
      heightGrid[lz * CHUNK_SIZE + lx] = h;
      if (h < lowest) lowest = h;
      if (h > highest) highest = h;
    }
  }
  // The band is 64 blocks tall and a chunk is 32, so a chunk can be IN the band and still contain no surface.
  // Both cases go back to the zero-allocation uniform form instead of materialising 32 KB of one value.
  // The two tests are DIFFERENT extremes, and getting them the wrong way round is a real bug: "no column
  // reaches into this chunk" is about the HIGHEST surface (`highest - 1 < bottom`), while "every column's
  // dirt band is above this chunk" is about the LOWEST (`lowest - SURFACE_LAYERS >= top`). A surface landing
  // exactly on a chunk's first layer is the case that catches a swap — the grass is written by the chunk that
  // OWNS it, so a chunk that bails out as "all air" leaves the layer below showing dirt.
  if (highest - 1 < bottom) {
    chunk.fill(AIR); // every column's surface is above this chunk
    return;
  }
  if (lowest - SURFACE_LAYERS >= top) {
    chunk.fill(stone); // every column's dirt band is above this chunk
    return;
  }

  const blocks = chunk.materialise();
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const h = heightGrid[lz * CHUNK_SIZE + lx]; // FIRST AIR LAYER of this column
      const solidTop = h - 1; // its topmost solid block
      const yTop = solidTop < top - 1 ? solidTop : top - 1; // …clipped to this chunk
      if (yTop < bottom) continue; // the column is all air in this chunk
      for (let y = bottom; y <= yTop; y++) {
        // ONE write per solid voxel, from the chunk's floor up to the surface: stone, then the dirt band, and
        // grass on the very top. Nothing above `yTop` is touched — the array came back zero-filled (AIR).
        blocks[voxelIndex(lx, y - bottom, lz)] = terrainLayerValue(h, y, stone, dirt, grass);
      }
    }
  }
}

export class VoxelWorld {
  /** Wrapped chunk key -> chunk. Bounded by the period in force: at most `worldChunksX() * worldChunksZ() *
   *  CHUNK_Y_COUNT` (8192 keys at the default 32×32 lap). Uniform chunks allocate no array, so the map holds
   *  an entry per chunk that was ever ensured and the real memory is the chunks a player edited — which is also
   *  why a BIGGER lap makes the missing eviction (ROADMAP §3.2) matter more: the map grows with exploration. */
  private readonly chunks = new Map<string, Chunk>();
  /** Chunk identities whose MESH is stale because a block was written (see setBlock).
   *  The render layer drains this with takeDirty(); the voxel layer never touches meshes. */
  private readonly dirty = new Set<string>();
  /** Chunk identities whose mesh is stale because the RESOURCE CHAIN changed (P1.49ab, the pack reload).
   *  Separate from `dirty` on purpose: a block edit is one chunk the player is waiting for and is rebuilt
   *  UNBUDGETED, while a texture change touches every loaded chunk and must be spread over frames — the
   *  chunk stream drains this at RESTYLE_BUDGET_PER_FRAME via takeStale(), and for a chain change that work is
   *  a look re-resolution rather than a re-mesh (P1.18i). */
  private readonly stale = new Set<string>();

  /** The block ids a voxel value names, in value order (1..N). DERIVED: the composition root hands the block
   *  registry ids in right after it builds them (P1.47), so every block an install ships is both placeable and
   *  drawable. Until that call (a gate test, a world without the content plugin) it is FALLBACK_PALETTE. */
  private palette: readonly string[] = FALLBACK_PALETTE;

  /** THE WORLD SIZE CHANGED (P2.02): throw away every chunk and both stale queues.
   *
   *  A chunk key is a WRAPPED identity, so the moment the period moves, every stored chunk means something else
   *  ("column 5" is a different place in a 64-chunk lap than in a 32-chunk one) — keeping them would leave the
   *  new world peppered with the old one's blocks. The render side has to drop its meshes in the same breath
   *  (`chunk-stream.resetForNewWorld`), and the caller is the world-entry driver, BEFORE anything is generated
   *  or streamed for the new world. */
  reset(): void {
    this.chunks.clear();
    this.dirty.clear();
    this.stale.clear();
  }

  /** Install the palette in force, REPLACING it. Boot-only now: the pack reload uses `mergePalette`, because
   *  a replacement is exactly what re-points every existing voxel at another block. */
  setPalette(ids: readonly string[]): void {
    if (ids.length > 0) this.palette = [...ids];
  }

  /** MERGE a block-id list into the palette in force, keeping every number already handed out (P1.49ab).
   *
   *  THE POINT — and the MC lesson this copies: a voxel stores a NUMBER, so "which number means which block"
   *  must be owned by the ENGINE, never by the resource chain. `setPalette` REPLACED the list, so a pack that
   *  reordered or dropped an entry silently re-pointed every existing voxel at a different block (in MC the
   *  registry is static and a reload never touches it). Merging only ever APPENDS: a block the install no
   *  longer names keeps its number (its chunks stay readable and draw as the missing block), and a block a
   *  new pack adds gets the next free number. That is what makes a running reload safe. */
  mergePalette(ids: readonly string[]): { readonly added: readonly string[]; readonly total: number } {
    const next = [...this.palette];
    const added: string[] = [];
    for (const id of ids) {
      if (next.includes(id)) continue;
      next.push(id);
      added.push(id);
    }
    this.palette = next;
    return { added, total: next.length };
  }

  /** Mark EVERY loaded chunk's mesh stale (P1.49ab). Returns how many. */
  markAllStale(): number {
    let n = 0;
    for (const key of this.chunks.keys()) {
      this.stale.add(key);
      n++;
    }
    return n;
  }

  /** Up to `limit` stale identities, removed from the set. Takes a LIMIT rather than draining everything,
   *  because the caller is on a per-frame budget: what it does not take stays queued for the next frame. */
  takeStale(limit: number): string[] {
    const out: string[] = [];
    for (const key of this.stale) {
      if (out.length >= limit) break;
      out.push(key);
    }
    for (const key of out) this.stale.delete(key);
    return out;
  }

  /** Stale identities still queued (the reload's progress, and what the gate reads). */
  get staleCount(): number {
    return this.stale.size;
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
