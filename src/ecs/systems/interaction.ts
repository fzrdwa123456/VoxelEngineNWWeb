// ===== Block interaction: break (left button) + place (right button) + target highlight =====
// Fixed lane, registered AFTER collision, so it acts on the settled player pose.
//
// POLLING, NOT EVENTS: the held bind codes live in CONTROL.keys (written by input.ts), so this
// system compares them against a dt-accumulated cooldown. That keeps it deterministic, and it
// means releasing the button resets the cooldown — the next press acts immediately, while
// holding repeats every REPEAT_SECONDS.
//
// ONE BLOCK TYPE: placement always writes SOLID, the engine's built-in checker block. The world
// still has no other block, so the inventory is consulted only to require a non-empty hand — and
// that comes in as a callback rather than an Inventory import, so this system never depends on
// the UI layer.
//
// PLACEMENT IS REFUSED when the new block would overlap the player's body box; otherwise you
// could seal yourself inside a block.
//
// The outline is presentation, updated here because this is where the raycast result lives. It
// is a pure transform write, so the fixed lane is a safe place for it.
import * as THREE from "three/webgpu";
import {
  CONTROL,
  EYE_HEIGHT,
  ORIENTATION,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  POSITION,
  type ControlC,
  type OrientationC,
} from "../components/Player";
import { getBind } from "../../platform/keybinds";
import { viewDirection } from "../../rendering/camera-view";
import { AIR, SOLID } from "../../voxel/chunk";
import { raycastVoxel, type RayHit } from "../../voxel/raycast";
import type { VoxelWorld } from "../../voxel/world";
import type { EntityId } from "../store";
import type { World } from "../World";
import type { PlayerInputSystem } from "./input";

/** How far the player can reach, in blocks (MC creative is 5) */
export const REACH = 6;
/** Seconds between repeats while a button is held */
const REPEAT_SECONDS = 0.18;

/** Scratch direction vector (avoid a per-tick allocation) */
const tmpDir = new THREE.Vector3();

export class BlockInteractionSystem {
  /** Wireframe box around the targeted block; main.ts adds it to the scene */
  readonly outline: THREE.LineSegments;

  private readonly pos: THREE.Vector3;
  private readonly ori: OrientationC;
  private readonly control: ControlC;
  private breakCooldown = 0;
  private placeCooldown = 0;

  constructor(
    private readonly world: World,
    private readonly player: EntityId,
    private readonly voxel: VoxelWorld,
    private readonly input: PlayerInputSystem,
    /** The UI's only say here: is a block selected at all? (empty hotbar slot = empty hand) */
    private readonly hasBlockInHand: () => boolean,
  ) {
    // Resolved in the constructor BODY (rule 5: field initializers cannot read parameter properties)
    this.pos = this.world.entities.get(this.player, POSITION)!;
    this.ori = this.world.entities.get(this.player, ORIENTATION)!;
    this.control = this.world.entities.get(this.player, CONTROL)!;

    const box = new THREE.BoxGeometry(1.002, 1.002, 1.002);
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0xffffff }), // white reads on both checker colours
    );
    box.dispose();
    this.outline.visible = false;
    this.outline.matrixAutoUpdate = false;
  }

  step(dt: number): void {
    // Without control (menu open / pointer unlocked) never edit the world from a UI click
    if (!this.input.canControl) {
      this.outline.visible = false;
      this.breakCooldown = 0;
      this.placeCooldown = 0;
      return;
    }

    viewDirection(this.ori, tmpDir);
    const hit = raycastVoxel(
      this.voxel,
      this.pos.x,
      this.pos.y,
      this.pos.z,
      tmpDir.x,
      tmpDir.y,
      tmpDir.z,
      REACH,
    );
    this.updateOutline(hit);

    this.breakCooldown -= dt;
    this.placeCooldown -= dt;

    if (this.control.keys.has(getBind("break"))) {
      if (this.breakCooldown <= 0) {
        if (hit) this.voxel.setBlock(hit.x, hit.y, hit.z, AIR);
        this.breakCooldown = REPEAT_SECONDS;
      }
    } else {
      this.breakCooldown = 0; // released: the next press acts immediately
    }

    if (this.control.keys.has(getBind("place"))) {
      if (this.placeCooldown <= 0) {
        this.place(hit);
        this.placeCooldown = REPEAT_SECONDS;
      }
    } else {
      this.placeCooldown = 0;
    }
  }

  private place(hit: RayHit | null): void {
    if (!hit) return;
    // An all-zero normal means the ray STARTED inside a solid voxel: there is no face to build on
    if (hit.nx === 0 && hit.ny === 0 && hit.nz === 0) return;

    const x = hit.x + hit.nx;
    const y = hit.y + hit.ny;
    const z = hit.z + hit.nz;

    if (this.voxel.isSolid(x, y, z)) return; // already occupied
    if (this.intersectsPlayer(x, y, z)) return; // never seal the player inside a block
    if (!this.hasBlockInHand()) return;
    this.voxel.setBlock(x, y, z, SOLID);
  }

  /** Does the block at (x,y,z) overlap the player's body box? Merely touching faces do not. */
  private intersectsPlayer(x: number, y: number, z: number): boolean {
    const feet = this.pos.y - EYE_HEIGHT;
    return (
      this.pos.x - PLAYER_HALF_WIDTH < x + 1 &&
      x < this.pos.x + PLAYER_HALF_WIDTH &&
      this.pos.z - PLAYER_HALF_WIDTH < z + 1 &&
      z < this.pos.z + PLAYER_HALF_WIDTH &&
      feet < y + 1 &&
      y < feet + PLAYER_HEIGHT
    );
  }

  private updateOutline(hit: RayHit | null): void {
    if (!hit) {
      this.outline.visible = false;
      return;
    }
    this.outline.visible = true;
    this.outline.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    this.outline.updateMatrix();
  }
}
