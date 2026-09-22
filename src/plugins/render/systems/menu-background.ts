// ===== Main-menu background: a MENU frame's background step, as a system object =====
// Equirectangular panorama on a sphere's inner wall; the camera sits fixed at the centre rotating slowly
// around Y (MC main-menu style panning). The background KIND comes from the pack chain
// (ui/background.ts, memoised), and the step is a no-op for the other two kinds (a static image or the
// checkerboard are the MENU widget tree's own backdrop, not a draw).
//
// WHY THIS IS NOT REGISTERED IN A LANE. The schedule has no run conditions (see ROADMAP §3.9), and the
// only caller is the MENU frame — a mode that runs the background and the ui lane and NOTHING else, so a
// `stage: "render"` registration would never fire in the mode it exists for (and would draw the panorama
// over a live world if it did). What the ECS change bought is the part that mattered: the SCENE, the
// CAMERA and the two numbers are the MENU_BACKGROUND resource (ecs/presentation.ts) instead of four
// module-level `let`s in the composition root, so the state has an owner and this object has one entry
// point. Its access declaration below is therefore documentation rather than a schedule input.
import * as THREE from "three/webgpu";
import { VIEWPORT, type ViewportState } from "../../../data/globals/resources";
import { MENU_BACKGROUND, RENDERER3D, type MenuBackgroundState } from "../../../data/globals/gfx";
import type { SystemAccess, World } from "../../../core/world";
import { menuBgKind } from "../../../data/assets/background";
import { resolveTexture } from "../../../data/assets/textures";

/** What this step touches. `framebuffer` is shared with renderer.draw — which is exactly why it must NOT
 *  be registered in the render lane: two systems writing the framebuffer in one stage would need an
 *  order, and the menu frame is the only frame where this one has anything to do. */
export const MENU_BACKGROUND_ACCESS: SystemAccess = {
  writesExternal: ["framebuffer", "menuBackgroundScene"],
};

export class MenuBackgroundSystem {
  private readonly bg: MenuBackgroundState;
  private readonly viewport: ViewportState;
  private readonly renderer: THREE.WebGPURenderer;

  constructor(world: World) {
    this.bg = world.resource(MENU_BACKGROUND);
    this.viewport = world.resource(VIEWPORT);
    this.renderer = world.resource(RENDERER3D);
  }

  /** One MENU frame's background step. Cheap when the kind is not a panorama: one memoised query. */
  step(): void {
    if (menuBgKind() !== "panorama") return;
    const bg = this.bg;
    if (!bg.scene) {
      // Lazy init: SphereGeometry's default UV is equirectangular; scale(-1,1,1) flips to the inner wall
      // without mirroring.
      bg.scene = new THREE.Scene();
      const tex = new THREE.TextureLoader().load(resolveTexture("backgrounds/panorama.png"));
      tex.colorSpace = THREE.SRGBColorSpace;
      const geo = new THREE.SphereGeometry(50, 64, 32);
      geo.scale(-1, 1, 1);
      bg.scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex })));
      bg.camera = new THREE.PerspectiveCamera(
        75,
        this.viewport.height > 0 ? this.viewport.width / this.viewport.height : 1,
        0.1,
        100,
      );
      bg.lastMs = performance.now();
    }

    // The menu camera's aspect follows the window — reconciled from the VIEWPORT resource, which is what
    // replaced main.ts's resize listener (that listener used to reach in here for exactly this line).
    if (this.viewport.width > 0 && this.viewport.height > 0 && bg.camera) {
      const aspect = this.viewport.width / this.viewport.height;
      if (aspect !== bg.appliedAspect) {
        bg.appliedAspect = aspect;
        bg.camera.aspect = aspect;
        bg.camera.updateProjectionMatrix();
      }
    }

    const now = performance.now();
    bg.yaw += Math.min((now - bg.lastMs) / 1000, 0.1) * 0.03; // Slow spin ~0.03 rad/s, a full turn in ~3.5 min
    bg.lastMs = now;
    bg.camera!.quaternion.setFromEuler(new THREE.Euler(0, bg.yaw, 0));
    this.renderer.render(bg.scene!, bg.camera!);
  }
}
