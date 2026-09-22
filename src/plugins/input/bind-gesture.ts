// ===== The key bind gesture's DEVICE half: the listeners that must decide inside the event =====
// These five listeners used to live in `ui/menu.ts` — a VIEW owning `document` listeners, which was the last
// place in the project where that was true (the inventory view's digit-key listener went to
// `ui.navigation`, the resize listener to `platform/viewport.ts`, and the ESC/contextmenu/Space guards to
// `platform/window-guards.ts`). They are device-layer code: every one of them decides something that can
// only be decided INSIDE the event that must be cancelled or intercepted.
//
// THEY ARE NOT REFACTORED, THEY ARE RELOCATED. Not one condition, order or synchronous read changed:
//   * the CLICK SHIELD (capture phase) swallows the synthetic click that follows a physical press — the
//     press already completed the binding, so the browser-generated click must not re-trigger chip
//     reselect / keycap pick / the Back button. Consuming it clears it, except during a drag (a drag may
//     outlive one click);
//   * the MOUSEUP listener is both the shield's fallback (a shield no click consumed — e.g. the drag
//     pressed a second button, breaking Chromium's click synthesis) and the drag's END;
//   * the WHEEL block keeps the options list from drifting under the operation;
//   * the KEYDOWN listener binds the pressed key while a capture is armed (Esc = unbind) and cancels a drag;
//   * the MOUSEDOWN listener starts a capture-free drag on a chip, or binds a mouse button while capturing.
//
// The gesture's STATE stays the `KEYBIND_GESTURE` resource and the PRESENTATION stays `ui.keybind`'s
// (highlight + rubber band, derived per frame). What the view keeps is the part only it can answer: which
// action ids a chip/keycap carries and the hit test that finds one, injected here as callbacks.
import type { BindAction } from "../../data/globals/binds";
import type { KeybindGesture, RebindIntent } from "../../data/globals/keybind-gesture";
import type { UiHit } from "../../shared/types/ui";

export interface BindGestureDeviceDeps {
  /** The gesture's state (the KEYBIND_GESTURE resource; null before wiring) */
  readonly gesture: () => KeybindGesture | null;
  /** The action a rebind capture is armed for, or null (platform/keybinds reads the gesture resource) */
  readonly capturing: () => BindAction | null;
  /** Abort a capture outright (the abnormal paths: a capture that started mid-drag) */
  readonly endCapture: () => void;
  /** Queue a rebind decision for the ui lane (`ui.keybind` applies it — the bind table is the SYSTEM's
   *  to write, the event only decides). `code` is already resolved here: KeyboardEvent.code for a key,
   *  `buttonToCode` for a button, the keycap hit test for a drag drop. */
  readonly queueRebind: (intent: RebindIntent) => void;
  /** The action id an action CHIP carries — a capture-free drag may only start on one */
  readonly chipAction: string;
  /** The KEYCAP code under a point, or null (the view owns the keycap action id and the hit test) */
  readonly keycapCodeAt: (x: number, y: number) => string | null;
  /** The widget under a point (the reconciler's hit test) */
  readonly hitTest: (x: number, y: number) => UiHit | null;
  /** Arm the one-shot click shield (the view's own arm path — the two arm paths stay distinct) */
  readonly armShield: (schedSelf: boolean) => void;
  /** Mouse button -> bind code (platform/keybinds) */
  readonly buttonToCode: (button: number) => string | null;
  readonly log: (line: string) => void;
}

/** Install the gesture's device listeners. Called ONCE by the view during wiring, so the listeners see the
 *  same state object the system derives its presentation from. */
export function installBindGestureHandlers(deps: BindGestureDeviceDeps): void {
  // Global click shield (capture phase: runs before all elements' own click).
  document.addEventListener(
    "click",
    (ev) => {
      const g = deps.gesture();
      if (deps.capturing() || g?.drag || g?.shield) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (g && !g.drag) g.shield = false;
      }
    },
    true,
  );

  // The release: the shield fallback AND the capture-free drag's end in ONE listener (both are "the button
  // came up").
  document.addEventListener("mouseup", (ev) => {
    const g = deps.gesture();
    if (!g) return;
    if (g.shield) {
      setTimeout(() => {
        g.shield = false;
      }, 0);
    }
    if (!g.drag) return;
    if (ev.button !== g.drag.button) return; // Release of the non-initiating button: ignore, do not interrupt the drag
    const { action, anchorX, anchorY } = g.drag;
    g.drag = null;
    g.hover = null; // ui.keybind clears the highlight and hides the line on the next frame
    const dragged = Math.hypot(ev.clientX - anchorX, ev.clientY - anchorY) >= 6;
    if (!dragged) return; // Plain click: hand over to the native click for the select toggle
    deps.armShield(true); // mouseup-armed: the synthetic click consumes it first (see the arm path)
    if (deps.capturing()) return; // A capture started mid-drag (abnormal path): abort the bind
    const code = deps.keycapCodeAt(ev.clientX, ev.clientY);
    if (!code) {
      deps.log(`KBCAP drag release action=${action} code=no hit`);
      return; // Released on empty space: no-op
    }
    // The bind itself is the ui lane's job (`ui.keybind` drains the queue); the EVENT only reports
    // "this action was dropped on this key", which is the half only an event can know.
    deps.queueRebind({ kind: "bindDrag", action, code });
  });

  // Capture state / capture-free drag in progress: forbid all wheel scrolling (prevents the bind options
  // list drifting under the operation). passive:false must be explicit — Chrome makes document-level wheel
  // listeners passive by default, otherwise preventDefault is ineffective.
  document.addEventListener(
    "wheel",
    (ev) => {
      if (deps.capturing() || deps.gesture()?.drag) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    },
    { passive: false },
  );

  // Physical key capture. Esc during a drag cancels the drag; with an action selected every key binds
  // (Esc = unbind) without closing the menu.
  document.addEventListener("keydown", (ev) => {
    const g = deps.gesture();
    const action = deps.capturing();
    if (!action && g?.drag) {
      // Drag in progress: keys have no default role here — Space/Enter/Tab would otherwise scroll the panel
      // or jump focus (browser defaults; the wheel is already blocked above). Every key is neutralized.
      // **ESC is not cancelled HERE any more**: that decision belongs to `ui.navigation`, the ONE
      // decision-maker for ESC, which cancels the drag instead of stepping back. Doing it in both places is
      // what made ESC during a drag both cancel the drag AND walk up a menu level once this handler's
      // registration order changed (a device listener cannot reliably preempt the key-edge publisher: only
      // listeners registered AFTER it can be stopped, and registration order is wiring order).
      ev.preventDefault();
      return;
    }
    // Diagnostic probe (**commented out for now**, for the 2026-09 hands-on test): it used to fire
    // unconditionally, so holding any key wrote ~30 lines/s into debug.log (Windows auto-repeat), and it
    // was unrelated to whether a bind capture was running. Uncomment to restore.
    // It is the same class of probe as `KBCAP mousedown` below (that line is still there, fired only on a
    // mouse press).
    // deps.log(`KBCAP keydown code=${ev.code} capturing=${action ?? "null"}`);
    if (!action) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    // The bind table is written by `ui.keybind`, not here: the event decides WHICH code, the lane applies
    // it. Escape means "unbind" ("" = unbound).
    deps.queueRebind({ kind: "bindCapture", code: ev.code === "Escape" ? "" : ev.code });
  });

  // Any mouse button (incl. left) binds its code on press while capturing. preventDefault stops the focused
  // button being activated by Space/Enter and middle-click autoscroll; stopImmediatePropagation blocks the
  // later-registered window guards and F3/F4 (the earlier-registered inventory E key yields via capturing).
  // The SAME listener starts a capture-free drag when the press lands on an action chip: the chip is a
  // widget, so this cannot be a per-chip listener — the hit test can already say "this point is the chip
  // whose value is `forward`".
  document.addEventListener("mousedown", (ev) => {
    const g = deps.gesture();
    const action = deps.capturing();
    deps.log(`KBCAP mousedown button=${ev.button} capturing=${action ?? "null"}`);
    if (!action) {
      // Capture-free drag start: hold a chip and move past the threshold to bind by dropping.
      if (ev.button !== 0 || !g || g.drag) return; // Only the left button starts a drag, one at a time
      const hit = deps.hitTest(ev.clientX, ev.clientY);
      if (!hit || hit.action !== deps.chipAction) return;
      ev.preventDefault(); // Prevent text selection while dragging
      g.drag = {
        action: hit.value as BindAction,
        button: ev.button,
        anchorX: ev.clientX,
        anchorY: ev.clientY,
        moved: false,
      };
      g.pointerX = ev.clientX;
      g.pointerY = ev.clientY;
      return;
    }
    ev.preventDefault();
    ev.stopImmediatePropagation();
    // One-shot shield for the upcoming synthetic click: only button 0 synthesizes one (right/middle/side
    // produce contextmenu/auxclick). Armed without a self-timeout — cleared by the click shield on
    // consumption or by the mouseup fallback above.
    if (ev.button === 0) deps.armShield(false);
    const code = deps.buttonToCode(ev.button); // Left/middle/right/X1/X2 all bind immediately
    if (!code) return;
    deps.queueRebind({ kind: "bindCapture", code });
    deps.log(`KBCAP mousedown bind done (${code})`);
  });
}
