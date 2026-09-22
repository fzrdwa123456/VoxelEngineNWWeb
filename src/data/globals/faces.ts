// ===== The cube's six faces and their corner UVs, as DATA =====
// A face is emitted only when the neighbour on that side is not solid, so the mesher walks this table to
// decide what to push. Each entry carries the neighbour offset that culls it, its outward normal and its
// four corners — the winding verified by `cross(p1-p0, p3-p0) === normal` for every entry.
//
// It lives under `data/` because it is a constant description of a cube: the mesher
// (`logic/host/gpu/chunkmesh.ts`) reads it, and a geometry built from it needs no three.js to be described.

export type Vec3 = readonly [number, number, number];

export interface Face {
  /** Offset to the neighbour that would cull this face */
  readonly dir: Vec3;
  /** Outward normal */
  readonly normal: Vec3;
  /** The four corners, counter-clockwise seen from OUTSIDE the block */
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3];
}

// Corner winding verified by cross(p1-p0, p3-p0) === normal for every entry.
export const FACES: readonly Face[] = [
  {
    dir: [1, 0, 0],
    normal: [1, 0, 0],
    corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
  },
  {
    dir: [-1, 0, 0],
    normal: [-1, 0, 0],
    corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  },
  {
    dir: [0, 1, 0],
    normal: [0, 1, 0],
    corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  },
  {
    dir: [0, -1, 0],
    normal: [0, -1, 0],
    corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  },
  {
    dir: [0, 0, 1],
    normal: [0, 0, 1],
    corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  },
  {
    dir: [0, 0, -1],
    normal: [0, 0, -1],
    corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
  },
];

/** UVs for corners 0..3: bottom-left, bottom-right, top-right, top-left */
export const CORNER_UVS: readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];
