// ===== The two UI TABLES a plugin may contribute into (P1.41) =====
// `UI_ACTIONS` and `UI_SOURCES` are RESOURCES the views fill while they wire (id -> handler, id -> getter). A
// plugin could always write into them by hand from `setup` — and then NOTHING took the entry back out on
// uninstall: the id stayed claimed (so a re-install threw `already registered`) and a stale handler stayed
// reachable from a widget that outlived its plugin.
//
// These helpers make the tables the FRAMEWORK's business: what a plugin files into `SLOT_UI_ACTIONS` /
// `SLOT_UI_SOURCES` is installed at install time and removed with the plugin, so "the surface is off" means
// the table agrees. The install half is a no-op for a world with no UI lane and for a plugin that filed
// neither — which is what keeps the gate's stub worlds, and a plugin with no UI, out of the way.
import { onUiAction, UI_ACTIONS, type UiActionHandler } from "../../data/globals/actions";
import { onUiSource, UI_SOURCES, type UiSource } from "../../data/globals/sources";
import { SLOT_UI_ACTIONS, SLOT_UI_SOURCES } from "../extension/slots";
import type { ExtensionRegistry, WithdrawnContribution } from "../extension/registry";
import type { World } from "../world";

/** One action a plugin files. Same shape the slot declares, spelled out so a plugin can import a name. */
export interface PluginAction {
  readonly id: string;
  readonly run: UiActionHandler;
}

/** One bound-widget source a plugin files (the value is in the WIDGET's domain; see data/globals/sources.ts). */
export interface PluginSource {
  readonly id: string;
  readonly read: UiSource;
}

/** Install what `owner` filed, and return how many entries landed.
 *
 *  A duplicate id THROWS inside `onUiAction`/`onUiSource` — that is deliberate and reaches the installer,
 *  which disables the plugin and logs it: two owners claiming one action id is a wiring bug, not a merge. */
export function installPluginUiTables(registry: ExtensionRegistry, world: World, owner: string): number {
  const actions = registry
    .list(SLOT_UI_ACTIONS)
    .filter((entry) => registry.ownerOf(SLOT_UI_ACTIONS, entry.id) === owner);
  const sources = registry
    .list(SLOT_UI_SOURCES)
    .filter((entry) => registry.ownerOf(SLOT_UI_SOURCES, entry.id) === owner);
  if (actions.length === 0 && sources.length === 0) return 0;
  if (!world.hasResource(UI_ACTIONS) || !world.hasResource(UI_SOURCES)) return 0; // no UI lane in this world
  let installed = 0;
  const actionTable = world.resource(UI_ACTIONS);
  for (const entry of actions) {
    onUiAction(actionTable, entry.id, entry.run);
    installed++;
  }
  const sourceTable = world.resource(UI_SOURCES);
  for (const entry of sources) {
    onUiSource(sourceTable, entry.id, entry.read);
    installed++;
  }
  return installed;
}

/** Take them back out. The input is what `registry.withdraw(owner)` returned: by then the filings are gone
 *  from the registry, and the TABLE is what still has to forget them. Returns how many were removed. */
export function removePluginUiTables(world: World, withdrawn: readonly WithdrawnContribution[]): number {
  let removed = 0;
  for (const entry of withdrawn) {
    if (entry.point === SLOT_UI_ACTIONS.name && world.hasResource(UI_ACTIONS)) {
      if (world.resource(UI_ACTIONS).delete(entry.id)) removed++;
    } else if (entry.point === SLOT_UI_SOURCES.name && world.hasResource(UI_SOURCES)) {
      if (world.resource(UI_SOURCES).delete(entry.id)) removed++;
    }
  }
  return removed;
}
