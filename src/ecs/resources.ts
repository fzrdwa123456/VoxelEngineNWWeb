// ===== World-scoped resources =====
// Every singleton the systems share. Resources are how a system reaches shared state WITHOUT
// importing another system — the input system and the movement system both need "can the player be
// controlled?", and neither is allowed to know the other exists.
//
// Definitions live here rather than next to their owner on purpose: `voxel/` must not import the
// ECS (its standalone tests depend on that), and `systems/input.ts` must not be a dependency of
// `systems/movement.ts`. A neutral file is the only place both rules survive.

import { defineResource, type Entity, type Resource } from "./World";
import type { VoxelWorld } from "../voxel/world";

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
}

export const INPUT_STATE = defineResource<InputState>("inputState");

export function createInputState(): InputState {
  return { locked: false, freeMouseActive: false, rawInputActive: false };
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
}

export const PICKER_STATE = defineResource<PickerState>("pickerState");

export function createPickerState(): PickerState {
  return { open: false, sel: 0, f3: false, f4: false };
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
