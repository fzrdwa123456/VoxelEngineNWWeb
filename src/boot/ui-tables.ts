// ===== The UI TABLES' implementation: what a plugin FILES, installed and withdrawn (P1.41) =====
// The other half of `core/plugin/ui-tables.ts`: the kernel declares the shape (`UiTablesHook`), the composition
// root does the work — because the two tables are DATA (`data/globals/actions.ts`, `data/globals/sources.ts`)
// and a `core/` file may not name a data value at runtime (P1.18d). This module sits in `boot/`, the one layer
// allowed to import both, and is handed to `installPlugins` and to the hot-plug host.
//
// WHAT IT DOES: for every entry a plugin filed into `SLOT_UI_ACTIONS` / `SLOT_UI_SOURCES`, write it into the
// table at install time and delete it again on uninstall — so "the surface is off" means the table agrees, a
// re-install never hits a stale claim, and no widget can reach a handler whose plugin is gone.
//
// A duplicate id THROWS inside `onUiAction`/`onUiSource`. That is deliberate and reaches the installer, which
// disables the plugin and logs it: two owners claiming one action id is a wiring bug, not a merge.
//
// BOTH HALVES ARE A NO-OP for a world with no UI lane (no `UI_ACTIONS`/`UI_SOURCES` resource) — which is what
// keeps the gate's stub worlds, and a build with the ui plugin off, out of the way.
import { SLOT_UI_ACTIONS, SLOT_UI_SOURCES } from "../core/extension/slots";
import { onUiAction, UI_ACTIONS } from "../data/globals/actions";
import { onUiSource, UI_SOURCES } from "../data/globals/sources";
import type { ExtensionRegistry, WithdrawnContribution } from "../core/extension/registry";
import type { World } from "../core/world";
import type { UiTablesHook } from "../core/plugin/ui-tables";

function install(registry: ExtensionRegistry, world: World, owner: string): number {
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

function remove(world: World, withdrawn: readonly WithdrawnContribution[]): number {
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

/** The implementation the root injects (see `core/plugin/ui-tables.ts` for why it is injected at all). */
export const uiTables: UiTablesHook = { install, remove };
