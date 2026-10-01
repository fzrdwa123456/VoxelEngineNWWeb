// ===== The PURE chunk mesher: voxel data in, typed arrays out (P1.18h) =====
// This is `chunkmesh.ts`'s scanning half with three.js, the material cache and the `VoxelWorld` taken OUT.
// Why that split exists:
//
//   * a WORKER may not touch three.js, the GPU, the block registry or the world's `Map` — it gets bytes and
//     gives bytes back, which is exactly what this module does (that is what makes meshing multi-core);
//   * the same function is the main thread's fallback, so there is ONE mesher and no second implementation
//     to keep in step (a worker path that computed something slightly different would be a silent bug);
//   * it is pure, so the gate can drive it and compare face counts and group layout directly.
//
// WHAT THE INPUT IS, and why it is small. The scan walks this chunk's voxels and culls each face against the
// neighbour on that side. Inside the chunk that is a plain array read; the only outside information is the
// SOLIDITY of the six neighbour chunks' facing layer (32x32 cells each), so a job ships:
//   * the chunk's own voxels — NOTHING AT ALL while it is uniform (the value says it all, and the scan's
//     uniform fast path visits only the boundary shell), or the 32^3 array once a block has been written;
//   * six 1024-byte planes, 1 = solid.
// They are transferred, not copied, and they are built fresh per job by `gatherChunkMeshInput`.
//
// WHAT THE OUTPUT IS: four typed arrays plus the LOOK SLOTS — `(voxel value << 2) | kind` with a contiguous
// face range each. The VALUE is all a worker may know about a block (the palette and the block table live on
// the main thread, and the texture resolution behind them is the pack chain), so the caller maps each slot key
// back to its `ChunkFaceSpec` and thence to a material. The two-pass scan below is what makes those ranges
// contiguous without a per-face sort, and BOTH passes walk in the same order (nothing in the walk depends on
// the counts), which is the property the slot layout rests on.
import { AIR, CHUNK_SIZE, type Chunk } from "./chunk";
import { CORNER_UVS, FACES, type Face } from "../globals/faces";
import type { VoxelWorld } from "./world";

/** Where the six neighbour planes live in `ChunkMeshInput.planes`, in this order. */
const PLANE = { PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 } as const;

/** One meshing job's input: bytes only, no world, no three.js. */
export interface ChunkMeshInput {
  /** The whole chunk is one value: the scan uses the shell fast path, so `blocks` is empty. */
  uniform: boolean;
  /** That value (meaningless unless `uniform`). */
  uniformValue: number;
  /** The chunk's voxels, `CHUNK_SIZE^3` of them — present only when `!uniform`.
   *  `Uint8Array<ArrayBuffer>` on purpose: these two arrays are handed to a Worker as TRANSFERABLES, and a
   *  `Uint8Array` over a `SharedArrayBuffer` cannot be transferred. */
  blocks: Uint8Array<ArrayBuffer> | null;
  /** Six `CHUNK_SIZE^2` planes of neighbour solidity, in `PLANE` order (+x, -x, +y, -y, +z, -z). */
  planes: Uint8Array<ArrayBuffer>;
}

/** One material group: the look this range of faces belongs to, and where it starts. */
export interface MeshSlot {
  /** `(voxel value << 2) | kind`, kind 0 top, 1 bottom, 2 side — the key `specFor` takes. */
  readonly key: number;
  /** First face index of the slice (faces, not vertices). */
  readonly start: number;
  /** How many faces the slice holds (> 0 for every slot that is returned). */
  readonly count: number;
}

/** A meshed chunk: chunk-local positions/normals/uvs and the quad indices, exactly as a geometry wants them. */
export interface MeshResult {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  /** Faces emitted; 0 means "nothing visible" and the caller drops the mesh. */
  readonly faces: number;
  /** One entry per look, in first-seen order (`geometry.groups` order). Empty when `faces === 0`. */
  readonly slots: readonly MeshSlot[];
  /** The buffer of every array above, so the caller can TRANSFER them back in one list. */
  readonly transfer: ArrayBuffer[];
}

/** Bytes needed for one chunk's own voxels. */
const CHUNK_VOXELS = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;
/** Bytes of one neighbour plane. */
const PLANE_BYTES = CHUNK_SIZE * CHUNK_SIZE;

/** The scan's answer to "is the voxel one step outside the chunk on this axis solid?".
 *
 *  Local-first, exactly like the geometry's old private helper: inside the chunk it is an array read, and
 *  only the boundary shell reads a plane. The scan only ever asks about ONE step outside (a face of a voxel
 *  that is itself inside), so a plane is always enough — no corner lookups exist here. */
function makeSolidAt(input: ChunkMeshInput): (lx: number, ly: number, lz: number) => boolean {
  const S = CHUNK_SIZE;
  const { blocks, uniform, uniformValue, planes } = input;
  return (lx, ly, lz) => {
    if (lx >= 0 && lx < S && ly >= 0 && ly < S && lz >= 0 && lz < S) {
      return (blocks ? blocks[lx + ly * S + lz * S * S] : uniformValue) !== AIR;
    }
    if (lx === S) return planes[PLANE.PX * PLANE_BYTES + ly * S + lz] === 1;
    if (lx === -1) return planes[PLANE.NX * PLANE_BYTES + ly * S + lz] === 1;
    if (ly === S) return planes[PLANE.PY * PLANE_BYTES + lx * S + lz] === 1;
    if (ly === -1) return planes[PLANE.NY * PLANE_BYTES + lx * S + lz] === 1;
    if (lz === S) return planes[PLANE.PZ * PLANE_BYTES + lx + ly * S] === 1;
    return planes[PLANE.NZ * PLANE_BYTES + lx + ly * S] === 1;
  };
}

/** Mesh one chunk. Pure: it reads its input and allocates its result, nothing else. */
export function meshChunk(input: ChunkMeshInput): MeshResult {
  const S = CHUNK_SIZE;
  const uniformSolid = input.uniform && input.uniformValue !== AIR;
  const solidAt = makeSolidAt(input);

  // ===== PASS A: count the faces of every look, in first-seen order =====
  const slotOf = new Map<number, number>();
  const slotKeys: number[] = [];
  const slotFaces: number[] = [];
  const slotStart: number[] = [];

  const valueAt = (lx: number, ly: number, lz: number): number =>
    input.blocks ? input.blocks[lx + ly * S + lz * S * S] : input.uniformValue;

  for (let ly = 0; ly < S; ly++) {
    for (let lz = 0; lz < S; lz++) {
      for (let lx = 0; lx < S; lx++) {
        if (uniformSolid && lx > 0 && lx < S - 1 && ly > 0 && ly < S - 1 && lz > 0 && lz < S - 1) continue;
        const value = valueAt(lx, ly, lz);
        if (value === AIR) continue;
        for (const face of FACES) {
          if (solidAt(lx + face.dir[0], ly + face.dir[1], lz + face.dir[2])) continue;
          const kind = face.dir[1] === 1 ? 0 : face.dir[1] === -1 ? 1 : 2;
          const key = (value << 2) | kind;
          let slot = slotOf.get(key);
          if (slot === undefined) {
            slot = slotKeys.length;
            slotOf.set(key, slot);
            slotKeys.push(key);
            slotFaces.push(0);
          }
          slotFaces[slot]++;
        }
      }
    }
  }

  let total = 0;
  for (let slot = 0; slot < slotKeys.length; slot++) {
    slotStart.push(total);
    total += slotFaces[slot];
  }
  if (total === 0) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      uvs: new Float32Array(0),
      indices: new Uint32Array(0),
      faces: 0,
      slots: [],
      transfer: [],
    };
  }

  // ===== PASS B: the SAME walk, writing into the slices pass A reserved =====
  const positions = new Float32Array(total * 4 * 3);
  const normals = new Float32Array(total * 4 * 3);
  const uvs = new Float32Array(total * 4 * 2);
  const indices = new Uint32Array(total * 6);
  const cursor = slotStart.slice();

  for (let ly = 0; ly < S; ly++) {
    for (let lz = 0; lz < S; lz++) {
      for (let lx = 0; lx < S; lx++) {
        if (uniformSolid && lx > 0 && lx < S - 1 && ly > 0 && ly < S - 1 && lz > 0 && lz < S - 1) continue;
        const value = valueAt(lx, ly, lz);
        if (value === AIR) continue;
        for (const face of FACES) {
          if (solidAt(lx + face.dir[0], ly + face.dir[1], lz + face.dir[2])) continue;
          const kind = face.dir[1] === 1 ? 0 : face.dir[1] === -1 ? 1 : 2;
          const slot = slotOf.get((value << 2) | kind)!;
          writeFace(positions, normals, uvs, indices, cursor[slot]++, lx, ly, lz, face);
        }
      }
    }
  }

  const slots: MeshSlot[] = [];
  for (let slot = 0; slot < slotKeys.length; slot++) {
    slots.push({ key: slotKeys[slot], start: slotStart[slot], count: slotFaces[slot] });
  }
  return {
    positions,
    normals,
    uvs,
    indices,
    faces: total,
    slots,
    transfer: [positions.buffer, normals.buffer, uvs.buffer, indices.buffer],
  };
}

/** One face straight into the typed arrays: no intermediate JS array, so no garbage. The face index is
 *  GIVEN, because pass B hands out each look's slice in order. */
function writeFace(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  indices: Uint32Array,
  faceIndex: number,
  lx: number,
  ly: number,
  lz: number,
  face: Face,
): void {
  const firstVertex = faceIndex * 4;
  const positionOffset = firstVertex * 3;
  const uvOffset = firstVertex * 2;
  for (let i = 0; i < 4; i++) {
    const corner = face.corners[i];
    const p = positionOffset + i * 3;
    positions[p] = lx + corner[0];
    positions[p + 1] = ly + corner[1];
    positions[p + 2] = lz + corner[2];
    normals[p] = face.normal[0];
    normals[p + 1] = face.normal[1];
    normals[p + 2] = face.normal[2];
    const u = uvOffset + i * 2;
    uvs[u] = CORNER_UVS[i][0];
    uvs[u + 1] = CORNER_UVS[i][1];
  }
  const io = faceIndex * 6;
  indices[io] = firstVertex;
  indices[io + 1] = firstVertex + 1;
  indices[io + 2] = firstVertex + 2;
  indices[io + 3] = firstVertex;
  indices[io + 4] = firstVertex + 2;
  indices[io + 5] = firstVertex + 3;
}

/** Build a job's input from the world (MAIN THREAD: it reads the chunks and the wrap).
 *
 *  Costs one pass over the six neighbour planes (6144 `isSolid` calls), which is the same work the scan
 *  itself used to do for the boundary shell — it is not new, it is moved to where the transfer starts. */
export function gatherChunkMeshInput(
  voxel: VoxelWorld,
  chunk: Chunk,
  cx: number,
  cy: number,
  cz: number,
): ChunkMeshInput {
  const S = CHUNK_SIZE;
  const gx0 = cx * S;
  const gy0 = cy * S;
  const gz0 = cz * S;
  const planes = new Uint8Array(6 * PLANE_BYTES);
  const at = (plane: number, a: number, b: number, x: number, y: number, z: number): void => {
    planes[plane * PLANE_BYTES + a * S + b] = voxel.isSolid(x, y, z) ? 1 : 0;
  };
  for (let ly = 0; ly < S; ly++) {
    for (let lz = 0; lz < S; lz++) {
      at(PLANE.PX, ly, lz, gx0 + S, gy0 + ly, gz0 + lz);
      at(PLANE.NX, ly, lz, gx0 - 1, gy0 + ly, gz0 + lz);
    }
  }
  for (let lx = 0; lx < S; lx++) {
    for (let lz = 0; lz < S; lz++) {
      at(PLANE.PY, lx, lz, gx0 + lx, gy0 + S, gz0 + lz);
      at(PLANE.NY, lx, lz, gx0 + lx, gy0 - 1, gz0 + lz);
    }
  }
  for (let lx = 0; lx < S; lx++) {
    for (let ly = 0; ly < S; ly++) {
      at(PLANE.PZ, lx, ly, gx0 + lx, gy0 + ly, gz0 + S);
      at(PLANE.NZ, lx, ly, gx0 + lx, gy0 + ly, gz0 - 1);
    }
  }

  if (chunk.isUniform) {
    return { uniform: true, uniformValue: chunk.uniformValue, blocks: null, planes };
  }
  // A written chunk ships its voxels as bytes (the worker cannot read the world).
  const blocks = new Uint8Array(CHUNK_VOXELS);
  for (let ly = 0; ly < S; ly++) {
    for (let lz = 0; lz < S; lz++) {
      for (let lx = 0; lx < S; lx++) blocks[lx + ly * S + lz * S * S] = chunk.get(lx, ly, lz);
    }
  }
  return { uniform: false, uniformValue: AIR, blocks, planes };
}
