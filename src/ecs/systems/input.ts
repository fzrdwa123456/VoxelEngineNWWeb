// ===== Player input system: pointer-lock state machine + mouse/keyboard/bind capture =====
// An ECS system module that only produces data: writes held keys into the player's CONTROL
// component, accumulates view deltas (consumeViewDelta, taken by the controller each fixed
// step), and applies jump events to MOTION/CONTROL immediately at key-press time.
// Race-sensitive logic (skipFirstMove / lockGrace / offscreen raw-input takeover) moved here
// verbatim from the old shell — do not "simplify" without replaying those pointer-lock races.
import { getBind } from "../../platform/keybinds";
import { EYE_HEIGHT, ORIENTATION, POSITION, CONTROL, MOTION, type MoveMode, type ControlC, type MotionC, type OrientationC } from "../components/Player";
import type { EntityId } from "../store";
import type { World } from "../World";
import type { Vector3 } from "three/webgpu";

const DOUBLE_TAP_MS = 250;
/** Protection window at lock instant (ms): pairs with skipFirstMove, covering synthetic deltas fired over multiple frames after pointer lock
 *  (swallowing only the first frame is not enough — Chromium/Windows "teleport" the cursor to the lock point, producing large deltas in a burst) */
const LOCK_GRACE_MS = 50;
/** Per-frame mouse delta cap (px): anything larger is treated as a synthetic spike and dropped (safety net).
 *  centerCursor (SetCursorPos) teleporting the cursor produces hundreds to thousands of px of fake relative movement;
 *  no real 8ms game movement reaches that magnitude, so the threshold is set high and only blocks teleports. */
const MAX_MOVE_DELTA = 1000;

/** Player input system: captures pointer lock, mouse, keyboard and mouse-button binds. */
export class PlayerInputSystem {
  locked = false;
  /** Whether clicking the canvas may grab the lock (main.ts sets false when menus/inventory are open, preventing mouse capture behind menus) */
  clickLockAllowed = true;
  /** Raw-input plugin availability (set true after main.ts init succeeds): free-mouse mode switches to WM_INPUT deltas */
  rawInputActive = false;
  /** Space key event log (last 10 entries, shown in the F3 debug panel) */
  readonly spaceLog: string[] = [];
  /** Mouse move event log (throttled to 100ms; shown in F3 + correlated in debug.log) */
  readonly mouseLog: string[] = [];

  // Player component records (stable references, resolved once in the constructor —
  // assigned in the constructor BODY, not field initializers: native class fields run
  // before parameter properties are assigned, so this.world would be undefined there)
  private readonly pos!: Vector3;
  private readonly ori!: OrientationC;
  private readonly motion!: MotionC;
  private readonly control!: ControlC;

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
  /** When the window is partially offscreen and Chromium cancels pointer lock BY ITSELF -> auto-switch
   *  to "free mouse" mode (MC-style windowed view). A lock WE released never enables this; see
   *  prepareUnlock(). */
  private freeMouseActive = false;
  /** Set by prepareUnlock() when it is about to release a lock we hold, so the pointerlockchange that
   *  follows knows the unlock was ours and must NOT engage the offscreen fallback. */
  private unlockIsIntentional = false;
  /** Raw-input takeover state tracking (logs one line on switch for diagnosis) */
  private rawTakeoverActive = false;
  /** Offscreen check result cache (~120ms), so not every mouse event triggers layout/screen queries */
  private offscreenCacheUntil = 0;
  private offscreenCached = false;
  /** Accumulated view deltas since the last fixed step (consumed by the controller system) */
  private yawAcc = 0;
  private pitchAcc = 0;

  constructor(
    private readonly world: World,
    private readonly player: EntityId,
    dom: HTMLElement,
    log: (line: string) => void = () => {},
  ) {
    // Resolve the player's component records once (spawnPlayer guarantees all four exist)
    this.pos = this.world.entities.get(this.player, POSITION)!;
    this.ori = this.world.entities.get(this.player, ORIENTATION)!;
    this.motion = this.world.entities.get(this.player, MOTION)!;
    this.control = this.world.entities.get(this.player, CONTROL)!;
    this.dom = dom;
    this.log = log;

    this.dom.addEventListener("click", () => {
      // Grab the lock ONLY when we do not already hold it. This is deliberate and load-bearing:
      // re-requesting pointer lock on the already-locked element is a known Chromium bug path
      // (issue 40122995: "we have a bug" from requestPointerLock called in a click handler on the
      // locked element) and in this NW.js build it is rejected as kAlreadyLocked. Worse, any
      // pointerlockchange it produces re-arms the grace window below, and that DISCARDS every
      // mousemove for LOCK_GRACE_MS — a visible freeze of mouse look right after each click.
      if (!this.clickLockAllowed || document.pointerLockElement !== null) return;
      this.log("LOCK click grab");
      const pending = this.lock();
      // Never leave this promise unhandled: a rejection used to surface as an unhandled rejection
      // and get written to the log by the window-level handler.
      if (pending) pending.catch((err) => this.log(`LOCK click grab rejected: ${String(err)}`));
    });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.dom;
      if (this.locked) {
        this.freeMouseActive = false;
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
        this.freeMouseActive = false;
      } else if (this.isWindowPartiallyOffScreen()) {
        // Window partially offscreen and pointer lock cancelled by Chromium by itself
        this.freeMouseActive = true;
      } else {
        this.freeMouseActive = false;
      }
    });
    document.addEventListener("mousemove", (ev) => {
      if (this.locked) {
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
        // Accumulate view deltas; yaw/pitch semantics are applied by the controller at the fixed step
        this.yawAcc += -ev.movementX * this.sensitivity;
        this.pitchAcc += -ev.movementY * this.sensitivity;
        const now = performance.now();
        if (now - this.lastMouseLog >= 100) {
          this.lastMouseLog = now;
          this.mouseLog.unshift(
            `MOUSE#${this.mouseSeq++} mmX=${ev.movementX.toFixed(1)} mmY=${ev.movementY.toFixed(1)} ` +
              `pitch=${this.ori.pitch.toFixed(6)}`,
          );
          if (this.mouseLog.length > 10) this.mouseLog.pop();
        }
      }
    });
    document.addEventListener("keydown", (ev) => this.onKeyDown(ev));
    document.addEventListener("keyup", (ev) => this.control.keys.delete(ev.code));
  }

  get mode(): MoveMode {
    return this.control.mode;
  }

  setMode(mode: MoveMode): void {
    this.control.mode = mode;
    this.control.flying = false;
    this.motion.vy = 0;
    this.motion.onGround = false;
  }

  /** Whether the player can be controlled: pointer locked OR free-mouse mode (offscreen fallback) */
  get canControl(): boolean {
    return this.locked || this.freeMouseActive;
  }

  /** Take the accumulated view deltas and reset them (called once per fixed step by the controller).
   *  Yaw accumulates around the constant up axis and pitch is a scalar, so applying the summed delta
   *  is mathematically identical to applying each event's delta separately. */
  consumeViewDelta(): { yaw: number; pitch: number } {
    const d = { yaw: this.yawAcc, pitch: this.pitchAcc };
    this.yawAcc = 0;
    this.pitchAcc = 0;
    return d;
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
    this.freeMouseActive = false;
    this.unlockIsIntentional = this.locked;
  }

  /** Raw mouse deltas (WM_INPUT, fed by main.ts polling).
   *  Takeover rule: plugin available + no menu/inventory + window extends past the screen; lock state irrelevant.
   *  Locked + offscreen = movementX is ruined by cursor clamping, exactly where raw input fills in;
   *  menu state discards (clickLockAllowed=false); onscreen locked state discards (movementX works, prevents double counting). */
  applyRawInput(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    const takeOver = this.rawInputShouldTakeOver();
    this.syncRawTakeoverLog(takeOver);
    if (!takeOver) return;
    // Spike protection matching the mousemove path (previously missing): centerCursor's SetCursorPos teleport feeds
    // huge fake deltas through WM_INPUT; without these two guards that is the direct cause of "view snaps to another angle"
    if (performance.now() < this.lockGraceUntil) return;
    if (Math.abs(dx) > MAX_MOVE_DELTA || Math.abs(dy) > MAX_MOVE_DELTA) return;
    this.yawAcc += -dx * this.sensitivity;
    this.pitchAcc += -dy * this.sensitivity;
  }

  /** Request pointer lock: plain requestPointerLock.
   *  No unadjustedMovement: NW.js Windows raw input (RIDEV_INPUTSINK) registration fails intermittently
   *  -> NotSupportedError, and the synchronous plain fallback gets rejected as kAlreadyLocked by the pending browser flow (double failure).
   *  Fake deltas at lock instant are handled by skipFirstMove + lockGrace. */
  lock(): Promise<void> | undefined {
    return this.dom.requestPointerLock() as Promise<void> | undefined;
  }

  /** Bind-code injection from non-keyboard event sources (mouse buttons etc.): press */
  bindPress(code: string): void {
    if (this.control.keys.has(code)) return; // Already held; prevents re-triggering jump semantics
    this.control.keys.add(code);
    if (code === getBind("jump")) this.onJumpPress(false);
  }

  /** Bind-code injection from non-keyboard event sources: release */
  bindRelease(code: string): void {
    this.control.keys.delete(code);
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

  /** Whether raw input should take over the view: plugin available + no menu/inventory + window offscreen. Lock state irrelevant. */
  private rawInputShouldTakeOver(): boolean {
    return this.rawInputActive && this.clickLockAllowed && this.isWindowPartiallyOffScreen();
  }

  /** Log one line when the takeover mode switches (for diagnosis) */
  private syncRawTakeoverLog(active: boolean): void {
    if (active !== this.rawTakeoverActive) {
      this.rawTakeoverActive = active;
      this.log(active ? "RAWINPUT takeover (movementX suspended)" : "RAWINPUT hands back to movementX");
    }
  }

  private onKeyDown(ev: KeyboardEvent): void {
    this.control.keys.add(ev.code);
    if (ev.code === getBind("jump")) {
      this.onJumpPress(ev.repeat);
    }
  }

  /** Jump key press semantics (shared by keyboard keydown and mouse injection): double-tap toggles fly / ground jump */
  private onJumpPress(repeat: boolean): void {
    const feet = this.pos.y - EYE_HEIGHT;
    const top = NaN; // No world — no terrain height (was groundTop())
    let action: string;
    if (repeat) {
      action = "repeat (held, ignored)";
    } else if (this.control.mode === "fly") {
      const now = performance.now();
      const isDouble = now - this.lastSpaceDown < DOUBLE_TAP_MS;
      this.lastSpaceDown = now;
      if (isDouble) {
        this.control.flying = !this.control.flying;
        this.motion.vy = 0;
        this.motion.onGround = false;
        action = `double-tap -> ${this.control.flying ? "enabled" : "disabled"} flying`;
      } else if (!this.control.flying && this.motion.onGround) {
        this.motion.vy = 7.5;
        action = "jump vy=7.5 (not flying)";
      } else {
        action = `no action (flying=${this.control.flying} ground=${this.motion.onGround})`;
      }
    } else if (this.control.mode === "walk" && this.motion.onGround) {
      this.motion.vy = 7.5;
      action = "jump vy=7.5";
    } else {
      action = `no action (mode=${this.control.mode} ground=${this.motion.onGround})`;
    }
    this.spaceLog.unshift(
      `SPACE#${this.spaceSeq++} ${repeat ? "repeat" : "single"} ` +
        `mode=${this.control.mode} flying=${this.control.flying} ground=${this.motion.onGround} vy=${this.motion.vy.toFixed(2)} ` +
        `feet=${feet.toFixed(4)} top=${Number.isFinite(top) ? top.toFixed(4) : "none"} ` +
        `gap=${Number.isFinite(top) ? (feet - top).toFixed(4) : "-"} -> ${action}`,
    );
    if (this.spaceLog.length > 10) this.spaceLog.pop();
  }
}
