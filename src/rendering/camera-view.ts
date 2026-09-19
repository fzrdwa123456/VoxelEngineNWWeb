// ===== Camera view system: render interpolation + orientation from the local basis =====
// Render lane. Position interpolates between PREV_POSITION and POSITION (MC-style fixed timestep);
// orientation is rebuilt from the entity's local basis (fwd + up + pitch) — not from a fixed Euler
// order.
//
// PREV_POSITION IS NOT WRITTEN HERE. This system used to own that snapshot, for the local player's
// row only — which quietly broke the collision sweep for every other entity (its origin froze at the
// spawn point). It is now the `motion.snapshot` fixed-lane system, query-driven over every entity
// that has a previous position; this system is purely a CONSUMER of it.
import * as THREE from "three/webgpu";
import { ORIENTATION, POSITION, PREV_POSITION } from "../ecs/components/Player";
import { LOCAL_PLAYER } from "../ecs/resources";
import { entityIndex, type SystemAccess, type World } from "../ecs/World";

/** Declared access. Reads the player's pose and writes the three.js camera; it shares the render
 *  stage's producer batch because nothing else touches "camera3d" until the draw. */
export const CAMERA_VIEW_ACCESS: SystemAccess = {
  reads: [POSITION, PREV_POSITION, ORIENTATION],
  writesExternal: ["camera3d"],
};

// Orientation scratch vectors (avoid per-frame allocations)
const tmpFwd = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpView = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpZ = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();
/** Scratch for viewDirection() — kept separate from tmpRight so a caller can never clobber the
 *  scratch vector render() is in the middle of using. */
const tmpTiltRight = new THREE.Vector3();

/** The view direction for an orientation basis: the horizontal heading tilted by `pitch` around
 *  `right` (= fwd × up, i.e. the local horizon).
 *  SINGLE SOURCE OF TRUTH — both the camera below and the block-interaction raycast use this, so
 *  the crosshair and what you actually see can never disagree.
 *  Takes plain vectors instead of an orientation record so the ECS can store orientation as six
 *  numbers; callers fill the scratch vectors from the ORIENTATION columns. */
export function viewDirection(
  fwd: THREE.Vector3,
  up: THREE.Vector3,
  pitch: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  tmpTiltRight.crossVectors(fwd, up).normalize();
  return out.copy(fwd).applyAxisAngle(tmpTiltRight, pitch).normalize();
}

export class CameraViewSystem {
  private readonly index: number;

  constructor(
    private readonly world: World,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    this.index = entityIndex(world.resource(LOCAL_PLAYER));
  }

  /** Per-frame: interpolate the position and rebuild the orientation quaternion */
  render(alpha: number): void {
    const index = this.index;
    const px = POSITION.x[index];
    const py = POSITION.y[index];
    const pz = POSITION.z[index];
    const qx = PREV_POSITION.x[index];
    const qy = PREV_POSITION.y[index];
    const qz = PREV_POSITION.z[index];
    this.camera.position.set(qx + (px - qx) * alpha, qy + (py - qy) * alpha, qz + (pz - qz) * alpha);

    const fwd = tmpFwd.set(ORIENTATION.fwdX[index], ORIENTATION.fwdY[index], ORIENTATION.fwdZ[index]);
    const up = tmpUp.set(ORIENTATION.upX[index], ORIENTATION.upY[index], ORIENTATION.upZ[index]);
    tmpRight.crossVectors(fwd, up).normalize(); // right = fwd × up (handedness matches movement/camera)
    // Pitch tilts the view around right (relative to the local horizon). Must run BEFORE tmpUp is
    // reused below, since viewDirection() needs the gravity up.
    viewDirection(fwd, up, ORIENTATION.pitch[index], tmpView);
    tmpUp.crossVectors(tmpRight, tmpView).normalize();
    tmpZ.copy(tmpView).negate(); // three cameras look down -Z -> Z axis = -view
    tmpMat.makeBasis(tmpRight, tmpUp, tmpZ);
    this.camera.quaternion.setFromRotationMatrix(tmpMat);
  }
}
