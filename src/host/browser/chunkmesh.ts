// ===== Chunk meshing: face-culled geometry, one MATERIAL GROUP per block look (P1.46) =====
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
// ===== ONE GEOMETRY, MANY LOOKS (P1.46) =====
// A voxel VALUE is a palette index (`data/world/palette.ts`), so a chunk can hold grass, dirt and stone at
// once — and each of them has its own textures (or a flat colour, or the engine's checker when an install
// ships no texture at all). three.js draws that with GEOMETRY GROUPS: one group per material, in order, and
// `mesh.material` an ARRAY. Faces are therefore gathered per "look":
//
//   * a LOOK is (voxel value, face kind): top, bottom and side may differ (grass does), and a bottom face
//     takes the definition's BOTTOM texture;
//   * the scan runs TWICE — once counting faces per look, then a prefix sum gives each look its slice, then
//     the same walk writes the faces into those slices. Two passes over the shell is the price of contiguous
//     groups without a per-face sort, and it keeps the in-place/no-allocation property above;
//   * `specs` is one entry per group, in `geometry.groups` order, and the CALLER resolves each to a material
//     (`ChunkMeshFactory.getMaterial`) — the mesher never touches the GPU or the material cache.
import * as THREE from "three/webgpu";
// The cube's six faces, their corner UVs and the two capacity knobs are DATA (`data/globals/faces.ts`,
// `data/globals/gfx.ts`): this file walks the tables, it does not own them.
import {
  CHUNK_FACES_INITIAL,
  CHUNK_FACES_MAX_DOUBLING,
  type ChunkFaceSpec,
  type ChunkMaterialState,
} from "../../data/globals/gfx";
import { CORNER_UVS, FACES, type Face } from "../../data/globals/faces";
import { AIR, CHUNK_SIZE, type Chunk } from "../../data/world/chunk";
import type { VoxelWorld } from "../../data/world/world";
import { paletteIdOf } from "../../data/world/palette";
import { getBlockDef } from "../../data/assets/blockregistry";
import { CHECKER_TEXTURE_URL, resolveTexture } from "../../data/assets/textures";

/** The engine's own look, for a block whose definition ships no texture and no colour. */
function checkerMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ map: textureFrom(CHECKER_TEXTURE_URL) });
}

function textureFrom(url: string): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** The material for one look. `spec` omitted = the engine's checker (the mesher's own fallback and what a
 *  caller with no groups gets). Cached per SPEC KEY in the CHUNK_MATERIAL resource: a GPU object belongs to
 *  the world, and one material per look is shared by every chunk that shows it. */
export function getChunkMaterial(state: ChunkMaterialState, spec?: ChunkFaceSpec): THREE.Material {
  if (!spec) {
    if (!state.material) state.material = checkerMaterial();
    return state.material;
  }
  const hit = state.materials.get(spec.key);
  if (hit) return hit;
  const made =
    spec.texture !== null
      ? new THREE.MeshLambertMaterial({ map: textureFrom(spec.texture) })
      : new THREE.MeshLambertMaterial({ color: new THREE.Color(spec.color ?? "#ffffff") });
  state.materials.set(spec.key, made);
  return made;
}

/** The look of one (voxel value, face kind): the definition's face texture, else its flat colour, else the
 *  engine checker. `kind` is 0 top, 1 bottom, 2 side — the registry has already defaulted top/bottom to the
 *  side texture, so a definition that sets only `all` (or only `side`) answers for every kind. */
function specFor(value: number, kind: number): ChunkFaceSpec {
  const id = paletteIdOf(value);
  const def = id === null ? undefined : getBlockDef(id);
  const path = kind === 0 ? def?.top : kind === 1 ? def?.bottom : def?.side;
  if (path !== undefined) {
    const url = resolveTexture(path);
    return { key: url, texture: url, color: null };
  }
  if (def?.color !== undefined) return { key: `color:${def.color}`, texture: null, color: def.color };
  return { key: "checker", texture: CHECKER_TEXTURE_URL, color: null };
}

/** One chunk's reusable geometry. A rebuild is a single `rebuild()` call: it overwrites the existing
 *  typed arrays, so nothing is allocated and no GPU buffer is touched as long as the face count
 *  stays within the capacity already reserved for this chunk. */
export class ChunkGeometry {
  readonly geometry = new THREE.BufferGeometry();
  /** One look per material group, in `geometry.groups` order (the caller resolves them to materials). */
  readonly specs: ChunkFaceSpec[] = [];
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
  /** Per-scan look bookkeeping: (value, kind) -> slot, how many faces each slot got, where its slice starts
   *  and how far it has been written. Cleared at the start of every rebuild. */
  private readonly slotOf = new Map<number, number>();
  private readonly slotFaces: number[] = [];
  private readonly slotStart: number[] = [];
  private readonly slotCursor: number[] = [];

  constructor() {
    this.capacityFaces = CHUNK_FACES_INITIAL;
    // CAREFUL: Float32BufferAttribute/Uint32BufferAttribute COPY the array they are handed
    // (`super(new Float32Array(array), ...)`), so the arrays we write into must be the ATTRIBUTES'
    // own arrays, not the ones passed in. Passing a fresh array and then keeping the attribute's
    // reference is what makes the in-place writes visible to three.js.
    this.positionAttr = new THREE.Float32BufferAttribute(new Float32Array(CHUNK_FACES_INITIAL * 4 * 3), 3);
    this.normalAttr = new THREE.Float32BufferAttribute(new Float32Array(CHUNK_FACES_INITIAL * 4 * 3), 3);
    this.uvAttr = new THREE.Float32BufferAttribute(new Float32Array(CHUNK_FACES_INITIAL * 4 * 2), 2);
    this.indexAttr = new THREE.Uint32BufferAttribute(new Uint32Array(CHUNK_FACES_INITIAL * 6), 1);
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
    this.specs.length = 0;
    this.slotOf.clear();
    this.slotFaces.length = 0;
    this.geometry.clearGroups();

    const chunk = voxel.getChunk(cx, cy, cz);
    if (chunk === null || (chunk.isUniform && chunk.uniformValue === AIR)) {
      this.geometry.setDrawRange(0, 0);
      return 0;
    }
    // Interior voxels of a uniform chunk are surrounded by solid on all six sides -> no faces
    const uniformSolid = chunk.isUniform && chunk.uniformValue !== AIR;

    // Pass A: count the faces of every look, so each one can be given a contiguous slice.
    this.scan(voxel, chunk, cx, cy, cz, uniformSolid, true);
    let total = 0;
    this.slotStart.length = this.specs.length;
    this.slotCursor.length = this.specs.length;
    for (let slot = 0; slot < this.specs.length; slot++) {
      this.slotStart[slot] = total;
      this.slotCursor[slot] = total;
      const faces = this.slotFaces[slot];
      if (faces > 0) this.geometry.addGroup(total * 6, faces * 6, slot);
      total += faces;
    }
    if (total > 0) {
      this.reserve(total);
      // Pass B: the SAME walk, in the same order, writing into the slices pass A reserved.
      this.scan(voxel, chunk, cx, cy, cz, uniformSolid, false);
      this.faceCount = total;
      // Same arrays, same length -> three.js re-uploads into the EXISTING GPU buffers
      this.positionAttr.needsUpdate = true;
      this.normalAttr.needsUpdate = true;
      this.uvAttr.needsUpdate = true;
      this.indexAttr.needsUpdate = true;
    }
    // Indexed geometry: drawRange counts INDICES, and a face is 6 of them
    this.geometry.setDrawRange(0, this.faceCount * 6);
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

  /** The look slot for one face, created on first use (so `specs`/`slotFaces` grow in first-seen order). */
  private slotFor(value: number, face: Face): number {
    const kind = face.dir[1] === 1 ? 0 : face.dir[1] === -1 ? 1 : 2;
    const key = (value << 2) | kind;
    const hit = this.slotOf.get(key);
    if (hit !== undefined) return hit;
    const slot = this.specs.length;
    this.slotOf.set(key, slot);
    this.specs.push(specFor(value, kind));
    this.slotFaces[slot] = 0;
    return slot;
  }

  /** One walk over the chunk's emissive voxels. `counting` picks the pass; both passes MUST visit faces in
   *  the same order, which they do because nothing here depends on the counts. */
  private scan(
    voxel: VoxelWorld,
    chunk: Chunk,
    cx: number,
    cy: number,
    cz: number,
    uniformSolid: boolean,
    counting: boolean,
  ): void {
    const S = CHUNK_SIZE;
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
          const value = chunk.get(lx, ly, lz);
          if (value === AIR) continue;

          for (const face of FACES) {
            if (solidAt(lx + face.dir[0], ly + face.dir[1], lz + face.dir[2])) continue;
            const slot = this.slotFor(value, face);
            if (counting) this.slotFaces[slot]++;
            else this.writeFace(this.slotCursor[slot]++, lx, ly, lz, face);
          }
        }
      }
    }
  }

  /** Write one face straight into the typed arrays (no intermediate JS array, so no garbage). The face index
   *  is GIVEN: pass B hands out each look's slice in order, which is what makes the groups contiguous. */
  private writeFace(faceIndex: number, lx: number, ly: number, lz: number, face: Face): void {
    const firstVertex = faceIndex * 4;
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

    const io = faceIndex * 6;
    this.indices[io] = firstVertex;
    this.indices[io + 1] = firstVertex + 1;
    this.indices[io + 2] = firstVertex + 2;
    this.indices[io + 3] = firstVertex;
    this.indices[io + 4] = firstVertex + 2;
    this.indices[io + 5] = firstVertex + 3;
  }

  /** Make room for `needed` faces (pass B knows the total before it starts, unlike the old per-face
   *  growth). Growing copies what has already been written, so a growth mid-scan needs no rescan: vertex
   *  numbering is absolute (face i owns vertices 4i..4i+3), which keeps every index already stored valid. */
  private reserve(needed: number): void {
    if (needed <= this.capacityFaces) return;

    let capacity = this.capacityFaces;
    while (capacity < needed && capacity < CHUNK_FACES_MAX_DOUBLING) capacity *= 2;
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
