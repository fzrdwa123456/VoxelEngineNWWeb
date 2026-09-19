// ===== Chunk: a fixed CHUNK_SIZE^3 block volume =====
// The world is a grid of these; `VoxelWorld` (voxel/world.ts) owns the map, the coordinate
// wrapping and the generation. A chunk is pure storage — no three.js, no behaviour.
//
// Block values are palette indices:
//   AIR   = 0  (nothing drawn, nothing solid)
//   SOLID = 1  (the engine's built-in magenta/black checker block — see rendering/chunkmesh.ts)
//
// UNIFORM CHUNKS COST NOTHING. The generator produces whole chunks of a single value, and a
// chunk only allocates its 32 KB array on the first set(). Until then it is "a single value that
// covers everything", which is why a tall build range full of air (and the entire solid mass
// below it) is essentially free: only chunks a player has actually edited allocate. `isUniform`
// also lets the mesher skip a fully empty chunk outright and skip the INTERIOR of a fully solid
// one, which is a ~6x saving on the common case.
//
// Flat index layout is (y * S + z) * S + x: y-major so a horizontal layer is contiguous.
export const CHUNK_SIZE = 32;
/** CHUNK_SIZE^3 voxels per chunk, if the chunk ever materialises */
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;
export const AIR = 0;
export const SOLID = 1;

/** Flat index of a local voxel. No bounds check — callers stay inside 0..CHUNK_SIZE-1 */
export function voxelIndex(lx: number, ly: number, lz: number): number {
  return (ly * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;
}

export class Chunk {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** Voxel data; null while the whole chunk still equals `uniform` */
  private blocks: Uint8Array | null = null;
  /** The value every voxel has while `blocks === null` */
  private uniform: number = AIR;

  constructor(cx: number, cy: number, cz: number) {
    this.cx = cx;
    this.cy = cy;
    this.cz = cz;
  }

  /** True while no voxel of this chunk was written (so the mesher can skip work) */
  get isUniform(): boolean {
    return this.blocks === null;
  }

  /** Value of a uniform chunk; meaningless once isUniform is false */
  get uniformValue(): number {
    return this.uniform;
  }

  get(lx: number, ly: number, lz: number): number {
    return this.blocks === null ? this.uniform : this.blocks[voxelIndex(lx, ly, lz)];
  }

  set(lx: number, ly: number, lz: number, value: number): void {
    if (this.blocks === null) {
      // First write: materialise the uniform value into a real array, then patch it
      const blocks = new Uint8Array(CHUNK_VOLUME);
      if (this.uniform !== AIR) blocks.fill(this.uniform);
      this.blocks = blocks;
    }
    this.blocks[voxelIndex(lx, ly, lz)] = value;
  }

  /** Whole-chunk fill: the generator's fast path, and it returns the chunk to the
   *  zero-allocation uniform form (it does NOT keep the old array around). */
  fill(value: number): void {
    this.blocks = null;
    this.uniform = value;
  }
}
