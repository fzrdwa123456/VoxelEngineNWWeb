// ===== input, as a DISCOVERED plugin (P1.18b) =====
// The device layer's DATA: it claims the KEYMAP and KEYBIND_GESTURE tokens, whose values the root inserts (the
// bind table is loaded from the settings file with the rest of the configuration, and the gesture is created
// with the other device state). Nothing here needs a host instance.
//
// `hot: false`: the bind table is read by movement/interaction/input every tick, and the settings file is
// validated against it — a surface that arrived at runtime could not re-derive either.
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import { inputPlugin } from "./index";

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  void host;
  return { hot: false, plugin: inputPlugin };
}
