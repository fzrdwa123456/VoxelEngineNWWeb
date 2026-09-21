// ===== The window's size: ONE listener, published as data =====
// Two places used to watch the window independently: main.ts's resize listener wrote `camera.aspect`,
// `camera.updateProjectionMatrix()` and `renderer.setSize()` the moment the event arrived, and
// ui/uiscale.ts kept a second, rAF-coalesced listener whose only remaining consumer was the settings
// panel's "UI scale: auto (1.25x)" label.
//
// Now there is ONE listener, in the host-service layer, and it does what a host service is allowed to do:
// it produces DATA. It publishes the VIEWPORT resource (ecs/resources.ts) and notifies the subscribers
// that only need to know "it changed" (that label — a value composed into a string is surface logic, so
// it cannot be re-derived by the reconciler the way a key can). The systems that need the size READ it and
// reconcile what they own: rendering/camera-view.ts the projection, the draw the renderer's size.
//
// The notification is coalesced into one rAF: a window drag fires resize at high frequency, and the
// subscribers only compose text, so at most one refresh per frame is enough.
import { VIEWPORT, type ViewportState } from "../ecs/resources";

let state: ViewportState | null = null;
const viewCbs = new Set<() => void>();

/** Start publishing into `viewport` (idempotent — the listener is installed once per process, however
 *  many times this is called). Publishes immediately, so the first frame already has a real size. The
 *  two "already installed / coalescer armed" flags are fields of the VIEWPORT resource now, so this
 *  module keeps no state of its own. */
export function adoptViewport(viewport: ViewportState): void {
  state = viewport;
  if (viewport.listenerInstalled) {
    publishNow();
    return;
  }
  viewport.listenerInstalled = true;
  window.addEventListener("resize", () => {
    publishNow();
    if (viewport.publishScheduled) return;
    viewport.publishScheduled = true;
    requestAnimationFrame(() => {
      viewport.publishScheduled = false;
      viewCbs.forEach((cb) => cb());
    });
  });
  publishNow();
}

/** The current size. Read by the composition root for the first `renderer.setSize` and by the
 *  menu-background step (which owns a second camera). */
export function currentViewport(): ViewportState {
  return (
    state ?? {
      width: window.innerWidth,
      height: window.innerHeight,
      appliedAspect: Number.NaN,
      listenerInstalled: false,
      publishScheduled: false,
    }
  );
}

/** Subscribe to "the window changed size" (coalesced to one call per frame). For views whose text is a
 *  VALUE composed into a sentence, which the reconciler cannot re-derive from a key. */
export function onViewportChange(cb: () => void): void {
  viewCbs.add(cb);
}

function publishNow(): void {
  if (!state) return;
  state.width = window.innerWidth;
  state.height = window.innerHeight;
}
