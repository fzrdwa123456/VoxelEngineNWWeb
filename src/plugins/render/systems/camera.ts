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
import { ORIENTATION, POSITION, PREV_POSITION } from "../../player/components";
import { viewDirection } from "../../../shared/math/view";
import { CAMERA3D } from "../../../data/globals/gfx";
import { LOCAL_PLAYER, VIEWPORT, type ViewportState } from "../../../data/globals/resources";
import { entityIndex, type SystemAccess, type World } from "../../../core/world";

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

export class CameraViewSystem {
  private readonly index: number;
  /** The world's camera, resolved in the constructor BODY (iron rule 6: a field initializer runs before
   *  a parameter property is assigned, so `this.world` is not readable there). The camera is a RESOURCE
   *  (ecs/presentation.ts) rather than an argument — it is world state, not a per-system object. */
  private readonly camera: THREE.PerspectiveCamera;
  /** The window size (VIEWPORT): the projection follows it, reconciled here instead of being pushed into
   *  the camera by a resize listener in the composition root. */
  private readonly viewport: ViewportState;
  /** The aspect last written into the projection, so a resize is applied ONCE (NaN = nothing yet). The
   *  VALUE is `VIEWPORT.appliedAspect` (its own resource): "the aspect the projection was built for" is
   *  state of the screen geometry, readable from the world instead of hidden in this object. */
  private get appliedAspect(): number {
    return this.viewport.appliedAspect;
  }
  private set appliedAspect(v: number) {
    this.viewport.appliedAspect = v;
  }

  constructor(private readonly world: World) {
    this.index = entityIndex(world.resource(LOCAL_PLAYER));
    this.camera = world.resource(CAMERA3D);
    this.viewport = world.resource(VIEWPORT);
  }

  /** Per-frame: interpolate the position and rebuild the orientation quaternion */
  render(alpha: number): void {
    // The projection first: a size of 0 means the platform service has not published yet, so the aspect
    // is left alone rather than computed from it (a 0-height window would make the aspect Infinity).
    const { width, height } = this.viewport;
    if (width > 0 && height > 0) {
      const aspect = width / height;
      if (aspect !== this.appliedAspect) {
        this.appliedAspect = aspect;
        this.camera.aspect = aspect;
        this.camera.updateProjectionMatrix();
      }
    }
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
