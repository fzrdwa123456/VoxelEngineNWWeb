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
// WHAT THE PAGE'S LISTENERS NO LONGER DO: draw. The key highlight, the rubber band and the redraw of
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
// geometry was rewritten on every mousemove. It is a WIDGET now, spawned by the `ui-keybind` plugin, whose UI_LAYOUT
// string `ui.keybind` writes once per frame from the GESTURE + the POINTER resource — so the pointer
// position travels as data (published by the device layer, which already listens for mousemove) instead of
// through a second listener here. What is left of the gesture in this file is the EVENT-TIME half only:
// the click shield, the drag's mousedown/mouseup, the wheel block and the key-capture handler, all of them
// decisions that can only be taken inside the event that must be cancelled (see the contract above).
import { t, getLang, setLang } from "../../../data/assets/i18n";
import { declaredLanguages } from "../../../data/assets/languages";
import { getUIScaleMode, setUIScaleMode, getCurrentScale } from "../../../data/globals/uiscale";
import { getFontId, setFontId } from "../../../data/globals/fonts";
import { listPacks } from "../../../data/assets/textures";
import type { WindowMode } from "../../../data/globals/shell";
import { onConfigChange } from "../../../core/services/bus";
import type { Entity, World } from "../../../core/world";
import { CAP_MAX, CAP_MIN, CAP_STEP, sanitizeFrameCap, UI_MODAL, type UiModalState } from "../../../data/globals/resources";
import { stepBackSettings } from "../systems/navigation";
import { onUiAction, UI_ACTIONS } from "../../../data/globals/actions";
import { onUiSource, SOURCE_FPS_CAP, UI_SOURCES, type UiSource } from "../../../data/globals/sources";
import { PACK_LIST_CAPACITY } from "../../../data/globals/paint";
import { UI_THEME } from "../../../data/assets/theme";
import { UI_PAGE_HOSTS } from "../../../data/globals/ui-pages";
import {
  setUiSelected,
  setUiText,
  setUiVisible,
  spawnButton,
  spawnLabel,
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
/** The menu FROST: one full-screen layer, painted by `ui.navigation` while any modal surface is up. Spawned
 *  here (wiring time) because spawning is a structural change; `parent = null` = a child of the UI root. */
export function spawnMenuBackdrop(world: World): Entity {
  return spawnPanel(world, null, "ui.frost", { hidden: true });
}

export interface MenuCallbacks extends SettingsCallbacks {
  onResume: () => void;
  onToMainMenu: () => void;
}

export type SettingsPanelId = "settings" | "lang" | "pack";

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
  /** One entry per SECTION, plus `root` - the settings BOX itself (P1.49), up whenever a section is
   *  selected. `ui.navigation` paints both from `UI_MODAL.settings`, so the box and its sections agree. */
  readonly entities: Readonly<Record<SettingsPanelId | "root", Entity>>;
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

  // THE BOX (P1.49): one panel, a LEFT nav column and a RIGHT content area. There are no sub-panels any
  // more - a nav button SELECTS a section (it writes `UI_MODAL.settings`, the same state as before), and
  // `ui.navigation` paints the box plus whichever section that value names.
  // A DYNAMIC width (P1.49c): the box holds a nav COLUMN plus the content, and the sections differ wildly -
  // the key bind page wants the keyboard board plus its chip column, which a fixed 40rem could not give it.
  const settingsRoot = spawnPanel(world, root, "settings.panelAuto", { hidden: true });
  // THE BOX TITLE IS SPAWNED FIRST - not cosmetic. Creation order IS render order (the reconciler only
  // appends children, it never re-orders), so a label spawned after `split` renders BELOW the nav plus
  // content block, i.e. at the bottom of the box next to Back. P1.49 introduced the split at the top of
  // this function while this line stayed where it was, which is how the title ended up down there.
  spawnLabel(world, settingsRoot, "settings.title", "menu.settings");
  const split = spawnPanel(world, settingsRoot, "settings.split");
  const nav = spawnPanel(world, split, "settings.nav");
  const content = spawnPanel(world, split, "settings.content");
  // The sections are LAYOUT-NEUTRAL containers inside the content area: the box around them is the panel, so
  // a section must not draw a second border of its own.
  const panels: Record<SettingsPanelId, Entity> = {
    settings: spawnPanel(world, content, "settings.pageRows", { hidden: true }),
    lang: spawnPanel(world, content, "settings.pageRows", { hidden: true }),
    pack: spawnPanel(world, content, "settings.pageRows", { hidden: true }),
  };
  // THE LEFT NAV: one row per section, and the PAGE host mounts its rows into this SAME column (P1.49), so a
  // page a plugin contributes (the key bind page) becomes a nav item instead of an entry button.
  const navRows: { id: SettingsPanelId; entity: Entity }[] = [
    { id: "settings", entity: spawnButton(world, nav, "settings.choice", `${id}.section`, "settings", "settings.graphics") },
    { id: "pack", entity: spawnButton(world, nav, "settings.choice", `${id}.section`, "pack", "settings.resourcepacks") },
    { id: "lang", entity: spawnButton(world, nav, "settings.choice", `${id}.section`, "lang", "settings.languageFont") },
  ];
  onUiAction(actions, `${id}.section`, (value) => show(value as SettingsPanelId));
  /** Which nav row is the selected one. The selection IS `UI_MODAL.settings`, so this only mirrors it. */
  const renderNav = (): void => {
    const current = world.resource(UI_MODAL).settings;
    for (const row of navRows) setUiSelected(world, row.entity, current === row.id);
  };
  // Which sub-panel is up is DATA (`UI_MODAL.settings`), not a closure variable: ui.navigation paints the
  // panels from it and the ESC step-back reads it, so there is one answer. These two functions only
  // write that state (and refresh the PUSHED labels, whose strings are composed rather than bound).
  const show = (which: SettingsPanelId | null): void => {
    world.resource(UI_MODAL).settings = which;
    renderNav();
    // The panel's PUSHED text (the cap label, whose string is composed rather than bound) is refreshed when
    // its section opens. The bound slider needs no such thing: it tracks the value in force every frame.
    if (which === "settings") {
      renderCap();
      renderScaleLabel();
    }
    // The pack list is a PUSH too (it comes from disk): refresh it whenever its section is selected.
    if (which === "pack") renderPacks();
  };
  const hideAll = (): void => show(null);

  // --- FPS cap slider: 30..240, maxed = unlimited (0) ---
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

  // --- Language & fonts: a SECTION now (the nav selects it) ---

  spawnLabel(world, panels.lang, "settings.title", "settings.languageFont");
  const choiceWrap = spawnPanel(world, panels.lang, "settings.columns");
  const langCol = spawnPanel(world, choiceWrap, "settings.column");
  spawnLabel(world, langCol, "settings.columnLabel", "settings.language");
  // THE CHOICES ARE THE DECLARED SET (P1.36), discovered from the pack chain — the same list the content
  // plugin contributes and `loadLang` builds dictionaries from, so a pack shipping `lang/fr.json` gets a
  // picker entry instead of a file nobody can select. The label is the `lang.<id>` key, which the pack's own
  // dictionary is expected to hold (a missing one shows the raw key: a missing TRANSLATION, not a missing
  // language). Spawning happens during wiring, i.e. after `preloadPacks()`.
  const langChoices = declaredLanguages().map((lang) => ({
    key: lang,
    entity: spawnButton(world, langCol, "settings.choice", `${id}.lang`, lang, `lang.${lang}`),
  }));
  const fontCol = spawnPanel(world, choiceWrap, "settings.column");
  spawnLabel(world, fontCol, "settings.columnLabel", "settings.font");
  const fontChoices = (["pixel", "system"] as const).map((font) => ({
    key: font,
    entity: spawnButton(world, fontCol, "settings.choice", `${id}.font`, font, `fonts.${font}`),
  }));
  onUiAction(actions, `${id}.lang`, (value) => setLang(value as string));
  onUiAction(actions, `${id}.font`, (value) => setFontId(value as "pixel" | "system"));

  // --- Resource packs: a SECTION now, listing game\resourcepacks\ ---

  spawnLabel(world, panels.pack, "settings.title", "settings.resourcepacks");
  const packScroll = spawnPanel(world, panels.pack, "settings.scrollArea");
  const packRows = spawnList(world, packScroll, "settings.row", PACK_LIST_CAPACITY);
  const packCells = packRows.map((row) => ({
    row,
    name: spawnLabel(world, row, "settings.rowName", "", { raw: true }),
    meta: spawnLabel(world, row, "settings.rowMeta", "", { raw: true }),
  }));
  const packEmpty = spawnLabel(world, panels.pack, "settings.empty", "settings.packsEmpty");

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

  // --- THE PAGE HOST (P1.29): this panel does not know which pages exist. It registers WHERE a page may be
  //     mounted (this list, this root, this action-id prefix, this `show`), and `ui.pages` materializes every
  //     page a plugin contributes — including one contributed by a plugin installed while the game runs.
  // WHERE PAGE ROWS GO (P1.29): a container at THIS spot in the list — the position the key bind row used to
  // have. Pages are mounted as its CHILDREN, so the layout decides the position and the data decides how many
  // rows there are. (Mounting them straight into the settings panel appended them after the Back button:
  // creation order IS render order, and the reconciler never re-orders.)
  const pageRows = spawnPanel(world, nav, "settings.pageRows");
  world.resource(UI_PAGE_HOSTS).push({
    world,
    id,
    settingsPanel: panels.settings,
    rowContainer: pageRows,
    root: content,
    show: (page) => show(page as SettingsPanelId | null),
    log: opts.log,
  });

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

  spawnButton(world, settingsRoot, "settings.btn", `${id}.back`, "", "menu.back");
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
    entities: { ...panels, root: settingsRoot },
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
    spawnButton(world, this.mainPanel, "settings.btnSolid", "pause.resume", "", "menu.resume");
    spawnButton(world, this.mainPanel, "settings.btnSolid", "pause.openSettings", "", "menu.settings");
    spawnButton(world, this.mainPanel, "settings.btnSolid", "pause.toMainMenu", "", "menu.toMainMenu");
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
  get panelEntities(): Readonly<Record<SettingsPanelId | "root", Entity>> {
    return this.panels.entities;
  }
}
