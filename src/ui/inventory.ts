// ===== Inventory VIEW: a WIDGET surface =====
// This class no longer OWNS anything, and it no longer owns any DOM either. The stacks and the selected
// slot are the INVENTORY component (ecs/components/Player.ts), which is what the gameplay systems read;
// this file turns that component into widget DATA (an icon URL, a count, a selected flag) and
// ecs/ui/system.ts turns that data into pixels.
//
// WHY IT IS A VIEW AND NOT THE DATA:
//   - `interaction` used to ask the UI "is a hand non-empty?" through a callback. It now reads the
//     selected slot itself, so the world and the UI cannot disagree about what is in your hand.
//   - Selection and stack moves are COMMANDS (`SelectSlot`, `SwapSlots`), so the UI never writes
//     component data — see ecs/core/commands.ts for why that rule exists.
//
// RECONCILE, DON'T REBUILD: sync() is called once per frame by the `ui.inventory` render system. It
// diffs the component against the last drawn state and only writes the widgets that changed, which is
// what makes "render every frame" cheap enough to be the default — and it removes the whole class of
// bug where a UI event handler forgets to re-render after changing the data.
//
// IT WRITES WIDGET COMPONENTS, SO IT MUST RUN BEFORE THE RECONCILER. That is not a convention: this
// system now declares `writes: [UI_IMAGE, UI_STATE, UI_TEXT, UI_TIP]` and `ui.widgets` reads those same
// components, so the schedule REFUSES to start unless the edge between them is declared (main.ts
// declares `after: [ui.inventory]`). Two systems touching one component and leaving the order to
// registration luck is exactly what the scheduler exists to prevent.
//
// Open/closed is NOT component data: it is view state (one panel, no entity can own "the backpack is
// open"), so it stays here — it is now one widget's `hidden` flag.
import { getBlockIcon, peekBlockIcon } from "../rendering/blockicons";
import { CHECKER_TEXTURE_URL } from "../rendering/textures";
import { getBlockDef } from "../blockregistry";
import { HOTBAR_SLOTS, INVENTORY, INVENTORY_SLOTS, type InventoryC } from "../ecs/components/Player";
import { UI_MODAL } from "../ecs/resources";
import { SelectSlot, SwapSlots } from "../ecs/commands";
import type { Entity, SystemAccess, World } from "../ecs/World";
import { onUiAction, UI_ACTIONS } from "../ecs/ui/actions";
import {
  setUiImage,
  setUiSelected,
  setUiText,
  setUiTip,
  setUiVisible,
  spawnButton,
  spawnLabel,
  spawnPanel,
  UI_IMAGE,
  UI_STATE,
  UI_TEXT,
  UI_TIP,
} from "../ecs/ui/widgets";

/** Declared access: a view of the player's INVENTORY component that WRITES WIDGET DATA and nothing
 *  else. No DOM target any more — the only system that touches an element is the reconciler. */
export const INVENTORY_VIEW_ACCESS: SystemAccess = {
  reads: [INVENTORY],
  writes: [UI_IMAGE, UI_STATE, UI_TEXT, UI_TIP],
};

/** The action id a bag slot dispatches; its VALUE is the absolute slot index. One handler serves the
 *  whole grid, which is why the slots do not each need a closure. */
const BAG_CLICK = "inv.bag";
/** Baked icon size, in px (the old view had an unused `iconSize` field and a dead re-bake path). */
const ICON_SIZE = 40;

export class Inventory {
  /** Widgets by inventory slot index (0..HOTBAR_SLOTS-1 = hotbar, then the bag) */
  private readonly slots: Entity[] = [];
  private readonly icons: Entity[] = [];
  private readonly counts: Entity[] = [];
  private readonly panel: Entity;
  /** The hotbar strip (spawned VISIBLE — `ui.hud` owns whether it is shown, see hotbarEntity) */
  private readonly hotbar: Entity;
  /** Last drawn signature per slot, so sync() can skip unchanged widgets */
  private readonly drawn: string[] = new Array<string>(INVENTORY_SLOTS).fill("\u0000");
  private drawnSelected = -1;

  /** Is the backpack up? The state IS the resource (`UI_MODAL.inventory`, flipped by ui.navigation) and
   *  the panel's visibility is painted from it by that system — this view writes neither, so there is no
   *  second copy of "the backpack is open" to drift. */
  get open(): boolean {
    return this.world.resource(UI_MODAL).inventory;
  }

  /** The panel widget, for ui.navigation (the system that paints every modal tree) */
  get panelEntity(): Entity {
    return this.panel;
  }

  /** The always-on hotbar strip, for `ui.hud` — the system that hides the GAMEPLAY widgets while no
   *  world is running. It is spawned VISIBLE (the hand-written HUD had no visibility state at all), so
   *  something has to own that flag, and it is not this view: a visibility flag is world state. */
  get hotbarEntity(): Entity {
    return this.hotbar;
  }

  constructor(
    private readonly world: World,
    private readonly entity: Entity,
  ) {

    const hotbar = spawnPanel(world, null, "inv.hotbar");
    this.hotbar = hotbar;
    for (let i = 0; i < HOTBAR_SLOTS; i++) this.addSlot(world, hotbar, i, false);

    this.panel = spawnPanel(world, null, "inv.panel", { hidden: true });
    const inner = spawnPanel(world, this.panel, "inv.inner");
    spawnLabel(world, inner, "inv.title", "inv.title");
    const grid = spawnPanel(world, inner, "inv.grid");
    for (let i = HOTBAR_SLOTS; i < INVENTORY_SLOTS; i++) this.addSlot(world, grid, i, true);

    // A bag slot click swaps it with the selected hotbar slot. Same behaviour as the hand-written view,
    // now declared as ONE action instead of 27 listeners.
    onUiAction(world.resource(UI_ACTIONS), BAG_CLICK, (value) => {
      this.world.commands.send(SwapSlots, {
        entity: this.entity,
        a: Number(value),
        b: this.inventory().selected,
      });
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.repeat) return;
      if (ev.code.startsWith("Digit")) {
        const n = Number(ev.code.slice(5));
        if (n >= 1 && n <= HOTBAR_SLOTS) {
          this.world.commands.send(SelectSlot, { entity: this.entity, slot: n - 1 });
        }
      }
    });

    this.sync();
  }

  /** The component this view renders. A record, so the reference is stable (iron rule 2). */
  private inventory(): InventoryC {
    return this.world.get(this.entity, INVENTORY)!;
  }

  /** One cell: a slot widget holding an icon face and a count. Bag cells are clickable, hotbar cells
   *  are not (the old view only listened on the bag), so only the bag gets a button. */
  private addSlot(world: World, parent: Entity, index: number, clickable: boolean): void {
    const slot = clickable
      ? spawnButton(world, parent, "inv.slot", BAG_CLICK, String(index))
      : spawnPanel(world, parent, "inv.slot");
    const icon = spawnPanel(world, slot, "inv.icon", { image: { url: "", scrim: false } });
    const count = spawnLabel(world, slot, "inv.count", "", { raw: true });
    this.slots[index] = slot;
    this.icons[index] = icon;
    this.counts[index] = count;
  }

  /** Render-lane reconcile: diff against the last drawn state, write only what changed.
   *  Called once per frame by the `ui.inventory` system — see the file header. */
  sync(): void {
    const inventory = this.inventory();
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
        setUiSelected(this.world, this.slots[i], i === inventory.selected);
      }
    }
  }

  /** Draw one slot: the placeholder icon, the name as a tooltip, the count as text, and the baked 3D
   *  icon fetched once it is ready.
   *
   *  THE PLACEHOLDER IS THE ENGINE'S CHECKER, NOT A SOLID COLOUR. It used to be the block's registry
   *  colour (or the theme's green fallback), which flashed a solid square for one frame on every stack
   *  move: this view writes DATA and the reconciler paints once per frame, so the intermediate state
   *  ("no icon yet") is a real painted frame — where the hand-written view wrote the DOM twice inside
   *  one task and the browser never showed it. Two reasons the checker is the better placeholder: it
   *  reads as "no icon yet" instead of as a real item, and it is the same look the world uses for a
   *  block with no texture, so it says the truth about what the slot is showing. */
  private draw(i: number): void {
    const item = this.inventory().slots[i];
    if (!item) {
      setUiImage(this.world, this.icons[i], "", false, "transparent");
      setUiText(this.world, this.counts[i], "", true);
      setUiTip(this.world, this.slots[i], "");
      return;
    }
    const def = getBlockDef(item.type);
    // An icon that is ALREADY baked is written straight away, in ONE write: no placeholder state ever
    // reaches a frame. That is the whole reason the renderer exposes a synchronous peek — this view
    // writes data and the reconciler paints once per frame, so a placeholder followed by a promise
    // would be a visible frame of the checker on every stack move (the hand-written view wrote the DOM
    // twice inside one task, where the browser never showed it). Only a first-time bake has to wait,
    // and it says so with the engine's checker rather than with a solid colour that reads as a real item.
    const baked = peekBlockIcon(item.type, ICON_SIZE);
    setUiImage(this.world, this.icons[i], baked ?? CHECKER_TEXTURE_URL, false);
    setUiTip(this.world, this.slots[i], def?.label ?? item.type); // Tooltip shows the block name
    setUiText(this.world, this.counts[i], item.count > 1 ? `${item.count}` : "", true);
    if (!baked) this.fetchIcon(i);
  }

  /** Bake and backfill the slot icon async. The `current.type === item.type` guard means a slot that
   *  changed hands while the bake was in flight cannot be overwritten by the old block's icon. */
  private fetchIcon(i: number): void {
    const item = this.inventory().slots[i];
    if (!item) return;
    const type = item.type;
    void getBlockIcon(type, ICON_SIZE).then((url) => {
      const current = this.inventory().slots[i];
      if (url && current && current.type === type) {
        setUiImage(this.world, this.icons[i], url, false, "");
      }
    });
  }
}
