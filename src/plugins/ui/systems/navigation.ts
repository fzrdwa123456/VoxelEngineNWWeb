// ===== ui.navigation: which modal surface is up, as DATA =====
// The ESC state machine used to live in main.ts as a five-branch if-chain over `mainMenu.visible`,
// `inv.open`, `menu.settingsOpen` and `menu.visible` — every one of them a private field of a view, so
// "which level am I on" had four different answers in four places, and the step-back logic read them
// through object methods. What is ECS here:
//   * the NAVIGATION STATE is `UI_MODAL` (`mainMenu` / `menu` / `inventory` / `settings` / `gen`). Every
//     surface publishes into it instead of keeping its own visibility field, so there is one answer;
//   * the DECISIONS (ESC step-back, the inventory key, the inventory mouse bind) are taken in `step()`
//     from the key/button EDGES the device layer publishes — the same channel `ui.picker` uses;
//   * this system PAINTS the modal widget trees from that state, so a surface never writes its own
//     visibility any more (`Menu.show()` is a data write now);
//   * the pointer-lock EFFECTS (unlock on open, relock on close) are edge-triggered from the state, and
//     arrive as injected callbacks, so this module stays DOM-free.
// What stays outside, deliberately: the Space/contextmenu/resize listeners in main.ts
// (`preventDefault` can only happen in the event that must be cancelled) and the arm paths of the key
// bind gesture (click-synthesis timing, see ui/menu.ts).
import { HOTBAR_SLOTS } from "../../player/components";
import { SelectSlot } from "../../../core/effect/commands";
import { HotPlugPlugin } from "../../../core/effect/commands";
import { hotPlugSurfaceForKey } from "../../../data/globals/hotplug";
import { LOCAL_PLAYER, UI_MODAL, type UiModalState } from "../../../data/globals/resources";import { KeyEdgeReader, type KeyEventLog } from "../../../data/globals/resources";
import { KEY_EVENTS } from "../../../data/globals/resources";
import type { Entity, SystemAccess, World } from "../../../core/world";
import { UI_PAINT, type UiNavigationPaint } from "../../../data/globals/paint";
import { UI_PAGES_MOUNTED, type MountedPage } from "../../../data/globals/ui-pages";
import { UI_STATE, setUiVisible } from "../components";

/** The settings sub-panel ids, as data. `ui/menu.ts` owns the panel list; this is the same four. */
export type SettingsPanelId = "settings" | "lang" | "pack";

export interface NavigationTrees {
  /** The pause menu: its root, its main panel and its four settings panels */
  readonly pauseRoot: Entity;
  readonly pauseMain: Entity;
  readonly pausePanels: Readonly<Record<SettingsPanelId, Entity>>;
  /** The main menu: root, main panel, world-type picker and its four settings panels */
  readonly mainRoot: Entity;
  readonly mainMain: Entity;
  readonly genPanel: Entity;
  readonly mainPanels: Readonly<Record<SettingsPanelId, Entity>>;
  /** The inventory/backpack panel (the hotbar is always up, so it is not navigation) */
  readonly inventoryPanel: Entity;
}

export interface NavigationDeps {
  readonly trees: NavigationTrees;
  /** The key that toggles the inventory (a BIND CODE, so a mouse button bound to "inventory" works too) */
  readonly inventoryCode: () => string;
  /** A rebind capture owns the keyboard: it must not also open a menu (see ui/menu.ts) */
  readonly capturing: () => boolean;
  /** Is a world actually RUNNING? The two actions below open a UI that only means something in a world
   *  (the pause menu, the backpack), so they are refused while the loading screen is up — the startup
   *  and a world entry both spend seconds in the `boot` mode with no modal open, and an ESC during them
   *  used to open the pause menu OVER the loading screen (and E opened the backpack behind it). */
  readonly inWorld: () => boolean;
  /** Pointer-lock effects, injected (this system writes no DOM and no device state by itself) */
  readonly prepareUnlock: () => void;
  /** Is a key bind DRAG in progress? (the KEYBIND_GESTURE resource, read through the root). Optional: a
   *  driver that does not model a drag (a test) simply never reports one. */
  readonly dragging?: () => boolean;
  /** Cancel that drag: clear the gesture and end a rebind capture. `reason` is for the log. */
  readonly cancelDrag?: (reason: string) => void;
  readonly exitPointerLock: () => void;
  readonly centerCursor: () => void;
  readonly relock: (reason: string) => void;
  readonly relockSoon: (reason: string) => void;
  readonly applyCursor: () => void;
  readonly log: (line: string) => void;
}

/** It writes the modal widgets' visibility and publishes the navigation state (a resource). It also
 *  READS the bind table, because "which key toggles the inventory" is a bind (KEYMAP). */
export const UI_NAVIGATION_ACCESS: SystemAccess = {
  writes: [UI_STATE],
  readsExternal: ["inputEdges", "keybinds"],
  writesExternal: ["pointerLock", "cursor"],
};

/** ONE step back through the sub-page ladder, as data. The mapping is shared by the ESC ladder, by
 *  `SettingsPanels`-driven Back buttons and by both menus' `goBack()`, because it used to exist twice
 *  and the copies disagreed: when the ESC branch was inlined into this system it lost the MIDDLE rung,
 *  so ESC on the settings LIST was a no-op (`settings` was already `"settings"`) and ESC on a sub-page
 *  skipped a level (straight to the container panel). */
export function stepBackSettings(ui: UiModalState): void {
  if (ui.gen) ui.gen = false;
  else if (ui.settings === "settings") ui.settings = null;
  else if (ui.settings !== null) ui.settings = "settings";
}

export class UiNavigationSystem {
  private readonly ui: UiModalState;
  private readonly reader: KeyEdgeReader;
  /** The mounted pages (each carries the panel this painter shows) — world data, filled by the page host. */
  /** null when the world has no page host at all — a legitimate world (and what the gate's stub builds). */
  private readonly pages: Map<string, MountedPage> | null;
  /** The player whose INVENTORY the hotbar keys select on (LOCAL_PLAYER, resolved once) */
  private readonly player: Entity;
  /** What the last frame saw, so the pointer-lock effects fire on an EDGE and not every frame. The DATA
   *  is UI_PAINT.navigation (ecs/ui/paint.ts) — a paint cache is world state like everything else. */
  private readonly paintCache: UiNavigationPaint;
  private get inventoryOpen(): boolean {
    return this.paintCache.inventoryOpen;
  }
  private set inventoryOpen(v: boolean) {
    this.paintCache.inventoryOpen = v;
  }
  private get menuOpen(): boolean {
    return this.paintCache.menuOpen;
  }
  private set menuOpen(v: boolean) {
    this.paintCache.menuOpen = v;
  }

  constructor(
    private readonly world: World,
    private readonly deps: NavigationDeps,
  ) {
    this.ui = world.resource(UI_MODAL);
    this.reader = new KeyEdgeReader(world.resource(KEY_EVENTS) as KeyEventLog);
    this.pages = world.hasResource(UI_PAGES_MOUNTED) ? world.resource(UI_PAGES_MOUNTED) : null;
    this.player = world.resource(LOCAL_PLAYER);
    this.paintCache = world.resource(UI_PAINT).navigation;
  }

  /** ui lane. Decisions first (they only write the state), then the paint, then the lock effects. */
  step(): void {
    const ui = this.ui;
    this.reader.drain((edge) => {
      if (!edge.down || edge.repeat) return; // a held key is one press; releases change nothing here
      if (edge.code === "Escape") {
        // A key bind DRAG owns ESC: it cancels the drag and does NOT step back. The decision lives HERE with
        // the rest of the ESC ladder — not in the gesture's device listener, which cannot reliably preempt
        // the key-edge publisher (only listeners registered after it can be stopped, and the registration
        // order is wiring order). Having it in both places is what made ESC cancel the drag AND walk up a
        // menu level at the same time.
        if (this.deps.dragging?.()) {
          this.deps.cancelDrag?.("ESC");
          return;
        }
        this.onEscape();
        return;
      }
      // THE HOT-PLUG KEY (P1.24). Installing or uninstalling a plugin at runtime is ASSEMBLY, not game state:
      // it adds systems to the schedule and re-resolves it, so it goes through the `HotPlugPlugin` COMMAND,
      // which the barrier applies before the next lane runs. This system is the right home for the key because
      // it already owns "which key means what" for the ui lane, and the table it asks is DATA
      // (`data/globals/hotplug.ts`), so this branch knows no plugin ids at all. It is deliberately NOT gated on
      // a world: hot-plugging is a developer affordance that works at the main menu too (the ui lane runs
      // there), and the outcome comes back as a toast, which is the only feedback a window with no console has.
      const hotSurface = hotPlugSurfaceForKey(edge.code);
      if (hotSurface) {
        this.world.commands.send(HotPlugPlugin, hotSurface.id);
        return;
      }
      if (edge.code === this.deps.inventoryCode()) {
        // The E key and a mouse button bound to "inventory" are the SAME code, which is what makes this
        // one branch: a rebind capture owns the keyboard, and a menu owns the inventory key. A world
        // must be RUNNING as well — the backpack belongs to a world, not to a loading screen.
        if (!this.deps.capturing() && !ui.mainMenu && !ui.menu && this.deps.inWorld()) {
          this.setInventory(!ui.inventory);
        }
        return;
      }
      // The HOTBAR keys. This used to be a `document` keydown listener inside the inventory VIEW
      // (ui/inventory.ts): a view owning a device listener, and with NO gate at all — pressing 1..9 at
      // the main menu, on the loading screen or with the pause menu open still moved the selection. The
      // decision belongs here with the other key decisions (this system already owns "which key means
      // what" for the inventory), the player and the slot count are world state, and the gate is the
      // inventory key's gate: a world must be running, no capture owns the keyboard, no MENU is up. The
      // backpack is deliberately NOT excluded — selecting a slot with the bag open is harmless and the
      // hotbar highlight is the feedback.
      if (edge.code.startsWith("Digit")) {
        const slot = Number(edge.code.slice(5)) - 1;
        if (slot >= 0 && slot < HOTBAR_SLOTS && !this.deps.capturing() && !ui.mainMenu && !ui.menu &&
            this.deps.inWorld()) {
          this.world.commands.send(SelectSlot, { entity: this.player, slot });
        }
      }
    });

    this.paint();

    // Pointer-lock effects, edge-triggered from the state. Opening the backpack releases the mouse and
    // stops the player's INTENT (canControl reads UI_MODAL); closing it relocks on the next event-loop
    // turn, which dodges Chromium's "ESC exits lock" default action during the current key dispatch.
    if (ui.inventory !== this.inventoryOpen) {
      this.inventoryOpen = ui.inventory;
      if (ui.inventory) {
        this.deps.prepareUnlock();
        this.deps.log("UNLOCK request (inventory)");
        this.deps.exitPointerLock();
        this.deps.centerCursor();
      } else {
        this.deps.relockSoon("inventory E");
      }
    }
    if (ui.menu !== this.menuOpen) this.menuOpen = ui.menu;
    this.deps.applyCursor();
  }

  /** ESC: the step-back ladder. It NEVER leaves the main menu, and it only ever writes state. */
  private onEscape(): void {
    const ui = this.ui;
    this.deps.log(
      `ESC modal=${ui.mainMenu || ui.menu || ui.inventory} mainMenu=${ui.mainMenu} menu=${ui.menu} ` +
        `settings=${ui.settings ?? "null"} gen=${ui.gen} capturing=${this.deps.capturing()}`,
    );
    if (ui.mainMenu) {
      // Main menu: ESC steps back through the world-type page or any settings sub-panel; otherwise
      // ignored (ESC never leaves the main menu).
      if (ui.gen || ui.settings !== null) stepBackSettings(ui);
      return;
    }
    if (ui.inventory) {
      this.setInventory(false);
      return;
    }
    if (ui.menu && ui.settings !== null) {
      // A settings sub-panel goes back to the settings LIST first, and the list goes back to the pause
      // menu — the same ladder the Back buttons use (this is the rung that was missing).
      stepBackSettings(ui);
      return;
    }
    if (ui.menu) {
      ui.menu = false;
      this.deps.relock("ESC closes menu"); // No cooldown, relock immediately
      return;
    }
    // In game: show the pause menu and release the mouse directly, so this works even when the cursor was
    // never captured. These effects are explicit here (and not a generic "menu opened" edge) because the
    // OTHER way a menu appears — window blur — must not move the cursor.
    // …and "in game" is checked rather than assumed: while a LOADING SCREEN is up (the startup, or the
    // world being built behind it) there is no modal and no world, so this branch would otherwise open
    // the pause menu over the loading screen.
    if (!this.deps.inWorld()) return;
    this.deps.prepareUnlock();
    this.deps.log("UNLOCK request (menu)");
    this.deps.exitPointerLock();
    ui.menu = true;
    this.deps.centerCursor();
  }

  /** The one painter of the modal trees: a surface changes STATE, this puts it on screen. */
  private paint(): void {
    const ui = this.ui;
    const t = this.deps.trees;
    setUiVisible(this.world, t.pauseRoot, ui.menu);
    setUiVisible(this.world, t.mainRoot, ui.mainMenu);
    setUiVisible(this.world, t.inventoryPanel, ui.inventory);
    // The settings panels are shared by both menus (only one menu is ever up), and the main panel of a
    // menu is up exactly when no settings sub-panel and no world-type picker is.
    for (const id of Object.keys(t.pausePanels) as SettingsPanelId[]) {
      setUiVisible(this.world, t.pausePanels[id], ui.menu && ui.settings === id);
    }
    for (const id of Object.keys(t.mainPanels) as SettingsPanelId[]) {
      setUiVisible(this.world, t.mainPanels[id], ui.mainMenu && ui.settings === id);
    }
    // THE PAGES a plugin contributed (P1.29): their panels belong to this painter, exactly like the four
    // settings panels above. `ui.pages` owns the widgets; WHERE they are shown is decided HERE, in the same
    // pass and from the same state as everything else — painting them from the host (which runs earlier in
    // the lane) left the page and the settings list visible together for one frame whenever ESC stepped back.
    for (const mount of this.pages?.values() ?? []) {
      const open = mount.host.id === "pause" ? ui.menu : ui.mainMenu;
      setUiVisible(this.world, mount.panel, open && ui.settings === mount.pageId);
    }
    setUiVisible(this.world, t.pauseMain, ui.menu && ui.settings === null);
    setUiVisible(this.world, t.mainMain, ui.mainMenu && ui.settings === null && !ui.gen);
    setUiVisible(this.world, t.genPanel, ui.mainMenu && ui.settings === null && ui.gen);
  }

  /** The inventory toggle: ONE place that flips the state (the lock effects follow from the edge) */
  setInventory(open: boolean): void {
    this.ui.inventory = open;
  }

  /** Which settings sub-panel is up (the panel visibility is painted from this) */
  setSettings(id: SettingsPanelId | null): void {
    this.ui.settings = id;
  }
}
