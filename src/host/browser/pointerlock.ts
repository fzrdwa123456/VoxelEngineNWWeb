// ===== Pointer lock management =====
import { invoke } from "@tauri-apps/api/core";

export interface PointerLockDeps {
  /** What the lock manager needs from the input system (structural, no concrete class) */
  input: { lock(): Promise<void> | undefined };
  /** The DEVICE state resource (`INPUT_STATE`): `appliedCursor` is the cursor value this manager last
   *  wrote, i.e. a fact about the window that belongs in the world rather than in a private field. */
  state: { appliedCursor: "none" | "default" | null };
  /** Whether a modal UI currently owns the mouse. ONE predicate, supplied by the composition root
   *  from the UI_MODAL resource — it replaced two separate callbacks (isMenuOpen / isInvOpen) whose
   *  OR only existed at the call sites. */
  isUiModal: () => boolean;
  /** Whether the player currently CONTROLS the mouse — i.e. `canControl(INPUT_STATE, UI_MODAL)`.
   *
   *  **This is the cursor's gate, and it is deliberately NOT `!isUiModal`.** The loading screen runs
   *  in `load` mode and owns no modal surface, so `!isUiModal` was TRUE there and the cursor was
   *  hidden while a loading bar was on screen. `canControl` is false until the mouse is actually
   *  captured, so the cursor stays visible through the startup, the settings check, the world entry
   *  and every menu — and is hidden only while a world is actually running under the player's hand. */
  canControl: () => boolean;
  /** Whether the window is **foreground** (`platform/shell.ts`'s winFocused).
   *
   *  **Capture must only be on while foreground.** Native capture goes through `ClipCursor`, and it
   *  **does not look at all** at whether the window is foreground; the browser's `requestPointerLock` is
   *  refused by Chromium (so the old version could drop this gate, and the old comment said exactly
   *  that) — but once the Tauri version went native, dropping it means allowing "capture in the
   *  background": the cursor is clamped inside a background window's rectangle (another application sits
   *  over that area), the view keeps turning (raw input is RIDEV_INPUTSINK, received in the background
   *  too), and the cursor is hidden globally as well. The easiest place to hit this is the **automatic
   *  relock on world entry** (switching away during loading, then capturing anyway once it finishes) —
   *  see `win.rs::capture_foreground_check`, which is the system-level backstop; this is the gate on the
   *  normal path. */
  focused: () => boolean;
  logDebug: (line: string) => void;
  /** Retry a rejected lock: **the deadline goes into the world** (`DELAYED_INTENTS::schedule`, see
   *  ecs/systems/delays.ts), applied by `ui.delays` on the next frame. This used to be
   *  `setTimeout(tryLock, 1300)` — a timer owned by this module alone, invisible to the schedule, still
   *  running while paused, and impossible to list in the log. */
  scheduleRetry: (delayMs: number, source: string) => void;
  /** Write the cursor once more (`reapplyCursor`'s two extra writes at 0 / 120 ms): likewise a delayed
   *  intent, not a timer owned by this module. */
  scheduleCursor: (delayMs: number) => void;
}

// relock() STILL **requires the window to be foreground** (deps.focused). The old comment said "no focus
// gate is needed" because the browser's requestPointerLock refuses anyway; the Tauri version goes through
// native ClipCursor, which does not look at the foreground — that assumption no longer holds.

export class PointerLock {
  constructor(private readonly deps: PointerLockDeps) {}

  relock(source: string): void {
        this.deps.logDebug(`LOCK request [${source}]`);
    this.attempt(source);
  }

  /** The expiry retry (called by `ui.delays`): the same path as `relock`, plus one line saying "this is
   *  a retry". */
  retry(source: string): void {
    this.deps.logDebug(`LOCK retry [${source}]`);
    this.attempt(source);
  }

  private attempt(source: string): void {
      if (this.deps.isUiModal()) return;
      if (!this.deps.focused()) {
        this.deps.logDebug(`LOCK skipped [${source}]: window is not foreground`);
        return;
      }
      const p = this.deps.input.lock();
      if (p) {
        p.catch(() => {
                    this.deps.logDebug(`LOCK rejected [${source}], retrying in 1300ms`);
          this.deps.scheduleRetry(1300, source);
        });
      }
  }

    // Cursor: hidden ONLY while the player actually controls the mouse (a world running, no modal UI
    // up). Visible on the loading screen, at the main menu, in the pause menu and in the backpack.
    // (It used to read `isUiModal` inverted, which made the loading screen hide the cursor.)
  /** Re-assert the cursor shape after the window regained focus (or after the menu/Apps key).
   *
   *  It used to write a DIFFERENT CSS value first (`auto`, then the target) to force Chromium to recompute
   *  its cached cursor. That is gone (P1.55): **Rust owns the real shape**, and one repeated INTENT is all it
   *  takes, because the Rust reconciler compares the plan with the SYSTEM (`GetCursorInfo`) instead of with
   *  its own record - in BOTH directions. So there is one writer of the CSS value and one mechanism for the
   *  shape, and never a frame in which a value nobody asked for is on screen. */
  reassertCursor(): void {
    this.applyCursor(); // keeps the CSS value in sync (idempotent)
    // The intent is sent even though the value did not change: it is the "apply it again, right now" ping.
    void invoke("cursor_intent", { visible: !this.deps.canControl() }).catch(() => {});
  }

  applyCursor(): void {
    const can = this.deps.canControl();
    const value: "none" | "default" = can ? "none" : "default";
    // Diagnostics: the last CSS value written, logged only when it **changes** (so it does not flood every
    // frame). The VALUE lives in INPUT_STATE.appliedCursor — a fact about the window, not a private field
    // of this manager — so the gate and the log can read it.
    if (value !== this.deps.state.appliedCursor) {
      this.deps.state.appliedCursor = value;
      // Diagnostics: the decision on the CSS side. Read together with the system-side [cursor] probes in
      // boot.log, it pinpoints the moment an inconsistency like "CSS says visible, the system says
      // hidden" happens.
      this.deps.logDebug(`CURSOR css=${value} canControl=${can}`);
      // Hand the **intent** to Rust: its sentinel (every 8ms) is then responsible for actually
      // showing/hiding the cursor, no longer depending on Chromium's push timing and no longer
      // vulnerable to Windows being dragged into menu mode by Alt.
      void invoke("cursor_intent", { visible: value !== "none" }).catch(() => {});
    }
    // **Important: it must be written as an important inline value.** The theme's global stylesheet has
    // a `*{cursor:inherit !important}` (to wipe out the controls' hand cursor), and body matches `*`
    // itself — only "inline important" beats "stylesheet important", letting body keep the game's policy
    // value while every other element inherits from body.
    document.body.style.setProperty("cursor", value, "important");
  }
}