// ===== A plugin, as data =====
// A plugin is NOT a class and NOT a base type to extend: it is an id, its dependencies, and one `setup`
// function that contributes into extension points. That is the whole contract, and it is deliberately
// small — everything else (which RESOURCE a plugin contributes, whether it also has a `stop`) is a
// capability the core can grow later without changing the shape of the plugin itself.
import type { PluginApi } from "./api";

export interface Plugin {
  /** Stable id: the manifest references it, the registry files contributions under it, the log names it. */
  readonly id: string;
  /** Plugin ids this one needs installed BEFORE its `setup` runs. A missing dep disables the plugin. */
  readonly deps?: readonly string[];
  /** Contribute into extension points. Runs once, during install, before `world.start()`. */
  readonly setup: (api: PluginApi) => void;
  /** OPTIONAL: runs AFTER `world.start()` — the schedule is resolved, every resource is in place, so this
   *  is where a plugin may look at the assembled world (and where a future hot-plug round would also
   *  re-run it). A `start` that throws disables that plugin and nothing else. */
  readonly start?: (api: PluginApi) => void;
  /** OPTIONAL: the reverse of `start`, called in reverse install order by `stopPlugins` (the app quitting,
   *  or — once P1.19 lands — a plugin being uninstalled). A plugin that never started is never stopped. */
  readonly stop?: (api: PluginApi) => void;
}

/** Identity function: it exists for the type and for greppability ("who is a plugin?"). */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
