// ===== Chunk streaming: keep the chunks around the player generated, meshed and placed =====
// Runs in the RENDER lane (presentation only: it never touches entity state).
//
// DRAWING A TORUS IN FLAT SPACE. The world wraps in X/Z (voxel/world.ts), so the same chunk
// identity can be drawn at several positions. Each mesh is keyed by its WRAPPED identity and
// placed at the representation nearest the player (nearestWrap), which makes the horizon
// seamless in every direction without ever teleporting the player. The visible window is
// (2*RADIUS+1)^2 columns; keeping RADIUS < WORLD_CHUNKS/2 guarantees a visible chunk's nearest
// representation never flips on screen.
//
// The wanted-key set is rebuilt only when the player crosses a chunk boundary, and meshes are
// built under a per-frame budget so the initial fill spreads over a couple of seconds instead
// of stalling. Chunks whose mesh came out empty (uniform solid, which is what the default
// generator produces) are remembered in `empty` and never retried — that cache assumes static
// terrain; an editable world must invalidate it on write.
import * as THREE from "three/webgpu";
import { CHUNK_SIZE } from "../../voxel/chunk";
import {
  CHUNK_Y_COUNT,
  MIN_CHUNK_Y,
  WORLD_CHUNKS_X,
  WORLD_CHUNKS_Z,
  nearestWrap,
  wrapChunkX,
  wrapChunkZ,
  type VoxelWorld,
} from "../../voxel/world";
import { ChunkGeometry, getChunkMaterial } from "../../rendering/chunkmesh";
import { POSITION } from "../components/Player";
import type { EntityId } from "../store";
import type { World } from "../World";

/** Window radius in chunks: 8 -> 17x17 = 289 columns, i.e. ~256 blocks of visible world.
 *  Keep it below WORLD_CHUNKS/2 so a chunk's nearest representation never flips on screen. */
export const RENDER_RADIUS_CHUNKS = 8;
/** Meshes built per frame, so the initial fill spreads over frames instead of stalling.
 *  Air chunks bail out immediately, so a high value mostly costs cheap early-outs. */
const MESH_BUDGET_PER_FRAME = 24;

interface ChunkMeshEntry {
  readonly mesh: THREE.Mesh;
  /** The chunk's REUSABLE geometry — a rebuild refills this instead of replacing the mesh */
  readonly geom: ChunkGeometry;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export class ChunkStreamSystem {
  private readonly meshes = new Map<string, ChunkMeshEntry>();
  /** Chunk identities that produced no geometry (kept so they are not retried every frame) */
  private readonly empty = new Set<string>();
  /** Column offsets ordered near-first, so the ground under the player appears first */
  private readonly offsets: ReadonlyArray<readonly [number, number]>;
  private wanted: Set<string> | null = null;
  private lastPcx = Number.NaN;
  private lastPcz = Number.NaN;

  constructor(
    private readonly ecs: World,
    private readonly player: EntityId,
    private readonly voxel: VoxelWorld,
    private readonly group: THREE.Group,
  ) {
    const offsets: Array<[number, number]> = [];
    for (let dx = -RENDER_RADIUS_CHUNKS; dx <= RENDER_RADIUS_CHUNKS; dx++) {
      for (let dz = -RENDER_RADIUS_CHUNKS; dz <= RENDER_RADIUS_CHUNKS; dz++) {
        offsets.push([dx, dz]);
      }
    }
    offsets.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1])));
    this.offsets = offsets;
  }

  /** Generate (without meshing) every chunk in the window around a world position. Called once
   *  before the loop starts, so collision has real blocks on the very first tick. */
  prime(x: number, z: number): void {
    const pcx = Math.floor(x / CHUNK_SIZE);
    const pcz = Math.floor(z / CHUNK_SIZE);
    for (const [dx, dz] of this.offsets) {
      for (let cy = MIN_CHUNK_Y; cy < MIN_CHUNK_Y + CHUNK_Y_COUNT; cy++) {
        this.voxel.ensureChunk(pcx + dx, cy, pcz + dz);
      }
    }
  }

  step(): void {
    const pos = this.ecs.entities.get(this.player, POSITION);
    if (!pos) return;

    const pcx = Math.floor(pos.x / CHUNK_SIZE);
    const pcz = Math.floor(pos.z / CHUNK_SIZE);
    const moved = pcx !== this.lastPcx || pcz !== this.lastPcz;
    this.lastPcx = pcx;
    this.lastPcz = pcz;

    if (moved || this.wanted === null) {
      this.wanted = this.wantedKeys(pcx, pcz);
      this.unloadOutside(this.wanted);
    }

    // Block edits are rebuilt FIRST and unbudgeted: the player must see the block they just
    // changed. One edit touches at most a handful of chunks (the owner plus any border
    // neighbour), and input is rate-limited in ecs/systems/interaction.ts, so this cannot flood
    // a frame.
    for (const key of this.voxel.takeDirty()) this.rebuild(key);

    let budget = MESH_BUDGET_PER_FRAME;
    for (const key of this.wanted) {
      if (budget <= 0) break;
      if (this.meshes.has(key) || this.empty.has(key)) continue;
      budget--;
      this.build(key);
    }

    if (moved) {
      for (const entry of this.meshes.values()) this.place(entry);
    }
  }

  /** Wrapped chunk identities of the window, ordered near-first, top Y chunk first */
  private wantedKeys(pcx: number, pcz: number): Set<string> {
    const out = new Set<string>();
    for (const [dx, dz] of this.offsets) {
      const cx = wrapChunkX(pcx + dx);
      const cz = wrapChunkZ(pcz + dz);
      for (let cy = MIN_CHUNK_Y + CHUNK_Y_COUNT - 1; cy >= MIN_CHUNK_Y; cy--) {
        out.add(`${cx},${cy},${cz}`);
      }
    }
    return out;
  }

  private unloadOutside(wanted: Set<string>): void {
    for (const [key, entry] of this.meshes) {
      if (wanted.has(key)) continue;
      this.group.remove(entry.mesh);
      entry.geom.dispose();
      this.meshes.delete(key);
      this.empty.delete(key);
    }
  }

  /** Re-mesh one chunk after a block write.
   *  If the chunk already has a mesh this refills its geometry IN PLACE — no dispose, no new Mesh,
   *  no new GPU buffers. That is what removes the per-click hitch: the mesh object and its buffers
   *  survive, only the vertex data inside them is rewritten.
   *  A chunk that had no mesh needs one built, and a chunk that just lost its last visible face
   *  must go back into the "empty" set. */
  private rebuild(key: string): void {
    const entry = this.meshes.get(key);
    if (entry) {
      if (entry.geom.rebuild(this.voxel, entry.cx, entry.cy, entry.cz) > 0) return;
      this.group.remove(entry.mesh);
      entry.geom.dispose();
      this.meshes.delete(key);
      this.empty.add(key);
      return;
    }
    this.empty.delete(key);
    if (this.wanted?.has(key)) this.build(key);
  }

  private build(key: string): void {
    const parts = key.split(",");
    const cx = Number(parts[0]);
    const cy = Number(parts[1]);
    const cz = Number(parts[2]);

    // Boundary faces are culled against neighbouring chunks, so those must exist first
    for (const [dx, dy, dz] of NEIGHBOURS) this.voxel.ensureChunk(cx + dx, cy + dy, cz + dz);

    const geom = new ChunkGeometry();
    if (geom.rebuild(this.voxel, cx, cy, cz) === 0) {
      geom.dispose();
      this.empty.add(key);
      return;
    }

    const mesh = new THREE.Mesh(geom.geometry, getChunkMaterial());
    mesh.matrixAutoUpdate = false;
    const entry: ChunkMeshEntry = { mesh, geom, cx, cy, cz };
    this.group.add(mesh);
    this.meshes.set(key, entry);
    this.place(entry);
  }

  /** Geometry is chunk-local, so the mesh sits at the chunk origin of its nearest copy */
  private place(entry: ChunkMeshEntry): void {
    const rx = nearestWrap(entry.cx, this.lastPcx, WORLD_CHUNKS_X);
    const rz = nearestWrap(entry.cz, this.lastPcz, WORLD_CHUNKS_Z);
    entry.mesh.position.set(rx * CHUNK_SIZE, entry.cy * CHUNK_SIZE, rz * CHUNK_SIZE);
    entry.mesh.updateMatrix();
  }
}
