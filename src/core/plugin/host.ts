// ===== What the CATALOGUE hands a plugin, and what a discovered plugin must export (P1.40) =====
// Two shapes, both small, and both about the same thing: making a plugin folder self-sufficient.
//
//   * `PluginHost` — the services the composition root publishes BY NAME. A plugin that needs one narrows it
//     to its own factory's types inside its own `plugin.ts`, so this module never has to know a plugin's
//     types (a plugin may not import another plugin, and the host may not import any of them either).
//   * `DiscoveredPlugin` — what `plugins/<id>/plugin.ts` returns: the descriptor plus whether the surface may
//     be installed and uninstalled AT RUNTIME (the `hot` flag the hot-plug keys read).
//
// The discovery itself is `boot/plugin-catalog.ts` (Vite's build-time glob over `plugins/<id>/plugin.ts`).
import type { World } from "../world";
import type { Plugin } from "./descriptor";

export interface PluginHost {
  /** The world being assembled. */
  readonly world: World;
  /** The root's log sink. */
  readonly log: (line: string) => void;
  /** "Is a world running?" — most surfaces gate on it. */
  readonly inWorld: () => boolean;
  /** The INSTANCES the optional surfaces are built around, by name (`uiPicker`, `uiToast`, `uiInventory`,
   *  `inv`, `uiKeybind`, `keybindEntries`, ...): the root constructs them because they close over wiring the
   *  plugin cannot see, and a plugin's `plugin.ts` narrows the ones it needs.
   *
   *  `unknown` is deliberate. A typed field here would be the host's guess at a plugin's types, and the one
   *  place that CAN know them is the plugin's own folder. */
  readonly instances: Readonly<Record<string, unknown>>;
}

export interface DiscoveredPlugin {
  /** The descriptor, ready for `installPlugins` and for the hot-plug catalogue. */
  readonly plugin: Plugin;
  /** May it be installed/uninstalled WHILE THE GAME RUNS? The keys in `data/globals/hotplug.ts` look a
   *  surface up by id in the discovered set, so a plugin that declares `hot: true` gets its key for free. */
  readonly hot: boolean;
}
