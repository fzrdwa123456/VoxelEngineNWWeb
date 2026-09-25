// ===== ui-debug, as a DISCOVERED plugin (P1.40) =====
// The catalogue finds this file and calls `createPlugin`, so adding a plugin folder no longer means editing
// `boot/main.ts`. The ADAPTER lives here, not in the host, because this folder is the only place that knows
// what this plugin needs: the host publishes instances by NAME (`host.instances`) and this file narrows the
// one it uses to its own factory's type. `hot: true` is what gives it a hot-plug key (F8).
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import { createUiDebugPlugin } from "./index";

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  const uiPicker = host.instances.uiPicker as { step(): void; close(): void };
  return { hot: true, plugin: createUiDebugPlugin({ uiPicker }) };
}
