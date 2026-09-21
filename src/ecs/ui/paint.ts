// ===== UI_PAINT: everything the UI layer last WROTE, as world data =====
// The reconciler and the widget-data systems each need one thing that is not game state: "what did I
// paint last time", so a frame can skip a DOM write whose value did not change (and so a scrollable list
// knows the EDGE on which it must return to the top). Those caches used to be private fields of the
// classes that own the writes — state living inside behaviour, invisible to the schedule, to a test and
// to anyone reading main.ts, and impossible to reset between two worlds.
//
// They are one RESOURCE now. Two things follow, and both are the point:
//   * the DATA has an owner and a name (`UI_PAINT`), like every other singleton in the engine;
//   * the LOGIC stays in the systems that write it, and the access is unchanged — only the reconciler
//     touches `dom`, only `ui.loading` touches `loading`, and so on. Nothing here is game state: it is the
//     browser-facing half of the UI, which is exactly why it belongs to the world and not to a closure.
//
// A cache is never read to ANSWER a question about the game: every value it mirrors is re-derived from
// its real owner every frame (UI_MODAL, LOADING_STATE, KEYBIND_GESTURE, the bind table, …). Losing this
// resource costs one repaint, never a wrong answer.
import type { Entity } from "../World";
import { defineResource, type Resource } from "../World";

/** What was last written to an element, so the frame can skip unchanged DOM */
export interface UiDrawn {
  style: string;
  text: string;
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

/** The reconciler's half: the elements it owns and the values it last stamped on them. The ELEMENT
 *  TABLES are data like everything else; the element itself is only ever touched by the reconciler. */
export interface UiDomPaint {
  readonly elements: Map<Entity, HTMLElement>;
  readonly entityOf: Map<HTMLElement, Entity>;
  readonly drawn: Map<Entity, UiDrawn>;
  /** DOM-transient interaction state, fed into the style table every frame. A SET rather than a flag per
   *  widget: the delegated hover handler computes the whole ancestor chain, so "who is hovered now" is a
   *  set by construction — and the diff against it is what replaces mouseenter/mouseleave. */
  readonly hovered: Set<Entity>;
  readonly pressed: Set<Entity>;
  /** The global stylesheet has been injected (once per process) */
  stylesheetInjected: boolean;
  /** The global style last applied to the document root (null = nothing yet, so the first frame writes) */
  appliedFontUi: string | null;
  appliedFontMono: string | null;
  appliedRootFontPx: number | null;
}

/** `ui.loading`: the last stage it painted, so an unchanged stage is not rewritten every frame. */
export interface UiLoadingPaint {
  shown: boolean;
  shownKey: string;
  shownPercent: number;
  filled: number;
  shownNote: string;
  shownNoteKey: string;
  shownNoteVisible: boolean;
}

/** `ui.toast`: the message it last painted. */
export interface UiToastPaint {
  shown: boolean;
  shownKey: string;
  shownRaw: boolean;
}

/** `ui.hud`: the gameplay gate's last painted value (the crosshair + hotbar visibility). */
export interface UiHudPaint {
  shown: boolean;
}

/** `ui.keybind`: the derived bind panels' last written text, plus the drag's presentation. */
export interface UiKeybindPaint {
  readonly drawn: Map<Entity, string>;
  /** The keycap the drag currently lights (the gesture knows its own target; this is what was PAINTED) */
  hovered: Entity | null;
  lineShown: boolean;
}

/** `ui.inventory`: the slot signatures it last drew, which slots are still waiting for an icon bake, and
 *  the selection it last highlighted. */
export interface UiInventoryPaint {
  readonly drawn: string[];
  readonly waiting: Uint8Array;
  drawnSelected: number;
}

/** `ui.navigation`: the modal state it last saw, so the pointer-lock effects fire on an EDGE and not
 *  every frame. */
export interface UiNavigationPaint {
  inventoryOpen: boolean;
  menuOpen: boolean;
}

/** `ui.bindings`: a source that resolved to nothing is reported once, not once per frame. */
export interface UiBindingsPaint {
  readonly reported: Set<string>;
}

export interface UiPaintState {
  readonly dom: UiDomPaint;
  readonly loading: UiLoadingPaint;
  readonly toast: UiToastPaint;
  readonly hud: UiHudPaint;
  readonly keybind: UiKeybindPaint;
  readonly inventory: UiInventoryPaint;
  readonly navigation: UiNavigationPaint;
  readonly bindings: UiBindingsPaint;
}

export const UI_PAINT: Resource<UiPaintState> = defineResource<UiPaintState>("uiPaint");

/** The factory takes the slot count so this module needs no component import (the inventory's arrays are
 *  sized once, exactly as the class used to size them). */
export function createUiPaint(inventorySlots: number): UiPaintState {
  return {
    dom: {
      elements: new Map(),
      entityOf: new Map(),
      drawn: new Map(),
      hovered: new Set(),
      pressed: new Set(),
      stylesheetInjected: false,
      appliedFontUi: null,
      appliedFontMono: null,
      appliedRootFontPx: null,
    },
    loading: {
      shown: false,
      shownKey: "\u0000",
      shownPercent: -1,
      filled: -1,
      shownNote: "\u0000",
      shownNoteKey: "\u0000",
      shownNoteVisible: false,
    },
    toast: { shown: false, shownKey: "", shownRaw: false },
    hud: { shown: true },
    keybind: { drawn: new Map(), hovered: null, lineShown: false },
    inventory: {
      drawn: new Array<string>(inventorySlots).fill("\u0000"),
      waiting: new Uint8Array(inventorySlots),
      drawnSelected: -1,
    },
    navigation: { inventoryOpen: false, menuOpen: false },
    bindings: { reported: new Set() },
  };
}
