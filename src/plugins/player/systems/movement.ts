// ===== Player movement system: mode-dependent locomotion (walk / fly / spectator) =====
// Query-driven: every live entity carrying CONTROL + POSITION + ORIENTATION + MOTION is moved by
// its own control state. The player is one such entity; an NPC with the same component set joins
// for free — no registration, no list to append to.
//
// The components are read into scratch vectors, the math runs on those (identical to the previous
// object-per-entity code), and the position is written back to its columns once.
//
// This system only integrates the tick PROVISIONALLY: ecs/systems/collision.ts runs right after it,
// re-integrates the same displacement in sub-steps and resolves it against the voxel world. Collision
// owns motion.onGround and zeroes motion.vy on contact.
import * as THREE from "three/webgpu";
import { getBind } from "../../input/keybinds";
import { CONTROL, MOTION, ORIENTATION, PLAYER, POSITION, type ControlC, type MotionC } from "../components";
import { canControl, INPUT_STATE, UI_MODAL, type InputState, type UiModalState } from "../../../data/globals/resources";
import type { SystemAccess, World } from "../../../core/world";

/** Declared access. Writes POSITION, which is why it must be ordered after the snapshot: the
 *  schedule would otherwise be free to run them in either order, and a snapshot taken AFTER
 *  movement leaves collision a zero-length sweep (the entity would never move). */
export const MOVEMENT_ACCESS: SystemAccess = {
  reads: [CONTROL, ORIENTATION],
  writes: [POSITION, MOTION],
  // The bind table is world state (the KEYMAP resource): this system asks it "which key is forward"
  // on every step, so it declares the read.
  readsExternal: ["keybinds"],
};

export const GRAVITY = 24;
export const WALK_SPEED = 4.2;
export const FLY_SPEED = 4.2;
/** Sprint multiplier — TEST-ONLY high speed: sprint fly ≈ 105 units/s.
 *  The intended gameplay value is 1.65 (MC-style sprint ratio); set SPRINT_MULT back to
 *  1.65 to restore the normal feel. Both numbers are fixed inputs of THIS repo: they were
 *  carried over from an external reference project that is NOT part of this tree, so they
 *  cannot be re-derived from anything here — treat them as design decisions, not as values
 *  to recompute. The number lives ONLY here; other modules point at this constant instead
 *  of restating it. */
const SPRINT_MULT = 25;

// Scratch vectors (avoid per-step allocations). tmpFwd/tmpUp/tmpPos are filled from the component
// columns for the entity being processed; tmpRight/tmpMove are internal to horizontalMove().
const tmpFwd = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpPos = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpMove = new THREE.Vector3();

export class PlayerMovementSystem {
  private readonly devices: InputState;
  private readonly ui: UiModalState;

  constructor(private readonly world: World) {
    // Resolved in the constructor BODY (rule 6): resources are stable objects
    this.devices = world.resource(INPUT_STATE);
    this.ui = world.resource(UI_MODAL);
  }

  /** Fixed-step update: move every controllable entity. The INPUT gate is applied PER ENTITY — a
   *  LOCAL player whose input is frozen (modal UI open / pointer unlocked) is still SIMULATED: it
   *  keeps its velocity and keeps falling under gravity, only its keys are ignored. Skipping the
   *  integration instead hung it in mid-air with its velocity intact, which read as "opening a UI
   *  turns gravity off" and contradicted the fact that the world keeps running behind the UI. An NPC
   *  never consults the gate at all: it does not care about our pointer. */
  step(dt: number): void {
    const controlled = canControl(this.devices, this.ui);
    const rows = this.world.query(CONTROL, POSITION, ORIENTATION, MOTION).indices;
    for (let row = 0; row < rows.length; row++) {
      const index = rows[row];
      // Input applies to everything EXCEPT the local player while a UI owns the input. Physics always
      // applies (see walk(): gravity and the carried velocity are not input).
      const input = controlled || PLAYER.sparse[index] < 0;
      const control = CONTROL.data[index]!;
      const motion = MOTION.data[index]!;
      const fwd = tmpFwd.set(ORIENTATION.fwdX[index], ORIENTATION.fwdY[index], ORIENTATION.fwdZ[index]);
      const up = tmpUp.set(ORIENTATION.upX[index], ORIENTATION.upY[index], ORIENTATION.upZ[index]);
      const pos = tmpPos.set(POSITION.x[index], POSITION.y[index], POSITION.z[index]);

      const flying = control.mode === "spectator" || (control.mode === "fly" && control.flying);
      // Without input, walking still integrates gravity; flight is input-driven with no inertia, so an
      // input-less flyer simply holds its position (and never falls — that is what flight means).
      if (!flying) this.walk(dt, control, pos, fwd, up, motion, input);
      else if (input) this.fly(dt, control, pos, fwd, up);

      POSITION.x[index] = pos.x;
      POSITION.y[index] = pos.y;
      POSITION.z[index] = pos.z;
    }
  }

  /** Walking: horizontal movement along the local basis (INPUT) + vertical gravity (PHYSICS).
   *  `input=false` drops the WASD displacement but keeps gravity and the current vy, so a frozen
   *  player falls exactly as it would have with no keys held — the freeze removes intent, not physics. */
  private walk(
    dt: number,
    control: ControlC,
    pos: THREE.Vector3,
    fwd: THREE.Vector3,
    up: THREE.Vector3,
    motion: MotionC,
    input: boolean,
  ): void {
    if (input) {
      pos.add(this.horizontalMove(dt, WALK_SPEED * (this.sprint(control) ? SPRINT_MULT : 1), control, fwd, up));
    }
    motion.vy -= GRAVITY * dt;
    pos.addScaledVector(up, motion.vy * dt);
  }

  /** Creative flight / spectator locomotion (MC-style): WASD moves horizontally along the
   *  yaw heading — pitch NEVER affects movement (look straight down and W still slides
   *  horizontally); Space/Ctrl ascend/descend along up. No gravity, no inertia. */
  private fly(
    dt: number,
    control: ControlC,
    pos: THREE.Vector3,
    fwd: THREE.Vector3,
    up: THREE.Vector3,
  ): void {
    const sp = FLY_SPEED * (this.sprint(control) ? SPRINT_MULT : 1);
    const move = this.horizontalMove(dt, sp, control, fwd, up);
    pos.add(move);
    let dy = 0;
    if (control.keys.has(getBind("jump"))) dy += sp * dt;
    if (control.keys.has(getBind("sneak"))) dy -= sp * dt;
    if (dy !== 0) pos.addScaledVector(up, dy);
  }

  /** Horizontal WASD displacement along the local basis (fwd/right), normalized to sp·dt.
   *  Shared by walking and MC-style flight. */
  private horizontalMove(
    dt: number,
    sp: number,
    control: ControlC,
    fwd: THREE.Vector3,
    up: THREE.Vector3,
  ): THREE.Vector3 {
    const right = tmpRight.crossVectors(fwd, up).normalize();
    const move = tmpMove.set(0, 0, 0);
    if (control.keys.has(getBind("forward"))) move.add(fwd);
    if (control.keys.has(getBind("back"))) move.sub(fwd);
    if (control.keys.has(getBind("right"))) move.add(right);
    if (control.keys.has(getBind("left"))) move.sub(right);
    const len = move.length();
    if (len > 0) move.multiplyScalar((sp * dt) / len);
    return move;
  }

  private sprint(control: ControlC): boolean {
    return control.keys.has(getBind("sprint"));
  }
}
