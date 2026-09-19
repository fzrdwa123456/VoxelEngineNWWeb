// ===== Chunk meshing: face-culled geometry + the built-in checker material =====
// A face is emitted only when the neighbour on that side is not solid, so:
//   - a uniformly AIR chunk draws nothing at all (the whole build space is free);
//   - a uniformly solid chunk with solid neighbours yields NO faces — the streaming system
//     remembers that and never asks again;
//   - for a uniformly filled chunk the interior voxels cannot emit anything, so the loop visits
//     only the boundary shell (32^3 -> 32^3 - 30^3 = 5 768 voxels, ~6x cheaper);
//   - because VoxelWorld treats below-world as bedrock, a chunk's bottom face is culled and only
//     the top chunk of each column produces geometry in the default world.
//
// GEOMETRY IS REUSED, NEVER REBUILT. This is the fix for the hitch that used to be felt on every
// dig/place click: the old code disposed the chunk's BufferGeometry and constructed a new one,
// i.e. it destroyed and recreated four GPU buffers per click, plus ~250 KB of throwaway JS arrays.
// `ChunkGeometry` now owns ONE geometry per chunk with a capacity that only ever grows, so a normal
// rebuild overwrites the existing typed arrays in place, flags them dirty and moves the draw range.
// No allocation, no disposal, no GPU buffer churn, no garbage.
//
// Geometry is CHUNK-LOCAL (0..CHUNK_SIZE), which also makes the bounding sphere constant — it is
// set once and never recomputed. The caller positions the mesh at the chunk origin.
//
// The surface texture is the engine's own built-in magenta/black checker (CHECKER_TEXTURE_URL),
// i.e. the "missing block" look, with no resource pack required. Voxel values are already a
// palette, so switching to blockregistry.ts lookups later is local to this file.
import * as THREE from "three/webgpu";
import { AIR, CHUNK_SIZE, type Chunk } from "../voxel/chunk";
import type { VoxelWorld } from "../voxel/world";
import { CHECKER_TEXTURE_URL } from "./textures";

type Vec3 = readonly [number, number, number];

interface Face {
  /** Offset to the neighbour that would cull this face */
  readonly dir: Vec3;
  /** Outward normal */
  readonly normal: Vec3;
  /** The four corners, counter-clockwise seen from OUTSIDE the block */
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3];
}

// Corner winding verified by cross(p1-p0, p3-p0) === normal for every entry.
const FACES: readonly Face[] = [
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
const CORNER_UVS: readonly [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** Faces a geometry starts out able to hold: one 32x32 layer, which is exactly what the default
 *  world needs for a column's top face — so the common case never has to grow. */
const INITIAL_FACES = 1024;
/** Doubling stops here; beyond it the capacity is rounded straight up to what is needed. */
const MAX_DOUBLING_FACES = 8192;

let sharedMaterial: THREE.MeshLambertMaterial | null = null;

/** One material for every chunk (shared texture + nearest filtering for the pixel look) */
export function getChunkMaterial(): THREE.MeshLambertMaterial {
  if (sharedMaterial) return sharedMaterial;
  const texture = new THREE.TextureLoader().load(CHECKER_TEXTURE_URL);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  sharedMaterial = new THREE.MeshLambertMaterial({ map: texture });
  return sharedMaterial;
}

/** One chunk's reusable geometry. A rebuild is a single `rebuild()` call: it overwrites the existing
 *  typed arrays, so nothing is allocated and no GPU buffer is touched as long as the face count
 *  stays within the capacity already reserved for this chunk. */
export class ChunkGeometry {
  readonly geometry = new THREE.BufferGeometry();
  private positions: Float32Array;
  private normals: Float32Array;
  private uvs: Float32Array;
  private indices: Uint32Array;
  private positionAttr: THREE.Float32BufferAttribute;
  private normalAttr: THREE.Float32BufferAttribute;
  private uvAttr: THREE.Float32BufferAttribute;
  private indexAttr: THREE.Uint32BufferAttribute;
  private capacityFaces: number;
  private faceCount = 0;

  constructor() {
    this.capacityFaces = INITIAL_FACES;
    // CAREFUL: Float32BufferAttribute/Uint32BufferAttribute COPY the array they are handed
    // (`super(new Float32Array(array), ...)`), so the arrays we write into must be the ATTRIBUTES'
    // own arrays, not the ones passed in. Passing a fresh array and then keeping the attribute's
    // reference is what makes the in-place writes visible to three.js.
    this.positionAttr = new THREE.Float32BufferAttribute(new Float32Array(INITIAL_FACES * 4 * 3), 3);
    this.normalAttr = new THREE.Float32BufferAttribute(new Float32Array(INITIAL_FACES * 4 * 3), 3);
    this.uvAttr = new THREE.Float32BufferAttribute(new Float32Array(INITIAL_FACES * 4 * 2), 2);
    this.indexAttr = new THREE.Uint32BufferAttribute(new Uint32Array(INITIAL_FACES * 6), 1);
    this.positions = this.positionAttr.array as Float32Array;
    this.normals = this.normalAttr.array as Float32Array;
    this.uvs = this.uvAttr.array as Float32Array;
    this.indices = this.indexAttr.array as Uint32Array;
    this.bind();

    // Chunk-local 0..CHUNK_SIZE means the bounds never change: set once, never recomputed
    this.geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(CHUNK_SIZE / 2, CHUNK_SIZE / 2, CHUNK_SIZE / 2),
      Math.SQRT2 * CHUNK_SIZE,
    );
    this.geometry.setDrawRange(0, 0);
  }

  /** Faces currently drawn */
  get faces(): number {
    return this.faceCount;
  }

  /** Rebuild this chunk's mesh in place. Returns the number of faces emitted (0 = nothing visible,
   *  in which case the caller should drop the mesh). `cx/cy/cz` may be unwrapped: VoxelWorld wraps
   *  X/Z for both the chunk lookup and the neighbour tests. */
  rebuild(voxel: VoxelWorld, cx: number, cy: number, cz: number): number {
    this.faceCount = 0;
    const chunk = voxel.getChunk(cx, cy, cz);
    if (chunk !== null && !(chunk.isUniform && chunk.uniformValue === AIR)) {
      this.scan(voxel, chunk, cx, cy, cz);
    }
    // Indexed geometry: drawRange counts INDICES, and a face is 6 of them
    this.geometry.setDrawRange(0, this.faceCount * 6);
    if (this.faceCount > 0) {
      // Same arrays, same length -> three.js re-uploads into the EXISTING GPU buffers
      this.positionAttr.needsUpdate = true;
      this.normalAttr.needsUpdate = true;
      this.uvAttr.needsUpdate = true;
      this.indexAttr.needsUpdate = true;
    }
    return this.faceCount;
  }

  dispose(): void {
    this.geometry.dispose();
  }

  private bind(): void {
    this.geometry.setAttribute("position", this.positionAttr);
    this.geometry.setAttribute("normal", this.normalAttr);
    this.geometry.setAttribute("uv", this.uvAttr);
    this.geometry.setIndex(this.indexAttr);
  }

  private scan(voxel: VoxelWorld, chunk: Chunk, cx: number, cy: number, cz: number): void {
    const S = CHUNK_SIZE;
    // Interior voxels of a uniform chunk are surrounded by solid on all six sides -> no faces
    const uniformSolid = chunk.isUniform && chunk.uniformValue !== AIR;
    const gx0 = cx * S;
    const gy0 = cy * S;
    const gz0 = cz * S;

    // Neighbour solidity, local-first: inside this chunk it is a plain array read, and only the
    // boundary shell pays for a VoxelWorld lookup (which is what handles wrapping and Y limits).
    // This matters a lot once the world is editable: writing one block clears the chunk's uniform
    // flag, and without the fast path every one of the 32^3 voxels' neighbour tests would become
    // a Map lookup — far too slow to re-mesh on each block edit.
    const solidAt = (lx: number, ly: number, lz: number): boolean =>
      lx >= 0 && lx < S && ly >= 0 && ly < S && lz >= 0 && lz < S
        ? chunk.get(lx, ly, lz) !== AIR
        : voxel.isSolid(gx0 + lx, gy0 + ly, gz0 + lz);

    for (let ly = 0; ly < S; ly++) {
      for (let lz = 0; lz < S; lz++) {
        for (let lx = 0; lx < S; lx++) {
          if (uniformSolid && lx > 0 && lx < S - 1 && ly > 0 && ly < S - 1 && lz > 0 && lz < S - 1) continue;
          if (chunk.get(lx, ly, lz) === AIR) continue;

          for (const face of FACES) {
            if (solidAt(lx + face.dir[0], ly + face.dir[1], lz + face.dir[2])) continue;
            this.pushFace(lx, ly, lz, face);
          }
        }
      }
    }
  }

  /** Write one face straight into the typed arrays (no intermediate JS array, so no garbage) */
  private pushFace(lx: number, ly: number, lz: number, face: Face): void {
    this.reserve();
    const firstVertex = this.faceCount * 4;
    const positionOffset = firstVertex * 3;
    const uvOffset = firstVertex * 2;

    for (let i = 0; i < 4; i++) {
      const corner = face.corners[i];
      const p = positionOffset + i * 3;
      this.positions[p] = lx + corner[0];
      this.positions[p + 1] = ly + corner[1];
      this.positions[p + 2] = lz + corner[2];
      this.normals[p] = face.normal[0];
      this.normals[p + 1] = face.normal[1];
      this.normals[p + 2] = face.normal[2];
      const u = uvOffset + i * 2;
      this.uvs[u] = CORNER_UVS[i][0];
      this.uvs[u + 1] = CORNER_UVS[i][1];
    }

    const io = this.faceCount * 6;
    this.indices[io] = firstVertex;
    this.indices[io + 1] = firstVertex + 1;
    this.indices[io + 2] = firstVertex + 2;
    this.indices[io + 3] = firstVertex;
    this.indices[io + 4] = firstVertex + 2;
    this.indices[io + 5] = firstVertex + 3;
    this.faceCount++;
  }

  /** Make room for one more face. Growing copies what has already been written, so a mid-scan
   *  growth needs no rescan: vertex numbering is absolute (face i owns vertices 4i..4i+3), which
   *  keeps every index already stored valid. This happens at most a few times per chunk. */
  private reserve(): void {
    if (this.faceCount < this.capacityFaces) return;

    const needed = this.faceCount + 1;
    let capacity = this.capacityFaces;
    while (capacity < needed && capacity < MAX_DOUBLING_FACES) capacity *= 2;
    if (capacity < needed) capacity = needed;

    // New attributes (see the constructor note: the attribute's array is the one to write into)
    const positionAttr = new THREE.Float32BufferAttribute(new Float32Array(capacity * 4 * 3), 3);
    const normalAttr = new THREE.Float32BufferAttribute(new Float32Array(capacity * 4 * 3), 3);
    const uvAttr = new THREE.Float32BufferAttribute(new Float32Array(capacity * 4 * 2), 2);
    const indexAttr = new THREE.Uint32BufferAttribute(new Uint32Array(capacity * 6), 1);

    const vertices = this.faceCount * 4;
    (positionAttr.array as Float32Array).set(this.positions.subarray(0, vertices * 3));
    (normalAttr.array as Float32Array).set(this.normals.subarray(0, vertices * 3));
    (uvAttr.array as Float32Array).set(this.uvs.subarray(0, vertices * 2));
    (indexAttr.array as Uint32Array).set(this.indices.subarray(0, this.faceCount * 6));

    this.positionAttr = positionAttr;
    this.normalAttr = normalAttr;
    this.uvAttr = uvAttr;
    this.indexAttr = indexAttr;
    this.positions = positionAttr.array as Float32Array;
    this.normals = normalAttr.array as Float32Array;
    this.uvs = uvAttr.array as Float32Array;
    this.indices = indexAttr.array as Uint32Array;
    this.capacityFaces = capacity;
    this.bind();
  }
}
