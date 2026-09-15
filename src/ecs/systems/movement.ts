// ===== Player movement system: mode-dependent locomotion (walk / fly / spectator) =====
// Query-driven: every live entity carrying CONTROL + POSITION + ORIENTATION + MOTION is moved
// by its own control state. The player is one such entity; future AI-driven ones join free.
// Walking uses horizontal movement + vertical gravity along up; flying/spectating use
// MC-style controls (horizontal WASD + Space/Ctrl vertical). This system only integrates the
// tick provisionally: ecs/systems/collision.ts runs right after it, re-integrates the same
// displacement in sub-steps and resolves it against the voxel world (it also owns
// motion.onGround and zeroes motion.vy on contact).
import * as THREE from "three/webgpu";
import { getBind } from "../../platform/keybinds";
import { CONTROL, MOTION, ORIENTATION, POSITION, type ControlC, type MotionC, type OrientationC } from "../components/Player";
import type { EntityId } from "../store";
import type { World } from "../World";
import type { PlayerInputSystem } from "./input";

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

// Scratch vectors (avoid per-step allocations)
const tmpRight = new THREE.Vector3();
const tmpMove = new THREE.Vector3();

export class PlayerMovementSystem {
  constructor(
    private readonly world: World,
    private readonly input: PlayerInputSystem,
  ) {}

  /** Fixed-step update: move every controllable entity (gated by the local control state —
   *  when the pointer is unlocked and free-mouse is off, everything freezes, matching the
   *  controller system's gate; per-entity gates come with AI-driven entities) */
  step(dt: number): void {
    if (!this.input.canControl) return;
    for (const id of this.world.entities.query(CONTROL, POSITION, ORIENTATION, MOTION)) {
      const control = this.world.entities.get(id, CONTROL)!;
      const pos = this.world.entities.get(id, POSITION)!;
      const ori = this.world.entities.get(id, ORIENTATION)!;
      const motion = this.world.entities.get(id, MOTION)!;
      const flying = control.mode === "spectator" || (control.mode === "fly" && control.flying);
      if (!flying) this.walk(dt, control, pos, ori, motion); // incl. creative-not-flying: walking with gravity
      else this.fly(dt, control, pos, ori); // MC-style flight (spectator adds noclip via the collision gate)
    }
  }

  /** Walking: horizontal movement along the local basis + vertical gravity along up */
  private walk(
    dt: number,
    control: ControlC,
    pos: THREE.Vector3,
    ori: OrientationC,
    motion: MotionC,
  ): void {
    pos.add(this.horizontalMove(dt, WALK_SPEED * (this.sprint(control) ? SPRINT_MULT : 1), control, ori));
    motion.vy -= GRAVITY * dt;
    pos.addScaledVector(ori.up, motion.vy * dt);
  }

  /** Creative flight / spectator locomotion (MC-style): WASD moves horizontally along the
   *  yaw heading — pitch NEVER affects movement (look straight down and W still slides
   *  horizontally); Space/Ctrl ascend/descend along up. No gravity, no inertia. */
  private fly(
    dt: number,
    control: ControlC,
    pos: THREE.Vector3,
    ori: OrientationC,
  ): void {
    const sp = FLY_SPEED * (this.sprint(control) ? SPRINT_MULT : 1);
    const move = this.horizontalMove(dt, sp, control, ori);
    pos.add(move);
    let dy = 0;
    if (control.keys.has(getBind("jump"))) dy += sp * dt;
    if (control.keys.has(getBind("sneak"))) dy -= sp * dt;
    if (dy !== 0) pos.addScaledVector(ori.up, dy);
  }

  /** Horizontal WASD displacement along the local basis (fwd/right), normalized to sp·dt.
   *  Shared by walking and MC-style flight. */
  private horizontalMove(
    dt: number,
    sp: number,
    control: ControlC,
    ori: OrientationC,
  ): THREE.Vector3 {
    const right = tmpRight.crossVectors(ori.fwd, ori.up).normalize();
    const move = tmpMove.set(0, 0, 0);
    if (control.keys.has(getBind("forward"))) move.add(ori.fwd);
    if (control.keys.has(getBind("back"))) move.sub(ori.fwd);
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
