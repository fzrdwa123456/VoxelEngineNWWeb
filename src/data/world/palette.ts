// ===== THE BLOCK PALETTE: what a voxel VALUE means (P1.46, derived since P1.47) =====
// A chunk stores one byte per voxel, so a voxel is a PALETTE INDEX: 0 is air, and 1..N name a block id. The
// storage never changed (see data/world/chunk.ts) — this file is the missing half of it: the mapping that says
// which id a value means, so the generator, the mesher and block placement cannot disagree.
//
// WHERE THE LIST COMES FROM. It used to be a hard-coded list of six ids, and that was a real defect: a block
// the list did not name could not be PLACED (placement fell back to value 1, which by then meant `grass`, so
// the engine's own checker block turned into grass in the world) and a pack's own block could never be shown.
// The palette is therefore DERIVED FROM THE BLOCK REGISTRY at boot — `VoxelWorld.setPalette(allBlockIds())`,
// called by the composition root right after `buildBlockRegistry` — so every block an install ships is both
// placeable and drawable: texture, else flat colour, else the engine checker.
//
// FALLBACK_PALETTE is what a world holds BEFORE that call (a gate test that builds a VoxelWorld on its own,
// and the ids the generator needs). It names the blocks the generator builds a world out of plus `missing`,
// the engine's untextured block.
//
// All three helpers are PURE and take the palette explicitly: the voxel layer owns the list (it is the thing
// that stores the values), and no module keeps a cache of it.
export const FALLBACK_PALETTE: readonly string[] = [
  "grass",
  "dirt",
  "stone",
  "missing",
  "gold",
  "ruby",
  "default",
];

/** The value `id` has in `palette`: 0 when that palette does not name it (callers treat 0 as "no block"). */
export function valueIn(palette: readonly string[], id: string): number {
  const at = palette.indexOf(id);
  return at >= 0 ? at + 1 : 0;
}

/** The id `value` names in `palette`, or null for air and for a value outside it. */
export function idIn(palette: readonly string[], value: number): string | null {
  return value > 0 && value <= palette.length ? palette[value - 1] : null;
}
