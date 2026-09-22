// ===== Player controller system: consume the buffered view deltas =====
// Fixed lane, registered AFTER the camera snapshot system (the interpolation source must freeze
// before physics moves the player). When control is unavailable (not locked and not free-mouse, or a
// modal UI owns the mouse) the player is frozen AND the buffer is DROPPED, not held. Holding it was a
// bug: the deltas the last fraction of a tick had already accumulated sat in VIEW for as long as the
// UI was open and were then replayed in one go the moment control came back — opening the pause
// menu/backpack WHILE moving the mouse and closing it slid the view by a few degrees. Dropping them
// is what makes "frozen" mean frozen; they are the same transition artifact the lock grace window in
// input.ts already discards (it drops 100 ms of movement at every unlock for exactly this reason).
//
// The deltas come from the VIEW component, not from a method call on the input system: that is what
// lets this system stay ignorant of who produced them.
import * as THREE from "three/webgpu";
import { ORIENTATION, VIEW } from "../components";
import { canControl, INPUT_STATE, LOCAL_PLAYER, UI_MODAL, type InputState, type UiModalState } from "../../../data/globals/resources";
import { entityIndex, type SystemAccess, type World } from "../../../core/world";

/** Declared access. Reads the input resource too (not modelled — resources are excluded from the
 *  conflict test; see ecs/core/schedule.ts). */
export const CONTROLLER_ACCESS: SystemAccess = {
  reads: [VIEW],
  writes: [ORIENTATION],
};

/** Pitch clamp, MC-style: look past the zenith has no function (movement is horizontal-only) and
 *  only flips the world, so pitch stops just short of straight up/down in EVERY mode. */
const PITCH_LIMIT = Math.PI / 2 - 0.01;

// Scratch vectors (avoid per-step allocations)
const tmpFwd = new THREE.Vector3();
const tmpUp = new THREE.Vector3();

export class PlayerControllerSystem {
  private readonly index: number;
  private readonly devices: InputState;
  private readonly ui: UiModalState;

  constructor(private readonly world: World) {
    this.index = entityIndex(world.resource(LOCAL_PLAYER));
    this.devices = world.resource(INPUT_STATE);
    this.ui = world.resource(UI_MODAL);
  }

  /** Fixed-step update (register AFTER the camera snapshot system) */
  step(): void {
    const index = this.index;
    // Read the buffer BEFORE the gate. Control can be taken away between two ticks (ESC, E, window
    // blur) with deltas already buffered by the tick that produced them, and this system is the only
    // consumer: whatever it does not take here stays in VIEW. Dropping it while uncontrolled is the
    // point — see the file header (a held buffer is replayed when control returns).
    const yaw = VIEW.yawDelta[index];
    const pitch = VIEW.pitchDelta[index];
    if (!canControl(this.devices, this.ui)) {
      VIEW.yawDelta[index] = 0;
      VIEW.pitchDelta[index] = 0;
      return;
    }
    if (yaw === 0 && pitch === 0) return;
    VIEW.yawDelta[index] = 0;
    VIEW.pitchDelta[index] = 0;

    // Apply accumulated view deltas: yaw rotates fwd around up (up is always (0,1,0), so summed
    // deltas compose exactly). Applying the summed delta is mathematically identical to applying
    // each event's delta separately, which is what makes the fixed step independent of event rate.
    if (yaw !== 0) {
      const fwd = tmpFwd.set(ORIENTATION.fwdX[index], ORIENTATION.fwdY[index], ORIENTATION.fwdZ[index]);
      const up = tmpUp.set(ORIENTATION.upX[index], ORIENTATION.upY[index], ORIENTATION.upZ[index]);
      fwd.applyAxisAngle(up, yaw).normalize();
      ORIENTATION.fwdX[index] = fwd.x;
      ORIENTATION.fwdY[index] = fwd.y;
      ORIENTATION.fwdZ[index] = fwd.z;
    }
    if (pitch !== 0) {
      ORIENTATION.pitch[index] = Math.max(
        -PITCH_LIMIT,
        Math.min(PITCH_LIMIT, ORIENTATION.pitch[index] + pitch),
      );
    }
  }
}
