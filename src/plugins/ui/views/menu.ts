// ===== Pause menu + shared settings panel: a WIDGET surface =====
// This file used to be ~970 lines of hand-built DOM (60 appendChild, 60 inline style writes, 45 colour
// literals). It now declares its tree with prefabs and writes widget DATA; ecs/ui/system.ts owns every
// element. What is left here is logic: the panel state machine, the settings callbacks, and the key bind
// gesture.
//
// Structure:
//   1. Shared cross-instance state     — the key bind gesture is DOCUMENT-level (it must survive the
//                                        pointer leaving the panel), and its STATE is the
//                                        KEYBIND_GESTURE resource (ecs/ui/keybind.ts); the hit test
//                                        stays here because only the UI system owns the elements.
//   2. The key bind gesture            — click shield + capture-free drag + physical capture. This is
//                                        timing-sensitive: it works around Chromium click synthesis.
//                                        Read the block comments before touching anything.
//   3. The keyboard layout TABLE       — 104 physical key positions. Geometry as data, not style.
//   4. buildSettingsPanel()            — the settings panels (shared by pause menu + main menu).
//   5. Menu                            — the pause menu class.
//
// WHAT THE LISTENERS IN §2 NO LONGER DO: draw. The keycap highlight, the rubber band and the redraw of
// every panel instance are derived once per frame by `ui.keybind` (ecs/ui/keybind.ts) from the gesture
// resource and the bind table, so a bind change, a language switch and the async OS layout all land
// without a call site to remember. The listeners keep their exact order and decisions — they are the
// timing-sensitive half.
//
// Behavior contracts (do not break; verified flows: click-rebind, drag-bind, Esc unbind,
// double-instance redraw, wheel blocking, click-synthesis suppression):
//   - A left-button mousedown in capture mode binds immediately; Chromium synthesizes a click
//     afterwards which would re-trigger panel handlers -> one-shot click shield, armed WITHOUT
//     a self-clearing timeout (a long press would fire the timeout before the synthetic click
//     arrives and let it through, re-entering capture on the chip). Cleared by the click shield
//     when consumed, or by the global mouseup fallback when no click is synthesized.
//   - A capture-free drag RELEASE arms the same shield WITH a 0ms timeout (the synthetic click
//     follows mouseup synchronously and consumes it first; drags that pressed a second mouse
//     button break click synthesis, so the timeout is the fallback). The two arm paths differ
//     on purpose — merging them reintroduces the regression.
//   - Only the left button synthesizes clicks (right/middle/side produce contextmenu/auxclick),
//     which is why only mousedown-with-button-0 arms the shield in capture mode.
//
// THIS FILE OWNS NO DOM ANY MORE. The drag rubber band was the last element it created: an SVG line whose
// geometry was rewritten on every mousemove. It is a WIDGET now (`spawnKeybindLine` below) whose UI_LAYOUT
// string `ui.keybind` writes once per frame from the GESTURE + the POINTER resource — so the pointer
// position travels as data (published by the device layer, which already listens for mousemove) instead of
// through a second listener here. What is left of the gesture in this file is the EVENT-TIME half only:
// the click shield, the drag's mousedown/mouseup, the wheel block and the key-capture handler, all of them
// decisions that can only be taken inside the event that must be cancelled (see the contract above).
import { t, getLang, setLang } from "../../../data/assets/i18n";
import { getUIScaleMode, setUIScaleMode, getCurrentScale } from "../../../data/globals/uiscale";
import { installBindGestureHandlers } from "../../input/bind-gesture";
import { getFontId, setFontId } from "../../../data/globals/fonts";
import { listPacks } from "../../../data/assets/textures";
import type { WindowMode } from "../../../data/globals/shell";
import { getBind, setBind, beginCapture, endCapture, getCapturing, codeDisplayName, buttonToCode } from "../../input/keybinds";
import { KB_ACTIONS, type BindAction } from "../../../data/globals/binds";
import { KB_ROWS, TOWER_GRID, NUM_GRID, MOUSE_GRID } from "../../../data/globals/keylayout";
import { onConfigChange } from "../../../core/services/bus";
import type { Entity, World } from "../../../core/world";
import { CAP_MAX, CAP_MIN, CAP_STEP, sanitizeFrameCap, UI_MODAL, type UiModalState } from "../../../data/globals/resources";
import { stepBackSettings } from "../systems/navigation";
import { ACTION_KEYBIND_CHIP, ACTION_KEYBIND_KEY, onUiAction, UI_ACTIONS, type UiActionHandler } from "../../../data/globals/actions";
import { onUiSource, SOURCE_FPS_CAP, UI_SOURCES, type UiSource } from "../../../data/globals/sources";
import { PACK_LIST_CAPACITY } from "../../../data/globals/paint";
import {
  registerKeybindPanel,
  type KeybindChip,
  type KeybindGesture,
  type KeybindKeycap,
} from "../../../data/globals/keybind-gesture";
import type { UiHit } from "../../../shared/types/ui";
import { UI_THEME } from "../../../data/assets/theme";
import {
  setUiSelected,
  setUiText,
  setUiVisible,
  spawnButton,
  spawnGridKey,
  spawnLabel,
  spawnLayoutBox,
  spawnList,
  spawnPanel,
  spawnSlider,
} from "../components";

// ===== 1. Shared cross-instance state =====
// buildSettingsPanel is instantiated once by the pause menu and once by the main menu, each with its own
// widget subtree. They show ONE bind table, so what they render is derived every frame by
// `ui.keybind` (ecs/ui/keybind.ts) from that table — there is no per-instance refresh to call and no
// cross-instance desync to avoid: the old `keybindRenderers` registry + imperative `renderAllPanels()`
// existed only because the panels owned copies of the state they displayed.

/** What the document-level drag needs in order to reach the widget tree: the world (for the theme), the
 *  hit test (which only the UI system can answer — it owns the elements) and the GESTURE STATE, which is
 *  the world resource ecs/ui/keybind.ts declares. The object is created by the composition root, handed
 *  over here AND inserted as that resource, so the listeners below and the system that applies them see
 *  the same data. Set once during wiring, because the gesture outlives any one panel. */
export interface KeybindDragDeps {
  /** The platform's log sink, INJECTED (a plugin may not import `host/`). */
  log: (line: string) => void;
  readonly world: World;
  readonly hitTest: (x: number, y: number) => UiHit | null;
  readonly gesture: KeybindGesture;
}
let dragDeps: KeybindDragDeps | null = null;
export function bindKeybindDrag(deps: KeybindDragDeps): void {
  dragDeps = deps;
  // Install the gesture's DEVICE listeners (platform/bind-gesture.ts) — the click shield, the drag's
  // start/end, the wheel block and the key capture. They live in the device layer because every one of them
  // decides something inside the event itself; what is injected here is the state they read and the two
  // facts only this file knows: which action ids a chip/keycap carries, and the hit test that finds one.
  // A BIND is no longer written here: the listener queues the decision (KEYBIND_GESTURE.rebinds) and
  // `ui.keybind` applies it in the ui lane.
  installBindGestureHandlers({
    gesture: gestureState,
    capturing: getCapturing,
    endCapture,
    queueRebind: (intent) => deps.gesture.rebinds.push(intent),
    chipAction: ACTION_KEYBIND_CHIP,
    keycapCodeAt: (x, y) => keycapAt(x, y)?.code ?? null,
    hitTest: (x, y) => deps.hitTest(x, y),
    armShield: armSuppressNextClick,
    buttonToCode: (button) => buttonToCode(button),
    log: deps.log,
  });
}

/** The gesture, for the event-time readers below. They MUST see the live state synchronously (the click
 *  shield decides inside the click it swallows), which is why it is data they read rather than a step
 *  they wait for. */
function gestureState(): KeybindGesture | null {
  return dragDeps?.gesture ?? null;
}

/** The codes bound to an action right now — the keycap "blue face" state. Injected into `ui.keybind`,
 *  because the bind table is platform state this file happens to know the layout of. */
export function boundCodes(): Set<string> {
  const bound = new Set<string>();
  for (const { action } of KB_ACTIONS) {
    const code = getBind(action);
    if (code) bound.add(code);
  }
  return bound;
}

/** Arm the one-shot click shield. schedSelf=false (capture-mode mousedown): cleared by the click shield
 *  when the synthetic click is consumed, or by the global mouseup fallback if none is synthesized.
 *  schedSelf=true (drag release): also schedule a 0ms self-clear — the synthetic click follows
 *  mouseup synchronously and consumes the flag first; the timeout only covers the no-click paths. */
function armSuppressNextClick(schedSelf: boolean): void {
  const g = gestureState();
  if (!g) return;
  g.shield = true;
  if (schedSelf) {
    setTimeout(() => {
      g.shield = false;
    }, 0);
  }
}

/** The drag RUBBER BAND, as a widget prefab. One layout-only box: its UI_LAYOUT string carries
 *  left/top/width/rotate and is rewritten by `ui.keybind` once per frame while a drag is past its
 *  threshold, so the geometry is DATA (derived from the gesture + the POINTER resource) and the
 *  reconciler paints it. Spawned by the composition root during wiring — spawning is a structural change,
 *  which a system may not make (iron rule 1). */
export function spawnKeybindLine(world: World): Entity {
  const line = spawnLayoutBox(world, null, "kb.line", "left:0;top:0;width:0;");
  // HIDDEN through the widget's own UI_STATE, like every other widget — the layout string carries the
  // geometry only, so `ui.keybind` rewriting it cannot accidentally reveal the line.
  setUiVisible(world, line, false);
  return line;
}

/** The drag's hover target for `ui.keybind`: the keycap under a point. Only a widget whose action IS a
 *  keycap counts — a drag released over an action chip must not bind the chip's own value as a key. */
export function keycapAtPoint(x: number, y: number): Entity | null {
  return keycapAt(x, y)?.entity ?? null;
}

/** Cancel the drag in progress: clear the gesture and end a rebind capture. `ui.navigation` calls this for
 *  ESC — the ONE decision-maker for that key (see its Escape branch). The device listener in
 *  platform/bind-gesture.ts only neutralizes keyboard defaults while a drag is live; deciding there too is
 *  what made ESC both cancel the drag AND walk up a menu level once the registration order changed. */
export function cancelKeybindDrag(reason: string, log: (line: string) => void): void {
  const g = gestureState();
  if (!g?.drag) return;
  g.drag = null;
  g.hover = null;
  endCapture();
  log(`KBCAP drag cancelled (${reason})`);
}

/** The KEYCAP under a point, if any. Only a widget whose action IS a keycap counts: a drag released
 *  over an action chip must not bind the chip's own value as a key. */
function keycapAt(x: number, y: number): { entity: Entity; code: string } | null {
  const hit = dragDeps?.hitTest(x, y) ?? null;
  if (!hit || hit.action !== ACTION_KEYBIND_KEY) return null;
  return { entity: hit.entity, code: hit.value };
}

// ===== 2. The key bind gesture =====
// The gesture's STATE is the KEYBIND_GESTURE resource (ecs/ui/keybind.ts): the drag in progress, the
// keycap it lit, the live pointer position and the click shield. What the listeners below do NOT do any
// more is the PRESENTATION — the keycap highlight, the rubber band and the panel redraw are derived from
// that state once per frame by `ui.keybind`. Their order, their decisions and their synchronous reads
// are unchanged: they are timing-sensitive click-synthesis handling (see the contract at the top).

// Capture-free drag binding: hold an action chip and drop it onto a keycap — no capture mode
// needed first. Either mouse button can start; the drag records the initiator — presses/releases
// of the OTHER button during the drag must be ignored (no interruptions/misbinds). Movement
// beyond the threshold makes it a drag; a plain click falls through to the native click's
// select toggle.

/** The key bind panel's two actions are DATA (`data/globals/actions.ts`). This flag is the file's own
 *  "registered once" bit: they are instance-independent (the capture state and the binds are global), so
 *  both settings instances dispatch to the same handlers — registered once, or the second instance would
 *  collide on the id. */
let keybindActionsReady = false;

function registerKeybindActions(actions: Map<string, UiActionHandler>, log: (line: string) => void): void {
  if (keybindActionsReady) return;
  keybindActionsReady = true;
  onUiAction(actions, ACTION_KEYBIND_CHIP, (value) => {
    const action = value as BindAction; // the chip's value IS a BindAction (see the spawn loop)
    log(`KBCAP click interactive button action=${action} capturing=${getCapturing() ?? "null"}`);
    if (getCapturing() === action) endCapture();
    else beginCapture(action);
  });
  onUiAction(actions, ACTION_KEYBIND_KEY, (code) => {
    const selected = getCapturing();
    if (!selected) return; // Clicking the keyboard with no action selected is a no-op
    setBind(selected, code);
    endCapture();
    log(`KBCAP keycap bind done (${code})`);
  });
}

// Global click shield (capture phase: runs before all elements' own click). Swallows every synthetic
// click while capture/drag is active or the shield is armed — the physical press already completed the
// binding, so the browser-generated click must not re-trigger chip reselect/keycap pick/back button.
// Consuming the shield clears it (except during drags, where a drag may outlive one click —
// preserving the original semantics).
// ===== 2b. The gesture's DEVICE listeners =====
// The five `document` listeners that used to sit here (click shield, mouseup = fallback + drag end, wheel
// block, key capture, drag start) are in `platform/bind-gesture.ts` now: they decide things that can only
// be decided INSIDE the event, which makes them device-layer code rather than a view's — this file was the
// last place in the project where a view owned `document` listeners. They are relocated, not refactored
// (not one condition or order changed), and they are installed by `bindKeybindDrag` below with the two
// things only this file can answer: which action ids a chip/keycap carries, and the hit test that finds one.

// ===== 3. The keyboard layout table =====
// The visual keyboard's codes, widths and grid areas are DATA now (`data/globals/keylayout.ts`), and so
// are the bind panel's rows with their i18n keys (`data/globals/binds.ts`). This file composes them into
// keycaps and chips; it holds no table of its own.

// The pack list's CAPACITY is data too: `PACK_LIST_CAPACITY` (data/globals/paint.ts).

// ===== 4. Shared settings panel =====

export interface SettingsCallbacks {
  getFpsCap: () => number;
  onFpsCap: (cap: number) => void;
  isGpuVsyncDisabled: () => boolean;
  onToggleGpuVsync: (disabled: boolean) => boolean;
  /** The "Diagnostic log" switch: it only gates whether probe lines reach `debug.log`,
   *  and is on by default. */
  isDiagLogEnabled: () => boolean;
  onToggleDiagLog: (on: boolean) => boolean;
  getWindowMode: () => WindowMode;
  onSetWindowMode: (mode: WindowMode) => void;
  /** The platform's log sink and the two config subscriptions, INJECTED: a plugin may not import
   *  `host/` (the layer rule in check:ecs). */
  log: (line: string) => void;
  onViewportChange: (cb: () => void) => void;
  onWindowModeChange: (cb: () => void) => void;
}

// Pause menu callbacks: the settings panel's six items + resume / back to main menu
export interface MenuCallbacks extends SettingsCallbacks {
  onResume: () => void;
  onToMainMenu: () => void;
}

export type SettingsPanelId = "settings" | "lang" | "pack" | "keybind";

/** The id of the frame cap's binding source. Registered ONCE (both settings instances read the same
 *  value through it), and the only place that knows the mapping between what is stored (0 = unlimited)
 *  and the slider's own domain (the TOP of its range means unlimited). */
// The frame cap's source id is DATA (`SOURCE_FPS_CAP`, data/globals/sources.ts).
let fpsSourceReady = false;

function registerFpsSource(
  sources: Map<string, UiSource>,
  getFpsCap: () => number,
): void {
  if (fpsSourceReady) return;
  fpsSourceReady = true;
  onUiSource(sources, SOURCE_FPS_CAP, () => {
    const cap = getFpsCap();
    return cap === 0 ? CAP_MAX : cap;
  });
}

/** What a caller gets back from buildSettingsPanel: the panel state machine, as data. */
export interface SettingsPanels {
  /** Which sub-panel is up, or null — the fact lives in `UI_MODAL.settings`, so the ESC step-back and the
   *  painter read the same thing (the hand-written menu read `element.style.display` back out of the DOM,
   *  which is how "the first ESC after resuming from settings did nothing" became possible). */
  openPanel(): SettingsPanelId | null;
  /** Show one sub-panel (and hide its siblings), or none at all with `null`. */
  show(id: SettingsPanelId | null): void;
  /** Hide all of them (the caller shows its own main panel). */
  hideAll(): void;
  /** The four panel widgets, for the system that paints modal visibility (ui.navigation). */
  readonly entities: Readonly<Record<SettingsPanelId, Entity>>;
}

// Shared settings panel: FPS cap slider + vsync toggle + language collection + resource pack
// collection + key binds + window mode + UI scale + back. The panels are spawned as CHILDREN of the
// caller's root widget, so hiding the caller hides them (no modality flag, no z-index juggling).
//
// `id` namespaces the panel's action ids: the pause menu and the main menu each build one, and both
// dispatch through the same table, so "pause.fpsCap" and "main.fpsCap" are distinct handlers.
export function buildSettingsPanel(
  world: World,
  root: Entity,
  id: string,
  opts: SettingsCallbacks & { onBack: () => void },
): SettingsPanels {
  const actions = world.resource(UI_ACTIONS);
  registerKeybindActions(actions, opts.log);

  const panels: Record<SettingsPanelId, Entity> = {
    settings: spawnPanel(world, root, "settings.panel", { hidden: true }),
    lang: spawnPanel(world, root, "settings.panelWide", { hidden: true }),
    pack: spawnPanel(world, root, "settings.panel", { hidden: true }),
    keybind: spawnPanel(world, root, "settings.panelXl", { hidden: true }),
  };
  // Which sub-panel is up is DATA (`UI_MODAL.settings`), not a closure variable: ui.navigation paints the
  // panels from it and the ESC step-back reads it, so there is one answer. These two functions only
  // write that state (and refresh the PUSHED labels, whose strings are composed rather than bound).
  const show = (which: SettingsPanelId | null): void => {
    world.resource(UI_MODAL).settings = which;
    // The panel's PUSHED text (the cap label, whose string is composed rather than bound) is refreshed
    // when it opens. The bound slider needs no such thing: it tracks the value in force every frame.
    if (which === "settings") {
      renderCap();
      renderScaleLabel();
    }
  };
  const hideAll = (): void => show(null);

  // --- FPS cap slider: 30..240, maxed = unlimited (0) ---
  spawnLabel(world, panels.settings, "settings.title", "menu.settings");
  spawnLabel(world, panels.settings, "settings.label", "settings.fpsCap");
  const capValue = spawnLabel(world, panels.settings, "settings.value", "", { raw: true });
  const capSlider = spawnSlider(
    world,
    panels.settings,
    "settings.range",
    `${id}.fpsCap`,
    "",
    {
      // The domain comes from ecs/resources.ts, where `sanitizeFrameCap` enforces it: a stored value is
      // therefore always one of these, so `initial` needs no clamping of its own (only the 0 -> top
      // mapping, which is what the slider's right end has always meant).
      min: CAP_MIN,
      max: CAP_MAX,
      step: CAP_STEP,
      initial: opts.getFpsCap() || CAP_MAX,
    },
    SOURCE_FPS_CAP, // BOUND: every settings instance shows the value in force, not its own copy
  );
  registerFpsSource(world.resource(UI_SOURCES), opts.getFpsCap);

  // --- GPU vsync toggle ---
  let gpuVsyncDisabled = opts.isGpuVsyncDisabled();
  const gpuBtn = spawnButton(world, panels.settings, "settings.btn", `${id}.vsync`, "", "settings.vsyncOff");
  const renderGpu = (): void => {
    setUiText(world, gpuBtn, gpuVsyncDisabled ? "settings.vsyncOff" : "settings.vsyncOn");
  };
  onUiAction(actions, `${id}.vsync`, () => {
    const next = !gpuVsyncDisabled;
    if (opts.onToggleGpuVsync(next)) {
      gpuVsyncDisabled = next;
      renderGpu();
    }
  });

  // --- "Diagnostic log": whether the FRAME/LOOK/RAWLAG/RAWMON/STALL/PHYS/SPACE#/MOUSE# lines
  //     reach debug.log. On by default; off keeps only the real event records — no restart needed. ---
  let diagLog = opts.isDiagLogEnabled();
  const diagBtn = spawnButton(
    world,
    panels.settings,
    "settings.btn",
    `${id}.diagLog`,
    "",
    diagLog ? "settings.diagLogOn" : "settings.diagLogOff",
  );
  onUiAction(actions, `${id}.diagLog`, () => {
    const next = !diagLog;
    if (opts.onToggleDiagLog(next)) {
      diagLog = next;
      setUiText(world, diagBtn, diagLog ? "settings.diagLogOn" : "settings.diagLogOff");
    }
  });

  // --- Language & fonts: entry button + two-column sub-panel ---
  spawnButton(world, panels.settings, "settings.btn", `${id}.openLang`, "", "settings.languageFont");
  onUiAction(actions, `${id}.openLang`, () => show("lang"));

  spawnLabel(world, panels.lang, "settings.title", "settings.languageFont");
  const choiceWrap = spawnPanel(world, panels.lang, "settings.columns");
  const langCol = spawnPanel(world, choiceWrap, "settings.column");
  spawnLabel(world, langCol, "settings.columnLabel", "settings.language");
  const langChoices = (["zh", "en", "ja"] as const).map((lang) => ({
    key: lang,
    entity: spawnButton(world, langCol, "settings.choice", `${id}.lang`, lang, `lang.${lang}`),
  }));
  const fontCol = spawnPanel(world, choiceWrap, "settings.column");
  spawnLabel(world, fontCol, "settings.columnLabel", "settings.font");
  const fontChoices = (["pixel", "system"] as const).map((font) => ({
    key: font,
    entity: spawnButton(world, fontCol, "settings.choice", `${id}.font`, font, `fonts.${font}`),
  }));
  spawnButton(world, panels.lang, "settings.btn", `${id}.langBack`, "", "menu.back");
  onUiAction(actions, `${id}.lang`, (value) => setLang(value as "zh" | "en" | "ja"));
  onUiAction(actions, `${id}.font`, (value) => setFontId(value as "pixel" | "system"));
  onUiAction(actions, `${id}.langBack`, () => show("settings"));

  // --- Resource packs: entry button + sub-panel listing game\resourcepacks\ ---
  spawnButton(world, panels.settings, "settings.btn", `${id}.openPack`, "", "settings.resourcepacks");
  onUiAction(actions, `${id}.openPack`, () => {
    show("pack");
    renderPacks();
  });

  spawnLabel(world, panels.pack, "settings.title", "settings.resourcepacks");
  const packScroll = spawnPanel(world, panels.pack, "settings.scrollArea");
  const packRows = spawnList(world, packScroll, "settings.row", PACK_LIST_CAPACITY);
  const packCells = packRows.map((row) => ({
    row,
    name: spawnLabel(world, row, "settings.rowName", "", { raw: true }),
    meta: spawnLabel(world, row, "settings.rowMeta", "", { raw: true }),
  }));
  const packEmpty = spawnLabel(world, panels.pack, "settings.empty", "settings.packsEmpty");
  spawnButton(world, panels.pack, "settings.btn", `${id}.packBack`, "", "menu.back");
  onUiAction(actions, `${id}.packBack`, () => show("settings"));

  const renderPacks = (): void => {
    const packs = listPacks();
    if (packs.length > PACK_LIST_CAPACITY) {
      opts.log(`PACKS ${packs.length} installed, only ${PACK_LIST_CAPACITY} rows exist (fixed capacity)`);
    }
    setUiVisible(world, packEmpty, packs.length === 0);
    packCells.forEach((cell, i) => {
      const pack = packs[i];
      setUiVisible(world, cell.row, pack !== undefined);
      if (!pack) return;
      setUiText(world, cell.name, pack.name, true);
      setUiText(
        world,
        cell.meta,
        `${pack.builtin ? t("settings.packsBuiltin") + " · " : ""}${pack.fileCount}`,
        true,
      );
    });
  };

  // --- Key binds: entry button + sub-panel (action chips + visual keyboard) ---
  spawnButton(world, panels.settings, "settings.btn", `${id}.openKeybind`, "", "settings.keybinds");
  onUiAction(actions, `${id}.openKeybind`, () => show("keybind"));

  // Key bind sub-panel: action chips + visual keyboard (full 104-key ANSI layout, fixed QWERTY
  // reference geometry = KeyboardEvent.code physical positions). Interaction: click an action
  // chip to select -> click a keyboard key to bind; conflict preemption handled by setBind.
  spawnLabel(world, panels.keybind, "kb.title", "settings.keybinds");
  spawnLabel(world, panels.keybind, "kb.hint", "bind.hint");
  const kbFlex = spawnPanel(world, panels.keybind, "kb.flex");
  const kbBoard = spawnPanel(world, kbFlex, "kb.board");
  const kbSide = spawnPanel(world, kbFlex, "kb.side");
  spawnLabel(world, kbSide, "kb.sideTitle", "settings.bindOptions");
  const chipList = spawnPanel(world, kbSide, "kb.chips");

  // Keycap legends: prefer the OS's actual layout (Keyboard Map API), fall back to QWERTY
  // reference letters on failure. Positions are always correct (code IS the physical position).
  let layoutLegends: Map<string, string> | null = null;
  const legendFor = (code: string): string => {
    const real = layoutLegends?.get(code);
    if (real) return real.length === 1 ? real.toUpperCase() : real;
    return codeDisplayName(code);
  };

  // What `ui.keybind` re-derives every frame from the bind table: one spec per panel INSTANCE, so the
  // pause menu and the main menu show the same thing by construction (they render from the same data,
  // not from two copies of it).
  const chipSpecs: KeybindChip[] = [];
  const capSpecs: KeybindKeycap[] = [];
  for (const { action, labelKey } of KB_ACTIONS) {
    const entity = spawnButton(world, chipList, "kb.chip", ACTION_KEYBIND_CHIP, action, "");
    chipSpecs.push({
      action,
      entity,
      labelKey,
      // Selected: the bare name (a KEY the reconciler re-resolves). Otherwise the name plus the current
      // key — a literal, because it carries a value.
      format: (code) => `${t(labelKey)} · ${code ? codeDisplayName(code) : t("bind.unbound")}`,
    });
  }

  /** code -> the keycap and its legend. The legend is a separate widget because the keycap is a
   *  `<button>` and its face is a `<span>` (the flex/grid centring relies on that). */
  const addKeycap = (parent: Entity, layout: string, code: string): void => {
    const key = spawnGridKey(world, parent, "kb.keycap", layout, ACTION_KEYBIND_KEY, code);
    const legend = spawnLabel(world, key, "kb.keyLegend", "", { raw: true });
    capSpecs.push({ code, key, legend, legendText: () => legendFor(code) });
  };

  for (const row of KB_ROWS) {
    const rowEl = spawnPanel(world, kbBoard, "kb.row");
    for (const [code, unit] of row) {
      const flex = `flex:${unit} ${unit} 0%;min-width:0;`;
      if (code === "") {
        // An empty cell: it is a ROW CELL with no key on it, so it uses the row-cell recipe and takes
        // its width from the layout table (the layout string always comes after the recipe, so the
        // exact flex wins over the recipe's default).
        spawnLayoutBox(world, rowEl, "kb.key", flex);
        continue;
      }
      addKeycap(rowEl, `${flex}height:1.8rem;`, code);
    }
  }
  const kbBottom = spawnPanel(world, kbBoard, "kb.bottom");
  const towerGrid = spawnPanel(world, kbBottom, "kb.tower");
  for (const cap of TOWER_GRID) addKeycap(towerGrid, `grid-area:${cap.area};`, cap.code);
  const numGrid = spawnPanel(world, kbBottom, "kb.numpad");
  for (const cap of NUM_GRID) addKeycap(numGrid, `grid-area:${cap.area};`, cap.code);
  const mouseGrid = spawnPanel(world, kbBottom, "kb.mouse");
  for (const cap of MOUSE_GRID) addKeycap(mouseGrid, `grid-area:${cap.area};`, cap.code);

  spawnButton(world, panels.keybind, "settings.btn", `${id}.keybindBack`, "", "menu.back");
  onUiAction(actions, `${id}.keybindBack`, () => {
    endCapture(); // Leaving the panel cancels an unfinished selection
    show("settings");
  });

  // This instance's chips and keycaps are now DATA `ui.keybind` renders every frame. Registering the
  // spec replaces the old `keybindRenderers.add(renderBinds)` + `renderAllPanels(...)` fan-out: a bind
  // change, a language switch and the OS layout arriving asynchronously all land on the next frame with
  // no call site to remember.
  registerKeybindPanel({ chips: chipSpecs, keycaps: capSpecs });

  // Async fetch of the OS keyboard layout for legends (silent fallback to the QWERTY reference)
  void (async () => {
    try {
      const kbApi = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
      if (kbApi?.getLayoutMap) {
        layoutLegends = await kbApi.getLayoutMap();
      }
    } catch {
      /* Fall back to reference letters */
    }
  })();

  // (The physical key/mouse capture listeners are module-level — see the top of this file.)

  // --- UI scale: small/normal/large/auto (MC-style GUI Scale) ---
  const scaleLabel = spawnLabel(world, panels.settings, "settings.label", "", { raw: true });
  const scaleRow = spawnPanel(world, panels.settings, "settings.btnRow");
  const scaleChoices = (["small", "normal", "large", "auto"] as const).map((key) => ({
    key,
    entity: spawnButton(world, scaleRow, "settings.choice", `${id}.uiScale`, key, `uiScale.${key}`),
  }));
  onUiAction(actions, `${id}.uiScale`, (value) => setUIScaleMode(value as "small" | "normal" | "large" | "auto"));

  // --- Window mode: windowed / fullscreen (NW.js runtime switch, no restart) ---
  spawnLabel(world, panels.settings, "settings.label", "settings.windowMode");
  const wmRow = spawnPanel(world, panels.settings, "settings.btnRow");
  const wmChoices = (["windowed", "fullscreen"] as const).map((key) => ({
    key,
    entity: spawnButton(world, wmRow, "settings.choice", `${id}.windowMode`, key, `windowMode.${key}`),
  }));
  onUiAction(actions, `${id}.windowMode`, (value) => opts.onSetWindowMode(value as WindowMode));

  spawnButton(world, panels.settings, "settings.btn", `${id}.back`, "", "menu.back");
  onUiAction(actions, `${id}.back`, () => {
    hideAll();
    opts.onBack();
  });

  /** The choices whose selection is a live setting rather than static text. */
  const renderChoices = (): void => {
    for (const choice of scaleChoices) setUiSelected(world, choice.entity, getUIScaleMode() === choice.key);
    for (const choice of wmChoices) setUiSelected(world, choice.entity, opts.getWindowMode() === choice.key);
    for (const choice of langChoices) setUiSelected(world, choice.entity, getLang() === choice.key);
    for (const choice of fontChoices) setUiSelected(world, choice.entity, getFontId() === choice.key);
  };
  /** The FPS cap label. It reads the value IN FORCE (not the widget), and it is a PUSH rather than a
   *  binding because its text is composed — "60 FPS" is a literal, "unlimited" is a translated key —
   *  and formatting is surface logic. Hence the refresh when the panel opens: the slider itself needs
   *  none (it is bound).
   *
   *  `justSet` is for the drag: the value in force arrives through the `SetFpsCap` COMMAND, which applies
   *  at the next barrier, so re-reading the resource right after sending it prints the cap from the
   *  PREVIOUS drag step — and since nothing else refreshes this label, it stayed one step behind the
   *  slider until the panel was reopened. The handler hands over the number it just sent. */
  const renderCap = (justSet?: number): void => {
    const cap = justSet ?? opts.getFpsCap();
    const unlimited = cap === 0;
    setUiText(world, capValue, unlimited ? "settings.unlimited" : `${cap} FPS`, !unlimited);
  };
  const renderScaleLabel = (): void => {
    setUiText(
      world,
      scaleLabel,
      `${t("settings.uiScale")}: ${t(`uiScale.${getUIScaleMode()}`)} (${getCurrentScale().toFixed(2)}x)`,
      true,
    );
  };

  onUiAction(actions, `${id}.fpsCap`, (value) => {
    // One rule, one place: `sanitizeFrameCap` owns the domain, including "the widget's TOP means
    // unlimited" (>= CAP_MAX -> 0) — so the label can never print a number the resource will not hold.
    const cap = sanitizeFrameCap(Number(value));
    // Only the RESOURCE is written: the slider's own value is derived from it by the binding, so the
    // two settings instances cannot drift apart. (Pushing it here too is what made them disagree.)
    opts.onFpsCap(cap);
    // …and the label is HANDED that value: it is applied at the next barrier, so reading the resource
    // back here would print the previous drag step (see renderCap).
    renderCap(cap);
  });
  opts.onViewportChange(renderScaleLabel);
  onConfigChange("uiScale", renderChoices);
  opts.onWindowModeChange(renderChoices);
  onConfigChange("font", renderChoices);
  onConfigChange("lang", () => {
    // Static text is a key and needs nothing, and the KEY BIND panel needs nothing either: ui.keybind
    // re-derives its composed labels ("Sprint · ShiftLeft") every frame, so a language switch reaches
    // it without a subscription. Only the labels composed from a value HERE need this.
    renderCap();
    renderScaleLabel();
    renderChoices();
    if (world.resource(UI_MODAL).settings === "pack") renderPacks();
  });

  renderGpu();
  renderCap();
  renderScaleLabel();
  renderChoices();
  // (The key bind panel needs no initial render: `ui.keybind` derives it from the bind table every
  // frame, including the frame this panel is first shown.)

  return {
    openPanel: () => (world.resource(UI_MODAL).settings as SettingsPanelId | null),
    show,
    hideAll,
    entities: panels,
  };
}

// ===== 5. Pause menu =====

export class Menu {
  private readonly world: World;
  private readonly root: Entity;
  private readonly mainPanel: Entity;
  private readonly panels: SettingsPanels;
  private readonly onResume: () => void;
  private readonly onToMainMenu: () => void;

  /** The pause menu's navigation state, read from the resource it lives in (this class used to keep a
   *  `visible` field next to it, which is how two copies of the same fact start drifting). */
  private ui(): UiModalState {
    return this.world.resource(UI_MODAL);
  }

  constructor(world: World, cb: MenuCallbacks) {
    this.world = world;
    this.onResume = cb.onResume;
    this.onToMainMenu = cb.onToMainMenu;

    this.root = spawnPanel(world, null, "menu.root", { hidden: true });
    this.mainPanel = spawnPanel(world, this.root, "settings.panel");
    spawnLabel(world, this.mainPanel, "settings.title", "menu.paused");

    const actions = world.resource(UI_ACTIONS);
    spawnButton(world, this.mainPanel, "settings.btn", "pause.resume", "", "menu.resume");
    spawnButton(world, this.mainPanel, "settings.btn", "pause.openSettings", "", "menu.settings");
    spawnButton(world, this.mainPanel, "settings.btn", "pause.toMainMenu", "", "menu.toMainMenu");
    onUiAction(actions, "pause.resume", () => {
      this.hide();
      this.onResume();
    });
    onUiAction(actions, "pause.openSettings", () => {
      // Navigation is DATA: opening a sub-panel is one write, and ui.navigation paints it (the main
      // panel is up exactly when no sub-panel is).
      this.panels.show("settings");
    });
    onUiAction(actions, "pause.toMainMenu", () => {
      this.hide();
      this.onToMainMenu();
    });

    this.panels = buildSettingsPanel(world, this.root, "pause", {
      log: cb.log,
      onViewportChange: cb.onViewportChange,
      onWindowModeChange: cb.onWindowModeChange,
      getFpsCap: cb.getFpsCap,
      onFpsCap: cb.onFpsCap,
      isGpuVsyncDisabled: cb.isGpuVsyncDisabled,
      onToggleGpuVsync: cb.onToggleGpuVsync,
      isDiagLogEnabled: cb.isDiagLogEnabled,
      onToggleDiagLog: cb.onToggleDiagLog,
      getWindowMode: cb.getWindowMode,
      onSetWindowMode: cb.onSetWindowMode,
      onBack: () => this.panels.hideAll(),
    });
  }

  /** Is a settings sub-panel up? The answer is DATA (`UI_MODAL.settings`) — the same fact the ESC
   *  step-back reads and ui.navigation paints from, instead of a closure three callers asked. */
  get settingsOpen(): boolean {
    return this.ui().settings !== null;
  }

  goBack(): void {
    const ui = this.ui();
    if (ui.settings === null && !ui.gen) return;
    // The SAME ladder ESC uses (one mapping, see ecs/ui/navigation.ts) — it used to be copied here.
    stepBackSettings(ui);
  }

  show(): void {
    this.ui().menu = true;
  }

  hide(): void {
    const ui = this.ui();
    ui.menu = false;
    // Reset the sub-panels. Leaving `settings` set caused two stale-state bugs: the ESC branch tests it
    // BEFORE the menu flag, so the first ESC after resuming from settings was swallowed, and the
    // inventory key's menu guard kept the backpack shut for the rest of the session once settings had
    // ever been opened.
    ui.settings = null;
  }

  /** The widget handles ui.navigation paints from the state (this class no longer touches visibility) */
  get rootEntity(): Entity {
    return this.root;
  }
  get mainPanelEntity(): Entity {
    return this.mainPanel;
  }
  get panelEntities(): Readonly<Record<SettingsPanelId, Entity>> {
    return this.panels.entities;
  }
}
