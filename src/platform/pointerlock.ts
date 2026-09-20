// ===== Pointer lock management =====
import { invoke } from "@tauri-apps/api/core";

export interface PointerLockDeps {
  /** What the lock manager needs from the input system (structural, no concrete class) */
  input: { lock(): Promise<void> | undefined };
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
  /** Diagnostics: the last CSS value written, logged only when it **changes** (so it does not flood every
   *  frame) */
  private lastCursor: "none" | "default" | null = null;

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
  /** After the window regains focus, force Chromium to **recompute** the cursor and push it down.
   *
   *  Why it is needed (probe evidence): at the moment focus is lost the CSS goes from `none` to
   *  `default`, but that push was dropped by the system (the window was deactivating); and Chromium's
   *  **cached "current cursor" is still NULL** — so asking it afterwards (the `WM_SETCURSOR` the Rust
   *  side sends) it answers NULL as well:
   *      `[cursor] focus GAIN before=showing=false hCursor=0` → `after` is still 0
   *  Only making the CSS **really change once** gets it to recompute. The trick: first write a string
   *  that differs from the target but is equivalent (both `auto` and `default` are an arrow, no visible
   *  difference), and in the next macrotask write the target value back.
   *  `applyCursor()` writes the same value every frame, and Chromium does not push when "the value did
   *  not change" — so it has to change once first. */
  reapplyCursor(): void {
    const target: "none" | "default" = this.deps.canControl() ? "none" : "default";
    if (target === "none") {
      // When hiding, this dance is not needed (the failure mode is "should be visible but stays hidden")
      this.applyCursor();
      return;
    }
    // Likewise it must be important: the theme's `*{cursor:inherit !important}` would beat a plain
    // inline value, that "forced change" would become a no-op, and Chromium would not push the cursor
    // again. (`auto` and `default` are both an arrow, no visible difference, but the value really did
    // change.)
    document.body.style.setProperty("cursor", "auto", "important");
    this.deps.scheduleCursor(0);
    // The render process may lag by one beat; write it once more
    this.deps.scheduleCursor(120);
  }

  applyCursor(): void {
    const can = this.deps.canControl();
    const value: "none" | "default" = can ? "none" : "default";
    if (value !== this.lastCursor) {
      this.lastCursor = value;
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