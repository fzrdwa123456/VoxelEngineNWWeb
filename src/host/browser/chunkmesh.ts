// ===== Chunk meshing: face-culled geometry, one MATERIAL GROUP per block look (P1.46) =====
// (The SCAN lives in `data/world/mesh.ts` since P1.18h — pure, so a Worker can run it; this file is the
//  GPU side: reusable buffers, the group/material mapping and the pack-chain look resolution.)
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
import { CHUNK_SIZE } from "../../data/world/chunk";
// The PURE mesher (P1.18h): the walk itself, plus the input gatherer that turns a chunk and its neighbour
// planes into bytes a Worker can take.
import { gatherChunkMeshInput, meshChunk, type MeshResult } from "../../data/world/mesh";
import type { VoxelWorld } from "../../data/world/world";
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
function specFor(id: string, kind: number): ChunkFaceSpec {
  const def = getBlockDef(id);
  const path = kind === 0 ? def?.top : kind === 1 ? def?.bottom : def?.side;
  if (path !== undefined) {
    const url = resolveTexture(path);
    return { key: url, texture: url, color: null };
  }
  if (def?.color !== undefined) return { key: `color:${def.color}`, texture: null, color: def.color };
  return { key: "checker", texture: CHECKER_TEXTURE_URL, color: null };
}

/** One chunk's reusable geometry. A rebuild is a single `apply()` call: it overwrites the existing
 *  typed arrays, so nothing is allocated and no GPU buffer is touched as long as the face count
 *  stays within the capacity already reserved for this chunk.
 *
 *  ===== THE SCAN IS NOT HERE ANY MORE (P1.18h) =====
 *  The face-culling walk lives in `data/world/mesh.ts` as a PURE function (`meshChunk`: voxel bytes in,
 *  typed arrays out), because that is what a Worker can run — and the same function is this class's own
 *  fallback, so the off-thread path and the on-thread path cannot drift. This class is now only the GPU
 *  side of it: reuse the buffers, copy the result in, resolve the LOOKS to materials (`specFor`) and move
 *  the draw range. */
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
  /** One slot KEY per entry of `specs`, in the same order: `(value << 2) | kind`. Kept so a PACK RELOAD can
   *  re-resolve the looks WITHOUT re-meshing — see `restyle()`. */
  private readonly slotKeys: number[] = [];

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

  /** Build this chunk's mesh IN PLACE from a pure mesher's result. Returns the number of faces drawn
   *  (0 = nothing visible, in which case the caller drops the mesh). `cx/cy/cz` are the chunk identity
   *  only for the LOOK lookup — the geometry itself is chunk-local.
   *
   *  The look bookkeeping is the reason a slot KEY carries its voxel value: the palette and the block table
   *  (and, behind them, the pack chain) live on this side, so the mesher hands over `(value, kind)` and this
   *  method resolves it with the SAME `specFor` the old in-place scan used, in the same first-seen order. */
  apply(voxel: VoxelWorld, mesh: MeshResult): number {
    this.faceCount = 0;
    this.specs.length = 0;
    this.slotKeys.length = 0;
    this.geometry.clearGroups();

    if (mesh.faces === 0) {
      this.geometry.setDrawRange(0, 0);
      return 0;
    }

    // Capacity first (this may replace the attributes), then ONE copy per channel.
    this.reserve(mesh.faces);
    this.positions.set(mesh.positions);
    this.normals.set(mesh.normals);
    this.uvs.set(mesh.uvs);
    this.indices.set(mesh.indices);
    this.faceCount = mesh.faces;

    for (let slot = 0; slot < mesh.slots.length; slot++) {
      const { key, start, count } = mesh.slots[slot];
      const value = key >>> 2;
      const kind = key & 3;
      // The palette lives on the world (P1.47), and an id it does not name falls back to the engine
      // untextured block, which resolves to the checker — a value outside the palette still draws SOMETHING.
      this.specs.push(specFor(voxel.idOf(value) ?? "missing", kind));
      this.slotKeys.push(key);
      if (count > 0) this.geometry.addGroup(start * 6, count * 6, slot);
    }

    // Same arrays, same length -> three.js re-uploads into the EXISTING GPU buffers
    this.positionAttr.needsUpdate = true;
    this.normalAttr.needsUpdate = true;
    this.uvAttr.needsUpdate = true;
    this.indexAttr.needsUpdate = true;
    // Indexed geometry: drawRange counts INDICES, and a face is 6 of them
    this.geometry.setDrawRange(0, this.faceCount * 6);
    return this.faceCount;
  }

  /** The SYNCHRONOUS path: gather on this thread, mesh, apply. Used when no worker pool is injected (the
   *  Node gate, a stub world) and for the block edits the player is waiting on. */
  rebuild(voxel: VoxelWorld, cx: number, cy: number, cz: number): number {
    const chunk = voxel.getChunk(cx, cy, cz);
    if (chunk === null) {
      this.faceCount = 0;
      this.specs.length = 0;
      this.slotKeys.length = 0;
      this.geometry.clearGroups();
      this.geometry.setDrawRange(0, 0);
      return 0;
    }
    return this.apply(voxel, meshChunk(gatherChunkMeshInput(voxel, chunk, cx, cy, cz)));
  }

  /** Re-resolve the material of every existing slot, in place, WITHOUT touching the vertex data. This is the
   *  PACK RELOAD path (P1.18i): positions, normals and uvs depend only on the VOXELS, and every uv is a
   *  per-face constant, so a reload that only changes what a block LOOKS like cannot invalidate the mesh.
   *  The palette is append-only (`mergePalette`), so an already-stored value still names its block, and
   *  `geometry.groups` (materialIndex = slot index, in the same order) needs no update either.
   *
   *  Returns the number of looks written, so the caller can report the work it just avoided. */
  restyle(voxel: VoxelWorld): number {
    for (let slot = 0; slot < this.slotKeys.length; slot++) {
      const key = this.slotKeys[slot];
      this.specs[slot] = specFor(voxel.idOf(key >>> 2) ?? "missing", key & 3);
    }
    return this.slotKeys.length;
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
