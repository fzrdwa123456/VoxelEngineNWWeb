// ===== Pointer lock management =====
import { invoke } from "@tauri-apps/api/core";

// The boot.log channel (P1.59): the front end's cursor diagnostics land in the SAME file as Rust's
// `[cursor]` probes, so one file tells the whole story in order. (mousecapture.ts imports from here too.)
import { cursorBoot } from "../desktop/shell";

export interface PointerLockDeps {
  /** What the lock manager needs from the input system (structural, no concrete class) */
  input: { lock(): Promise<void> | undefined };
  /** The DEVICE state resource (`INPUT_STATE`): `appliedCursor` is the cursor value this manager last
   *  wrote, i.e. a fact about the window that belongs in the world rather than in a private field.
   *  `locked` / `freeMouseActive` are read by the P1.59 cursor diagnostics, which has to say WHO ordered a
   *  hidden cursor and with which inputs — the two fields that can make `canControl()` true with no capture
   *  behind it are exactly the ones a "the cursor is invisible" report has to rule out. */
  state: {
    appliedCursor: "none" | "default" | null;
    locked: boolean;
    freeMouseActive: boolean;
  };
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
  /** **Is the user moving or resizing the window right now?** (`win-session`, P1.62e) A capture taken then is
   *  taken out of a window the user is holding: it would end on the first movement anyway (main.ts's
   *  `onWinGeometry` pauses), so the request is refused here — with a line saying why, instead of a capture
   *  that silently appears and disappears. Read synchronously, like `focused`. */
  windowMoving: () => boolean;
  logDebug: (line: string) => void;
  /** Retry a rejected lock: **the deadline goes into the world** (`DELAYED_INTENTS::schedule`, see
   *  ecs/systems/delays.ts), applied by `ui.delays` on the next frame. This used to be
   *  `setTimeout(tryLock, 1300)` — a timer owned by this module alone, invisible to the schedule, still
   *  running while paused, and impossible to list in the log. */
  scheduleRetry: (delayMs: number, source: string) => void;
}

// relock() STILL **requires the window to be foreground** (deps.focused). The old comment said "no focus
// gate is needed" because the browser's requestPointerLock refuses anyway; the Tauri version goes through
// native ClipCursor, which does not look at the foreground — that assumption no longer holds.
//
// **AND IT IS EXPLICIT-ONLY NOW (P1.58).** `relock` is called by the paths where the PLAYER asks for the mouse
// (Resume, ESC out of a menu, the backpack key, entering a world) and by nothing else: the focus handler used
// to call it too, and the Windows key's `focus LOST` / `focus GAIN` flap re-opened the capture — which hides
// the cursor — several times per keypress. A focus event re-asserts the cursor INTENT instead
// (main.ts::onWinFocus -> reassertCursor), and Rust's foreground rule is what takes a background capture
// away (win.rs::on_foreground_lost, which also forgets the hidden intent).

export class PointerLock {
  /** A nudge is waiting for its SECOND step (see `nudgeCursor`): the next `applyCursor()` — which the ui lane
   *  calls every frame — completes it. A field, not a timer: the process already owns exactly one loop. */
  private nudgePending = false;

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
    if (this.deps.windowMoving()) {
      this.deps.logDebug(`LOCK skipped [${source}]: the window is being moved or resized`);
      return;
    }
    // Diagnostics (P1.65): the reported "it enters paused, but Resume leaves the cursor visible and the view
    // dead" is a lock that never SETTLES into `locked=true`. These two lines say whether the request resolved
    // at all and which mechanism actually took the mouse (the native clip leaves pointerLockElement null; a
    // fallback sets it).
    cursorBoot(`LOCK attempt [${source}] ${this.stateLine()}`);
    const p = this.deps.input.lock();
    if (p) {
      p.then(() => {
        cursorBoot(`LOCK OK [${source}] plock=${document.pointerLockElement !== null} ${this.stateLine()}`);
      }).catch((err) => {
        cursorBoot(`LOCK FAILED [${source}] ${String(err)} plock=${document.pointerLockElement !== null}`);
        this.deps.logDebug(`LOCK rejected [${source}], retrying in 1300ms`);
        this.deps.scheduleRetry(1300, source);
      });
    } else {
      cursorBoot(`LOCK no-op [${source}] (the lock path returned nothing)`);
    }
  }

  // Cursor: hidden ONLY while the player actually controls the mouse (a world running, no modal UI
  // up). Visible on the loading screen, at the main menu, in the pause menu and in the backpack.
  // (It used to read `isUiModal` inverted, which made the loading screen hide the cursor.)
  /** Re-assert the cursor shape after the window regained focus (or after the menu/Apps key).
   *
   *  **It WRITES the CSS value again**, even when it has not changed — that is what "re-assert" means, and it
   *  is half of the two-step nudge below (P1.60). The INTENT is sent unconditionally for the same reason: it
   *  is the "apply it again, right now" ping. */
  reassertCursor(reason = "unspecified"): void {
    this.writeCursor(true); // force the write: see `nudgeCursor`
    // **Diagnostics (P1.59): the intent is logged even though the value did not change** — this is the call
    // that can ORDER a hidden cursor while nothing is captured, so the line right after it in boot.log
    // decides whether the report "the cursor is invisible after the Win key" is a stale intent or a repaint.
    cursorBoot(`JS reassert [${reason}] ${this.stateLine()}`);
    // The intent is sent even though the value did not change: it is the "apply it again, right now" ping.
    void invoke("cursor_intent", { visible: !this.deps.canControl() }).catch(() => {});
  }

  /** **THE TWO-STEP CURSOR NUDGE (P1.60)** — write a DIFFERENT value now, the real one on the next frame.
   *
   *  It is the ONE cure for "Chromium's cached cursor is still the NULL it pushed while we were capturing":
   *  Chromium answers `WM_SETCURSOR` from that cache, so a repeated *intent*, and even a `SetCursor` from
   *  Rust, does not turn it back into an arrow — **the CSS value has to CHANGE under it**. The boot.log of
   *  the Win-key report shows the whole thing: right after the release the arrow was pushed and
   *  `showing=true`; ~0.2 s later the system reported `showing=false hCursor=0` with no push from us, and
   *  then four consecutive `RAWMON … cursorFix=0 desired=1 showing=0` windows — four seconds of an invisible
   *  cursor that only a real mouse move brought back.
   *
   *  P1.55 deleted the old `reapplyCursor` (writes at 0 / 120 ms) in favour of Rust's sentinel; the log
   *  proved the sentinel cannot do this job, so it comes back NARROWLY: never while we hold the mouse (the
   *  first write would show an arrow), and the second write is the ordinary per-frame `applyCursor()` the ui
   *  lane already calls — no timer, no queue, no new resource.
   *
   *  `auto` and `default` both draw the standard arrow, so the intermediate value is invisible to the
   *  player; what matters is that it is a DIFFERENT computed value for Blink. */
  nudgeCursor(reason: string): void {
    if (this.deps.canControl() || this.deps.state.appliedCursor === "none") {
      // We hold the mouse, or we still WANT it hidden: a nudge would put an arrow on screen for a frame.
      return;
    }
    this.nudgePending = true;
    this.deps.logDebug(`CURSOR nudge [${reason}] auto -> default`);
    cursorBoot(`JS nudge [${reason}] auto -> default ${this.stateLine()}`);
    document.body.style.setProperty("cursor", "auto", "important");
  }

  /** The front end's own cursor facts, as one appended fragment. Everything that decides the intent, plus
   *  the CSS value the SYSTEM will read back through `WM_SETCURSOR` — a hidden-but-uncaptured cursor is
   *  either this side asking for `none`, or Chromium answering from a stale cache, and the two need
   *  different cures. */
  private stateLine(): string {
    const computed =
      typeof getComputedStyle === "function" ? getComputedStyle(document.body).cursor : "?";
    const held = this.deps.state.locked || document.pointerLockElement !== null;
    return (
      `css=${document.body.style.cursor || "(unset)"} computed=${computed} ` +
      `locked=${this.deps.state.locked} held=${held} free=${this.deps.state.freeMouseActive} ` +
      `modal=${this.deps.isUiModal()} canControl=${this.deps.canControl()} ` +
      `applied=${this.deps.state.appliedCursor ?? "null"} ` +
      `domFocus=${typeof document.hasFocus === "function" ? document.hasFocus() : "?"}`
    );
  }

  applyCursor(): void {
    // The second half of a pending nudge arrives HERE (the ui lane calls this every frame), which is what
    // completes the two-step without a timer of this module's own.
    const forced = this.nudgePending;
    this.nudgePending = false;
    this.writeCursor(forced);
  }

  /** The ONE writer of the CSS value. `force` writes it even when the value did not change (the re-assert
   *  and the nudge's second step need that; the per-frame call does not). */
  private writeCursor(force: boolean): void {
    const can = this.deps.canControl();
    const value: "none" | "default" = can ? "none" : "default";
    // Diagnostics: the last CSS value written, logged only when it **changes** (so it does not flood every
    // frame). The VALUE lives in INPUT_STATE.appliedCursor — a fact about the window, not a private field
    // of this manager — so the gate and the log can read it.
    const changed = value !== this.deps.state.appliedCursor;
    if (changed) {
      this.deps.state.appliedCursor = value;
      // Diagnostics: the decision on the CSS side. Read together with the system-side [cursor] probes in
      // boot.log, it pinpoints the moment an inconsistency like "CSS says visible, the system says
      // hidden" happens.
      this.deps.logDebug(`CURSOR css=${value} canControl=${can}`);
      // **And the same decision, with every input, into boot.log (P1.59)** — next to Rust's `[cursor]`
      // lines, so one file shows the whole exchange in order.
      cursorBoot(`JS applyCursor value=${value} ${this.stateLine()}`);
      // Hand the **intent** to Rust: its sentinel (every 8ms) is then responsible for actually
      // showing/hiding the cursor, no longer depending on Chromium's push timing and no longer
      // vulnerable to Windows being dragged into menu mode by Alt.
      void invoke("cursor_intent", { visible: value !== "none" }).catch(() => {});
    }
    // The write happens when the TARGET changed, when a re-assert or a nudge asked for it, **or when the
    // element does not carry the value any more** — the third case is the nudge's `auto` waiting to be
    // replaced, and reading it back is what keeps this the single owner of the element's value.
    if (changed || force || document.body.style.cursor !== value) {
      // **Important: it must be written as an important inline value.** The theme's global stylesheet has
      // a `*{cursor:inherit !important}` (to wipe out the controls' hand cursor), and body matches `*`
      // itself — only "inline important" beats "stylesheet important", letting body keep the game's policy
      // value while every other element inherits from body.
      document.body.style.setProperty("cursor", value, "important");
    }
  }
}