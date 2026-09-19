// ===== Block interaction: break (left button) + place (right button) + target highlight =====
// Fixed lane, registered AFTER collision, so it acts on the settled player pose.
//
// QUERY-DRIVEN: every entity carrying CONTROL + POSITION + ORIENTATION + INTERACTION + REACH + BODY
// gets its own raycast, its own rate limits and its own reach. Nothing here is per-player any more —
// the cooldowns used to be two private fields on this system, which silently meant "only one
// entity in the game can edit blocks".
//
// POLLING, NOT EVENTS: the held bind codes live in the entity's CONTROL record (written by
// input.ts), so this system compares them against a dt-accumulated cooldown. That keeps it
// deterministic, and it means releasing the button resets the cooldown — the next press acts
// immediately, while holding repeats every REPEAT_SECONDS.
//
// THE HAND COMES FROM THE INVENTORY COMPONENT. This system used to ask the UI through a callback
// ("is a hand non-empty?"); it now reads the selected slot itself, so the UI is purely a view and
// cannot disagree with the world. The block TYPE is therefore known here — but placement still
// writes SOLID, because the world has exactly one block value. Making the type meaningful needs a
// palette in the voxel data plus per-value materials in chunkmesh.ts (ROADMAP.md §3.2), and that is
// a separate change from this one.
//
// PLACEMENT IS REFUSED when the new block would overlap the entity's body box; otherwise you could
// seal yourself inside a block.
//
// The outline is presentation, updated here because this is where the raycast result lives, and only
// for the LOCAL player (otherwise two entities would fight over one wireframe). It is a pure
// transform write, so the fixed lane is a safe place for it.
import * as THREE from "three/webgpu";
import {
  BODY,
  CONTROL,
  INVENTORY,
  INTERACTION,
  ORIENTATION,
  PLAYER,
  POSITION,
  REACH,
  type BlockTypeId,
} from "../components/Player";
import { getBind } from "../../platform/keybinds";
import { viewDirection } from "../../rendering/camera-view";
import { AIR, SOLID } from "../../voxel/chunk";
import { raycastVoxel, type RayHit } from "../../voxel/raycast";
import type { VoxelWorld } from "../../voxel/world";
import { canControl, INPUT_STATE, LOCAL_PLAYER, UI_MODAL, VOXEL, type InputState, type UiModalState } from "../resources";
import { entityIndex, type SystemAccess, type World } from "../World";

/** Declared access. Reads POSITION (so it must follow collision, which writes it) and writes the
 *  block world plus the three.js outline — both external targets. */
export const INTERACTION_ACCESS: SystemAccess = {
  reads: [POSITION, ORIENTATION, CONTROL, INVENTORY, REACH, BODY],
  writes: [INTERACTION],
  writesExternal: ["voxelBlocks", "outline"],
  // "Which key breaks/blocks" comes from the KEYMAP resource, asked on every step.
  readsExternal: ["keybinds"],
};

/** Seconds between repeats while a button is held */
const REPEAT_SECONDS = 0.18;

// Scratch vectors (avoid a per-tick allocation). tmpFwd/tmpUp carry the entity's basis for the
// raycast direction; tmpDir is the resulting unit direction.
const tmpFwd = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpDir = new THREE.Vector3();

/** Scratch body dimensions for the entity being processed */
const dims = { halfWidth: 0, height: 0, eyeHeight: 0 };

export class BlockInteractionSystem {
  /** Wireframe box around the targeted block; main.ts adds it to the scene */
  readonly outline: THREE.LineSegments;

  /** Row of the local player — the only entity whose target this system highlights */
  private readonly localIndex: number;
  private readonly voxel: VoxelWorld;
  private readonly devices: InputState;
  private readonly ui: UiModalState;

  constructor(private readonly world: World) {
    this.localIndex = entityIndex(world.resource(LOCAL_PLAYER));
    this.voxel = world.resource(VOXEL);
    this.devices = world.resource(INPUT_STATE);
    this.ui = world.resource(UI_MODAL);

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
    const controlled = canControl(this.devices, this.ui);
    const rows = this.world.query(CONTROL, POSITION, ORIENTATION, INTERACTION, REACH, BODY).indices;
    for (let row = 0; row < rows.length; row++) {
      const index = rows[row];
      // An uncontrolled LOCAL player must never edit the world from a UI click (menu open,
      // pointer unlocked). Other entities — NPCs — keep acting; they do not care about our pointer.
      if (!controlled && PLAYER.sparse[index] >= 0) {
        INTERACTION.breakCooldown[index] = 0;
        INTERACTION.placeCooldown[index] = 0;
        continue;
      }
      this.update(index, dt);
    }
    if (!controlled) this.outline.visible = false;
  }

  private update(index: number, dt: number): void {
    dims.halfWidth = BODY.halfWidth[index];
    dims.height = BODY.height[index];
    dims.eyeHeight = BODY.eyeHeight[index];

    const fwd = tmpFwd.set(ORIENTATION.fwdX[index], ORIENTATION.fwdY[index], ORIENTATION.fwdZ[index]);
    const up = tmpUp.set(ORIENTATION.upX[index], ORIENTATION.upY[index], ORIENTATION.upZ[index]);
    viewDirection(fwd, up, ORIENTATION.pitch[index], tmpDir);
    const hit = raycastVoxel(
      this.voxel,
      POSITION.x[index],
      POSITION.y[index],
      POSITION.z[index],
      tmpDir.x,
      tmpDir.y,
      tmpDir.z,
      REACH.distance[index],
    );
    if (index === this.localIndex) this.updateOutline(hit);

    let breakCooldown = INTERACTION.breakCooldown[index] - dt;
    let placeCooldown = INTERACTION.placeCooldown[index] - dt;
    const keys = CONTROL.data[index]!.keys;

    if (keys.has(getBind("break"))) {
      if (breakCooldown <= 0) {
        if (hit) this.voxel.setBlock(hit.x, hit.y, hit.z, AIR);
        breakCooldown = REPEAT_SECONDS;
      }
    } else {
      breakCooldown = 0; // released: the next press acts immediately
    }

    if (keys.has(getBind("place"))) {
      if (placeCooldown <= 0) {
        this.place(index, hit);
        placeCooldown = REPEAT_SECONDS;
      }
    } else {
      placeCooldown = 0;
    }

    INTERACTION.breakCooldown[index] = breakCooldown;
    INTERACTION.placeCooldown[index] = placeCooldown;
  }

  private place(index: number, hit: RayHit | null): void {
    if (!hit) return;
    // An all-zero normal means the ray STARTED inside a solid voxel: there is no face to build on
    if (hit.nx === 0 && hit.ny === 0 && hit.nz === 0) return;

    const x = hit.x + hit.nx;
    const y = hit.y + hit.ny;
    const z = hit.z + hit.nz;

    if (this.voxel.isSolid(x, y, z)) return; // already occupied
    if (this.intersectsBody(index, x, y, z)) return; // never seal the entity inside a block
    // The type is known (blockInHand) but the world still has one block value: see the file header.
    if (this.blockInHand(index) === null) return;
    this.voxel.setBlock(x, y, z, SOLID);
  }

  /** Block type in the entity's selected slot, or null for an empty hand. Read straight from the
   *  INVENTORY component — no callback, no mirrored copy in the UI. */
  private blockInHand(index: number): BlockTypeId | null {
    const inventory = INVENTORY.data[index];
    if (!inventory) return null;
    const item = inventory.slots[inventory.selected];
    return item ? item.type : null;
  }

  /** Does the block at (x,y,z) overlap the entity's body box? Merely touching faces do not. */
  private intersectsBody(index: number, x: number, y: number, z: number): boolean {
    const px = POSITION.x[index];
    const pz = POSITION.z[index];
    const feet = POSITION.y[index] - dims.eyeHeight;
    return (
      px - dims.halfWidth < x + 1 &&
      x < px + dims.halfWidth &&
      pz - dims.halfWidth < z + 1 &&
      z < pz + dims.halfWidth &&
      feet < y + 1 &&
      y < feet + dims.height
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
