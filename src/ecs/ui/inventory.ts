// ===== ui.inventory: the backpack's WIDGET DATA, as a system =====
// This used to be `Inventory.sync()` — a method on the VIEW, invoked by a one-line system
// (`run: () => inv.sync()`) whose access declaration was the view's. Reconciling the player's INVENTORY
// component into widget data once per frame IS system work: it reads component data, diffs it against
// what it last wrote and touches widgets only where something changed. (The same split P1.9 made for the
// F3 panel, where the HUD view stopped being called by `diagnostics`.)
//
// The VIEW (`ui/inventory.ts`) is now only WIRING: it spawns the tree, publishes the widget handles
// (the INVENTORY_WIDGETS resource) and registers the one bag-click action. Spawning is a structural
// change, so it belongs to wiring and not to a system (iron rule 1).
//
// IT WRITES WIDGET COMPONENTS, SO IT MUST RUN BEFORE THE RECONCILER. That is not a convention: this
// system declares `writes: [UI_IMAGE, UI_STATE, UI_TEXT, UI_TIP]` and `ui.widgets` reads those same
// components, so the schedule REFUSES to start unless the edge between them is declared (main.ts
// declares `after: ["ui.inventory"]`).
import { iconCacheKey, peekBlockIcon, requestBlockIcon } from "../../rendering/blockicons";
import { CHECKER_TEXTURE_URL } from "../../rendering/textures";
import { getBlockDef } from "../../blockregistry";
import { INVENTORY, INVENTORY_SLOTS, type InventoryC } from "../components/Player";
import { ICON_BAKE, type IconBakeState } from "../presentation";
import { INVENTORY_WIDGETS, LOCAL_PLAYER, type InventoryWidgets } from "../resources";
import type { SystemAccess, World } from "../World";
import { UI_PAINT, type UiInventoryPaint } from "./paint";
import {
  setUiImage,
  setUiSelected,
  setUiText,
  setUiTip,
  UI_IMAGE,
  UI_STATE,
  UI_TEXT,
  UI_TIP,
} from "./widgets";

/** Declared access: a view of the player's INVENTORY component that WRITES WIDGET DATA and nothing
 *  else. No DOM target: the only code that touches an element is the reconciler. It also READS the item
 *  icon cache and starts a bake when a miss is found (ICON_BAKE, ecs/presentation.ts), so that state is
 *  declared as an external target — it is a GPU object the ECS does not model. */
export const INVENTORY_VIEW_ACCESS: SystemAccess = {
  reads: [INVENTORY],
  writes: [UI_IMAGE, UI_STATE, UI_TEXT, UI_TIP],
  writesExternal: ["iconBake"],
};

/** Baked icon size, in px (the hand-written view had an unused `iconSize` field and a dead re-bake path). */
const ICON_SIZE = 40;

export class UiInventorySystem {
  /** The component this system renders. A record, so the reference is stable (iron rule 2). */
  private readonly inv: InventoryC;
  private readonly widgets: InventoryWidgets;
  /** The icon bake's cache/pending maps (a RESOURCE — see ecs/presentation.ts::ICON_BAKE) */
  private readonly bake: IconBakeState;
  /** The reconcile caches (drawn signatures, which slots are still waiting for a bake, the selection
   *  last highlighted). They are UI_PAINT.inventory now (ecs/ui/paint.ts) — world data with an owner,
   *  instead of three private arrays inside the system. */
  private readonly paint: UiInventoryPaint;
  private get drawn(): string[] {
    return this.paint.drawn;
  }
  private get waiting(): Uint8Array {
    return this.paint.waiting;
  }
  private get drawnSelected(): number {
    return this.paint.drawnSelected;
  }
  private set drawnSelected(v: number) {
    this.paint.drawnSelected = v;
  }

  constructor(private readonly world: World) {
    this.inv = world.get(world.resource(LOCAL_PLAYER), INVENTORY)!;
    this.widgets = world.resource(INVENTORY_WIDGETS);
    this.bake = world.resource(ICON_BAKE);
    this.paint = world.resource(UI_PAINT).inventory;
  }

  /** Render-lane reconcile: diff against the last drawn state, write only what changed. */
  step(): void {
    const inventory = this.inv;
    this.collectFinishedBakes();
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const item = inventory.slots[i];
      const signature = item ? `${item.type}\u0000${item.count}` : "";
      if (signature === this.drawn[i]) continue;
      this.drawn[i] = signature;
      this.draw(i);
    }
    if (inventory.selected !== this.drawnSelected) {
      this.drawnSelected = inventory.selected;
      for (let i = 0; i < INVENTORY_SLOTS; i++) {
        setUiSelected(this.world, this.widgets.slots[i], i === inventory.selected);
      }
    }
  }

  /** Draw one slot: the placeholder icon, the name as a tooltip, the count as text, and the baked 3D
   *  icon once ICON_BAKE has one (asked for on the first miss, drawn by `collectFinishedBakes` when it
   *  lands).
   *
   *  THE PLACEHOLDER IS THE ENGINE'S CHECKER, NOT A SOLID COLOUR. It used to be the block's registry
   *  colour (or the theme's green fallback), which flashed a solid square for one frame on every stack
   *  move: a view writes DATA and the reconciler paints once per frame, so the intermediate state
   *  ("no icon yet") is a real painted frame — where the hand-written view wrote the DOM twice inside
   *  one task and the browser never showed it. Two reasons the checker is the better placeholder: it
   *  reads as "no icon yet" instead of as a real item, and it is the same look the world uses for a
   *  block with no texture, so it says the truth about what the slot is showing. */
  private draw(i: number): void {
    const widgets = this.widgets;
    const item = this.inv.slots[i];
    if (!item) {
      setUiImage(this.world, widgets.icons[i], "", false, "transparent");
      setUiText(this.world, widgets.counts[i], "", true);
      setUiTip(this.world, widgets.slots[i], "");
      return;
    }
    const def = getBlockDef(item.type);
    // An icon that is ALREADY baked is written straight away, in ONE write: no placeholder state ever
    // reaches a frame (see the method above). Only a first-time bake has to wait, and it says so with the
    // engine's checker rather than with a solid colour that reads as a real item.
    const baked = peekBlockIcon(this.bake, item.type, ICON_SIZE);
    setUiImage(this.world, widgets.icons[i], baked ?? CHECKER_TEXTURE_URL, false);
    setUiTip(this.world, widgets.slots[i], def?.label ?? item.type); // Tooltip shows the block name
    setUiText(this.world, widgets.counts[i], item.count > 1 ? `${item.count}` : "", true);
    this.waiting[i] = baked ? 0 : 1;
    if (!baked) requestBlockIcon(this.bake, item.type, ICON_SIZE);
  }

  /** Do the bakes asked for on an earlier frame have a result? A slot whose icon HAS landed is marked
   *  dirty, so the ordinary diff below draws it in ONE write (the checker never survives a frame it did
   *  not have to). A slot whose bake FAILED (not cached and nothing in flight) stops waiting: the
   *  checker stays, and re-requesting it every frame would be an endless GPU loop.
   *
   *  This is the whole cost of deleting the promise continuation's component write: one Map lookup per
   *  waiting slot per frame, and the write itself happens inside a lane. */
  private collectFinishedBakes(): void {
    const bake = this.bake;
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      if (!this.waiting[i]) continue;
      const item = this.inv.slots[i];
      if (!item) {
        this.waiting[i] = 0;
        continue;
      }
      const key = iconCacheKey(item.type, ICON_SIZE);
      if (bake.cache.has(key)) {
        this.waiting[i] = 0;
        this.drawn[i] = "\u0000"; // no real signature equals this: the diff below redraws the slot
      } else if (!bake.pending.has(key)) {
        this.waiting[i] = 0; // the bake failed (or was never started): keep the checker, do not retry
      }
    }
  }
}
