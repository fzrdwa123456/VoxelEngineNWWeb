// ===== render, as a DISCOVERED plugin (P1.45) =====
// See `plugins/ui-debug/plugin.ts` for the shape (a folder opts in with this file; the adapter narrows the host
// instances it needs). Two things are specific to this one:
//
//   * the platform MESHER is a host object (a plugin may not import `host/`), so the root hands it in as a host
//     instance - the same one-way direction as every other instance;
//   * the boot driver DRIVES the chunk stream by hand, so the plugin PUBLISHES it (`RENDER_HANDLES`): the
//     reverse direction, and the shape the remaining core plugins (`player`, `ui`) need too.
//
// `hot: false`: the renderer is not one of the F8-F11 surfaces - turning it off is a manifest decision (and an
// install without it draws nothing, so "hot" would only put a broken state behind a keypress).
import type { DiscoveredPlugin, PluginHost } from "../../core/plugin/host";
import { createRenderPlugin, type RenderWiring } from "./index";
import { RENDER_HANDLES } from "../../data/globals/render-handles";

export function createPlugin(host: PluginHost): DiscoveredPlugin {
  const mesh = host.instances.chunkMeshFactory as RenderWiring["mesh"];
  const built = createRenderPlugin({ world: host.world, mesh });
  // What the root DRIVES: the boot driver primes/warms the chunk stream, the menu frame steps the background.
  host.world.insertResource(RENDER_HANDLES, {
    chunkStream: built.systems.chunkStream,
    menuBackground: built.systems.menuBg,
  });
  return { hot: false, plugin: built.plugin };
}
