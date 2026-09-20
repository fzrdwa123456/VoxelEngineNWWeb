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
import { getBlockIcon, peekBlockIcon } from "../../rendering/blockicons";
import { CHECKER_TEXTURE_URL } from "../../rendering/textures";
import { getBlockDef } from "../../blockregistry";
import { INVENTORY, INVENTORY_SLOTS, type InventoryC } from "../components/Player";
import { INVENTORY_WIDGETS, LOCAL_PLAYER, type InventoryWidgets } from "../resources";
import type { SystemAccess, World } from "../World";
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
 *  else. No DOM target: the only code that touches an element is the reconciler. */
export const INVENTORY_VIEW_ACCESS: SystemAccess = {
  reads: [INVENTORY],
  writes: [UI_IMAGE, UI_STATE, UI_TEXT, UI_TIP],
};

/** Baked icon size, in px (the hand-written view had an unused `iconSize` field and a dead re-bake path). */
const ICON_SIZE = 40;

export class UiInventorySystem {
  /** The component this system renders. A record, so the reference is stable (iron rule 2). */
  private readonly inv: InventoryC;
  private readonly widgets: InventoryWidgets;
  /** Last drawn signature per slot, so a frame can skip the widgets that did not change */
  private readonly drawn: string[] = new Array<string>(INVENTORY_SLOTS).fill("\u0000");
  private drawnSelected = -1;

  constructor(private readonly world: World) {
    this.inv = world.get(world.resource(LOCAL_PLAYER), INVENTORY)!;
    this.widgets = world.resource(INVENTORY_WIDGETS);
  }

  /** Render-lane reconcile: diff against the last drawn state, write only what changed. */
  step(): void {
    const inventory = this.inv;
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
   *  icon fetched once it is ready.
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
    const baked = peekBlockIcon(item.type, ICON_SIZE);
    setUiImage(this.world, widgets.icons[i], baked ?? CHECKER_TEXTURE_URL, false);
    setUiTip(this.world, widgets.slots[i], def?.label ?? item.type); // Tooltip shows the block name
    setUiText(this.world, widgets.counts[i], item.count > 1 ? `${item.count}` : "", true);
    if (!baked) this.fetchIcon(i);
  }

  /** Bake and backfill the slot icon async. The `current.type === type` guard means a slot that changed
   *  hands while the bake was in flight cannot be overwritten by the old block's icon. */
  private fetchIcon(i: number): void {
    const item = this.inv.slots[i];
    if (!item) return;
    const type = item.type;
    void getBlockIcon(type, ICON_SIZE).then((url) => {
      const current = this.inv.slots[i];
      if (url && current && current.type === type) {
        setUiImage(this.world, this.widgets.icons[i], url, false, "");
      }
    });
  }
}
