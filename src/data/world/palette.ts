// ===== THE BLOCK PALETTE: what a voxel VALUE means (P1.46) =====
// A chunk stores one byte per voxel, so a voxel is a PALETTE INDEX: 0 is air, and 1..N name a block id. The
// storage never changed (see data/world/chunk.ts) — this file is the missing half of it: ONE list that says
// which id a value means, so the generator, the mesher and block placement cannot disagree.
//
// WHY A LIST AND NOT A MAP BUILT FROM THE REGISTRY: the generator runs while chunks stream (long after boot)
// and the voxel layer must stay pure data with no idea what a "block definition" is. The palette is therefore
// the ENGINE's own small vocabulary of blocks it knows how to build a world out of, and every id in it is
// optional: an install whose packs do not define `dirt` simply gets the checker texture for value 3 (see the
// mesher's spec resolution). A content plugin declaring the palette is future work (SLOT_BLOCKS could carry
// it), and this list is where that declaration would land.
export const BLOCK_PALETTE: readonly string[] = ["grass", "stone", "dirt", "gold", "ruby", "default"];

/** The voxel value for a block id: 0 when the id is not in the palette (callers treat 0 as "no block"). */
export function paletteValueOf(id: string): number {
  const at = BLOCK_PALETTE.indexOf(id);
  return at >= 0 ? at + 1 : 0;
}

/** The block id a voxel value names, or null for air / a value outside the palette. */
export function paletteIdOf(value: number): string | null {
  return value > 0 && value <= BLOCK_PALETTE.length ? BLOCK_PALETTE[value - 1] : null;
}
