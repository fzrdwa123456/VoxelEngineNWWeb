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
//   INPUT_TIMING   the race guards' own state (which mousemove is the synthetic lock-instant one,
//                  whether the unlock was ours, the grace deadline, the offscreen cache): the fields
//                  that make this file race-sensitive, in a resource so a test and a log can see them
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
// verbatim from the old shell — do not "simplify" without replaying those pointer-lock races. Its STATE
// is the INPUT_TIMING resource now (a change of where the fields live, not of when they are read or
// written); the logic itself is untouched.
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
import { RENDERER3D } from "../presentation";
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
  /** The DEVICE-TIMING state (INPUT_TIMING, ecs/resources.ts): which mousemove is the synthetic one at
   *  lock instant, whether an unlock was OURS, how long the grace window runs, when the offscreen check
   *  was last done, and the diagnostic counters. It is world state now — one home, readable by a test and
   *  by the gate — while the DECISIONS stay exactly where they were: the listeners still decide at event
   *  time and only queue. Moving these fields moved no line of that logic; if a change ever does, iron
   *  rule 3 says replay the races first. */
  private readonly timing: InputTiming;
  /** The queue of decisions waiting for `step()`. It IS the INPUT_INTENTS resource (ecs/resources.ts):
   *  the array lives in the world, this system is its only writer and its only reader, and the accessor
   *  below keeps every use site reading like a local field. */
  private readonly intents: InputIntentLog;

  // ===== LOOK 诊断计数器（每秒一行 `LOOK`，只为把"转视角不顺滑"变成数字）=====
  // 它们全是**读数**，不参与任何判定、不影响任何逻辑：这一秒收了多少原始增量、成功排进队列多少、
  // 分别在哪个 guard 上被丢掉、键盘边沿各来了多少、以及采样瞬间还没被固定步消费的队列长度。
  // 判定到底丢在哪一环，比"看感觉"可靠。
  private lookRaw = 0;
  private lookApplied = 0;
  private dropTakeover = 0;
  private dropGrace = 0;
  private dropSpike = 0;
  private mmSkipFirst = 0;
  private mmGrace = 0;
  private mmSpike = 0;
  private keyDowns = 0;
  private keyRepeats = 0;
  private keyUps = 0;
  private lookLogAt = 0;
  /** 每帧计量器（`LOOK` 行看不出"每帧分到几份"，这一对就是为它准备的）：这一帧（= 上一帧之后到现在）
   *  从鼠标采样到多少份 `look`、合计多少**像素当量**（`Math.hypot(yaw,pitch)/sensitivity`，这样主循环
   *  不用知道灵敏度）。`takeLookFrameMeter()` 读即清零，由 FRAME 行每帧取一次。 */
  private frameLookSamples = 0;
  private frameLookPx = 0;
  /** 通过全部判定、等着本帧 `frameLook()` 一次性应用的原始位移（像素）。判定在 `rawDelta()` 里做完，
   *  这里只累积"已经通过的部分"。 */
  private rawFrameDx = 0;
  private rawFrameDy = 0;

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
    document.addEventListener("pointerlockchange", () => {
      this.state.locked = document.pointerLockElement === this.dom;
      if (this.state.locked) {
        this.state.freeMouseActive = false;
        this.timing.unlockIsIntentional = false; // moot once we hold the lock again
        this.timing.skipFirstMove = true;
        this.timing.lockGraceUntil = performance.now() + LOCK_GRACE_MS;
      } else if (this.timing.unlockIsIntentional) {
        // WE released the lock (pause menu / inventory / window blur). This must NOT enable the
        // offscreen fallback: a window half offscreen that opens a menu is indistinguishable from
        // "Chromium cancelled the lock" by position alone, and treating it as such leaves the game
        // fully controllable behind the menu (movement, view, break/place all gate on canControl).
        // prepareUnlock() has already cleared freeMouseActive for the case where no event follows.
        this.timing.unlockIsIntentional = false;
        this.state.freeMouseActive = false;
      } else if (this.isWindowPartiallyOffScreen()) {
        // Window partially offscreen and pointer lock cancelled by Chromium by itself
        this.state.freeMouseActive = true;
      } else {
        this.state.freeMouseActive = false;
      }
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
        // --- Pointer-locked mode ---
        // Window offscreen + raw input available: skip movementX (the cursor is clamped onscreen, its delta goes to zero and would double count with raw input)
        const takeOver = this.rawInputShouldTakeOver();
        this.syncRawTakeoverLog(takeOver);
        if (takeOver) return;
        if (performance.now() < this.timing.lockGraceUntil) {
          this.mmGrace++;
          return;
        }
        if (this.timing.skipFirstMove) {
          this.timing.skipFirstMove = false;
          this.mmSkipFirst++;
          return;
        }
        // Synthetic spike guard (pointer lock / SetCursorPos race): normal movement never reaches this magnitude
        if (Math.abs(ev.movementX) > MAX_MOVE_DELTA || Math.abs(ev.movementY) > MAX_MOVE_DELTA) {
          this.mmSpike++;
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
      this.keyUps++;
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
          this.frameLookSamples++;
          this.frameLookPx += Math.hypot(intent.yaw, intent.pitch) / this.sensitivity;
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

  /** 每帧计量器（FRAME 行每帧读一次，读即清零）：`samples` = 这一帧从鼠标采样到几份 `look`，
   *  `px` = 这些采样合计多少像素当量的鼠标移动。
   *
   *  存在的原因：`LOOK` 行按秒聚合，"每帧分到的份数不匀"（8ms 拉一次 ≈ 每帧 1.67 份 → 2,2,1 的图案）
   *  在秒级数字上完全看不出来，而它正是"快转时一格一格"的嫌疑来源。这一对把它变成直方图。 */
  takeLookFrameMeter(): { samples: number; px: number } {
    const out = { samples: this.frameLookSamples, px: this.frameLookPx };
    this.frameLookSamples = 0;
    this.frameLookPx = 0;
    return out;
  }

  /** Queue a held-key transition (keyboard, or a mouse-button bind injected from main.ts) */
  private queueKey(code: string, down: boolean): void {
    this.pending.push({ kind: "key", code, down });
  }

  /** 每秒一行 `LOOK`：把"这一秒的鼠标输入发生了什么"写成数字（见上面的计数器）。
   *  `raw` = 从原始输入通道到达几块增量（Rust 每 4ms 推一块）；`app` = 推入意图队列几次
   *  （改成每帧一次之后，它 ≈"有位移的帧数/秒"）；`dTO`（接管未开启）/`dG`（锁后宽限窗口）/
   *  `dS`（尖峰保护）= 三条丢在哪的计数；`mmSkip`/`mmG`/`mmS` = 浏览器 mousemove 那条路的对应丢弃；
   *  `key` = 这一秒的 keydown/keydown-repeat/keyup 次数（按住一个键应该 ≈1/30/1）；
   *  `pend`/`yaw`/`pitch` = 采样瞬间还没被固定步消费的队列长度和待应用视角量。 */
  private logLook(): void {
    const now = performance.now();
    if (this.lookLogAt === 0) {
      this.lookLogAt = now;
      return;
    }
    if (now - this.lookLogAt < 1000) return;
    this.lookLogAt = now;
    this.log(
      `LOOK raw=${this.lookRaw} app=${this.lookApplied} dTO=${this.dropTakeover} dG=${this.dropGrace} ` +
        `dS=${this.dropSpike} mmSkip=${this.mmSkipFirst} mmG=${this.mmGrace} mmS=${this.mmSpike} ` +
        `key=${this.keyDowns}/${this.keyRepeats}/${this.keyUps} pend=${this.pending.length} ` +
        `yaw=${VIEW.yawDelta[this.index].toFixed(4)} pitch=${VIEW.pitchDelta[this.index].toFixed(4)}`,
    );
    this.lookRaw = 0;
    this.lookApplied = 0;
    this.dropTakeover = 0;
    this.dropGrace = 0;
    this.dropSpike = 0;
    this.mmSkipFirst = 0;
    this.mmGrace = 0;
    this.mmSpike = 0;
    this.keyDowns = 0;
    this.keyRepeats = 0;
    this.keyUps = 0;
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
    this.timing.lockGraceUntil = performance.now() + 100;
    this.state.freeMouseActive = false;
    this.timing.unlockIsIntentional = this.state.locked;
  }

  /** Raw mouse deltas (WM_INPUT). Called ONCE PER ARRIVAL by `platform/rawinput.ts`'s event listener
   *  (~4 ms, the Rust push cadence) — not by a timer any more: see `frameLook()` for why.
   *
   *  EVERY DECISION STAYS HERE, at arrival time, with the same order and the same thresholds as the
   *  8 ms poll it replaced (iron rule 3): takeover, then the lock-grace window, then the spike guard.
   *  Only what PASSES is accumulated; the frame applies the total later.
   *
   *  Takeover rule: plugin available + no menu/inventory + window extends past the screen; lock state irrelevant.
   *  Locked + offscreen = movementX is ruined by cursor clamping, exactly where raw input fills in;
   *  menu state discards (no modal UI owns the mouse); onscreen locked state discards (movementX works, prevents double counting). */
  rawDelta(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.lookRaw++;
    const takeOver = this.rawInputShouldTakeOver();
    this.syncRawTakeoverLog(takeOver);
    if (!takeOver) {
      this.dropTakeover++;
      return;
    }
    // Spike protection matching the mousemove path (previously missing): centerCursor's SetCursorPos teleport feeds
    // huge fake deltas through WM_INPUT; without these two guards that is the direct cause of "view snaps to another angle"
    if (performance.now() < this.timing.lockGraceUntil) {
      this.dropGrace++;
      return;
    }
    if (Math.abs(dx) > MAX_MOVE_DELTA || Math.abs(dy) > MAX_MOVE_DELTA) {
      this.dropSpike++;
      return;
    }
    // Accepted: accumulate for this frame's ONE look intent (the guards above already had their say,
    // which is what keeps the spike threshold per DELTA and not per frame — a fast flick may exceed
    // 1000 px in a frame and must not be thrown away).
    this.rawFrameDx += dx;
    this.rawFrameDy += dy;
  }

  /** 每帧一次，帧的开头（固定步之前）由 `main.ts` 的 frame() 调用：把这一帧收到的位移作为**一个**
   *  `look` 意图排队。
   *
   *  **为什么不再是 8ms 定时器。** 视角增量原来是 `setInterval(…, 8)` 每 8ms 取走一次累加器，于是
   *  "每帧分到几份"取决于那个定时器和帧率（16.67ms）的相位：名义上 1.67 份/帧，实际是 2/2/1 的图案。
   *  更要命的是 **Chromium 把 keydown/keyup 这类输入任务排在定时器任务前面**，所以一按住键（自动重复
   *  ~30 次/秒），那个定时器就被挤成 9~12ms 一档：探针实测**不按键时 122~127 份/秒、90% 的帧恰好 2 份；
   *  按住键时掉到 84~110 份/秒、每帧份数在 0/1/2/3 之间乱跳（只有 ~40% 的帧是 2 份）** —— 每帧转角度
   *  因此最多相差 3 倍，眼睛看到的就是"按住键转视角不顺滑"。
   *
   *  改成每帧取一次之后：**每帧的转角度 = 该帧鼠标的真实位移**，与主线程上还在发生什么（按键、输入法、
   *  日志、GC）完全无关，也不会再有 0/1/2/3 的跳变。判定仍全部在 `rawDelta()`（事件期）完成，所以
   *  rule 3 那套接管/宽限/尖峰时序一个都没动。 */
  frameLook(): void {
    if (!this.inWorld()) {
      // 没有世界就没有视角：绝不让一个缓冲区跨过"进世界"那一刻（进场时捕获可能已经开着，而 load
      // 模式不跑固定步，攒下来的位移会在第一帧一次性甩出去 —— 那就是一次视角突跳）。
      this.rawFrameDx = 0;
      this.rawFrameDy = 0;
      return;
    }
    if (this.rawFrameDx === 0 && this.rawFrameDy === 0) return;
    const dx = this.rawFrameDx;
    const dy = this.rawFrameDy;
    this.rawFrameDx = 0;
    this.rawFrameDy = 0;
    this.lookApplied++;
    this.pending.push({ kind: "look", yaw: -dx * this.sensitivity, pitch: -dy * this.sensitivity });
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
    this.timing.unlockIsIntentional = false; // moot once we hold the mouse again
    this.timing.skipFirstMove = true;
    this.timing.lockGraceUntil = performance.now() + LOCK_GRACE_MS;
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
    if (now >= this.timing.offscreenCacheUntil) {
      this.timing.offscreenCacheUntil = now + 120;
      const scr = screen as Screen & { availLeft?: number; availTop?: number };
      const mLeft = scr.availLeft ?? 0;
      const mTop = scr.availTop ?? 0;
      const x = window.screenX;
      const y = window.screenY;
      this.timing.offscreenCached =
        x < mLeft - 1 ||
        y < mTop - 1 ||
        x + window.outerWidth > mLeft + screen.width + 1 ||
        y + window.outerHeight > mTop + screen.height + 1;
    }
    return this.timing.offscreenCached;
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
    if (ev.repeat) this.keyRepeats++;
    else this.keyDowns++;
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
