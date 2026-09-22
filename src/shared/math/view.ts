// ===== The view direction, as pure math =====
// The horizontal heading tilted by `pitch` around the local horizon (`right = fwd × up`).
//
// SINGLE SOURCE OF TRUTH: the camera and the block-interaction raycast both use this, so the crosshair
// and what you actually see can never disagree. It lives in `shared/` (not in the render plugin) because
// the PLAYER plugin's raycast needs it too — a plugin-to-plugin import for one pure function is exactly
// the coupling the layer rules exist to prevent.
//
// Takes plain vectors instead of an orientation record so the ECS can store orientation as six numbers;
// callers fill their own scratch vectors from the ORIENTATION columns.
import * as THREE from "three/webgpu";

/** Scratch for the horizon, module-private so a caller can never clobber its own scratch vector. */
const tmpRight = new THREE.Vector3();

export function viewDirection(
  fwd: THREE.Vector3,
  up: THREE.Vector3,
  pitch: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  tmpRight.crossVectors(fwd, up).normalize();
  return out.copy(fwd).applyAxisAngle(tmpRight, pitch).normalize();
}
