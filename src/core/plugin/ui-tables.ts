// ===== The two UI TABLES a plugin may contribute into (P1.41) — the kernel's half, which is a SHAPE =====
// `UI_ACTIONS` and `UI_SOURCES` are RESOURCES the views fill while they wire (id -> handler, id -> getter). A
// plugin could always write into them by hand from `setup` — and then NOTHING took the entry back out on
// uninstall: the id stayed claimed (so a re-install threw `already registered`) and a stale handler stayed
// reachable from a widget that outlived its plugin.
//
// THE INVERSION (P1.18d): the installer used to live in THIS file and import the two tables, i.e. a `core/`
// file naming a `data/` VALUE — the one thing the kernel must not do, because the mechanism would then depend
// on the program (`check:ecs` counts that direction and fails on a single runtime import). The kernel declares
// the SHAPE instead, and the composition root supplies the implementation: `boot/ui-tables.ts`, the one layer
// that may import both. It travels the way every other capability does — through the installer's options and
// the hot-plug host — so `core/` never learns that the tables exist.
import type { ExtensionRegistry, WithdrawnContribution } from "../extension/registry";
import type { World } from "../world";

/** The kernel's half of the UI tables: what `installPlugins` and the hot-plug host call, implemented by the
 *  composition root.
 *
 *  `install` returns how many entries landed (0 = the plugin filed none, or this world has no UI lane);
 *  `remove` takes back exactly what `registry.withdraw(owner)` returned. Both are pure plumbing — no policy
 *  lives here, which is why the kernel can stay deaf to which tables a UI has. */
export interface UiTablesHook {
  install(registry: ExtensionRegistry, world: World, owner: string): number;
  remove(world: World, withdrawn: readonly WithdrawnContribution[]): number;
}
