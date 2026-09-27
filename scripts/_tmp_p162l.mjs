// P1.62e: a world entered while the user is holding the window starts PAUSED (and the lock manager refuses to
// capture then, too). The platform pushes its "the user is moving/resizing the window" flag to the front end.
// One-shot: every anchor is verified before anything is written.
import fs from "node:fs";

let failures = 0;
const read = (f) => fs.readFileSync(f, "utf8");
const write = (f, t) => fs.writeFileSync(f, t, "utf8");
const lf = (s) => s.split("\r\n").join("\n").split("\r").join("\n");
function fail(what) {
  failures++;
  console.error(`MISSING/NOT UNIQUE: ${what}`);
}
function sub(file, oldText, newText, what) {
  const at = lf(read(file));
  const i = at.indexOf(oldText);
  if (i < 0 || at.indexOf(oldText, i + 1) >= 0) return fail(what);
  write(file, at.slice(0, i) + newText + at.slice(i + oldText.length));
  console.log(`patched: ${file} - ${what}`);
}

const SHELLSTATE = "src/data/globals/shell.ts";
const SHELL = "src/host/desktop/shell.ts";
const RESOURCES = "src/data/globals/resources.ts";
const MAIN = "src/boot/main.ts";
const PLOCK = "src/host/browser/pointerlock.ts";
const WIN = "src-tauri/src/win.rs";

// ===== 1. SHELL_STATE gains the pushed fact =====
sub(
  SHELLSTATE,
  [
    "  diagLogEnabled: boolean;",
    "  windowFocused: boolean;",
    "}",
  ].join("\n"),
  [
    "  diagLogEnabled: boolean;",
    "  windowFocused: boolean;",
    "  /** **Is the user moving or resizing the window right now?** (P1.62e)",
    "   *",
    "   *  The PLATFORM pushes it (`win-session`, from the same `WM_ENTERSIZEMOVE`/`WM_NCLBUTTONDOWN` flag the",
    "   *  cursor code already keeps), because a **held** title-bar press produces NO geometry event at all: the",
    "   *  front end otherwise cannot tell \"the user has a hand on the frame\" from \"the user is waiting\", and a",
    "   *  world entered in that state captured the mouse and paused only once the window moved. Read",
    "   *  synchronously by the lock manager and the entry driver, exactly like `windowFocused`. */",
    "  windowMoving: boolean;",
    "}",
  ].join("\n"),
  "the ShellState field",
);
sub(
  SHELLSTATE,
  [
    "  diagLogEnabled: true,",
    "  windowFocused: false,",
    "};",
  ].join("\n"),
  [
    "  diagLogEnabled: true,",
    "  windowFocused: false,",
    "  windowMoving: false,",
    "};",
  ].join("\n"),
  "the ShellState default",
);

// ===== 2. the host listens for it =====
sub(
  SHELL,
  [
    "  void listen(\"win-geometry\", () => {",
    "    geometryListeners.forEach((cb) => cb());",
    "  });",
  ].join("\n"),
  [
    "  void listen(\"win-geometry\", () => {",
    "    geometryListeners.forEach((cb) => cb());",
    "  });",
    "  // The window is being MOVED or RESIZED by the user (P1.62e): pushed by the cursor code's own session flag,",
    "  // because a held title-bar press produces no geometry event. A plain boolean payload - there is nothing",
    "  // else to say about it.",
    "  void listen(\"win-session\", (ev) => {",
    "    state.windowMoving = ev.payload === true;",
    "  });",
  ].join("\n"),
  "preloadShell listens",
);
sub(
  SHELL,
  [
    "export function winFocused(): boolean {",
    "  return state.windowFocused;",
    "}",
  ].join("\n"),
  [
    "export function winFocused(): boolean {",
    "  return state.windowFocused;",
    "}",
    "",
    "/** Is the user moving or resizing the window right now? (P1.62e - see `ShellState.windowMoving`.)",
    " *  Synchronous, like `winFocused()`: it is a device fact the PLATFORM pushed, not a query. */",
    "export function winWindowMoving(): boolean {",
    "  return state.windowMoving;",
    "}",
  ].join("\n"),
  "winWindowMoving()",
);

// ===== 3. LOOP_STATE remembers a geometry change outside a world =====
sub(
  RESOURCES,
  [
    "  /** Until this wall-clock time, a window geometry change is OUR OWN switch and must not pause */",
    "  suppressGeometryUntil: number;",
    "}",
  ].join("\n"),
  [
    "  /** Until this wall-clock time, a window geometry change is OUR OWN switch and must not pause */",
    "  suppressGeometryUntil: number;",
    "  /** **A geometry change arrived while NO world was running** (the startup, or a world entry): the entry",
    "   *  driver starts PAUSED if it is set (P1.62e). While the loading screen is up there is nothing to pause,",
    "   *  so the pause has to be deferred to the moment the world is ready - and a window the user fiddled with",
    "   *  during the loading must not hand the mouse over behind their back. Reset by `enterWorld` itself. */",
    "  geometryDuringLoad: boolean;",
    "}",
  ].join("\n"),
  "the LoopState field",
);
sub(
  RESOURCES,
  [
    "    rendererReady: false,",
    "    suppressGeometryUntil: 0,",
    "  };",
  ].join("\n"),
  [
    "    rendererReady: false,",
    "    suppressGeometryUntil: 0,",
    "    geometryDuringLoad: false,",
    "  };",
  ].join("\n"),
  "the LoopState default",
);

// ===== 4. main.ts: remember it, and gate the entry on it =====
sub(
  MAIN,
  "-->, onWinGeometry, onCaptureLost,",
  "onWinGeometry, onCaptureLost,",
  "unused import probe",
).valueOf?.();
sub(
  MAIN,
  "winFocused, quitApp, onWinFocus, onWinBlur, onWinGeometry, onCaptureLost,",
  "winFocused, winWindowMoving, quitApp, onWinFocus, onWinBlur, onWinGeometry, onCaptureLost,",
  "the shell import",
);
sub(
  MAIN,
  [
    "onWinGeometry(() => {",
    "  if (performance.now() < loop.suppressGeometryUntil) return; // our own fullscreen/windowed switch",
    "  // NOT IN A WORLD: nothing is captured and there is nothing to pause, so do (and LOG) nothing. This used",
    "  // to run on every geometry event regardless of the mode, which meant hundreds of debug.log lines for one",
    "  // window drag at the main menu (and a pointless native-capture release per event).",
    "  if (!inWorld()) return;",
  ].join("\n"),
  [
    "onWinGeometry(() => {",
    "  if (performance.now() < loop.suppressGeometryUntil) return; // our own fullscreen/windowed switch",
    "  // NOT IN A WORLD: nothing is captured and there is nothing to pause, so do (and LOG) nothing. This used",
    "  // to run on every geometry event regardless of the mode, which meant hundreds of debug.log lines for one",
    "  // window drag at the main menu (and a pointless native-capture release per event).",
    "  // **BUT REMEMBER IT (P1.62e)**: a world ENTRY is exactly this state, and a window the user fiddled with",
    "  // while the loading screen was up must not hand the mouse over behind their back - the entry driver reads",
    "  // this flag and starts on the pause menu. (Our own mode switch returned above, so it never counts.)",
    "  if (!inWorld()) {",
    "    loop.geometryDuringLoad = true;",
    "    return;",
    "  }",
  ].join("\n"),
  "onWinGeometry remembers",
);
sub(
  MAIN,
  [
    "  // Entering a world **must be foregrounded** to capture. Switching to another app during the load",
    "  // would make this relock open native capture on a **background** window (the cursor clamped into that",
    "  // screen region while another app is over it; raw input is collected in the background too, so the",
    "  // view keeps turning; and the cursor is globally hidden) — and **no** blur event will come to rescue",
    "  // it, because focus was lost long ago. So the treatment is \"not foreground ⇒ pause\": into the pause",
    "  // menu at once, and on switching back onWinFocus sees a UI open and does not auto-capture (a menu",
    "  // does not auto-close, resume manually — the existing convention).",
    "  if (winFocused()) {",
    "    pointerLock.relock(\"world entered\");",
    "  } else {",
    "    menu.show();",
    "    logDebug(\"WORLD entered while not foreground -> pause menu (no capture)\");",
    "  }",
  ].join("\n"),
  [
    "  // **Entering a world must be a DELIBERATE \"give me the mouse\" moment.** Two things can make it wrong,",
    "  // and both end in the same place: no capture, and the pause menu.",
    "  //   * the window is not FOREGROUND: the relock would open native capture on a background window (the",
    "  //     cursor clamped into a screen region another app is over; raw input is collected in the background",
    "  //     too, so the view keeps turning; and the cursor is globally hidden) — and no blur event will come to",
    "  //     the rescue, because focus was lost long ago;",
    "  //   * the user has a HAND ON THE WINDOW (P1.62e): holding a title bar or a border produces NO geometry",
    "  //     event until it MOVES, so the game used to come up \"playing\" with a hand on the frame and pause only",
    "  //     on the first movement. `winWindowMoving()` is the platform's own view of that (pushed as",
    "  //     `win-session`), and `geometryDuringLoad` covers \"they fiddled with it at some point while it was",
    "  //     loading\" — where there was nothing to pause yet.",
    "  const moving = winWindowMoving();",
    "  const fiddled = loop.geometryDuringLoad;",
    "  if (winFocused() && !moving && !fiddled) {",
    "    pointerLock.relock(\"world entered\");",
    "  } else {",
    "    menu.show();",
    "    logDebug(",
    "      `WORLD entered while ${
    "        !winFocused()",
    "          ? \"not foreground\"",
    "          : moving",
    "            ? \"the window is being moved/resized\"",
    "            : \"the window was moved during loading\"",
    "      } -> pause menu (no capture)`,",
    "    );",
    "  }",
  ].join("\n"),
  "the entry gate",
);
sub(
  MAIN,
  "  const entryStart = performance.now();",
  [
    "  const entryStart = performance.now();",
    "  // The entry watches the window for fiddling of its own (P1.62e): a drag during the loading is remembered",
    "  // and makes this entry start on the pause menu instead of capturing behind the user's back.",
    "  loop.geometryDuringLoad = false;",
  ].join("\n"),
  "enterWorld resets the flag",
);
sub(
  MAIN,
  [
    "  // Capture only opens while foregrounded (native ClipCursor does not look at focus; the browser's",
    "  // requestPointerLock refuses on its own anyway).",
    "  focused: winFocused,",
  ].join("\n"),
  [
    "  // Capture only opens while foregrounded (native ClipCursor does not look at focus; the browser's",
    "  // requestPointerLock refuses on its own anyway).",
    "  focused: winFocused,",
    "  // …and not while the user is holding the window (P1.62e): a capture taken then would end on the first",
    "  // movement anyway (`onWinGeometry` pauses), so it is refused with a line saying why.",
    "  windowMoving: winWindowMoving,",
  ].join("\n"),
  "the pointerLock dep",
);

// ===== 5. pointerlock.ts: refuse a capture while the window is being moved =====
sub(
  PLOCK,
  [
    "  focused: () => boolean;",
    "  logDebug: (line: string) => void;",
  ].join("\n"),
  [
    "  focused: () => boolean;",
    "  /** **Is the user moving or resizing the window right now?** (`win-session`, P1.62e) A capture taken then is",
    "   *  taken out of a window the user is holding: it would end on the first movement anyway (main.ts's",
    "   *  `onWinGeometry` pauses), so the request is refused here — with a line saying why, instead of a capture",
    "   *  that silently appears and disappears. Read synchronously, like `focused`. */",
    "  windowMoving: () => boolean;",
    "  logDebug: (line: string) => void;",
  ].join("\n"),
  "PointerLockDeps.windowMoving",
);
sub(
  PLOCK,
  [
    "    if (!this.deps.focused()) {",
    "      this.deps.logDebug(`LOCK skipped [${source}]: window is not foreground`);",
    "      return;",
    "    }",
  ].join("\n"),
  [
    "    if (!this.deps.focused()) {",
    "      this.deps.logDebug(`LOCK skipped [${source}]: window is not foreground`);",
    "      return;",
    "    }",
    "    if (this.deps.windowMoving()) {",
    "      this.deps.logDebug(`LOCK skipped [${source}]: the window is being moved or resized`);",
    "      return;",
    "    }",
  ].join("\n"),
  "the attempt gate",
);

// ===== 6. win.rs: push the session flag =====
sub(
  WIN,
  [
    "/// Is the user moving or resizing the window right now? Read by `reclip_mouse_capture` and `reconcile`.",
    "fn clip_is_postponed() -> bool {",
  ].join("\n"),
  [
    "/// Is the user moving or resizing the window right now? Read by `reclip_mouse_capture` and `reconcile`, and",
    "/// PUSHED to the front end (`win-session`, P1.62e) - a held title-bar press produces no geometry event, so",
    "/// this is the only way the front end can know a hand is on the frame.",
    "pub fn clip_is_postponed() -> bool {",
  ].join("\n"),
  "clip_is_postponed is public",
);
sub(
  WIN,
  [
    "/// See `WM_ENTERSIZEMOVE`: true while the window is in a title-click / move / size session.",
    "static CLIP_POSTPONED: AtomicBool = AtomicBool::new(false);",
  ].join("\n"),
  [
    "/// See `WM_ENTERSIZEMOVE`: true while the window is in a title-click / move / size session.",
    "static CLIP_POSTPONED: AtomicBool = AtomicBool::new(false);",
    "",
    "/// The value last PUSHED to the front end (`win-session`), so the transition is emitted once (P1.62e).",
    "static SESSION_PUSHED: AtomicBool = AtomicBool::new(false);",
  ].join("\n"),
  "the pushed mirror",
);
sub(
  WIN,
  [
    "        let mut m = model();",
    "        // **THE USER IS MOVING OR RESIZING THE WINDOW (P1.62).** Hand the pointer back ONCE, then leave the",
  ].join("\n"),
  [
    "        let mut m = model();",
    "        // **PUSH THE WINDOW-SESSION FACT TO THE FRONT END (P1.62e).** A held title-bar press produces NO",
    "        // geometry event, so the front end cannot tell \"a hand is on the frame\" from \"the user is waiting\" -",
    "        // and a world entered in that state used to capture the mouse and pause only once the window moved.",
    "        // The flag itself is set inside the window procedure (which has no AppHandle), so the TRANSITION is",
    "        // noticed and emitted here, on the main thread, before the session branch below returns.",
    "        let moving = clip_is_postponed();",
    "        if moving != SESSION_PUSHED.load(Ordering::SeqCst) {",
    "            SESSION_PUSHED.store(moving, Ordering::SeqCst);",
    "            crate::boot_line(&handle, &format!(\"[cursor] window session moving={moving} [{}]\", trace_of(&m)));",
    "            let _ = tauri::Emitter::emit(&handle, \"win-session\", moving);",
    "        }",
    "        // **THE USER IS MOVING OR RESIZING THE WINDOW (P1.62).** Hand the pointer back ONCE, then leave the",
  ].join("\n"),
  "the session push",
);
sub(
  WIN,
  "        if m.want == 0 && !m.relative && m.arrow_guard == 0 {",
  "        if m.want == 0 && !m.relative && m.arrow_guard == 0 && !clip_is_postponed() {",
  "the sentinel's session clause",
);

// ===== 7. the gate =====
sub(
  "scripts/check-ecs.mjs",
  '  assert(/contains\\(clip, p\\.pos\\)/.test(modelSrc), "and no rule may exclude the pointer: moving it is what towed the window");',
  [
    '  assert(/contains\\(clip, p\\.pos\\)/.test(modelSrc), "and no rule may exclude the pointer: moving it is what towed the window");',
    "  // **P1.62e - A WINDOW THE USER IS HOLDING MUST NOT BE CAPTURED.** A held title-bar press produces NO",
    "  // geometry event, so the platform pushes the fact (`win-session`) and the front end reads it synchronously:",
    "  // the entry driver starts on the PAUSE MENU instead of capturing behind the user's back, and the lock",
    "  // manager refuses the request with a line saying why.",
    '  assert(/win-session/.test(winSrc) && /pub fn clip_is_postponed/.test(winSrc),',
    '    "the platform pushes the window-session fact");',
    '  assert(/export function winWindowMoving/.test(readSource("src/host/desktop/shell.ts")) &&',
    '      /winWindowMoving: winWindowMoving/.test(main),',
    '    "\\u2026read synchronously by the lock manager and the entry driver");',
    '  assert(/geometryDuringLoad/.test(main),',
    '    "\\u2026and a window fiddled with during the LOADING starts the world PAUSED (there is nothing to pause yet)");',
    '  assert(/the window is being moved or resized/.test(stripComments(readSource("src/host/browser/pointerlock.ts"))),',
    '    "\\u2026the refusal is logged, not silent");',
  ].join("\n"),
  "the P1.62e pins",
);

if (failures > 0) {
  console.error(`\n${failures} patch(es) FAILED.`);
  process.exit(1);
}
console.log("\nP1.62e patches applied");
