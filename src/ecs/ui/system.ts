// ===== UI render system: reconcile the DOM to the widget entities =====
// The ONLY code in the project that creates, styles, removes or listens to a DOM element for a widget
// tree. Every UI surface is data (ecs/ui/widgets.ts); this system turns that data into DOM once per
// frame and touches each element only where the derived value changed. That covers the menus too: no
// surface builds an element, writes a style or attaches a listener any more.
//
// RECONCILE, DON'T REBUILD, and for the same reason ui/inventory.ts does it: writing the DOM every
// frame is cheap when nothing changed, and it removes the whole class of bug where a surface forgets to
// refresh after changing its own data. Text is re-derived from the i18n lookup EVERY frame, so a
// language switch needs no listener, and a style is written only when its recipe, state or theme
// changed.
//
// HOVER AND PRESSED ARE DOM-TRANSIENT STATE, and they live here for the same reason the widget data
// lives in components: a surface must not attach a listener (the hand-written menus did, which is where
// their `style.filter`/`style.outline` writes came from). The reconciler tracks them per element and
// feeds them into the style table, so the theme stays the only place a colour is decided.
//
// WHAT A SYSTEM MAY NOT DO: spawn or despawn a widget (iron rule 1). That is why lists have a fixed
// capacity and hide their unused tail (see spawnList) instead of growing with the data.
//
// The i18n lookup is INJECTED rather than imported, so this module never depends on src/ui/, and the
// theme and the action table are resources — which is also what lets the Node gate compile and load it
// without a DOM (nothing here runs at import time).
import type { Entity } from "../World";
import { NULL_ENTITY, type SystemAccess, type World } from "../World";
import { dispatchUiAction, UI_ACTIONS, type UiActionHandler } from "./actions";
import { recipeStyle, UI_THEME, type UiTheme } from "./theme";
import {
  UI_ACTION,
  UI_IMAGE,
  UI_INPUT,
  UI_LAYOUT,
  UI_LOOK,
  UI_STATE,
  UI_TEXT,
  UI_TIP,
  UI_TREE,
  type UiTreeNode,
} from "./widgets";

/** Declared access: it reads every widget component and writes the DOM. That it writes no COMPONENT is
 *  deliberate — a reconciler that wrote widget data would fight whoever owns it. A scrollable role's
 *  position is NOT recorded anywhere either: it is the browser's, and this system only puts a list back
 *  at the top when its panel appears (see step()). */
export const UI_RENDER_ACCESS: SystemAccess = {
  reads: [UI_TREE, UI_TEXT, UI_LOOK, UI_STATE, UI_ACTION, UI_INPUT, UI_LAYOUT, UI_IMAGE, UI_TIP],
  writesExternal: ["dom.ui"],
  // It re-derives every widget's text through `translate` every frame, so it reads the LOCALE resource.
  readsExternal: ["locale"],
};

export interface UiRenderDeps {
  /** Where root widgets are mounted (ui/uiscale.ts's `uiStage` in the real game) */
  readonly mount: HTMLElement;
  /** i18n lookup — injected so this module never imports the UI layer */
  readonly translate: (key: string) => string;
  /** Where a dispatch failure is reported (a widget whose action nobody registered) */
  readonly log?: (line: string) => void;
}

/** What was last written to an element, so the frame can skip unchanged DOM */
interface Drawn {
  style: string;
  text: string;
  /** DOM-transient interaction state (hover/press), fed into the style table */
  hovered: boolean;
  pressed: boolean;
  /** The background image last written ("" = none) + the tint data behind it */
  image: string;
  /** The tooltip last written */
  tip: string;
  /** The slider value last written, so a user's drag is never fought */
  value: string;
  /** The slider range last written ("min|max|step") */
  range: string;
  /** Marquee shift in px for text that does not fit (0 = fits) */
  marquee: number;
  /** Was this widget hidden on the previous frame — itself OR behind a hidden ancestor? A scrollable
   *  role returns to the TOP on the frame it comes back, which is an EDGE: while it stays up, whatever
   *  the user scrolled to is left alone (its position is never recorded anywhere). */
  wasHidden: boolean;
}

/** A hit-test result: the widget under a point, when it carries an action. Used by interactions that
 *  must ask "what is the cursor over" — the key bind drag being the only one today. */
export interface UiHit {
  readonly entity: Entity;
  readonly action: string;
  readonly value: string;
}

export class UiRenderSystem {
  private readonly theme: UiTheme;
  private readonly actions: ReadonlyMap<string, UiActionHandler>;
  private readonly elements = new Map<Entity, HTMLElement>();
  private readonly entityOf = new Map<HTMLElement, Entity>();
  private readonly drawn = new Map<Entity, Drawn>();
  private stylesheetInjected = false;

  constructor(
    private readonly world: World,
    private readonly deps: UiRenderDeps,
  ) {
    this.theme = world.resource(UI_THEME);
    this.actions = world.resource(UI_ACTIONS);
  }

  /** Render-lane step: unmount what died, then mount/update in creation order (a parent is always
   *  created before its children, so ascending `order` is enough to have every parent element ready). */
  step(): void {
    this.injectStylesheet();
    const handles = [...this.world.query(UI_TREE).entities()];
    const live = new Set(handles);

    for (const entity of [...this.elements.keys()]) {
      if (!live.has(entity) || this.hasDeadAncestor(entity, live)) this.unmount(entity);
    }

    handles.sort((a, b) => this.orderOf(a) - this.orderOf(b));
    // A text write REPLACES an element's children, so text only ever goes on a LEAF widget. A container
    // that carries a text component (a keycap holding a legend span, for instance) must not have its
    // text written, or the reconciler would delete the very children it just appended.
    const parents = new Set<Entity>();
    for (const entity of handles) {
      const parent = this.world.get(entity, UI_TREE)?.parent ?? NULL_ENTITY;
      if (parent !== NULL_ENTITY) parents.add(parent);
    }
    for (const entity of handles) {
      const element = this.elements.get(entity) ?? this.mount(entity);
      this.update(entity, element, !parents.has(entity));
    }
  }

  /** How many widgets are currently mounted (diagnostics / the Node gate) */
  get mountedCount(): number {
    return this.elements.size;
  }

  /** The widget under a screen point, if it carries an action (see UiHit). Walks up from the hit
   *  element, so a click on a label INSIDE a button still resolves to the button — which is what the
   *  hand-written keycap registry did by hand, with a cross-instance table because it had no other way
   *  to find the visible instance's element. */
  hitTest(x: number, y: number): UiHit | null {
    let node = document.elementFromPoint(x, y) as HTMLElement | null;
    while (node) {
      const entity = this.entityOf.get(node);
      if (entity !== undefined) {
        const action = this.world.get(entity, UI_ACTION);
        if (action) return { entity, action: action.action, value: action.value };
      }
      node = node.parentElement;
    }
    return null;
  }

  /** The theme's global rules (what an inline style cannot express). One element, written by the DOM
   *  owner, so no surface ever touches the document head. */
  private injectStylesheet(): void {
    if (this.stylesheetInjected) return;
    this.stylesheetInjected = true;
    if (!this.theme.stylesheet) return;
    const style = document.createElement("style");
    style.textContent = this.theme.stylesheet;
    this.deps.mount.appendChild(style);
  }

  private orderOf(entity: Entity): number {
    return this.world.get(entity, UI_TREE)?.order ?? 0;
  }

  /** Is this widget hidden by its OWN state or by any ancestor's? A whole panel disappears through its
   *  own flag, and the scrollable list inside it is never marked hidden itself — which is why the
   *  "bring a list back to the top" edge has to ask the whole chain, not just this widget. Only called
   *  for the roles the theme lists as scrollable, so the walk costs nothing for the other hundred. */
  private hiddenByAncestor(entity: Entity): boolean {
    let parent = this.world.get(entity, UI_TREE)?.parent ?? NULL_ENTITY;
    while (parent !== NULL_ENTITY) {
      if (this.world.get(parent, UI_STATE)?.hidden) return true;
      parent = this.world.get(parent, UI_TREE)?.parent ?? NULL_ENTITY;
    }
    return false;
  }

  /** A widget whose parent chain is broken must go even if the entity itself is still alive — the
   *  alternative is an element stranded inside a removed subtree that the next frame re-appends. */
  private hasDeadAncestor(entity: Entity, live: ReadonlySet<Entity>): boolean {    let parent = this.world.get(entity, UI_TREE)?.parent ?? NULL_ENTITY;
    while (parent !== NULL_ENTITY) {
      if (!live.has(parent)) return true;
      parent = this.world.get(parent, UI_TREE)?.parent ?? NULL_ENTITY;
    }
    return false;
  }

  private mount(entity: Entity): HTMLElement {
    const tree = this.world.get(entity, UI_TREE) as UiTreeNode;
    const element = document.createElement(tree.tag);
    if (tree.tag === "input") (element as HTMLInputElement).type = "range";
    const parent =
      tree.parent === NULL_ENTITY ? this.deps.mount : (this.elements.get(tree.parent) ?? this.deps.mount);
    parent.appendChild(element);
    this.elements.set(entity, element);
    this.entityOf.set(element, entity);
    this.wire(entity, element);
    return element;
  }

  /** Attach the listeners a widget's DATA asks for. A widget with no action gets none: the reconciler
   *  is not "a DOM layer with handlers", it is the interpreter of what the data says the widget is. */
  private wire(entity: Entity, element: HTMLElement): void {
    const action = this.world.get(entity, UI_ACTION);
    if (!action) return;
    const input = this.world.get(entity, UI_INPUT);
    if (input) {
      // A slider reports through the same table as a click, carrying the value it was moved to. The
      // reconciler does NOT write the component back: whoever owns the slider does that, so this system
      // keeps writing no component at all (see UI_RENDER_ACCESS).
      element.addEventListener("input", () => {
        const moved = (element as HTMLInputElement).valueAsNumber;
        dispatchUiAction(this.actions, action.action, String(moved), this.deps.log);
      });
      return;
    }
    element.addEventListener("click", () => {
      dispatchUiAction(this.actions, action.action, action.value, this.deps.log);
    });
    // Interaction state. No forced update: `hovered`/`pressed` feed the style string, and the frame
    // compares it — so the shade lands on the next frame, which is under a millisecond at 120 Hz.
    const state = (): Drawn | undefined => this.drawn.get(entity);
    element.addEventListener("mouseenter", () => {
      const d = state();
      if (d) d.hovered = true;
    });
    element.addEventListener("mouseleave", () => {
      const d = state();
      if (d) {
        d.hovered = false;
        d.pressed = false;
      }
    });
    element.addEventListener("mousedown", () => {
      const d = state();
      if (d) d.pressed = true;
    });
    element.addEventListener("mouseup", () => {
      const d = state();
      if (d) d.pressed = false;
    });
  }

  private unmount(entity: Entity): void {
    const element = this.elements.get(entity);
    element?.remove();
    if (element) this.entityOf.delete(element);
    this.elements.delete(entity);
    this.drawn.delete(entity);
  }

  private update(entity: Entity, element: HTMLElement, isLeaf: boolean): void {
    const look = this.world.get(entity, UI_LOOK);
    const state = this.world.get(entity, UI_STATE);
    const text = this.world.get(entity, UI_TEXT);
    const layout = this.world.get(entity, UI_LAYOUT);
    const image = this.world.get(entity, UI_IMAGE);
    const input = this.world.get(entity, UI_INPUT);
    const recipe = look?.recipe ?? "text.label";

    let drawn = this.drawn.get(entity);
    if (!drawn) {
      drawn = {
        style: "",
        text: "\u0000",
        hovered: false,
        pressed: false,
        image: "\u0000",
        tip: "\u0000",
        value: "\u0000",
        range: "\u0000",
        marquee: 0,
        wasHidden: false,
      };
      this.drawn.set(entity, drawn);
      // The role is addressable from the theme's stylesheet (pseudo-elements cannot be inline).
      element.dataset.uiRecipe = recipe;
    }

    const style =
      recipeStyle(
        recipe,
        { selected: state?.selected ?? false, active: state?.active ?? false, hovered: drawn.hovered, pressed: drawn.pressed },
        this.theme,
      ) +
      (layout?.css ?? "") +
      (state?.hidden ? "display:none;" : "");
    const value = text ? (text.raw ? text.key : this.deps.translate(text.key)) : "";

    // Re-derived every frame, so a language change needs no listener; the cache keeps it off the DOM.
    let remeasure = false;
    if (isLeaf && drawn.text !== value) {
      element.textContent = value;
      drawn.text = value;
      remeasure = true;
    }
    // Text that does not fit: scroll it (the visual keyboard's long legends). Measuring is a layout
    // read, so it happens only when the text changed — and it is the reconciler's job, not a
    // surface's: a surface cannot read the DOM it does not own.
    if (remeasure && this.theme.marquee.includes(recipe)) {
      const over = element.scrollWidth - element.clientWidth;
      drawn.marquee = over > 1 ? -over - 2 : 0;
    }

    // Whether the cssText has to be rewritten THIS frame. Captured before the write, because the
    // background-image/tint below must be re-applied whenever the shorthand was (rewriting cssText
    // resets every longhand it expanded into).
    const styleChanged = drawn.style !== style;
    const marqueeChanged = (drawn.marquee !== 0) !== drawn.style.includes("capScroll");
    if (styleChanged || marqueeChanged) {
      element.style.cssText = style;
      if (drawn.marquee !== 0) {
        element.style.justifyContent = "flex-start";
        element.style.setProperty("--cap-shift", `${drawn.marquee}px`);
        element.style.animation = "capScroll 2.4s ease-in-out infinite alternate";
      }
      drawn.style = style;
    }

    // Scroll position: NOT recorded anywhere (no component, no resource, no listener). A scrollable role
    // simply starts at the TOP every time its panel appears — and "its panel" means the whole ancestor
    // chain, because the key bind chip list is never hidden itself, the panel that holds it is. While the
    // panel stays up, whatever the user scrolled to is left ALONE: this is an edge, not a per-frame write
    // (a per-frame write is what pulled a list back to the top, or silently did nothing at all because a
    // `display:none` box cannot hold an offset — the two failure modes the previous attempt alternated
    // between).
    if (this.theme.scroll.includes(recipe)) {
      const shown = state?.hidden !== true && !this.hiddenByAncestor(entity);
      if (drawn.wasHidden && shown) element.scrollTop = 0;
      drawn.wasHidden = !shown;
    }

    // Background image + the data tint behind it. The scrim is the theme's, the URL and the tint are
    // data — a surface supplies a resource, not a style.
    //
    // ONLY for a widget that DECLARES an image slot. Writing `backgroundColor` on any other widget
    // deletes the colour the recipe's `background:` shorthand just set, and the browser then falls back
    // to its own face for that element type: a `<button>` without an author background is ButtonFace
    // (light grey), which is how every menu button and choice turned white until the pointer touched it
    // (hover changes the style string, which rewrites cssText, which brought the colour back).
    if (image) {
      const url = image.url;
      const tint = image.tint;
      const key = `${image.scrim ? "scrim:" : ""}${url}|${tint}`;
      if (drawn.image !== key || styleChanged) {
        element.style.backgroundImage = !url
          ? ""
          : image.scrim
            ? `linear-gradient(${this.theme.backdrop.scrim},${this.theme.backdrop.scrim}),url("${url}")`
            : `url("${url}")`;
        element.style.backgroundColor = tint;
        drawn.image = key;
      }
    }

    // A native tooltip (registry labels are data, so this is a literal).
    const tip = this.world.get(entity, UI_TIP)?.text ?? "";
    if (drawn.tip !== tip) {
      element.title = tip;
      drawn.tip = tip;
    }

    // A slider: its RANGE first, then its value. The range used to be dropped on the floor — the
    // component carried min/max/step and the element kept the browser's defaults (0..100, step 1) —
    // which is why the FPS cap's right end read 100 fps, why it moved in ones, and why the label could
    // never reach its "unlimited" case (that needs value >= the surface's max).
    if (input) {
      const el = element as HTMLInputElement;
      const range = `${input.min}|${input.max}|${input.step}`;
      if (drawn.range !== range) {
        el.min = String(input.min);
        el.max = String(input.max);
        el.step = String(input.step);
        drawn.range = range;
      }
      // The value is written only when it changed since the last frame, which is what keeps the
      // reconciler from fighting the user's own drag (and a BOUND slider: see ecs/ui/bindings.ts).
      const shown = String(input.value);
      if (drawn.value !== shown) {
        el.value = shown;
        drawn.value = shown;
      }
    }
  }
}
