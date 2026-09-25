// ===== THE PLUGIN CATALOGUE, discovered from the FOLDER TREE (P1.40) =====
// The plugin list used to be hand-maintained arrays in `boot/main.ts` (the boot list, the hot-plug catalogue,
// and one factory call per optional surface). A folder anybody added was invisible until someone remembered to
// wire it — and forgetting the CATALOGUE meant the surface existed but had no hot-plug key.
//
// Now a folder joins by EXISTING: `plugins/<id>/plugin.ts` is the opt-in, and Vite's build-time glob below
// turns the tree into the list. Nothing here enumerates anything, and adding a plugin does not touch this
// file: the plugin's own `plugin.ts` adapts `PluginHost` to its factory (see core/plugin/host.ts).
//
// The glob is resolved at BUILD time — the modules are part of the bundle — so there is no runtime disk
// lookup, no dynamic-import failure mode, and `check:ecs` can hold the folder tree and this list together.
import type { DiscoveredPlugin, PluginHost } from "../core/plugin/host";

type PluginModule = { createPlugin?: (host: PluginHost) => DiscoveredPlugin };

/** Every `plugins/<id>/plugin.ts` in the build, keyed by its path. */
const modules = import.meta.glob("../plugins/*/plugin.ts", { eager: true }) as Record<string, PluginModule>;

/** The paths the glob found (sorted). `check:ecs` walks the same folder tree and asserts the two agree: a
 *  `plugin.ts` this list is missing, or a folder with no `plugin.ts` at all, is drift the build must not
 *  allow — that is what keeps "add a folder" from silently doing nothing. */
export function discoveredPluginPaths(): string[] {
  return Object.keys(modules).sort();
}

/** Every discovered plugin, in a STABLE order (by id).
 *
 *  Stable matters: the schedule resolves `after`/`before` by name, and the registration order is only the
 *  default order, so it must not follow the filesystem's enumeration. A module without a `createPlugin`
 *  export is skipped LOUDLY — that is a folder that opted in and then did not say how to build itself. */
export function discoverPlugins(host: PluginHost): DiscoveredPlugin[] {
  const out: DiscoveredPlugin[] = [];
  for (const [path, mod] of Object.entries(modules)) {
    const make = mod?.createPlugin;
    if (typeof make !== "function") {
      host.log(`PLUGIN ${path}: no createPlugin() export - not a discoverable plugin, skipped`);
      continue;
    }
    out.push(make(host));
  }
  return out.sort((a, b) => (a.plugin.id < b.plugin.id ? -1 : a.plugin.id > b.plugin.id ? 1 : 0));
}
