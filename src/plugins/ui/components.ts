// ===== UI widgets: components + prefabs =====
// A widget is an ENTITY. Its tag/parent/creation order is a component, its text is an i18n KEY (or a
// literal), its look is a RECIPE from ecs/ui/theme.ts, its visibility/selection are DATA FIELDS, and
// its click (if it has one) is an ACTION ID dispatched to whoever owns the surface. The DOM element is
// owned by ecs/ui/system.ts, which reconciles the tree once per frame — so NO UI surface writes CSS,
// builds an element or touches the document any more, the menus included.
//
// WHY PREFABS ARE THE REUSE LAYER: `spawnLabel(world, panel, "f3.chunks")` is the whole widget. A new
// surface composes existing prefabs instead of pasting a 30-character style string for the third time,
// and the look of every label in the game changes in one recipe. The five prefabs below are the whole
// vocabulary the menus and the inventory need: panel, label, button, slider, list row.
//
// THE BARRIER RULE APPLIES TO THE UI TOO: spawning a widget is a STRUCTURAL change, so it happens
// during wiring or inside a command — never inside a system. A widget whose CONTENT varies is therefore
// spawned once and has its text written afterwards (see setUiText); a LIST is spawned at a fixed
// capacity and hides its unused tail (see spawnList), which is also why a longer pack list cannot grow
// the tree at runtime.
import { defineRecord, defineResource, NULL_ENTITY, type Entity, type Resource, type World } from "../../core/world";
import type { UiRecipe } from "../../data/assets/theme";

export type UiTag = "div" | "span" | "button" | "input";

/** Where a widget sits in the tree. `order` is the creation sequence: the reconciler APPENDS in that
 *  order and never re-orders, so a widget that must move is despawned and re-spawned. */
export interface UiTreeNode {
  readonly tag: UiTag;
  /** NULL_ENTITY = a root, mounted directly on the UI stage */
  readonly parent: Entity;
  readonly order: number;
}

export const UI_TREE = defineRecord<UiTreeNode>("uiTree", () => ({
  tag: "div",
  parent: NULL_ENTITY,
  order: 0,
}));

/** Text content: an i18n key by default, a literal string when `raw` (numbers, counters, log lines) */
export interface UiTextC {
  key: string;
  raw: boolean;
}
export const UI_TEXT = defineRecord<UiTextC>("uiText", () => ({ key: "", raw: false }));

/** Which style recipe this widget uses (see recipeStyle) */
export interface UiLookC {
  recipe: UiRecipe;
}
export const UI_LOOK = defineRecord<UiLookC>("uiLook", () => ({ recipe: "text.label" }));

/** Widget state. Plain fields, NOT markers: toggling visibility must not be a structural change, or a
 *  system could never do it (iron rule 1). */
export interface UiStateC {
  hidden: boolean;
  /** This widget is THE current pick (a choice/radio, a chip in capture mode, a picker item) — and,
   *  on a gesture, the widget the pointer is pointing AT (the key bind drag target). */
  selected: boolean;
  /** The widget is engaged by DATA rather than by a pick: a keycap that carries a binding. It needs
   *  its own field because a bound keycap can also be the drag target at the same time, and the two
   *  states look different (a blue face vs a white outline). */
  active: boolean;
}
export const UI_STATE = defineRecord<UiStateC>("uiState", () => ({
  hidden: false,
  selected: false,
  active: false,
}));

/** A widget that carries this is CLICKABLE: the reconciler wires its click to the surface's dispatch.
 *  `action` names the handler, `value` carries which choice it is (which language, which key code,
 *  which world type) — so one handler serves a whole group instead of one closure per button. */
export interface UiActionC {
  action: string;
  value: string;
}
export const UI_ACTION = defineRecord<UiActionC>("uiAction", () => ({ action: "", value: "" }));

/** A native range input. The widget IS the control: the reconciler writes min/max/step/value and
 *  reports every input event through the same dispatch as a click. */
export interface UiInputC {
  min: number;
  max: number;
  step: number;
  value: number;
}
export const UI_INPUT = defineRecord<UiInputC>("uiInput", () => ({ min: 0, max: 100, step: 1, value: 0 }));

/** Raw layout CSS for a widget, from a layout TABLE rather than a style role: the visual keyboard's
 *  104 physical key positions are data ("row 4, column 2, spanning two rows", or a flex weight), and
 *  there is no honest way to tokenise them. Deliberately narrow, and the only place a surface may hand
 *  the theme a geometry string — everything else must be a recipe. */
export const UI_LAYOUT = defineRecord<{ css: string }>("uiLayout", () => ({ css: "" }));

/** A background image (a data URL: a block icon, a menu background). `scrim` lays the theme's dark
 *  gradient over it, which is what keeps the main menu's title readable on a pack background. `tint` is
 *  a background COLOUR supplied as data — a block's registry colour, shown until its baked icon
 *  arrives — and it is data, not styling: the theme never sees it. */
export interface UiImageC {
  url: string;
  scrim: boolean;
  tint: string;
}
export const UI_IMAGE = defineRecord<UiImageC>("uiImage", () => ({ url: "", scrim: false, tint: "" }));

/** A native tooltip (`element.title`). Registry labels are data, so this is a literal, not a key. */
export const UI_TIP = defineRecord<{ text: string }>("uiTip", () => ({ text: "" }));

/** A BINDING: this widget's value comes from shared state, named here, resolved every frame by
 *  ecs/ui/bindings.ts. It is what keeps two sliders that show the same setting from drifting apart —
 *  the surface declares WHERE the value lives instead of pushing values into its own copy (which is
 *  how the main menu's FPS slider and the pause menu's ended up disagreeing with each other and with
 *  the value actually in force). The widget still owns its RANGE (that is presentation); it just does
 *  not own the number. */
export const UI_BIND = defineRecord<{ source: string }>("uiBind", () => ({ source: "" }));

/** Creation sequence — the reconciler appends DOM nodes in this order. It is a RESOURCE: it used to be a
 *  module-level `let`, i.e. global state shared by every World, so a second world (a test, the gate)
 *  continued the first one's numbering and two trees built in different worlds could not be compared.
 *  One counter per world is what "the creation sequence of THIS tree" means. */
export interface UiOrderState {
  next: number;
}

export const UI_ORDER: Resource<UiOrderState> = defineResource<UiOrderState>("uiOrder");

export function createUiOrder(): UiOrderState {
  return { next: 1 };
}

export interface UiSpawnOptions {
  readonly text?: string;
  /** Interpret `text` as a literal instead of an i18n key */
  readonly raw?: boolean;
  readonly hidden?: boolean;
  /** Give the widget a background image slot, so a system (the inventory view) can fill it later
   *  without inserting a component — inserting is a structural change, and a system may not. */
  readonly image?: { readonly url: string; readonly scrim: boolean; readonly tint?: string };
  /** Give the widget a tooltip slot, filled later with setUiTip */
  readonly tip?: string;
}

/** The one primitive every prefab is built from. Call during wiring or from a command. */
export function spawnUiNode(
  world: World,
  parent: Entity | null,
  tag: UiTag,
  recipe: UiRecipe,
  options: UiSpawnOptions = {},
): Entity {
  const entity = world.spawn();
  world.insert(entity, UI_TREE, {
    tag,
    parent: parent ?? NULL_ENTITY,
    order: world.resource(UI_ORDER).next++,
  });
  world.insert(entity, UI_LOOK, { recipe });
  world.insert(entity, UI_STATE, { hidden: options.hidden ?? false, selected: false, active: false });
  if (options.text !== undefined) {
    world.insert(entity, UI_TEXT, { key: options.text, raw: options.raw ?? false });
  }
  if (options.image) {
    world.insert(entity, UI_IMAGE, {
      url: options.image.url,
      scrim: options.image.scrim,
      tint: options.image.tint ?? "",
    });
  }
  if (options.tip !== undefined) world.insert(entity, UI_TIP, { text: options.tip });
  return entity;
}

/** A container: the recipe decides where it sits and how its children flow. */
export function spawnPanel(
  world: World,
  parent: Entity | null,
  recipe: UiRecipe,
  options: UiSpawnOptions = {},
): Entity {
  return spawnUiNode(world, parent, "div", recipe, options);
}

/** A text line. `text` is an i18n key unless `raw`. */
export function spawnLabel(
  world: World,
  parent: Entity | null,
  recipe: UiRecipe,
  text = "",
  options: UiSpawnOptions = {},
): Entity {
  return spawnUiNode(world, parent, "span", recipe, { ...options, text });
}

/** A button. `action` is dispatched to the surface; `value` says which one of a group it is.
 *  `text` is omitted for a button that will have CHILDREN (the keycaps hold a legend): a text
 *  component on a container is a trap, because writing text replaces the element's children — the
 *  reconciler refuses to write text on a widget that has any (see system.ts). */
export function spawnButton(
  world: World,
  parent: Entity | null,
  recipe: UiRecipe,
  action: string,
  value: string,
  text?: string,
  options: UiSpawnOptions = {},
): Entity {
  const entity = spawnUiNode(
    world,
    parent,
    "button",
    recipe,
    text === undefined ? options : { ...options, text },
  );
  world.insert(entity, UI_ACTION, { action, value });
  return entity;
}

/** A keycap of the visual keyboard: a button whose position comes from the layout table (UI_LAYOUT). */
export function spawnGridKey(
  world: World,
  parent: Entity | null,
  recipe: UiRecipe,
  layout: string,
  action: string,
  value: string,
): Entity {
  const entity = spawnButton(world, parent, recipe, action, value);
  world.insert(entity, UI_LAYOUT, { css: layout });
  return entity;
}

/** A layout-only widget: a flex spacer, a grid cell holder. No text, no action, no recipe of its own
 *  beyond the container role it plays. */
export function spawnLayoutBox(
  world: World,
  parent: Entity | null,
  recipe: UiRecipe,
  layout: string,
): Entity {
  const entity = spawnPanel(world, parent, recipe);
  world.insert(entity, UI_LAYOUT, { css: layout });
  return entity;
}

/** Update a widget's raw layout CSS (the reconciler appends it AFTER the recipe's style, so it wins).
 *  For a widget whose geometry is derived per frame — the key bind drag's rubber band is the only one
 *  today. A widget spawned WITHOUT UI_LAYOUT cannot gain one here: attaching a component is a structural
 *  change, which a system may not make (iron rule 1). */
export function setUiLayout(world: World, entity: Entity, css: string): void {
  const layout = world.get(entity, UI_LAYOUT);
  if (!layout || layout.css === css) return;
  layout.css = css;
}

/** A native range slider (the FPS cap). Wired like a button: the dispatch reports the new value.
 *
 *  `source` makes the slider BOUND: its value then comes from that source every frame (see UI_BIND),
 *  and the surface must NOT also push a value into it. A slider with no source keeps whatever value
 *  its own code writes. */
export function spawnSlider(
  world: World,
  parent: Entity | null,
  recipe: UiRecipe,
  action: string,
  value: string,
  range: { min: number; max: number; step: number; initial: number },
  source?: string,
): Entity {
  const entity = spawnUiNode(world, parent, "input", recipe);
  world.insert(entity, UI_ACTION, { action, value });
  world.insert(entity, UI_INPUT, {
    min: range.min,
    max: range.max,
    step: range.step,
    value: snapToRange(range.initial, range),
  });
  if (source) world.insert(entity, UI_BIND, { source });
  return entity;
}

/** Snap a value into a range's grid: clamp to [min, max] and land on a step from min. Used by the
 *  binding resolver so the COMPONENT and the ELEMENT agree — a browser normalises a slider's value the
 *  same way, and if the two disagreed the DOM would silently show a different number than the data
 *  (which is exactly what a bound value must never do). */
export function snapToRange(
  value: number,
  range: { min: number; max: number; step: number },
): number {
  if (!Number.isFinite(value)) return range.min;
  const step = range.step > 0 ? range.step : 1;
  const steps = Math.round((value - range.min) / step);
  const snapped = range.min + steps * step;
  return Math.min(range.max, Math.max(range.min, snapped));
}

/** A fixed-capacity list. Returns the ROW entities; the caller spawns what goes inside each row and
 *  hides the unused tail with setUiVisible. Fixed capacity is not a limitation to work around: a
 *  system may not spawn (iron rule 1), so a list that grew with its data could only be rebuilt from
 *  outside the schedule. */
export function spawnList(
  world: World,
  parent: Entity | null,
  rowRecipe: UiRecipe,
  capacity: number,
  options: UiSpawnOptions = {},
): Entity[] {
  const rows: Entity[] = [];
  for (let i = 0; i < capacity; i++) {
    rows.push(spawnPanel(world, parent, rowRecipe, { hidden: true, ...options }));
  }
  return rows;
}

// ===== data writers (safe to call from inside a system) =====

export function setUiText(world: World, entity: Entity, text: string, raw = false): void {
  const record = world.get(entity, UI_TEXT);
  if (!record) return;
  record.key = text;
  record.raw = raw;
}

export function setUiVisible(world: World, entity: Entity, visible: boolean): void {
  const record = world.get(entity, UI_STATE);
  if (record) record.hidden = !visible;
}

export function setUiSelected(world: World, entity: Entity, selected: boolean): void {
  const record = world.get(entity, UI_STATE);
  if (record) record.selected = selected;
}

/** Mark a widget as carrying data (a bound keycap). See UiStateC.active. */
export function setUiActive(world: World, entity: Entity, active: boolean): void {
  const record = world.get(entity, UI_STATE);
  if (record) record.active = active;
}

/** Set a widget's background image (a block icon's data URL, a menu background). Write-only, like the
 *  other setters: the image SLOT has to exist already (see UiSpawnOptions.image), because inserting a
 *  component from inside a system would break iron rule 1. */
export function setUiImage(world: World, entity: Entity, url: string, scrim = false, tint = ""): void {
  const record = world.get(entity, UI_IMAGE);
  if (!record) return;
  record.url = url;
  record.scrim = scrim;
  record.tint = tint;
}

/** Set a widget's native tooltip. Write-only, like the other setters. */
export function setUiTip(world: World, entity: Entity, text: string): void {
  const record = world.get(entity, UI_TIP);
  if (record) record.text = text;
}
