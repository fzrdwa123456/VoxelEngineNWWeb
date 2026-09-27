// ===== Player input system: the mouse-capture state machine + mouse/keyboard/bind capture =====
// An ECS system in the FIXED lane and the tick's FIRST act: the device events that arrived between two
// ticks become component data here, before anything that reads them runs.
//   CONTROL.keys   held bind codes (read by movement/interaction)
//   VIEW           accumulated view deltas (drained by the controller in the same tick)
//   MOTION/CONTROL jump + fly state, decided at press time by onJumpPress — but ONLY while the player
//                  is controllable (canControl)
//   INPUT_STATE    whether WE hold the mouse + raw-input availability (read by every gameplay system
//                  through canControl() — that is why this file is not imported by them)
//   KEY_EVENTS     key EDGES, published at event time and consumed by the ui systems that own a global
//                  chord (ui.picker's F3+F4) — a held-key set cannot say "F3 went down just now"
//   INPUT_TIMING   the race guards' own state (which mouse event is the synthetic capture-instant one,
//                  the grace deadline): the fields that make this file race-sensitive, in a resource so
//                  a test and a log can see them
//
// The DOM listeners below are PRODUCERS: they take every decision at EVENT time — which key, which
// view delta, which jump branch, and all of the race guards — exactly where they were when the writes
// were immediate, and queue the resulting INTENT. step() drains that queue into the components. The
// hand-off buys two things and changes neither the timing nor the order of any guard (iron rule 3):
//   * a gameplay component is written inside a system run only, between the scheduler's structural
//     checks, by a system with a DECLARED access set — input is no longer the one exception;
//   * the schedule can order it against the controller/movement/collision that consume it.
// INPUT_STATE stays event-time on purpose: the capture state machine has to react SYNCHRONOUSLY to a
// capture/release (a flag that lands a tick late is a bug, not a refactor), and that
// resource belongs to the device layer. What it does NOT hold is "may a click grab the mouse": that is
// `!isModalUi(UI_MODAL)`, asked at the moment of the question instead of cached on the device state.
//
// Race-sensitive logic (skipFirstMove / lockGrace / the raw-input takeover) moved here
// verbatim from the old shell — do not "simplify" without replaying those races. Its STATE
// is the INPUT_TIMING resource now (a change of where the fields live, not of when they are read or
// written); the logic itself is untouched.
//
// ===== Mouse capture is OURS, and it is the ONLY path (P1.72) =====
// `state.locked` does not mean "the browser granted pointer lock" — it means "**we captured the mouse**"
// (Rust side: ClipCursor + SetCursor(NULL), see the note in platform/mousecapture.ts), with the view
// turns coming from raw input (WM_INPUT).
//
// **There is no fallback to the Pointer Lock API any more, and that is the Minecraft model**: MC never
// touches the OS cursor while it holds the mouse (`SDL_SetWindowRelativeMouseMode` is its whole
// mechanism: hidden + constrained + raw deltas), never re-derives the grab from window/focus state, and
// has exactly ONE place that grabs and releases (`Gui.setScreen`). The browser's own path was the source
// of every special case we kept paying for: ESC force-unlocks it (a browser security policy — the page
// cannot prevent it), relocking is refused for a while afterwards (`kUserEscapeCooldown` in
// `pointer_lock_controller.cc`), a lost focus unlocks it by itself, the page needs a fresh user gesture to
// re-lock, and on unlock the cursor is put back where it was when the lock was entered — i.e. the "the
// menu's cursor lands on the crosshair" behaviour this engine wants is IMPOSSIBLE there. So a failed
// capture now fails LOUDLY and leaves the mouse free; it does not silently change mechanism.
/** The native mouse-capture pair, INJECTED rather than imported: a plugin may not reach into `host/`
 *  (the layer rule enforced by check:ecs), and engaging/dropping the native capture is a platform
 *  operation. The composition root hands in `host/browser/mousecapture`'s pair. */
export interface MouseCapture {
  capture(dom: HTMLElement): Promise<void>;
  release(): void;
}
/** Default so a drive-by test can construct this system without a platform. */
const NO_MOUSE: MouseCapture = { capture: async () => {}, release: () => {} };
import { buttonToAction, buttonToCode, getBind, isCapturing } from "../../input/keybinds";
import {
  BODY,
  CONTROL,
  MOTION,
  ORIENTATION,
  POSITION,
  VIEW,
  type ControlC,
  type MotionC,
} from "../components";
import { RENDERER3D } from "../../../data/globals/gfx";
import {
  canControl,
  INPUT_DIAGNOSTICS,
  INPUT_INTENTS,
  INPUT_STATE,
  INPUT_TIMING,
  isModalUi,
  KEY_EVENTS,
  LOCAL_PLAYER,
  POINTER,
  publishKeyEdge,
  UI_MODAL,
  type InputDiagnostics,
  type InputIntent,
  type InputIntentLog,
  type InputState,
  type InputTiming,
  type KeyEventLog,
  type PointerState,
  type UiModalState,
} from "../../../data/globals/resources";
import { entityIndex, type World } from "../../../core/world";

const DOUBLE_TAP_MS = 250;
/** Protection window at lock instant (ms): pairs with skipFirstMove, covering synthetic deltas fired over multiple frames after pointer lock
 *  (swallowing only the first frame is not enough — Chromium/Windows "teleport" the cursor to the lock point, producing large deltas in a burst) */
const LOCK_GRACE_MS = 50;
/** Per-frame mouse delta cap (px): anything larger is treated as a synthetic spike and dropped (safety net).
 *  centerCursor (SetCursorPos) teleporting the cursor produces hundreds to thousands of px of fake relative movement;
 *  no real 8ms game movement reaches that magnitude, so the threshold is set high and only blocks teleports. */
const MAX_MOVE_DELTA = 1000;

/** What the DOM/device layer hands the fixed lane. A decision that is already made: the handlers below
 *  compute the value and queue it, so step() writes it without re-deciding anything (the guard timing
 *  must not move — iron rule 3). The union itself lives in ecs/resources.ts with the INPUT_INTENTS log
 *  that holds them. */

/** What this system touches, for the schedule (spread into its registration in main.ts).
 *  WRITES: the held-key set, the accumulated look deltas the controller drains, and the jump/fly state.
 *  READS: the state each press decides against — and ORIENTATION/POSITION/BODY, which the
 *  mouse/SPACE logs print. Those are written by the systems that FOLLOW this one, so the edge below is
 *  a real read-after-write, not a formality.
 *  EXTERNAL: the pointer lock and the window geometry the takeover arbitration asks about, the bind
 *  table it reads ("is this key the jump bind"), plus the
 *  things it publishes that the ECS does not model — INPUT_STATE (a resource of the device layer, also
 *  written by platform/pointerlock.ts), the race guards' INPUT_TIMING, and the F3 input queues
 *  diagnostics forwards. */
export const INPUT_ACCESS = {
  reads: [CONTROL, MOTION, POSITION, BODY, ORIENTATION],
  writes: [CONTROL, VIEW, MOTION],
  readsExternal: ["pointerLock", "windowGeometry", "keybinds"],
  writesExternal: ["inputState", "inputTiming", "inputDiagnosticQueues", "keyEvents"],
} as const;

/** Player input system: captures pointer lock, mouse, keyboard and mouse-button binds.
 *  Registered in the FIXED lane (main.ts) with INPUT_ACCESS above; `step()` is what the lane calls. */
export class PlayerInputSystem {
  /** The SPACE/MOUSE diagnostic logs. They are the INPUT_DIAGNOSTICS resource (ecs/resources.ts) — the
   *  device layer writes them, diagnostics forwards and prints them — so this system owns no array of its
   *  own; `this.diag.spaceLog` / `this.diag.mouseLog` are the two readers' single source. */
  private readonly diag: InputDiagnostics;
  /** The pointer's last known position/buttons (POINTER, ecs/resources.ts): published here at event time
   *  for the consumers that follow the cursor, so no second mousemove listener exists anywhere. */
  private readonly pointer: PointerState;

  // Component/resource access (resolved in the constructor BODY, not field initializers: native
  // class fields run before parameter properties are assigned, so this.world would be undefined
  // there). Resolved HERE rather than at start() because the DOM listeners below are attached in
  // this same body and may fire before a later initialisation pass would run.
  private readonly state: InputState;
  /** The modal-UI flags the control gate reads (same predicate every gameplay system uses) */
  private readonly ui: UiModalState;
  /** The key EDGE log the ui lane consumes (ui.picker owns the F3+F4 chord) */
  private readonly keyEdges: KeyEventLog;
  private readonly index: number;
  /** CONTROL/MOTION are RECORD components: their identity is stable while attached (iron rule 1) */
  private readonly control: ControlC;
  private readonly motion: MotionC;

  /** The canvas the pointer-lock listeners belong to. It IS the renderer's `domElement`, resolved from
   *  RENDERER3D (ecs/presentation.ts): "the element the pointer is locked to" and "the element the GPU
   *  draws into" are the same object, and two wiring paths for it could drift. */
  private readonly dom: HTMLElement;
  private readonly log: (line: string) => void;
  private readonly sensitivity = 0.002;
  /** The DEVICE-TIMING state (INPUT_TIMING, ecs/resources.ts): which mouse event is the synthetic one at
   *  capture instant, how long the grace window runs, and the diagnostic counters. It is world state now —
   *  one home, readable by a test and by the gate — while the DECISIONS stay exactly where they were: the
   *  listeners still decide at event time and only queue. Moving these fields moved no line of that logic;
   *  if a change ever does, iron rule 3 says replay the races first. */
  private readonly timing: InputTiming;
  /** The queue of decisions waiting for `step()`. It IS the INPUT_INTENTS resource (ecs/resources.ts):
   *  the array lives in the world, this system is its only writer and its only reader, and the accessor
   *  below keeps every use site reading like a local field. */
  private readonly intents: InputIntentLog;

  // ===== The LOOK / RAWLAG diagnostics live in the INPUT_DIAGNOSTICS resource =====
  // They used to be private fields here (and the raw-transport ones module state in
  // platform/rawinput.ts). They are all **readings**: they take part in no decision — how many raw
  // deltas arrived this second, how many made it into the queue, which guard dropped each of the rest,
  // how many key edges of each kind arrived, the queue length at the sampling instant, and the
  // per-frame meter the FRAME probe reads. This system writes them and prints both lines once a second;
  // the device layer writes the raw-transport half. Declared in ecs/resources.ts.
  /** Raw displacement (pixels) that passed every guard and waits for this frame's single `frameLook()`
   *  application. The decisions are made in `rawDelta()`; this only accumulates what got through. The
   *  ACCUMULATOR is `INPUT_INTENTS.frameDx/frameDy` (ecs/resources.ts) — pending input is world data, and
   *  these accessors are the only members left here. */
  private get rawFrameDx(): number {
    return this.intents.frameDx;
  }
  private set rawFrameDx(v: number) {
    this.intents.frameDx = v;
  }
  private get rawFrameDy(): number {
    return this.intents.frameDy;
  }
  private set rawFrameDy(v: number) {
    this.intents.frameDy = v;
  }

  /** The pending intents (the resource's array — read in place, never copied) */
  private get pending(): InputIntent[] {
    return this.intents.intents;
  }

  constructor(
    private readonly world: World,
    log: (line: string) => void = () => {},
    /** Is a world RUNNING? Asked by the click-to-capture path only. A capture engaged before a world
     *  exists (a click on the loading screen — which owns no modal flag, so the UI_MODAL guard below let it
     *  through) is how the reported bug started: entering the world then re-locks on top of it while the
     *  user was still mid-interaction with the window. Defaults to true so a drive-by test behaves as
     *  before. */
    private readonly inWorld: () => boolean = () => true,
    /** The native capture pair (see MouseCapture): resolved here, never imported from `host/`. */
    private readonly mouse: MouseCapture = NO_MOUSE,
  ) {
    const player = this.world.resource(LOCAL_PLAYER);
    this.state = this.world.resource(INPUT_STATE);
    this.ui = this.world.resource(UI_MODAL);
    this.keyEdges = this.world.resource(KEY_EVENTS);
    this.timing = this.world.resource(INPUT_TIMING);
    this.diag = this.world.resource(INPUT_DIAGNOSTICS);
    this.intents = this.world.resource(INPUT_INTENTS);
    this.pointer = this.world.resource(POINTER);
    this.index = entityIndex(player);
    this.control = this.world.get(player, CONTROL)!;
    this.motion = this.world.get(player, MOTION)!;
    this.dom = this.world.resource(RENDERER3D).domElement;
    this.log = log;

    this.dom.addEventListener("click", () => {
      // Grab the mouse ONLY when we do not already hold it. This is deliberate and load-bearing:
      // re-requesting a capture on every click re-arms the grace window below, and that DISCARDS every
      // delta for LOCK_GRACE_MS — a visible freeze of mouse look right after each click.
      // (It used to matter for a second reason too: re-requesting a POINTER LOCK on the already-locked
      // element was a known Chromium bug path, issue 40122995 "we have a bug". That path is gone.)
      if (isModalUi(this.ui) || this.state.locked) return;
      // …and nothing may capture the mouse before a WORLD exists. The loading screen is not a modal
      // surface, so this guard let a click there engage the native capture; the world entry then re-locked
      // on top of a capture that was already live (see the injection comment above).
      if (!this.inWorld()) return;
      this.log("LOCK click grab");
      const pending = this.lock();
      // Never leave this promise unhandled: a rejection used to surface as an unhandled rejection
      // and get written to the log by the window-level handler.
      if (pending) pending.catch((err) => this.log(`LOCK click grab rejected: ${String(err)}`));
    });
    document.addEventListener("mousemove", (ev) => {
      // The POINTER resource first, BEFORE any guard below returns: this is the device layer's record of
      // where the cursor is, and consumers (the key bind drag's hover target and rubber band) read it
      // instead of listening for mousemove themselves. It is deliberately independent of the lock state:
      // a menu drag happens with the pointer free.
      this.pointer.x = ev.clientX;
      this.pointer.y = ev.clientY;
      this.pointer.buttons = ev.buttons;
      if (this.state.locked) {
        // --- Captured: the view comes from raw input (see `rawInputShouldTakeOver`) ---
        // While raw is the source, `movementX` is ignored outright: it is derived from the cursor, which our
        // own clip stops at the client edge, so accepting both would double count and would freeze at the edge.
        // **This branch is unreachable by construction since P1.72** (`lock()` refuses a capture without the
        // raw listener, and a modal UI blocks the takeover), but it is kept as the defence in depth it always
        // was: it is the only thing that would stop a future change from double counting, and iron rule 3 says
        // the guards below are not to be deleted on a reading.
        const takeOver = this.rawInputShouldTakeOver();
        this.syncRawTakeoverLog(takeOver);
        if (takeOver) return;
        if (performance.now() < this.timing.lockGraceUntil) {
          this.diag.look.mmGrace++;
          return;
        }
        if (this.timing.skipFirstMove) {
          this.timing.skipFirstMove = false;
          this.diag.look.mmSkip++;
          return;
        }
        // Synthetic spike guard (pointer lock / SetCursorPos race): normal movement never reaches this magnitude
        if (Math.abs(ev.movementX) > MAX_MOVE_DELTA || Math.abs(ev.movementY) > MAX_MOVE_DELTA) {
          this.diag.look.mmSpike++;
          return;
        }
        // Accumulate view deltas; yaw/pitch semantics are applied by the controller at the fixed step.
        // The scale is applied HERE, at event time, so step() only adds the number (see the header).
        this.pending.push({
          kind: "look",
          yaw: -ev.movementX * this.sensitivity,
          pitch: -ev.movementY * this.sensitivity,
        });
        const now = performance.now();
        if (now - this.timing.lastMouseLog >= 100) {
          this.timing.lastMouseLog = now;
          this.diag.mouseLog.unshift(
            `MOUSE#${this.timing.mouseSeq++} mmX=${ev.movementX.toFixed(1)} mmY=${ev.movementY.toFixed(1)} ` +
              `pitch=${ORIENTATION.pitch[this.index].toFixed(6)}`,
          );
          if (this.diag.mouseLog.length > 10) this.diag.mouseLog.pop();
        }
      }
    });
    document.addEventListener("keydown", (ev) => this.onKeyDown(ev));
    document.addEventListener("keyup", (ev) => {
      this.diag.look.keyUps++;
      this.publishEdge(ev.code, false, false);
      this.queueKey(ev.code, false);
    });
    // Mouse buttons that carry a BIND belong to the device layer too (only this file may listen). They
    // publish an EDGE for the systems that care — the "inventory" bind is read by ui.navigation — and
    // feed the held set through the same queue the keyboard uses.
    document.addEventListener("mousedown", (ev) => {
      this.pointer.buttons = ev.buttons;
      if (isCapturing()) return; // No accidental triggers while a rebind capture is active
      const action = buttonToAction(ev.button);
      if (!action) return;
      const code = buttonToCode(ev.button);
      if (!code) return;
      this.publishEdge(code, true, false);
      if (action === "inventory") return; // A toggle with no held state: the edge is the whole signal
      this.bindPress(code);
    });
    document.addEventListener("mouseup", (ev) => {
      this.pointer.buttons = ev.buttons;
      const action = buttonToAction(ev.button);
      const code = buttonToCode(ev.button);
      if (!code || !action || action === "inventory") return;
      // break/place MUST be released: otherwise the button stays in CONTROL.keys forever and block
      // interaction would keep repeating after a single click.
      this.publishEdge(code, false, false);
      this.bindRelease(code);
    });
  }

  /** The fixed lane's entry point (registered FIRST: it is the tick's first act). Turns the intents the
   *  device layer decided into component writes — the only place this file writes a gameplay component.
   *  Draining in place costs no allocation: the loop below cannot queue anything (a DOM event cannot
   *  fire while a system runs — single main thread, iron rule 4). */
  step(): void {
    const queue = this.pending;
    this.logLook();
    if (queue.length === 0) return;
    for (const intent of queue) {
      switch (intent.kind) {
        case "key":
          if (intent.down) this.control.keys.add(intent.code);
          else this.control.keys.delete(intent.code);
          break;
        case "look":
          VIEW.yawDelta[this.index] += intent.yaw;
          VIEW.pitchDelta[this.index] += intent.pitch;
          this.diag.look.frameSamples++;
          this.diag.look.framePx += Math.hypot(intent.yaw, intent.pitch) / this.sensitivity;
          break;
        case "motion":
          this.control.flying = intent.flying;
          this.motion.vy = intent.vy;
          this.motion.onGround = intent.onGround;
          break;
      }
    }
    queue.length = 0;
  }

  /** The per-frame meter (the FRAME line reads it once per frame, and reading clears it): `samples` =
   *  how many `look` samples were taken from the mouse this frame, `px` = how much mouse movement in
   *  pixel equivalents those samples total.
   *
   *  Why it exists: a `LOOK` line aggregates per second, and "the samples per frame are uneven" (an
   *  8 ms pull ≈ 1.67 per frame → a 2,2,1 pattern) is invisible in a per-second number — yet it is the
   *  prime suspect behind "turning comes in steps when you spin fast". This pair turns it into a
   *  histogram. */
  takeLookFrameMeter(): { samples: number; px: number } {
    const out = { samples: this.diag.look.frameSamples, px: this.diag.look.framePx };
    this.diag.look.frameSamples = 0;
    this.diag.look.framePx = 0;
    return out;
  }

  /** Queue a held-key transition (keyboard, or a mouse-button bind injected from main.ts) */
  private queueKey(code: string, down: boolean): void {
    this.pending.push({ kind: "key", code, down });
  }

  /** One `LOOK` line per second: "what happened to the mouse input this second" as numbers (see the
   *  counters above). `raw` = how many deltas arrived from the raw-input channel (Rust pushes one
   *  every 4 ms); `app` = how many times one was pushed into the intent queue (after the move to once
   *  per frame this ≈ "frames with displacement per second"); `dTO` (takeover off) / `dG` (post-lock
   *  grace window) / `dS` (spike guard) = the three drop counters; `mmSkip`/`mmG`/`mmS` = the matching
   *  drops on the browser mousemove path; `key` = this second's keydown/keydown-repeat/keyup counts
   *  (holding a key should be ≈1/30/1); `pend`/`yaw`/`pitch` = at the sampling instant, the queue
   *  length the fixed step has not consumed yet and the view delta still waiting to be applied.
   *
   *  The same flush prints `RAWLAG`, which the DEVICE layer fills in (the arrival rhythm and the queue
   *  backlog of the raw-input events) — one window, two writers, one printer. */
  private logLook(): void {
    const now = performance.now();
    const look = this.diag.look;
    const raw = this.diag.raw;
    if (look.logAt === 0) {
      look.logAt = now;
      return;
    }
    if (now - look.logAt < 1000) return;
    look.logAt = now;
    this.log(
      `LOOK raw=${look.raw} app=${look.applied} dTO=${look.dropTakeover} dG=${look.dropGrace} ` +
        `dS=${look.dropSpike} mmSkip=${look.mmSkip} mmG=${look.mmGrace} mmS=${look.mmSpike} ` +
        `key=${look.keyDowns}/${look.keyRepeats}/${look.keyUps} pend=${this.pending.length} ` +
        `yaw=${VIEW.yawDelta[this.index].toFixed(4)} pitch=${VIEW.pitchDelta[this.index].toFixed(4)}`,
    );
    this.log(
      `RAWLAG ev=${raw.evCount}/s gapMax=${raw.gapMax.toFixed(1)}ms ` +
        `backlogAvg=${(raw.evCount > 0 ? raw.backlogSum / raw.evCount : 0).toFixed(2)}ms ` +
        `backlogMax=${raw.backlogMax.toFixed(1)}ms`,
    );
    look.raw = 0;
    look.applied = 0;
    look.dropTakeover = 0;
    look.dropGrace = 0;
    look.dropSpike = 0;
    look.mmSkip = 0;
    look.mmGrace = 0;
    look.mmSpike = 0;
    look.keyDowns = 0;
    look.keyRepeats = 0;
    look.keyUps = 0;
    raw.evCount = 0;
    raw.gapMax = 0;
    raw.backlogSum = 0;
    raw.backlogMax = 0;
  }

  /** Is `code` held right now, counting the intents this frame has not drained yet?
   *  bindPress() must not re-trigger jump semantics for a key whose press is still queued. */
  private keyHeld(code: string): boolean {
    let held = this.control.keys.has(code);
    for (const intent of this.pending) {
      if (intent.kind === "key" && intent.code === code) held = intent.down;
    }
    return held;
  }

  /** CONTROL/MOTION as the queue would leave them. onJumpPress READS that state and WRITES it in the
   *  same breath, so a second press inside one frame (a key plus a mouse bind) has to see the first
   *  one — exactly as it did while the writes were immediate. */
  private stagedMotion(): { flying: boolean; vy: number; onGround: boolean } {
    let flying = this.control.flying;
    let vy = this.motion.vy;
    let onGround = this.motion.onGround;
    for (const intent of this.pending) {
      if (intent.kind === "motion") {
        flying = intent.flying;
        vy = intent.vy;
        onGround = intent.onGround;
      }
    }
    return { flying, vy, onGround };
  }

  /** Whether clicking the canvas may grab the lock: no modal UI owns the mouse. Derived from UI_MODAL
   *  at the moment of the question instead of read from a cached copy on the input state — the cache
   *  was a second owner of the same fact, kept in sync by platform/pointerlock.ts. */
  get clickLockAllowed(): boolean {
    return !isModalUi(this.ui);
  }

  /** Whether WE currently hold the mouse (the native capture) */
  get locked(): boolean {
    return this.state.locked;
  }

  /** Raw-input plugin availability (set true after main.ts init succeeds): free-mouse mode switches to WM_INPUT deltas */
  get rawInputActive(): boolean {
    return this.state.rawInputActive;
  }
  set rawInputActive(active: boolean) {
    this.state.rawInputActive = active;
  }

  /** Called immediately BEFORE we release the mouse on purpose (open the pause menu, open the inventory,
   *  lose window focus): arm the grace window that swallows the synthetic deltas of the SetCursorPos race
   *  while still captured. It used to do two more things — drop free-mouse mode at once and record that
   *  "this unlock was OURS" — and both existed only because the browser could have cancelled a pointer
   *  lock behind our back. There is no second owner of the mouse left to be mistaken for (P1.72). */
  prepareUnlock(): void {
    this.timing.lockGraceUntil = performance.now() + 100;
  }

  /** Raw mouse deltas (WM_INPUT). Called ONCE PER ARRIVAL by `platform/rawinput.ts`'s event listener
   *  (~4 ms, the Rust push cadence) — not by a timer any more: see `frameLook()` for why.
   *
   *  EVERY DECISION STAYS HERE, at arrival time, with the same order and the same thresholds as the
   *  8 ms poll it replaced (iron rule 3): takeover, then the lock-grace window, then the spike guard.
   *  Only what PASSES is accumulated; the frame applies the total later.
   *
   *  Takeover rule: raw listener available + no menu/inventory + we hold the mouse. While captured, the
   *  clip stops the cursor at the client edge, so a delta derived from its position would freeze there —
   *  which is exactly the job raw input fills in. Menu state discards (no modal UI owns the mouse). */
  rawDelta(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.diag.look.raw++;
    const takeOver = this.rawInputShouldTakeOver();
    this.syncRawTakeoverLog(takeOver);
    if (!takeOver) {
      this.diag.look.dropTakeover++;
      return;
    }
    // Spike protection matching the mousemove path (previously missing): centerCursor's SetCursorPos teleport feeds
    // huge fake deltas through WM_INPUT; without these two guards that is the direct cause of "view snaps to another angle"
    if (performance.now() < this.timing.lockGraceUntil) {
      this.diag.look.dropGrace++;
      return;
    }
    if (Math.abs(dx) > MAX_MOVE_DELTA || Math.abs(dy) > MAX_MOVE_DELTA) {
      this.diag.look.dropSpike++;
      return;
    }
    // Accepted: accumulate for this frame's ONE look intent (the guards above already had their say,
    // which is what keeps the spike threshold per DELTA and not per frame — a fast flick may exceed
    // 1000 px in a frame and must not be thrown away).
    this.rawFrameDx += dx;
    this.rawFrameDy += dy;
  }

  /** Once per frame, at the head of the frame (before the fixed steps), called by `main.ts`'s frame():
   *  queue this frame's displacement as **one** `look` intent.
   *
   *  **Why this is no longer an 8 ms timer.** The view delta used to be taken out of the accumulator
   *  every 8 ms by `setInterval(…, 8)`, so "how many samples land in each frame" depended on the phase
   *  between that timer and the frame rate (16.67 ms): nominally 1.67 per frame, in practice a 2/2/1
   *  pattern. Worse, **Chromium schedules input tasks such as keydown/keyup ahead of timer tasks**, so
   *  the moment a key is held (auto-repeat ~30/s) that timer is squeezed into a 9~12 ms band: probe
   *  measurements gave **122~127 per second with no key held, and exactly 2 samples in 90% of frames;
   *  with a key held it drops to 84~110 per second and the per-frame count jumps around between
   *  0/1/2/3 (only ~40% of frames have 2)** — the turn per frame therefore varies by up to 3x, which
   *  the eye reads as "turning while holding a key is not smooth".
   *
   *  Taking it once per frame changes that: **a frame's turn = the mouse displacement really received
   *  in that frame**, entirely independent of whatever else is happening on the main thread (keys, the
   *  IME, logging, GC), and the 0/1/2/3 jumps are gone. Every decision is still made in `rawDelta()`
   *  (event time), so none of rule 3's takeover/grace/spike timing moved. */
  frameLook(): void {
    if (!this.inWorld()) {
      // No world, no view: a buffer must never cross the "entering the world" instant (the capture may
      // already be engaged at entry, and load mode runs no fixed steps, so the accumulated
      // displacement would be flung out in one go on the first frame — a single view jump).
      this.rawFrameDx = 0;
      this.rawFrameDy = 0;
      return;
    }
    if (this.rawFrameDx === 0 && this.rawFrameDy === 0) return;
    const dx = this.rawFrameDx;
    const dy = this.rawFrameDy;
    this.rawFrameDx = 0;
    this.rawFrameDy = 0;
    this.diag.look.applied++;
    this.pending.push({ kind: "look", yaw: -dx * this.sensitivity, pitch: -dy * this.sensitivity });
  }

  /** **Grab the mouse — the ONE way in (P1.72).** The native capture (Win32 `ClipCursor` + a hidden
   *  cursor) plus raw input for the view; the Pointer Lock API is not touched from anywhere in the engine
   *  any more, so none of the browser's policies apply: no ESC unlock gesture, no cooldown after an unlock,
   *  no lost-focus unlock we did not ask for, and no "the cursor goes back where it was when you locked".
   *
   *  **Requires raw input.** A capture without it would hide and clip the cursor for a view that cannot
   *  turn (deltas would have to come from `mousemove`, which the clip stops at the window edge) — so a
   *  missing listener is a LOUD no-op and the mouse stays free, instead of silently switching mechanism
   *  the way the old `requestPointerLock` fallback did. Diagnose with the F3 panel's `RAWINPUT` state or
   *  the boot.log line the composition root writes when the listener starts.
   *
   *  There is no browser event to wait for, so the "just captured" bookkeeping (skipFirstMove + the grace
   *  window) is armed here, after the native call resolves. */
  lock(): Promise<void> | undefined {
    if (!this.state.rawInputActive) {
      this.log("MOUSE CAPTURE refused: raw input is not running (there is no other source of view deltas)");
      return undefined;
    }
    const pending = this.mouse.capture(this.dom);
    // Record only on success: a failed capture leaves the mouse free, and the caller's `.catch` reports it.
    pending.then(() => this.onCaptured()).catch(() => {});
    return pending;
  }

  /** Record "the mouse is captured now": the state flag plus the two race guards that swallow the
   *  synthetic deltas of the capture-time warp. */
  private onCaptured(): void {
    this.state.locked = true;
    this.timing.skipFirstMove = true;
    this.timing.lockGraceUntil = performance.now() + LOCK_GRACE_MS;
    this.log("MOUSE CAPTURE on (native ClipCursor; browser pointer lock not used)");
  }

  /** Release the mouse (opening a menu / losing focus / leaving the world): called right after
   *  prepareUnlock(). There is no browser unlock to wait for either — the state is settled here. */
  releaseCapture(): void {
    // **IDEMPOTENT (P1.58).** This used to invoke the native release unconditionally, and its callers fire
    // per DEVICE event - `onWinGeometry` runs on every pixel of a window drag - so one boot.log held 30+
    // `[cursor] capture on=false` round-trips for a single title-bar drag, every one of them a main-thread
    // ClipCursor + SetCursor pass. Releasing something we do not hold is not a state change.
    if (!this.state.locked) return;
    this.log("MOUSE CAPTURE off (native ClipCursor released)");
    this.state.locked = false;
    this.mouse.release();
  }

  /** Bind-code injection from non-keyboard event sources (mouse buttons etc.): press */
  bindPress(code: string): void {
    if (this.keyHeld(code)) return; // Already held; prevents re-triggering jump semantics
    this.queueKey(code, true);
    if (code === getBind("jump")) this.onJumpPress(false);
  }

  /** Bind-code injection from non-keyboard event sources: release */
  bindRelease(code: string): void {
    this.queueKey(code, false);
  }

  /** **Whether raw input is the source of the view right now: it is, whenever we hold the mouse (P1.72).**
   *
   *  During the native capture (ClipCursor) it MUST be: the cursor is clamped inside the client area, stops
   *  moving at its edge, and a delta derived from its position would go to zero exactly there — Minecraft
   *  has the same rule by construction (`SDL_SetWindowRelativeMouseMode`, i.e. raw HID, is its entire
   *  mechanism). WM_INPUT deltas are unaffected by clamping, and `RIDEV_INPUTSINK` delivers them to our
   *  hidden message window regardless of the pointer's position or the window's shape.
   *
   *  The `movementX` path below therefore keeps working only for the free cursor — menus, the loading screen
   *  — and, because nothing accumulates it while we are not captured (`mousemove`'s look branch requires
   *  `locked`), the two sources can never double count. The old third case (`window partially offscreen and
   *  NOT captured`, a workaround for a pointer lock Chromium had cancelled by itself) is gone with the
   *  browser path. */
  private rawInputShouldTakeOver(): boolean {
    return this.state.rawInputActive && this.clickLockAllowed && this.state.locked;
  }

  /** Log one line when the takeover mode switches (for diagnosis) */
  private syncRawTakeoverLog(active: boolean): void {
    if (active !== this.timing.rawTakeoverActive) {
      this.timing.rawTakeoverActive = active;
      this.log(active ? "RAWINPUT takeover (movementX suspended)" : "RAWINPUT hands back to movementX");
    }
  }

  private onKeyDown(ev: KeyboardEvent): void {
    // TAB is the ONE key that can hand the keyboard focus OUT of the page: Chromium's focus traversal walks
    // off the end of the tab order, the window deactivates for a few milliseconds, and our "lost the window
    // → pause" handler fires (the log shows `KBCAP keydown code=Tab` → `WINFOCUS blur` → `blur -> pause
    // menu` → `WINFOCUS focus` 1ms later). While the game OWNS the mouse there is nothing to tab to anyway,
    // so the default action is cancelled — in the menus (not captured) TAB keeps working normally.
    //
    // CANCEL THE DEFAULT, DO NOT SWALLOW THE KEY. The first version of this fix ALSO returned here, and that
    // silently made TAB UNBINDABLE in a world: the panel accepts Tab as a bind (platform/keybinds.ts maps
    // it), but the key never reached `queueKey`/`publishEdge` below, so the bound action did nothing. The
    // `preventDefault()` is the whole fix for the blur — the rest of the handler must run for TAB exactly
    // as it does for every other key.
    if (ev.code === "Tab" && this.state.locked) ev.preventDefault();
    // A REBIND CAPTURE OWNS ESC. The key bind panel's capture handler unbinds the action on ESC
    // (platform/bind-gesture.ts), but it is installed LATER than this listener — the gesture's device
    // listeners are mounted by `bindKeybindDrag()` in main.ts, while this one belongs to the input
    // system's constructor — so its `stopImmediatePropagation()` cannot take an EDGE back out of the
    // KEY_EVENTS log. `ui.navigation` therefore read the same Escape and ALSO walked one level back
    // through the menu ladder: ESC unbound the action AND left the panel. The NW.js build installed the
    // capture handler at IMPORT time (module-level `ui/menu.ts`), i.e. BEFORE this listener, and relied
    // on exactly that suppression; the Tauri port's relocation into the device layer inverted the order.
    //
    // GATED HERE, IN THE EVENT, because this is the only moment where the answer is still true: the
    // capture handler calls `endCapture()` synchronously, so by the time the ui lane drains the log a
    // `capturing()` test inside `ui.navigation` would already read false (the drag path can test it
    // there, because the drag is cleared BY that system).
    //
    // ONLY ESC: every other key must keep reaching the edge log and the queue, because the systems that
    // consume global keys gate on `capturing()` themselves (ui.navigation's inventory/digit branches) and
    // TAB must stay BINDABLE — a capture that swallows its key would make Tab unassignable again.
    if (ev.code === "Escape" && isCapturing()) return;
    if (ev.repeat) this.diag.look.keyRepeats++;
    else this.diag.look.keyDowns++;
    this.publishEdge(ev.code, true, ev.repeat);
    this.queueKey(ev.code, true);
    if (ev.code === getBind("jump")) {
      this.onJumpPress(ev.repeat);
    }
  }

  /** Publish a key EDGE for the systems that own a global key chord (ui.picker): the held-key set
   *  cannot say "F3 went down just now", and only this file may listen to the DOM. Event time, next to
   *  the decision it belongs to — the queue below is for the fixed lane, this is for the ui lane, which
   *  also runs while the game loop is stopped (the main menu is where F3/F4 must still work). */
  private publishEdge(code: string, down: boolean, repeat: boolean): void {
    publishKeyEdge(this.keyEdges, { code, down, repeat });
  }

  /** Jump key press semantics (shared by keyboard keydown and mouse injection): double-tap toggles fly / ground jump.
   *
   *  GATED on canControl() — the same predicate movement/controller/interaction use. Space is the ONE
   *  input that writes state through the intent queue instead of the held-keys set, so a press
   *  while a modal UI owns the input (backpack, pause menu) used to queue `vy = 7.5`, or flip `flying`
   *  on a double tap, and the player launched the instant that UI closed. Nothing else could swallow
   *  it: the keypress does not depend on the game loop, and `movement` only drops the keys afterwards —
   *  it still integrates the body, so a queued `vy` surfaced the instant the UI closed.
   *  Held keys are deliberately NOT gated here — that set is state, and every consumer of it already
   *  gates per entity (iron rule: a gate that applies to ONE entity is data, not an early return).
   *
   *  The branch is decided HERE and only the resulting values are queued (step() writes them), so the
   *  gate, the double-tap window and the log line all still run at press time, in this order. */
  private onJumpPress(repeat: boolean): void {
    const feet = POSITION.y[this.index] - BODY.eyeHeight[this.index];
    const top = NaN; // No world — no terrain height (was groundTop())
    // Read through the queue: a press earlier in THIS frame is not in the components yet (stagedMotion).
    const staged = this.stagedMotion();
    let flying = staged.flying;
    let vy = staged.vy;
    let onGround = staged.onGround;
    let commit = false;
    let action: string;
    if (!canControl(this.state, this.ui)) {
      action = "ignored (modal UI owns the input)";
    } else if (repeat) {
      action = "repeat (held, ignored)";
    } else if (this.control.mode === "fly") {
      const now = performance.now();
      const isDouble = now - this.timing.lastSpaceDown < DOUBLE_TAP_MS;
      this.timing.lastSpaceDown = now;
      if (isDouble) {
        flying = !flying;
        vy = 0;
        onGround = false;
        commit = true;
        action = `double-tap -> ${flying ? "enabled" : "disabled"} flying`;
      } else if (!flying && onGround) {
        vy = 7.5;
        commit = true;
        action = "jump vy=7.5 (not flying)";
      } else {
        action = `no action (flying=${flying} ground=${onGround})`;
      }
    } else if (this.control.mode === "walk" && onGround) {
      vy = 7.5;
      commit = true;
      action = "jump vy=7.5";
    } else {
      action = `no action (mode=${this.control.mode} ground=${onGround})`;
    }
    if (commit) this.pending.push({ kind: "motion", flying, vy, onGround });
    // The line reports the values this press PRODUCES (what the old immediate write left behind),
    // which is why it reads the locals and not the components.
    this.diag.spaceLog.unshift(
      `SPACE#${this.timing.spaceSeq++} ${repeat ? "repeat" : "single"} ` +
        `mode=${this.control.mode} flying=${flying} ground=${onGround} vy=${vy.toFixed(2)} ` +
        `feet=${feet.toFixed(4)} top=${Number.isFinite(top) ? top.toFixed(4) : "none"} ` +
        `gap=${Number.isFinite(top) ? (feet - top).toFixed(4) : "-"} -> ${action}`,
    );
    if (this.diag.spaceLog.length > 10) this.diag.spaceLog.pop();
  }
}
