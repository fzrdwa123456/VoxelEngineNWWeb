// ===== Inventory VIEW: a WIDGET surface — and now ONLY wiring =====
// The stacks and the selected slot are the INVENTORY component (ecs/components/Player.ts), which is what
// the gameplay systems read; this file SPAWNS the widget tree and publishes the handles, and
// ecs/ui/inventory.ts (the `ui.inventory` system) turns the component into widget DATA — an icon URL, a
// count, a selected flag — which ecs/ui/system.ts turns into pixels.
//
// WHY THE RECONCILE IS NOT HERE ANY MORE: it used to be `sync()`, a method on this view, invoked by a
// one-line system whose access declaration was the view's. Reading component data, diffing it against what
// was last written and touching the changed widgets is exactly what a ui-lane system does, and the handles
// it needs (the slots, their icon faces and their counts) travel as the INVENTORY_WIDGETS resource — so
// the view stopped being called once per frame at all. Spawning stays here because it is a structural
// change, which a system may not make (iron rule 1).
//
// WHO SPAWNS WHAT (P1.34): the BAG is a modal surface, so it is built here once, during wiring. The HOTBAR
// is a HUD ELEMENT — `ui.hud` owns its lifetime, which is what makes the inventory layer optional at
// runtime: uninstalling the plugin takes the strip down, installing it builds a new one. So the hotbar
// arrives through `buildHotbar` (called at a barrier by the host) instead of in the constructor, and the
// cells it spawns land in the SAME handle arrays `ui.inventory` writes (a stale handle is inert: every
// setter checks the component first).
//
// WHY THE DATA IS NOT HERE: `interaction` used to ask the UI "is a hand non-empty?" through a callback. It
// reads the selected slot itself now, so the world and the UI cannot disagree about what is in your hand.
// Selection and stack moves are COMMANDS (`SelectSlot`, `SwapSlots`), so the UI never writes component
// data — see ecs/core/commands.ts for why that rule exists.
//
// Open/closed is not component data either: the state is `UI_MODAL.inventory` (flipped by ui.navigation,
// which also paints it), so there is no second copy of "the backpack is open" to drift.
import { HOTBAR_SLOTS, INVENTORY, INVENTORY_SLOTS, type InventoryC } from "../../player/components";
import { SwapSlots } from "../../../core/effect/commands";
import { UI_MODAL } from "../../../data/globals/resources";
import { UI_PAINT } from "../../../data/globals/paint";
import { onUiAction, UI_ACTIONS, ACTION_BAG_CLICK } from "../../../data/globals/actions";
import { spawnButton, spawnLabel, spawnPanel } from "../../ui/components";
import type { Entity, World } from "../../../core/world";

/** The action id a bag slot dispatches is DATA (`ACTION_BAG_CLICK`); its VALUE is the absolute slot index.
 *  One handler serves the whole grid, which is why the slots do not each need a closure. */

export class Inventory {
  /** Widgets by inventory slot index (0..HOTBAR_SLOTS-1 = hotbar, then the bag) */
  private readonly slots: Entity[] = [];
  private readonly icons: Entity[] = [];
  private readonly counts: Entity[] = [];
  private readonly panel: Entity;

  /** Is the backpack up? The state IS the resource (`UI_MODAL.inventory`, flipped by ui.navigation) and
   *  the panel's visibility is painted from it by that system — this view writes neither. */
  get open(): boolean {
    return this.world.resource(UI_MODAL).inventory;
  }

  /** The panel widget, for ui.navigation (the system that paints every modal tree) */
  get panelEntity(): Entity {
    return this.panel;
  }

  /** The widget handles `ui.inventory` writes into — published as the INVENTORY_WIDGETS resource by the
   *  composition root. The arrays are this view's own and they are MUTATED IN PLACE by `buildHotbar` (a
   *  re-install fills slots 0..HOTBAR_SLOTS-1 again), which is why the resource gets the arrays and never a
   *  copy: a fresh array would leave the system writing the dead cells of the previous strip. */
  get widgets(): { slots: readonly Entity[]; icons: readonly Entity[]; counts: readonly Entity[] } {
    return { slots: this.slots, icons: this.icons, counts: this.counts };
  }

  constructor(
    private readonly world: World,
    private readonly entity: Entity,
  ) {
    // THE BAG (a modal surface: built once, hidden until UI_MODAL.inventory says otherwise).
    this.panel = spawnPanel(world, null, "inv.panel", { hidden: true });
    const inner = spawnPanel(world, this.panel, "inv.inner");
    spawnLabel(world, inner, "inv.title", "inv.title");
    const grid = spawnPanel(world, inner, "inv.grid");
    for (let i = HOTBAR_SLOTS; i < INVENTORY_SLOTS; i++) this.addSlot(world, grid, i, true);

    // A bag slot click swaps it with the selected hotbar slot: ONE action id instead of 27 listeners. It
    // sends a COMMAND (the only way non-system code may change state) and reads the selection from the
    // component the gameplay systems read, so the two cannot disagree.
    onUiAction(world.resource(UI_ACTIONS), ACTION_BAG_CLICK, (value) => {
      this.world.commands.send(SwapSlots, {
        entity: this.entity,
        a: Number(value),
        b: this.inventory().selected,
      });
    });

    // The HOTBAR digit keys (1..9) are NOT handled here: this view used to `document
    // .addEventListener("keydown")` and send SelectSlot itself — a view owning a device listener, and with
    // no gate, so 1..9 also worked at the main menu, on the loading screen and with the pause menu open.
    // The decision is `ui.navigation`'s, taken from the key EDGES the device layer publishes (ecs/ui/
    // navigation.ts), which is also where the inventory key already lived.
  }

  /** THE HOTBAR STRIP — the HUD element's `build`, called by `ui.hud` at a barrier whenever the element is
   *  mounted (boot, and again after every hot re-install). It returns the ROOT: the host despawns the whole
   *  subtree when the element goes away.
   *
   *  Spawned HIDDEN: the host writes the element's gate in the same frame (see the hud view's note), and a
   *  strip that is up for one frame would be a visible flash every time the plugin is installed.
   *
   *  THE PAINT CACHE IS INVALIDATED HERE, and that is not an optimisation: `ui.inventory` diffs the component
   *  against what it last DREW, and those cells are the ones that were just despawned — without this the diff
   *  would skip every hotbar cell and the strip would come back BLANK after a hot re-install. */
  buildHotbar(world: World): Entity {
    const hotbar = spawnPanel(world, null, "inv.hotbar", { hidden: true });
    for (let i = 0; i < HOTBAR_SLOTS; i++) this.addSlot(world, hotbar, i, false);
    const paint = world.resource(UI_PAINT).inventory;
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      paint.drawn[i] = "\u0000"; // no real signature equals this: the diff below redraws the cell
      paint.waiting[i] = 0;
    }
    return hotbar;
  }

  /** The component this view's widgets mirror. A record, so the reference is stable (iron rule 2). */
  private inventory(): InventoryC {
    return this.world.get(this.entity, INVENTORY)!;
  }

  /** One cell: a slot widget holding an icon face and a count. Bag cells are clickable, hotbar cells are
   *  not (the old view only listened on the bag), so only the bag gets a button. */
  private addSlot(world: World, parent: Entity, index: number, clickable: boolean): void {
    const slot = clickable
      ? spawnButton(world, parent, "inv.slot", ACTION_BAG_CLICK, String(index))
      : spawnPanel(world, parent, "inv.slot");
    const icon = spawnPanel(world, slot, "inv.icon", { image: { url: "", scrim: false } });
    const count = spawnLabel(world, slot, "inv.count", "", { raw: true });
    this.slots[index] = slot;
    this.icons[index] = icon;
    this.counts[index] = count;
  }
}
