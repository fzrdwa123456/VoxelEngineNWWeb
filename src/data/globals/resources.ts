// ===== World-scoped resources =====
// Every singleton the systems share. Resources are how a system reaches shared state WITHOUT
// importing another system — the input system and the movement system both need "can the player be
// controlled?", and neither is allowed to know the other exists.
//
// Definitions live here rather than next to their owner on purpose: `voxel/` must not import the
// ECS (its standalone tests depend on that), and `systems/input.ts` must not be a dependency of
// `systems/movement.ts`. A neutral file is the only place both rules survive.

import { defineResource, type Entity, type Resource } from "../../core/world";
import type { VoxelWorld } from "../world/world";

/** The local player's entity. Kept as a resource so "the player" is greppable data rather than a
 *  constructor argument hard-wired into five systems. */
export const LOCAL_PLAYER: Resource<Entity> = defineResource<Entity>("localPlayer");

/** The block world. Not a component: one global asset, not per-entity state. */
export const VOXEL: Resource<VoxelWorld> = defineResource<VoxelWorld>("voxel");

/** Device/pointer-lock state. Owned and written by ecs/systems/input.ts, READ by every gameplay
 *  system through canControl(): that single gate is what stops a UI click from driving the game.
 *
 *  There is deliberately NO "click may grab the lock" field here any more: that was a CACHE of
 *  `!isModalUi(UI_MODAL)` kept in sync by platform/pointerlock.ts's applyCursor(), i.e. a second copy of
 *  the answer UI_MODAL already holds. The two readers (the canvas click handler and the raw-input
 *  takeover test) ask UI_MODAL directly now, which is both authoritative and one frame EARLIER than the
 *  cache was — a stale `true` there would have let a click capture the mouse behind an open menu. */
export interface InputState {
  /** The game canvas holds the pointer lock */
  locked: boolean;
  /** Chromium cancelled the lock by itself (window partly offscreen) -> MC-style free-mouse mode */
  freeMouseActive: boolean;
  /** The raw-input (WM_INPUT) plugin is available, so free-mouse mode can use its deltas */
  rawInputActive: boolean;
  /** The cursor value the shell last APPLIED ("none" while playing, "default" with a UI up; null before
   *  the first write). `platform/pointerlock.ts` used to keep this in a private field — it is a fact about
   *  the window, not about the lock manager, so it belongs here with the rest of the device state. */
  appliedCursor: "none" | "default" | null;
}

export const INPUT_STATE = defineResource<InputState>("inputState");

export function createInputState(): InputState {
  return { locked: false, freeMouseActive: false, rawInputActive: false, appliedCursor: null };
}

/** The WINDOW'S SIZE in CSS pixels, as data. Written by `platform/viewport.ts` — the ONE resize listener
 *  in the process, which publishes here at event time — and read by the camera (whose projection follows
 *  it) and by the draw (whose renderer size follows it). Those two used to be driven by a resize listener
 *  in main.ts that reached into a three.js camera and the GPU device; and ui/uiscale.ts kept a SECOND
 *  resize listener for the settings panel's scale label. One publisher, two consumers, both of which
 *  RECONCILE (they compare against what they last applied) instead of being poked. */
export interface ViewportState {
  width: number;
  height: number;
  /** The aspect ratio the camera's projection was last BUILT for (`cameraView.render` writes it, and
   *  compares against it to know when to rebuild). A paint cache, but one the camera reconciler owns —
   *  kept here rather than as a private field of the system, like every other "what did I apply" value. */
  appliedAspect: number;
  /** The ONE resize listener has been installed (`platform/viewport.ts` — its own idempotence flag) */
  listenerInstalled: boolean;
  /** A coalesced "size changed" notification is already armed for the next frame */
  publishScheduled: boolean;
}

export const VIEWPORT = defineResource<ViewportState>("viewport");

/** Zero-sized until the platform service publishes: a consumer must therefore treat 0 as "unknown"
 *  rather than computing an aspect from it (see rendering/camera-view.ts). */
export function createViewport(): ViewportState {
  return {
    width: 0,
    height: 0,
    appliedAspect: Number.NaN,
    listenerInstalled: false,
    publishScheduled: false,
  };
}

/** The POINTER's last known position (CSS pixels, viewport-relative) and which buttons are down. Published
 *  by the DEVICE layer while it handles mousemove/mousedown/mouseup — it already listens to all three for
 *  gameplay, so this adds no listener — and read by anything that has to follow the cursor. The key bind
 *  drag is the first consumer: its rubber band and hover target used to be pushed by a SECOND `document`
 *  mousemove listener inside the view. */
export interface PointerState {
  x: number;
  y: number;
  /** The event's `buttons` bitmask (1 = left) */
  buttons: number;
}

export const POINTER = defineResource<PointerState>("pointer");

export function createPointer(): PointerState {
  return { x: 0, y: 0, buttons: 0 };
}

/** The DEVICE-TIMING state of the pointer-lock / raw-input layer: the ten fields that make
 *  ecs/systems/input.ts race-sensitive. They used to be private fields of that system, so the only way
 *  to see WHY a mousemove was swallowed — or to replay a race in a test — was to instrument the system.
 *  The values are world state like the rest of the device state; what does NOT move with them is the
 *  LOGIC (iron rule 3): every decision still happens in the same listener, in the same order, reading the
 *  same facts. This is a change of WHERE the fields live, never of when they are read or written.
 *
 *  What is deliberately NOT here: the queued `InputIntent`s. Producer and consumer are the same object
 *  there, and nothing outside it may observe a half-applied frame — a resource would be a promise the
 *  system cannot keep. */
export interface InputTiming {
  /** Ignore the single synthetic fake delta at lock instant (the first mousemove after locking must not
   *  rotate the view) */
  skipFirstMove: boolean;
  /** Grace window armed before an intentional unlock: swallows synthetic deltas during the
   *  exitPointerLock / SetCursorPos race (while still locked). Absolute performance.now() deadline. */
  lockGraceUntil: number;
  /** Set by prepareUnlock() when it is about to release a lock we hold, so the pointerlockchange that
   *  follows knows the unlock was ours and must NOT engage the offscreen fallback. */
  unlockIsIntentional: boolean;
  /** Raw-input takeover state tracking (logs one line on switch for diagnosis) */
  rawTakeoverActive: boolean;
  /** Offscreen check result cache (~120ms), so not every mouse event triggers layout/screen queries */
  offscreenCacheUntil: number;
  offscreenCached: boolean;
  /** Last Space press (a double tap toggles flying) plus the diagnostic counters behind the F3
   *  SPACE/MOUSE logs the debug forwarder drains. */
  lastSpaceDown: number;
  spaceSeq: number;
  mouseSeq: number;
  lastMouseLog: number;
}

export const INPUT_TIMING = defineResource<InputTiming>("inputTiming");

/** One decision the DEVICE layer already made, waiting for the fixed lane's first system to write it.
 *  The union lives here (and not in the input system) because the log below is its container; it is
 *  structural data, so this neutral file needs no platform import. */
export type InputIntent =
  | { kind: "key"; code: string; down: boolean }
  | { kind: "look"; yaw: number; pitch: number }
  | { kind: "motion"; flying: boolean; vy: number; onGround: boolean };

/** The queue of pending device intents. It used to be a PRIVATE field of ecs/systems/input.ts with the
 *  reasoning that "nothing outside may see a half-applied frame" — that guarantee is kept by the SHAPE
 *  instead: the only reader is `step()`, which drains the array in place at the top of the tick, and it
 *  cannot queue while it runs (one main thread). So what an outside reader sees is exactly "the decisions
 *  that have not been applied yet" — a pending log, which is what a resource is for. */
export interface InputIntentLog {
  /** Pending intents, oldest first. Emptied by the consumer at the top of the tick. */
  intents: InputIntent[];
  /** The raw mouse displacement that PASSED every guard since the last frame, waiting for the frame's
   *  single `frameLook()` to turn it into ONE `look` intent. It used to be two private fields of the
   *  input system: it is "the mouse movement this frame has not been given to the view yet", i.e. pending
   *  input — the same thing this resource is for, and now visible while it waits. */
  frameDx: number;
  frameDy: number;
}

export const INPUT_INTENTS = defineResource<InputIntentLog>("inputIntents");

export function createInputIntentLog(): InputIntentLog {
  return { intents: [], frameDx: 0, frameDy: 0 };
}

/** The three lanes' driver state: which MODE the one frame loop is in, the fixed-step and frame-cap
 *  accumulators, the viewport size the renderer was last sized to, and the window-geometry suppression
 *  deadline. They used to be seven module-level `let`s in main.ts — the loop's own bookkeeping, which the
 *  composition root could neither inspect nor reset. The loop BODY stays the adapter (a rAF callback
 *  cannot be a lane), but its state is world data now, like every other singleton. */
export type LoopMode = "load" | "game" | "menu";

export interface LoopState {
  mode: LoopMode;
  /** Fixed-step accumulator (seconds not yet simulated) */
  physAcc: number;
  /** Frame-cap accumulator: one frame is drawn once its budget has passed */
  renderAcc: number;
  /** The size the renderer was last sized to (0 = never) */
  appliedViewportW: number;
  appliedViewportH: number;
  /** `renderer.init()` has finished, so the canvas may be sized */
  rendererReady: boolean;
  /** Until this wall-clock time, a window geometry change is OUR OWN switch and must not pause */
  suppressGeometryUntil: number;
}

export const LOOP_STATE = defineResource<LoopState>("loopState");

export function createLoopState(): LoopState {
  return {
    // "load" until the boot driver picks a mode, so the first transition always applies
    mode: "load",
    physAcc: 0,
    renderAcc: 0,
    appliedViewportW: 0,
    appliedViewportH: 0,
    rendererReady: false,
    suppressGeometryUntil: 0,
  };
}

/** The FRAME probe's accumulators (one line per second + stall warnings + the per-frame look meter).
 *  Pure diagnostics, but the same rule as every other counter: they are data with an owner instead of a
 *  dozen module-level `let`s in the composition root. */
export interface FrameProbeState {
  last: number;
  n: number;
  sum: number;
  max: number;
  stalls: number;
  stallMax: number;
  statAt: number;
  /** Histogram of the per-frame look sample count (index = count, the last bucket folds the tail) */
  readonly pfBuckets: number[];
  pxMin: number;
  pxMax: number;
  pxSum: number;
  pxN: number;
}

export const FRAME_PROBE = defineResource<FrameProbeState>("frameProbe");

/** How many buckets the per-frame look histogram has (0..12 samples, folded into the last one) */
export const FRAME_PF_BUCKETS = 13;

export function createFrameProbe(): FrameProbeState {
  return {
    last: 0,
    n: 0,
    sum: 0,
    max: 0,
    stalls: 0,
    stallMax: 0,
    statAt: 0,
    pfBuckets: new Array<number>(FRAME_PF_BUCKETS).fill(0),
    pxMin: Number.POSITIVE_INFINITY,
    pxMax: 0,
    pxSum: 0,
    pxN: 0,
  };
}

/** The RAW-TRANSPORT counters behind the once-a-second `RAWLAG` line: the arrival rhythm of the
 *  `raw-input` events and an estimate of how long they sat in the queue. They used to be seven
 *  module-level `let`s inside platform/rawinput.ts — diagnostic state with no owner, written by the
 *  device layer and printed by the input system, i.e. exactly the "one value, two readers" shape a
 *  resource is for. */
export interface RawTransportCounters {
  /** Events seen in the current window */
  evCount: number;
  /** Longest gap between two arrivals in this window (ms) */
  gapMax: number;
  /** Arrival time of the previous event (0 = none yet) */
  lastArrive: number;
  /** Smallest (arrival - send) offset ever seen: the baseline the backlog is measured against, because
   *  the Rust and JS clocks have different origins */
  minOffset: number;
  backlogSum: number;
  backlogMax: number;
  /** When the current RAWLAG window started (0 = the first window) */
  lagAt: number;
}

/** The LOOK counters behind the once-a-second `LOOK` line: how many raw deltas arrived, how many became
 *  intents, which guard dropped the rest, the key-edge counts, and the per-frame meter the FRAME probe
 *  reads. They were private fields of the input system; they are diagnostics state, so they live next to
 *  the SPACE/MOUSE logs. */
export interface InputLookCounters {
  /** Raw deltas that arrived (one per Rust push) */
  raw: number;
  /** Intents pushed into the queue (one per frame while moving) */
  applied: number;
  /** Where the rest went: the takeover was off / the lock grace window / the spike guard */
  dropTakeover: number;
  dropGrace: number;
  dropSpike: number;
  /** The same three for the browser `mousemove` path: skip-first, grace, spike */
  mmSkip: number;
  mmGrace: number;
  mmSpike: number;
  /** Key edges seen (`down`/`repeat`/`up`) — holding a key should read ≈1/30/1 per second */
  keyDowns: number;
  keyRepeats: number;
  keyUps: number;
  /** The per-frame meter: how many `look` intents the last frame consumed and their pixel-equivalent */
  frameSamples: number;
  framePx: number;
  /** When the current LOOK window started (0 = the first window) */
  logAt: number;
}

/** The input system's DIAGNOSTIC LOGS (the SPACE/MOUSE windows the F3 panel shows and the debug log
 *  forwards). They are written by the device layer as it handles events and read by `diagnostics`, i.e.
 *  one log with two readers — which is what a resource is for. They used to travel as `queues: input`
 *  (a system handed to another system's constructor, which the "systems never import each other" rule
 *  only tolerated because it was a structural type). */
export interface InputDiagnostics {
  /** Newest-first, capped at 10 entries by the producer */
  readonly spaceLog: string[];
  readonly mouseLog: string[];
  /** Raw-transport counters (the RAWLAG line): written by the device layer, printed by the input system */
  readonly raw: RawTransportCounters;
  /** LOOK counters: written at event/step time by the input system, printed by it once a second */
  readonly look: InputLookCounters;
}

export const INPUT_DIAGNOSTICS = defineResource<InputDiagnostics>("inputDiagnostics");

export function createInputDiagnostics(): InputDiagnostics {
  return {
    spaceLog: [],
    mouseLog: [],
    raw: {
      evCount: 0,
      gapMax: 0,
      lastArrive: 0,
      minOffset: Number.POSITIVE_INFINITY,
      backlogSum: 0,
      backlogMax: 0,
      lagAt: 0,
    },
    look: {
      raw: 0,
      applied: 0,
      dropTakeover: 0,
      dropGrace: 0,
      dropSpike: 0,
      mmSkip: 0,
      mmGrace: 0,
      mmSpike: 0,
      keyDowns: 0,
      keyRepeats: 0,
      keyUps: 0,
      frameSamples: 0,
      framePx: 0,
      logAt: 0,
    },
  };
}

/** The debug-log sink (`platform/debuglog.ts` + `platform/shell.ts`): the diagnostics system forwards the
 *  input queues through it and writes its periodic PHYS line. Structural, so this neutral file needs no
 *  platform import — and a resource, so diagnostics takes no constructor arguments at all. */
export interface DebugLogSink {
  /** Forward the new entries of the input queues to the log file (incremental) */
  forward(queues: InputDiagnostics): void;
  /** Append one line to the debug log */
  line(text: string): void;
}

export const DEBUG_LOG = defineResource<DebugLogSink>("debugLog");

/** The F3 debug panel's two widget entities (the panel and its one preformatted text line). The HUD view
 *  SPAWNS them (spawning is a structural change, so it belongs to wiring) and `diagnostics` writes their
 *  data — it used to call back into the `Hud` object to do it, which made a render-lane system depend on
 *  a view. Passing the handles as data is what removes that dependency. */
export interface F3Panel {
  readonly panel: Entity;
  readonly body: Entity;
}

export const F3_PANEL = defineResource<F3Panel>("f3Panel");

/** The backpack/hotbar widget handles. The VIEW spawns them during wiring (a structural change) and
 *  publishes them here; `ui.inventory` — the system — writes their data every frame. Slots are indexed by
 *  inventory slot: `0..HOTBAR_SLOTS-1` is the hotbar strip, the rest the bag grid; `icons`/`counts` are the
 *  two children of each slot. Passing the handles as data is what moved the reconcile out of the view and
 *  into the system (the same shape as F3_PANEL above). */
/** SPARSE, and normal: the HOTBAR cells (indices `0..HOTBAR_SLOTS-1`) are a HUD ELEMENT now, so they exist
 *  only while `ui.hud` has that element mounted (P1.34) — installing/uninstalling the inventory layer spawns
 *  and despawns them. A reader must therefore skip a group with no handles instead of writing through them. */
export interface InventoryWidgets {
  readonly slots: readonly (Entity | undefined)[];
  readonly icons: readonly (Entity | undefined)[];
  readonly counts: readonly (Entity | undefined)[];
}

export const INVENTORY_WIDGETS = defineResource<InventoryWidgets>("inventoryWidgets");

export function createInputTiming(): InputTiming {
  return {
    skipFirstMove: false,
    lockGraceUntil: 0,
    unlockIsIntentional: false,
    rawTakeoverActive: false,
    offscreenCacheUntil: 0,
    offscreenCached: false,
    lastSpaceDown: 0,
    spaceSeq: 0,
    mouseSeq: 0,
    lastMouseLog: 0,
  };
}

/** Which MODAL UI surfaces are open — the single source of truth for "a UI owns the mouse", and the
 *  reason gameplay freezes. A surface PUBLISHES here when it becomes visible and invisible; the one
 *  gate (canControl) reads it.
 *
 *  Before this existed the answer was DERIVED, twice over: main.ts OR'd six container booleans at
 *  five different sites, and platform/pointerlock.ts folded that into a second copy on the input state,
 *  which denied control only INDIRECTLY (by suppressing raw-input takeover and by clearing
 *  freeMouseActive inside prepareUnlock). Two consequences: adding a seventh UI surface meant finding
 *  all five OR sites, and between prepareUnlock() and the asynchronous pointerlockchange the player
 *  stayed controllable for a frame with the menu already on screen. */
export interface UiModalState {
  /** Main menu, including its settings / language / packs / keybinds / world-type sub-panels */
  mainMenu: boolean;
  /** Pause menu, including its sub-panels */
  menu: boolean;
  /** The inventory / backpack panel */
  inventory: boolean;
  /** Which SETTINGS sub-panel is up, or null. Navigation DATA: the ESC step-back reads this instead of
   *  asking a surface (`SettingsPanels.openPanel()` used to keep the same fact in a closure), and the
   *  pause menu and the main menu share the field because only one of them can be up at a time. */
  settings: string | null;
  /** The main menu's world-type picker is up */
  gen: boolean;
}

export const UI_MODAL = defineResource<UiModalState>("uiModal");

export function createUiModalState(): UiModalState {
  return { mainMenu: false, menu: false, inventory: false, settings: null, gen: false };
}

/** True when any modal surface is open. The sub-panels deliberately have NO flag of their own: they
 *  are children of their container, so hiding the container hides them, and a stale `style.display`
 *  on a child (the ESC log has shown `gen=true` while in game) must not keep the game frozen. */
export function isModalUi(state: UiModalState): boolean {
  return state.mainMenu || state.menu || state.inventory;
}

/** True when a MENU owns the mouse, ignoring the inventory. The inventory key and its mouse binding
 *  must still be able to CLOSE the inventory, so they ask this narrower question. */
export function isMenuUi(state: UiModalState): boolean {
  return state.mainMenu || state.menu;
}

/** The frame-rate cap. `cap === 0` means unlimited, on disk and in memory alike.
 *
 *  WHY THIS IS A RESOURCE AND NOT A CLOSURE VARIABLE IN main.ts: the number is read EVERY FRAME by the
 *  loop's frame gate (which decides whether this frame draws and samples at all) and once per stats
 *  window by ecs/systems/diagnostics.ts, which prints it into the F3 panel. It is also a SETTING, so
 *  the composition root loads it at boot and writes it back when the panel changes it — it is the one
 *  setting that also gates the loop, which is exactly why it cannot live in a pure config module next
 *  to i18n/fonts/uiscale/background: those are read on change, this one is read per frame. */
export interface FrameCapState {
  /** Frames per second, or 0 for unlimited */
  cap: number;
}

/** The cap's DOMAIN, here rather than in the settings panel that draws it: a value the widget cannot
 *  express is not a legal value (a hand-edited `fpsCap: 1` used to load as 1 while the slider showed
 *  30 and the label showed "1 FPS"). The slider imports these, and `sanitizeFrameCap` enforces them, so
 *  there is exactly one declaration per number. The TOP of the range means UNLIMITED (0), matching what
 *  the widget's right end has always said. */
export const CAP_MIN = 30;
export const CAP_MAX = 240;
export const CAP_STEP = 2;

export const FPS_CAP = defineResource<FrameCapState>("fpsCap");

/** Sanitising factory: a hand-edited settings.json can hold anything, and a NaN/negative cap would
 *  make the frame gate's 1/cap budget nonsense. Anything unusable becomes "unlimited". */
export function createFrameCap(cap = 0): FrameCapState {
  return { cap: sanitizeFrameCap(cap) };
}

/** The same rule, for a value that arrives at RUNTIME (the SetFpsCap command): the factory sanitises
 *  the file, this sanitises the write, and they must not disagree about what a legal cap is.
 *
 *  It CLAMPS AND SNAPS into the cap's domain, so the value in force is always one the slider can
 *  express — that invariant is what keeps the label and the slider from disagreeing, and `check:ecs`
 *  asserts it by sweeping inputs through `snapToRange` with the same domain:
 *    * `<= 0` (or NaN/Infinity) -> 0, unlimited;
 *    * below CAP_MIN -> CAP_MIN (a "1" in the file becomes 30, not 1);
 *    * CAP_MAX or above -> 0, because the slider's TOP means unlimited;
 *    * anything between -> the nearest step from CAP_MIN (a hand-edited 59 becomes 60), and a value
 *      that rounds UP onto CAP_MAX also becomes 0. */
export function sanitizeFrameCap(cap: number): number {
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  const rounded = Math.round(cap);
  if (rounded < CAP_MIN) return CAP_MIN;
  if (rounded >= CAP_MAX) return 0;
  const snapped = CAP_MIN + Math.round((rounded - CAP_MIN) / CAP_STEP) * CAP_STEP;
  return snapped >= CAP_MAX ? 0 : snapped;
}

/** Whether the local player may be controlled: the pointer is usable AND no modal UI holds the
 *  mouse. Two independent reasons, ONE gate — and the reason a system may bail out early, keeping
 *  its last rendered state. */
export function canControl(devices: InputState, ui: UiModalState): boolean {
  return (devices.locked || devices.freeMouseActive) && !isModalUi(ui);
}

// ===== Configuration resources: the settings that are read ON THE TICK =====
// Configuration is not GAME state — nothing simulates it and no entity owns it — but part of it is read
// on the tick, which is what makes it world state: `movement`, `interaction` and `input` ask the bind
// table "which key is jump" every step, and the reconciler re-derives every widget's text from the
// dictionary every frame. So the mutable config VALUES live here: one owner, created and inserted by the
// composition root, declared (`readsExternal`) by every system that reads them. The modules that own the
// FILES — ui/i18n.ts, ui/fonts.ts, ui/uiscale.ts, platform/keybinds.ts — keep the I/O, the validation
// and the appliers, and read/write these objects through `adopt*`/`load*`. That is the same split as
// FPS_CAP: the file is configuration, the value in force is the world's.
//
// What is deliberately NOT here: the DICTIONARIES and the BLOCK REGISTRY. They are ASSETS — loaded once
// from the pack chain and never changed — and an asset is a constant, not state (the same call as the
// texture and icon caches). `background.ts` is in that group too: its kind is derived from the packs.
//
// The shapes are structural (a string, a map) on purpose: ecs/resources.ts imports nothing from ui/ or
// platform/, so the union types (`Lang`, `FontId`, `UIScaleMode`, `BindAction`) stay in the modules that
// validate them.
export interface LocaleState {
  /** The language in force ("zh"/"en"/"ja" — validated by ui/i18n.ts) */
  lang: string;
}
export interface FontState {
  /** The font pair in force ("pixel"/"system" — validated by ui/fonts.ts) */
  id: string;
}
export interface ScaleState {
  /** The UI scale mode in force ("small"/"normal"/"large"/"auto" — validated by ui/uiscale.ts) */
  mode: string;
}
export interface KeyMapState {
  /** action id -> bind code ("" = unbound). Seeded with the defaults by platform/keybinds.ts. */
  codes: Map<string, string>;
}

export const LOCALE = defineResource<LocaleState>("locale");
export const FONT = defineResource<FontState>("font");
export const UI_SCALE = defineResource<ScaleState>("uiScale");
export const KEYMAP = defineResource<KeyMapState>("keymap");

export function createLocale(lang = "zh"): LocaleState {
  return { lang };
}
export function createFont(id = "pixel"): FontState {
  return { id };
}
export function createScale(mode = "auto"): ScaleState {
  return { mode };
}
export function createKeyMap(): KeyMapState {
  return { codes: new Map() };
}

// ===== 1. Key EDGES: the one event log in the world =====
// A held-key SET cannot answer "did F3 go down this frame", and a system cannot listen to the DOM
// (only the device layer in ecs/systems/input.ts does). So that layer PUBLISHES edges here — at event
// time, where it already decides everything — and the systems that own a global key chord (ui.picker
// today) consume them from a lane. It lives in a RESOURCE and not in a component because there is one
// keyboard for the whole world, and it is a LOG rather than a signal because a consumer may run once
// per frame while several edges arrived.
//
// Growth is bounded by the producer (KEY_EDGE_CAP) so a world with no consumer cannot leak; a live
// consumer drains the log every frame, and in the worst case a burst older than the cap is dropped
// whole rather than half-applied.
export interface KeyEdge {
  /** Monotonic id, so several consumers can read the same log without stealing edges from each other
   *  (a consumer keeps its own cursor — see KeyEdgeReader). */
  readonly seq: number;
  /** KeyboardEvent.code ("KeyW", "F3", "Escape", …) or a mouse BUTTON's bind code ("MouseLeft") */
  readonly code: string;
  readonly down: boolean;
  /** Keyboard auto-repeat (a held key): a chord must not re-fire on it */
  readonly repeat: boolean;
}

export interface KeyEventLog {
  edges: KeyEdge[];
  /** Next seq to hand out (the producer owns it) */
  next: number;
}

/** Beyond this many undrained edges the OLDEST are dropped: a consumer that stopped consuming must
 *  not make the producer allocate forever, and a chord that is 64 keys stale is not a chord. A consumer
 *  whose cursor falls off the front simply misses those edges (they are older than the cap). */
export const KEY_EDGE_CAP = 64;

export const KEY_EVENTS = defineResource<KeyEventLog>("keyEvents");

export function createKeyEventLog(): KeyEventLog {
  return { edges: [], next: 1 };
}

/** Publish one edge (the device layer is the ONLY writer — see ecs/systems/input.ts) */
export function publishKeyEdge(log: KeyEventLog, edge: { code: string; down: boolean; repeat: boolean }): void {
  log.edges.push({ seq: log.next++, code: edge.code, down: edge.down, repeat: edge.repeat });
  if (log.edges.length > KEY_EDGE_CAP) log.edges.splice(0, log.edges.length - KEY_EDGE_CAP);
}

/** A cursor into the edge log. Two systems already need the same edges (ui.picker for the F3+F4 chord,
 *  ui.navigation for ESC and the inventory key), so the log is a READ-ONCE-PER-CONSUMER channel rather
 *  than a queue somebody drains: each reader sees every edge exactly once, in order. */
export class KeyEdgeReader {
  private seq = 0;

  constructor(private readonly log: KeyEventLog) {}

  /** Visit the edges published since the last call */
  drain(visit: (edge: KeyEdge) => void): void {
    for (const edge of this.log.edges) {
      if (edge.seq <= this.seq) continue;
      this.seq = edge.seq;
      visit(edge);
    }
  }
}

// ===== 2. The F3+F4 game-mode picker's state =====
// It used to be four private fields of ui/gamemode.ts, a class that listened to the DOM itself and
// reached the player's mode through an adapter closure the composition root built. The mode it edits
// is component data (CONTROL.mode), so the picker's own state belongs in the world next to it.
export interface PickerState {
  /** Is the picker panel up? */
  open: boolean;
  /** Index into the mode list the picker cycles through */
  sel: number;
  /** The chord's two keys, held: F3+F4 opens the picker, F3 release applies it */
  f3: boolean;
  f4: boolean;
  /** What `ui.picker` last did about "is a world running" — its paint cache, kept here rather than as a
   *  private field of the system (the panels are only touched when the answer changes). */
  outsideWorld: boolean;
}

export const PICKER_STATE = defineResource<PickerState>("pickerState");

export function createPickerState(): PickerState {
  return { open: false, sel: 0, f3: false, f4: false, outsideWorld: false };
}

// ===== 3. The toast =====
// `showToast` used to be a method that wrote two widgets and armed a setTimeout. The TIMER was the
// reason it could not be a system: nothing but a wall clock says "this message expires in 2.5 s",
// and the ui lane runs with dt = 0 while the main menu pumps it. So the deadline is DATA (an absolute
// wall-clock time) and the system that owns the toast compares against the clock — which also means
// a toast expires while the game is paused, exactly like the timeout it replaced.
export interface ToastState {
  /** i18n key, or the literal text when `raw` */
  key: string;
  raw: boolean;
  /** performance.now() deadline; <= now means "not showing" */
  until: number;
}

/** How long a toast stays up (ms) */
export const TOAST_MS = 2500;

export const TOAST = defineResource<ToastState>("toast");

export function createToastState(): ToastState {
  return { key: "", raw: false, until: 0 };
}

// ===== 4. The loading screen (the startup, and a world entry) =====
// The window is shown while the GPU is still being initialised, so the process needs something to
// put on screen BEFORE the game exists — a loading screen covering the startup stages (the settings
// check, `renderer.init()`) and, later, the spawn window's generation and meshing on the way into a
// world.
//
// WHY IT IS A RESOURCE AND NOT A DOM OVERLAY IN main.ts: the screen is UI, and this repo has exactly
// one way to write UI — a surface writes DATA and the reconciler paints it (see ecs/ui/system.ts).
// main.ts is the composition root and may not build an element or write a style string; it may only
// publish what the process is DOING, through the SetLoadingStage command. The ui lane's `ui.loading`
// system turns this state into widget data and the reconciler paints it, which is also why the loading
// text is an i18n KEY and why a language switch reaches a screen that is already up.
//
// `progress` is a 0..1 fraction because that is the fact the drivers know; the SEGMENT count of the
// bar it draws is presentation, so it lives here with the other shared shape constants.
export interface LoadingState {
  /** Is the loading screen up? false the moment the world (or the menu) is ready to be shown */
  active: boolean;
  /** 0..1 across the whole run of stages */
  progress: number;
  /** i18n key of the line under the title ("which stage is this") */
  key: string;
  /** i18n key of the note's LABEL, or "" when there is nothing to report. The note is the settings
   *  check's outcome — a key plus a list of setting names, so the two halves stay translatable. */
  noteKey: string;
  /** The note's literal text: setting names, a file name. Data, never a sentence — see `setUiText`. */
  noteValue: string;
}

/** Segments in the loading bar. The bar is a row of widgets rather than one element whose WIDTH is
 *  written per frame, because a width would be a style string written from inside a system. */
export const LOADING_SEGMENTS = 24;

export const LOADING_STATE = defineResource<LoadingState>("loadingState");

export function createLoadingState(): LoadingState {
  return { active: false, progress: 0, key: "", noteKey: "", noteValue: "" };
}

// ===== 5. Delayed intents: "do this in a moment" as DATA =====
// Four `setTimeout` calls were the only way this process could say "in a moment": closing the backpack
// relocked the mouse on the next event-loop turn, the lock manager retried a rejected lock after 1300 ms,
// and the cursor was re-asserted after the menu/Apps key (plus `requestAnimationFrame` for one more).
// Each was a TIMER owned by whichever module wanted it — invisible to the schedule, invisible in a debug
// log, and still running while the game was paused.
//
// The shape is the TOAST's, for the same reason: the DEADLINE is data (an absolute wall-clock time) and a
// system compares it against the clock. `ui.delays` (ecs/systems/delays.ts) applies what is due, once per
// frame, in the ui lane — the only lane that runs in every mode, which is exactly where a lost cursor or a
// lost capture has to be fixed. The EFFECTS stay injected there, so the queue holds nothing but data and
// the module that owns the effect still owns it.
export type DelayKind = "relock" | "cursor" | "lockRetry";

export interface DelayedIntent {
  /** performance.now() deadline: the intent is due once the clock has passed it */
  readonly at: number;
  readonly kind: DelayKind;
  /** WHY — the reason string of a relock, so its log line reads the same as the timeout's did */
  readonly arg: string;
}

export interface DelayedIntents {
  /** Arm `kind` in `delayMs`. Several of the same kind may be pending at once (the cursor re-assert
   *  deliberately fires at 0/32/80 ms), so the queue is ordered by DEADLINE and never deduplicated. */
  schedule(kind: DelayKind, delayMs: number, arg?: string): void;
  /** The intents whose deadline has passed, in deadline order, REMOVED from the queue. */
  takeDue(): DelayedIntent[];
  /** How many are waiting (diagnostics / the Node gate) */
  readonly pending: number;
  /** How many have been applied since boot (`ui.delays` counts them here — a diagnostic fact about the
   *  queue belongs to the queue, not to a private field of the system that drains it). */
  applied: number;
  /** The wall clock the queue runs on — injected so the gate can drive it instead of sleeping */
  now(): number;
}

/** Bound on the queue. The menu/Apps key schedules four re-asserts per press (twice: keydown AND keyup),
 *  so a held or hammered key must not grow this without limit. At the cap the FURTHEST deadline is
 *  dropped: the urgent re-asserts are the ones that win the cursor race. */
export const DELAY_QUEUE_CAP = 64;

export const DELAYED_INTENTS = defineResource<DelayedIntents>("delayedIntents");

export function createDelayedIntents(clock: () => number = () => performance.now()): DelayedIntents {
  const queue: DelayedIntent[] = [];
  const state = {
    schedule(kind: DelayKind, delayMs: number, arg = ""): void {
      const intent: DelayedIntent = { at: clock() + Math.max(0, delayMs), kind, arg };
      if (queue.length >= DELAY_QUEUE_CAP) {
        let furthest = 0;
        for (let i = 1; i < queue.length; i++) if (queue[i].at > queue[furthest].at) furthest = i;
        queue.splice(furthest, 1);
      }
      queue.push(intent);
      queue.sort((a, b) => a.at - b.at);
    },
    takeDue(): DelayedIntent[] {
      const now = clock();
      if (queue.length === 0 || queue[0].at > now) return [];
      let n = 0;
      while (n < queue.length && queue[n].at <= now) n++;
      return queue.splice(0, n);
    },
    get pending(): number {
      return queue.length;
    },
    /** `ui.delays` increments this; it is a plain field so the reader can see the count in the world. */
    applied: 0,
    now: clock,
  };
  return state;
}
