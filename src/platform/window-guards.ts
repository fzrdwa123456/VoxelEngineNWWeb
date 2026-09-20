// ===== The window-level guards: the listeners that must decide INSIDE the event =====
// These four used to sit in `main.ts` (the composition root — which should WIRE, not listen). They are
// device-layer code by nature: each one exists only because something has to happen *inside* the event
// that must be cancelled, which no lane or system can do for it.
//
//   1. `pointerlockchange` — a diagnostic line, the moment the lock state changes. It is what the
//      cursor-centering races were diagnosed with (boot.log/debug.log probe lines).
//   2. `Escape` — the browser's default action for ESC is to exit pointer lock / leave fullscreen, and a
//      `preventDefault` is only possible in the event itself. The DECISION is not here: `ui.navigation`
//      reads the Escape EDGE the device layer publishes and steps back through UI_MODAL.
//   3. `contextmenu` — right-click is a game action (place a block), so the browser menu must never
//      appear: in a captured window it interrupts the frame and pulls the cursor away for a moment.
//   4. `Space` (capture phase) — while any modal UI is open, Space's default (scroll the nearest
//      scrollable ancestor of the focused element, e.g. the keybind chip list) is swallowed. Gameplay
//      Space is unaffected, and a rebind capture still sees the event through its own handler.
//
// Installed ONCE by the composition root during wiring, with the two facts it needs injected — so this
// module imports nothing and the root holds no listener of its own.
export interface WindowGuardDeps {
  /** Does a modal UI own the mouse right now? (UI_MODAL, through the ONE predicate) */
  readonly isUiModal: () => boolean;
  /** Write the cursor state again (platform/pointerlock.ts::applyCursor): used to re-assert "hidden"
   *  immediately after a key that makes the SYSTEM reveal the cursor. */
  readonly applyCursor: () => void;
  /** Arm another cursor write in `delayMs` (ecs/resources.ts::DELAYED_INTENTS, applied by
   *  `ecs/systems/delays.ts`). This used to be a `setTimeout` + a `requestAnimationFrame` here: the
   *  re-assert has to happen across ~80 ms to win the race, and a timer owned by a listener is exactly
   *  what the ui lane cannot see. */
  readonly scheduleCursor: (delayMs: number) => void;
  readonly log: (line: string) => void;
}

export function installWindowGuards(deps: WindowGuardDeps): void {
  document.addEventListener("pointerlockchange", () => {
    deps.log(`LOCKCHANGE ${document.pointerLockElement ? "locked" : "unlocked"}`);
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.code !== "Escape") return;
    ev.preventDefault(); // #7907: block the default unlock; we control menu open/close
  });

  document.addEventListener("contextmenu", (ev) => ev.preventDefault());

  // The keyboard CONTEXT MENU gesture: the menu/Apps key, and Shift+F10 (its keyboard equivalent).
  // Chromium treats it as "show a context menu" and REVEALS THE SYSTEM CURSOR for it; the low-level keyboard
  // hook that was supposed to swallow the key before Chromium sees it has never fired (the HOOKPROBE line
  // reports seen=0), so this is the last layer we own.
  //
  // TWO things, because one alone was not enough: cancel the default on the PRESS **and** the RELEASE (the
  // reveal can happen on either), and then RE-ASSERT the hidden cursor immediately plus on the next few
  // frames — the flash is a race between the system showing the cursor and our sentinel hiding it again, and
  // waiting up to 8ms for the sentinel is exactly the frame the player sees.
  // `preventDefault` ONLY (no stopImmediatePropagation): the `KBCAP keydown code=ContextMenu` line stays as
  // the probe for whether the low-level hook is doing its job.
  const contextMenuGesture = (ev: KeyboardEvent): void => {
    if (ev.code !== "ContextMenu" && !(ev.code === "F10" && ev.shiftKey)) return;
    ev.preventDefault();
    deps.applyCursor();
    // The re-assert schedule: NOW (inside the event), then at 0/32/80 ms. Those four deadlines are DATA
    // in DELAYED_INTENTS and `ui.delays` applies them — one per ui lane, i.e. one per frame, which is
    // denser than the timers this replaced (the frame is 8 ms at 120 Hz) and therefore wins the race
    // sooner. `requestAnimationFrame` here was a second frame callback for a deadline that the lane
    // already fires on.
    deps.scheduleCursor(0);
    deps.scheduleCursor(32);
    deps.scheduleCursor(80);
  };
  document.addEventListener("keydown", contextMenuGesture, true);
  document.addEventListener("keyup", contextMenuGesture, true);

  document.addEventListener(
    "keydown",
    (ev) => {
      if (ev.code !== "Space") return;
      if (deps.isUiModal()) ev.preventDefault();
    },
    true,
  );
}
