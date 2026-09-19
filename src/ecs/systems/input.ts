// ===== Player input system: pointer-lock state machine + mouse/keyboard/bind capture =====
// An ECS system in the FIXED lane and the tick's FIRST act: the device events that arrived between two
// ticks become component data here, before anything that reads them runs.
//   CONTROL.keys   held bind codes (read by movement/interaction)
//   VIEW           accumulated view deltas (drained by the controller in the same tick)
//   MOTION/CONTROL jump + fly state, decided at press time by onJumpPress — but ONLY while the player
//                  is controllable (canControl)
//   INPUT_STATE    pointer-lock / free-mouse / raw-input availability (read by every gameplay system
//                  through canControl() — that is why this file is not imported by them)
//   KEY_EVENTS     key EDGES, published at event time and consumed by the ui systems that own a global
//                  chord (ui.picker's F3+F4) — a held-key set cannot say "F3 went down just now"
//
// The DOM listeners below are PRODUCERS: they take every decision at EVENT time — which key, which
// view delta, which jump branch, and all of the race guards — exactly where they were when the writes
// were immediate, and queue the resulting INTENT. step() drains that queue into the components. The
// hand-off buys two things and changes neither the timing nor the order of any guard (iron rule 3):
//   * a gameplay component is written inside a system run only, between the scheduler's structural
//     checks, by a system with a DECLARED access set — input is no longer the one exception;
//   * the schedule can order it against the controller/movement/collision that consume it.
// INPUT_STATE stays event-time on purpose: the pointer-lock state machine has to react SYNCHRONOUSLY
// to a pointerlockchange (a lock flag that lands a tick late is a bug, not a refactor), and that
// resource belongs to the device layer. What it does NOT hold is "may a click grab the lock": that is
// `!isModalUi(UI_MODAL)`, asked at the moment of the question instead of cached on the device state.
//
// Race-sensitive logic (skipFirstMove / lockGrace / offscreen raw-input takeover) moved here
// verbatim from the old shell — do not "simplify" without replaying those pointer-lock races.
//
// ===== Tauri 版的一处改动：鼠标捕获由 Win32 做，不走 Pointer Lock API =====
// `state.locked` 的含义从"浏览器给了指针锁定"变成"**我们自己捕获了鼠标**"（Rust 侧
// ClipCursor + SetCursorPos，见 platform/mousecapture.ts 的说明）。浏览器那套是安全策略：
// ESC 强制解锁 + 解锁后一段时间拒绝重新锁定，页面和宿主都无权关闭。
// 于是 lock() 不再 requestPointerLock，而是打开原生捕获，并自己同步记账
// （原生捕获没有 pointerlockchange 可等）。**原始输入不可用时才回退**到浏览器那套。
import { captureMouse, releaseMouse } from "../../platform/mousecapture";
import { buttonToAction, buttonToCode, getBind, isCapturing } from "../../platform/keybinds";
import {
  BODY,
  CONTROL,
  MOTION,
  ORIENTATION,
  POSITION,
  VIEW,
  type ControlC,
  type MotionC,
} from "../components/Player";
import {
  canControl,
  INPUT_STATE,
  isModalUi,
  KEY_EVENTS,
  LOCAL_PLAYER,
  publishKeyEdge,
  UI_MODAL,
  type InputState,
  type KeyEventLog,
  type UiModalState,
} from "../resources";
import { entityIndex, type World } from "../World";

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
 *  must not move — iron rule 3). */
type InputIntent =
  | { kind: "key"; code: string; down: boolean }
  | { kind: "look"; yaw: number; pitch: number }
  | { kind: "motion"; flying: boolean; vy: number; onGround: boolean };

/** What this system touches, for the schedule (spread into its registration in main.ts).
 *  WRITES: the held-key set, the accumulated look deltas the controller drains, and the jump/fly state.
 *  READS: the state each press decides against — and ORIENTATION/POSITION/BODY, which the
 *  mouse/SPACE logs print. Those are written by the systems that FOLLOW this one, so the edge below is
 *  a real read-after-write, not a formality.
 *  EXTERNAL: the pointer lock and the window geometry the takeover arbitration asks about, the bind
 *  table it reads ("is this key the jump bind"), plus the two
 *  things it publishes that the ECS does not model — INPUT_STATE (a resource of the device layer, also
 *  written by platform/pointerlock.ts) and the F3 input queues diagnostics forwards. */
export const INPUT_ACCESS = {
  reads: [CONTROL, MOTION, POSITION, BODY, ORIENTATION],
  writes: [CONTROL, VIEW, MOTION],
  readsExternal: ["pointerLock", "windowGeometry", "keybinds"],
  writesExternal: ["inputState", "inputDiagnosticQueues", "keyEvents"],
} as const;

/** Player input system: captures pointer lock, mouse, keyboard and mouse-button binds.
 *  Registered in the FIXED lane (main.ts) with INPUT_ACCESS above; `step()` is what the lane calls. */
export class PlayerInputSystem {
  /** Space key event log (last 10 entries, shown in the F3 debug panel) */
  readonly spaceLog: string[] = [];
  /** Mouse move event log (throttled to 100ms; shown in F3 + correlated in debug.log) */
  readonly mouseLog: string[] = [];

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

  private readonly dom: HTMLElement;
  private readonly log: (line: string) => void;
  private readonly sensitivity = 0.002;
  private lastSpaceDown = 0;
  private spaceSeq = 0;
  private mouseSeq = 0;
  private lastMouseLog = 0;
  /** Ignore the single synthetic fake delta at lock instant (the first mousemove after locking does not rotate the view) */
  private skipFirstMove = false;
  /** Grace period armed before an intentional unlock: swallows synthetic deltas during the exitPointerLock + SetCursorPos race (while still locked) */
  private lockGraceUntil = 0;
  /** Set by prepareUnlock() when it is about to release a lock we hold, so the pointerlockchange that
   *  follows knows the unlock was ours and must NOT engage the offscreen fallback. */
  private unlockIsIntentional = false;
  /** Raw-input takeover state tracking (logs one line on switch for diagnosis) */
  private rawTakeoverActive = false;
  /** Offscreen check result cache (~120ms), so not every mouse event triggers layout/screen queries */
  private offscreenCacheUntil = 0;
  private offscreenCached = false;
  /** Intents the device layer decided since the last tick, waiting for step() to write them. It is
   *  deliberately NOT a resource: producer and consumer are this one object, and nothing else may see
   *  a half-applied frame. */
  private pending: InputIntent[] = [];

  constructor(
    private readonly world: World,
    dom: HTMLElement,
    log: (line: string) => void = () => {},
  ) {
    const player = this.world.resource(LOCAL_PLAYER);
    this.state = this.world.resource(INPUT_STATE);
    this.ui = this.world.resource(UI_MODAL);
    this.keyEdges = this.world.resource(KEY_EVENTS);
    this.index = entityIndex(player);
    this.control = this.world.get(player, CONTROL)!;
    this.motion = this.world.get(player, MOTION)!;
    this.dom = dom;
    this.log = log;

    this.dom.addEventListener("click", () => {
      // Grab the lock ONLY when we do not already hold it. This is deliberate and load-bearing:
      // re-requesting pointer lock on the already-locked element is a known Chromium bug path
      // (issue 40122995: "we have a bug" from requestPointerLock called in a click handler on the
      // locked element) and in this NW.js build it is rejected as kAlreadyLocked. Worse, any
      // pointerlockchange it produces re-arms the grace window below, and that DISCARDS every
      // mousemove for LOCK_GRACE_MS — a visible freeze of mouse look right after each click.
      // 已经捕获就别再抓一次。**必须带上 state.locked**：原生捕获下
      // document.pointerLockElement 永远是 null，少了这一项，每次点击都会重新 arm 一次
      // grace 窗口 —— 那就是"每次点击后视角卡一下"（原来那段注释警告的正是这个）。
      if (isModalUi(this.ui) || this.state.locked || document.pointerLockElement !== null) return;
      this.log("LOCK click grab");
      const pending = this.lock();
      // Never leave this promise unhandled: a rejection used to surface as an unhandled rejection
      // and get written to the log by the window-level handler.
      if (pending) pending.catch((err) => this.log(`LOCK click grab rejected: ${String(err)}`));
    });
    document.addEventListener("pointerlockchange", () => {
      this.state.locked = document.pointerLockElement === this.dom;
      if (this.state.locked) {
        this.state.freeMouseActive = false;
        this.unlockIsIntentional = false; // moot once we hold the lock again
        this.skipFirstMove = true;
        this.lockGraceUntil = performance.now() + LOCK_GRACE_MS;
      } else if (this.unlockIsIntentional) {
        // WE released the lock (pause menu / inventory / window blur). This must NOT enable the
        // offscreen fallback: a window half offscreen that opens a menu is indistinguishable from
        // "Chromium cancelled the lock" by position alone, and treating it as such leaves the game
        // fully controllable behind the menu (movement, view, break/place all gate on canControl).
        // prepareUnlock() has already cleared freeMouseActive for the case where no event follows.
        this.unlockIsIntentional = false;
        this.state.freeMouseActive = false;
      } else if (this.isWindowPartiallyOffScreen()) {
        // Window partially offscreen and pointer lock cancelled by Chromium by itself
        this.state.freeMouseActive = true;
      } else {
        this.state.freeMouseActive = false;
      }
    });
    document.addEventListener("mousemove", (ev) => {
      if (this.state.locked) {
        // --- Pointer-locked mode ---
        // Window offscreen + raw input available: skip movementX (the cursor is clamped onscreen, its delta goes to zero and would double count with raw input)
        const takeOver = this.rawInputShouldTakeOver();
        this.syncRawTakeoverLog(takeOver);
        if (takeOver) return;
        if (performance.now() < this.lockGraceUntil) return;
        if (this.skipFirstMove) {
          this.skipFirstMove = false;
          return;
        }
        // Synthetic spike guard (pointer lock / SetCursorPos race): normal movement never reaches this magnitude
        if (Math.abs(ev.movementX) > MAX_MOVE_DELTA || Math.abs(ev.movementY) > MAX_MOVE_DELTA) return;
        // Accumulate view deltas; yaw/pitch semantics are applied by the controller at the fixed step.
        // The scale is applied HERE, at event time, so step() only adds the number (see the header).
        this.pending.push({
          kind: "look",
          yaw: -ev.movementX * this.sensitivity,
          pitch: -ev.movementY * this.sensitivity,
        });
        const now = performance.now();
        if (now - this.lastMouseLog >= 100) {
          this.lastMouseLog = now;
          this.mouseLog.unshift(
            `MOUSE#${this.mouseSeq++} mmX=${ev.movementX.toFixed(1)} mmY=${ev.movementY.toFixed(1)} ` +
              `pitch=${ORIENTATION.pitch[this.index].toFixed(6)}`,
          );
          if (this.mouseLog.length > 10) this.mouseLog.pop();
        }
      }
    });
    document.addEventListener("keydown", (ev) => this.onKeyDown(ev));
    document.addEventListener("keyup", (ev) => {
      this.publishEdge(ev.code, false, false);
      this.queueKey(ev.code, false);
    });
    // Mouse buttons that carry a BIND belong to the device layer too (only this file may listen). They
    // publish an EDGE for the systems that care — the "inventory" bind is read by ui.navigation — and
    // feed the held set through the same queue the keyboard uses.
    document.addEventListener("mousedown", (ev) => {
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

  /** Queue a held-key transition (keyboard, or a mouse-button bind injected from main.ts) */
  private queueKey(code: string, down: boolean): void {
    this.pending.push({ kind: "key", code, down });
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

  /** Whether we currently hold the pointer lock */
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

  /** Called immediately BEFORE we release the pointer on purpose (open the pause menu, open the
   *  inventory, lose window focus). Three things have to happen here:
   *    1. arm the grace window that swallows the synthetic deltas of the exitPointerLock +
   *       SetCursorPos race while still locked;
   *    2. drop free-mouse mode AT ONCE — control has to stop the moment a UI opens, and this is also
   *       what covers the case where the lock was ALREADY gone (Chromium had cancelled it earlier),
   *       because then exitPointerLock() changes nothing and no pointerlockchange will follow;
   *    3. record that this unlock is OURS, so the pointerlockchange that does follow cannot mistake
   *       it for Chromium cancelling the lock and re-enable the offscreen fallback. */
  prepareUnlock(): void {
    this.lockGraceUntil = performance.now() + 100;
    this.state.freeMouseActive = false;
    this.unlockIsIntentional = this.state.locked;
  }

  /** Raw mouse deltas (WM_INPUT, fed by main.ts polling).
   *  Takeover rule: plugin available + no menu/inventory + window extends past the screen; lock state irrelevant.
   *  Locked + offscreen = movementX is ruined by cursor clamping, exactly where raw input fills in;
   *  menu state discards (no modal UI owns the mouse); onscreen locked state discards (movementX works, prevents double counting). */
  applyRawInput(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    const takeOver = this.rawInputShouldTakeOver();
    this.syncRawTakeoverLog(takeOver);
    if (!takeOver) return;
    // Spike protection matching the mousemove path (previously missing): centerCursor's SetCursorPos teleport feeds
    // huge fake deltas through WM_INPUT; without these two guards that is the direct cause of "view snaps to another angle"
    if (performance.now() < this.lockGraceUntil) return;
    if (Math.abs(dx) > MAX_MOVE_DELTA || Math.abs(dy) > MAX_MOVE_DELTA) return;
    this.pending.push({ kind: "look", yaw: -dx * this.sensitivity, pitch: -dy * this.sensitivity });
  }

  /** The raw-input plugin's own cadence: 8 ms, independent of the frame rate, and it keeps DRAINING
   *  while the game loop is stopped (MENU mode) so entering a world cannot replay a backlog of deltas.
   *  The device layer owns its cadence; `applyRawInput` decides whether the deltas are used at all.
   *  (The interval lives here, not in the composition root: it is a property of the device, and the
   *  polled data goes through the same intent queue as every other input.) */
  startRawPolling(source: { poll(): { dx: number; dy: number } }): void {
    setInterval(() => {
      const d = source.poll();
      if (d.dx !== 0 || d.dy !== 0) this.applyRawInput(d.dx, d.dy);
    }, 8);
  }

  /** Grab the mouse.
   *
   *  **有原始输入时走原生捕获**（Win32 ClipCursor）：完全不碰 Pointer Lock API，于是没有
   *  ESC 解锁手势、没有解锁后的冷却期、没有浏览器把锁拿走 —— 这几条都是页面管不了的策略。
   *  原始输入不可用时才回退到 requestPointerLock（那时只能靠 movementX）。
   *
   *  原生捕获**没有 pointerlockchange 可等**，所以"刚锁上"的那套记账（skipFirstMove + grace）
   *  在 promise 成功之后自己做掉，语义与 pointerlockchange 里 locked 那一支完全一致。 */
  lock(): Promise<void> | undefined {
    if (!this.state.rawInputActive) {
      return this.dom.requestPointerLock() as Promise<void> | undefined;
    }
    const pending = captureMouse(this.dom);
    // 成功了才记账：失败时前端会回退到 requestPointerLock，那由 pointerlockchange 负责。
    pending.then(() => this.onCaptured()).catch(() => {});
    return pending;
  }

  /** 记"现在已经捕获"——对应 pointerlockchange 里 locked 那一支的四件事，逐条照抄 */
  private onCaptured(): void {
    this.state.locked = true;
    this.state.freeMouseActive = false;
    this.unlockIsIntentional = false; // moot once we hold the mouse again
    this.skipFirstMove = true;
    this.lockGraceUntil = performance.now() + LOCK_GRACE_MS;
    this.log("MOUSE CAPTURE on (native ClipCursor; browser pointer lock not used)");
  }

  /** 放开鼠标（开菜单 / 失焦 / 退出世界）：紧跟在 prepareUnlock() 之后调用。
   *  原生捕获没有 pointerlockchange 可等，所以状态必须在这里自己落下去；
   *  回退路径下 releaseMouse() 还会顺带 document.exitPointerLock()。 */
  releaseCapture(): void {
    if (this.state.locked) this.log("MOUSE CAPTURE off (native ClipCursor released)");
    this.state.locked = false;
    this.state.freeMouseActive = false;
    releaseMouse();
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

  /** Whether the window extends past its monitor bounds (screen coordinate system, result cached ~120ms).
   *  Key context: pointer lock clamps the cursor to the window∩screen area,
   *  a half-offscreen window pushes the cursor against the virtual desktop edge -> Windows stops sending deltas -> movementX goes to zero -> view frozen;
   *  and the lock is NOT cancelled (the window still counts as visible), so pointerlockchange does not fire.
   *  WM_INPUT relative deltas are unaffected by cursor clamping — the only input source that keeps turning the view. */
  private isWindowPartiallyOffScreen(): boolean {
    const now = performance.now();
    if (now >= this.offscreenCacheUntil) {
      this.offscreenCacheUntil = now + 120;
      const scr = screen as Screen & { availLeft?: number; availTop?: number };
      const mLeft = scr.availLeft ?? 0;
      const mTop = scr.availTop ?? 0;
      const x = window.screenX;
      const y = window.screenY;
      this.offscreenCached =
        x < mLeft - 1 ||
        y < mTop - 1 ||
        x + window.outerWidth > mLeft + screen.width + 1 ||
        y + window.outerHeight > mTop + screen.height + 1;
    }
    return this.offscreenCached;
  }

  /** Whether raw input should take over the view.
   *  原生捕获（ClipCursor）期间**必须**接管：光标被夹在窗口里，贴到边就不动了，movementX
   *  随之归零 —— 这和原来"窗口一半在屏幕外"是同一个原因。
   *  其余情况：插件可用 + 无菜单 + 窗口一半在屏幕外。 */
  private rawInputShouldTakeOver(): boolean {
    if (!this.state.rawInputActive || !this.clickLockAllowed) return false;
    if (this.state.locked) return true;
    return this.isWindowPartiallyOffScreen();
  }

  /** Log one line when the takeover mode switches (for diagnosis) */
  private syncRawTakeoverLog(active: boolean): void {
    if (active !== this.rawTakeoverActive) {
      this.rawTakeoverActive = active;
      this.log(active ? "RAWINPUT takeover (movementX suspended)" : "RAWINPUT hands back to movementX");
    }
  }

  private onKeyDown(ev: KeyboardEvent): void {
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
      const isDouble = now - this.lastSpaceDown < DOUBLE_TAP_MS;
      this.lastSpaceDown = now;
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
    this.spaceLog.unshift(
      `SPACE#${this.spaceSeq++} ${repeat ? "repeat" : "single"} ` +
        `mode=${this.control.mode} flying=${flying} ground=${onGround} vy=${vy.toFixed(2)} ` +
        `feet=${feet.toFixed(4)} top=${Number.isFinite(top) ? top.toFixed(4) : "none"} ` +
        `gap=${Number.isFinite(top) ? (feet - top).toFixed(4) : "-"} -> ${action}`,
    );
    if (this.spaceLog.length > 10) this.spaceLog.pop();
  }
}
