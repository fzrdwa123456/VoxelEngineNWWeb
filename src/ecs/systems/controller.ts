// ===== Player controller system: consumes input data, applies view deltas, advances physics =====
// Registered in the World AFTER the camera-view snapshot system (the interpolation source must
// freeze before physics moves the player). When control is unavailable (not locked and not
// free-mouse) the player is frozen — the last rendered state is kept.
import { ORIENTATION, CONTROL, type OrientationC, type ControlC } from "../components/Player";
import type { EntityId } from "../store";
import type { World } from "../World";
import type { PlayerInputSystem } from "./input";

export class PlayerControllerSystem {
  private readonly ori: OrientationC;
  private readonly control: ControlC;

  constructor(
    private readonly world: World,
    private readonly player: EntityId,
    private readonly input: PlayerInputSystem,
  ) {
    // Resolved in the constructor BODY (native field initializers run before parameter
    // properties are assigned — this.world would be undefined in a field initializer)
    this.ori = this.world.entities.get(this.player, ORIENTATION)!;
    this.control = this.world.entities.get(this.player, CONTROL)!;
  }

  /** Fixed-step update (register AFTER the camera-view snapshot system in the World) */
  step(_dt: number): void {
    if (!this.input.canControl) return;
    // Apply accumulated view deltas: yaw rotates fwd around up (up is always (0,1,0), so summed
    // deltas compose exactly). Pitch clamps to ±89.4° MC-style in EVERY mode — movement is
    // horizontal-only now, so looking past the zenith has no function and only flips the world.
    const { yaw, pitch } = this.input.consumeViewDelta();
    if (yaw !== 0) this.ori.fwd.applyAxisAngle(this.ori.up, yaw).normalize();
    if (pitch !== 0) {
      this.ori.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.ori.pitch + pitch));
    }
  }
}
