// ===== ui.toast: the HUD toast, as DATA + a system =====
// `showToast(key)` used to be a method on the Hud that wrote two widgets and armed a setTimeout. It is
// a SYSTEM now, for two reasons that had nothing to do with tidiness:
//   1. the message outlives the caller. A toast raised from the MAIN MENU (the multiplayer placeholder)
//      is shown while the game loop is stopped, so nothing but the ui pump was left to take it down —
//      and a `setTimeout` inside a view is a second, invisible owner of "how long is this up".
//   2. it must survive the frame it was created in. The caller is a DOM callback; the widgets it wrote
//      were reconciled a frame later. Now the caller sends the ShowToast COMMAND and this system puts
//      the message on screen in the ui lane of the very same frame (the barrier runs before the lane).
//
// The deadline is a WALL-CLOCK time (TOAST_STATE.until), not a dt counter: the ui lane runs with
// dt = 0 while the main menu pumps it, and a toast that only expires while the world simulates would
// stay on screen forever there. That also reproduces the setTimeout semantics exactly (2.5 s of real
// time, paused or not), which is what the F3 log and the user's eye both expect.
import { TOAST, type ToastState } from "../../../data/globals/resources";
import type { Entity, SystemAccess, World } from "../../../core/world";
import { UI_PAINT, type UiToastPaint } from "../../../data/globals/paint";
import { UI_STATE, UI_TEXT, setUiText, setUiVisible } from "../components";

/** It writes the toast's own widgets and nothing else. */
export const UI_TOAST_ACCESS: SystemAccess = {
  writes: [UI_STATE, UI_TEXT],
  readsExternal: ["wallClock"],
};

export class UiToastSystem {
  private readonly state: ToastState;
  private readonly panel: Entity;
  private readonly body: Entity;
  /** What is on screen right now (the widgets are diffed by the reconciler; this skips re-writing
   *  them every frame, which is the same reason ui.inventory keeps a drawn signature). The DATA is the
   *  UI_PAINT.toast block (ecs/ui/paint.ts). */
  private readonly paint: UiToastPaint;

  private get shown(): boolean {
    return this.paint.shown;
  }
  private set shown(v: boolean) {
    this.paint.shown = v;
  }
  private get shownKey(): string {
    return this.paint.shownKey;
  }
  private set shownKey(v: string) {
    this.paint.shownKey = v;
  }
  private get shownRaw(): boolean {
    return this.paint.shownRaw;
  }
  private set shownRaw(v: boolean) {
    this.paint.shownRaw = v;
  }

  constructor(
    private readonly world: World,
    panel: Entity,
    body: Entity,
  ) {
    this.state = world.resource(TOAST);
    this.panel = panel;
    this.body = body;
    this.paint = world.resource(UI_PAINT).toast;
  }

  /** ui lane, once per frame: puts the armed message up, then takes it down when its deadline passes. */
  step(): void {
    const toast = this.state;
    const visible = toast.until > performance.now();
    if (visible && (toast.key !== this.shownKey || toast.raw !== this.shownRaw)) {
      // A KEY, not a finished sentence, unless the caller had to interpolate a value: the reconciler
      // re-resolves it every frame, so a language switch re-translates a toast that is already up.
      setUiText(this.world, this.body, toast.key, toast.raw);
      this.shownKey = toast.key;
      this.shownRaw = toast.raw;
    }
    if (visible !== this.shown) {
      this.shown = visible;
      setUiVisible(this.world, this.panel, visible);
    }
  }
}
