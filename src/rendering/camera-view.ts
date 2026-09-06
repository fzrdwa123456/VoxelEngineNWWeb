// ===== Camera view system: render interpolation + orientation from the local basis =====
// Owns everything visual about the camera. Position interpolates between the previous and the
// current physics state (MC-style fixed timestep); orientation is rebuilt from the player
// entity's local basis (fwd + up + pitch) — not from a fixed Euler order.
import * as THREE from "three/webgpu";
import { ORIENTATION, POSITION, type OrientationC } from "../ecs/components/Player";
import type { EntityId } from "../ecs/store";
import type { World } from "../ecs/World";

// Orientation scratch vectors (avoid per-frame allocations)
const tmpFwd = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpView = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpZ = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();

export class CameraViewSystem {
  /** Pre-movement position snapshot (fixed-step start): the render lerp and the collision
   *  system re-simulate the tick displacement from this — taken BEFORE movement touches pos. */
  readonly snapshot = new THREE.Vector3();
  /** Player component records (resolved once in the constructor — stable store references) */
  private readonly pos: THREE.Vector3;
  private readonly ori: OrientationC;

  constructor(
    private readonly world: World,
    private readonly player: EntityId,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    // Resolved in the constructor BODY (native field initializers run before parameter
    // properties are assigned — this.world would be undefined in a field initializer)
    this.pos = this.world.entities.get(this.player, POSITION)!;
    this.ori = this.world.entities.get(this.player, ORIENTATION)!;
  }

  /** Fixed-step snapshot (register this system BEFORE the controller in the World):
   *  freezes the interpolation source so the render lerp spans exactly one physics tick. */
  beginStep(): void {
    this.snapshot.copy(this.pos);
  }

  /** Per-frame: interpolate the position and rebuild the orientation quaternion */
  render(alpha: number): void {
    this.camera.position.lerpVectors(this.snapshot, this.pos, alpha);
    const up = this.ori.up;
    tmpFwd.copy(this.ori.fwd);
    tmpRight.crossVectors(tmpFwd, up).normalize(); // right = fwd × up (handedness matches movement/camera)
    // Pitch tilts the view around right (relative to the local horizon)
    tmpView.copy(tmpFwd).applyAxisAngle(tmpRight, this.ori.pitch).normalize();
    tmpUp.crossVectors(tmpRight, tmpView).normalize();
    tmpZ.copy(tmpView).negate(); // three cameras look down -Z -> Z axis = -view
    tmpMat.makeBasis(tmpRight, tmpUp, tmpZ);
    this.camera.quaternion.setFromRotationMatrix(tmpMat);
  }
}
