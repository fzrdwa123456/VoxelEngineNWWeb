// ===== ui-keybind, as a DISCOVERED plugin (P1.40) =====
// See `plugins/ui-debug/plugin.ts` for the shape. This one takes TWO factory arguments: the system bag and the
// key bind ENTRY data the root reads from the bind table. Both are narrowed from the host — the entry type is
// taken from the factory itself (`Parameters<...>`), so this file never guesses a name. `hot: true` -> F9.
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import { createUiKeybindPlugin } from "./index";

type Entries = Parameters<typeof createUiKeybindPlugin>[1];

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  const uiKeybind = host.instances.uiKeybind as Parameters<typeof createUiKeybindPlugin>[0]["uiKeybind"];
  const entries = host.instances.keybindEntries as Entries;
  return { hot: true, plugin: createUiKeybindPlugin({ uiKeybind }, entries) };
}
