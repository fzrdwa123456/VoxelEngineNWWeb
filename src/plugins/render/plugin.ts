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
  // …and the meshing WORKER POOL (P1.18h), same direction: the pool is a `host/` object (it creates Workers),
  // so the root builds it and this adapter narrows it. Absent = the chunk stream meshes on the main thread.
  const pool = host.instances.meshPool as RenderWiring["pool"];
  // A pool with NO live worker is worse than no pool at all: `request` answers "saturated" for ever, so the
  // chunk stream would stop asking and NOTHING would ever be meshed. Hand it `null` instead, which is the
  // documented pre-P1.18h behaviour (mesh on this thread). P1.18i: a pool can start non-empty and lose every
  // worker later, which the stream handles itself by asking `workers` again.
  const usable = pool && pool.workers > 0 ? pool : null;
  // The probe's report goes to the same log the rest of the boot/plugin wiring writes to (`host.log` IS the
  // log sink), so "where does the probe write" stays a wiring decision, like every other host service.
  const built = createRenderPlugin({ world: host.world, mesh, pool: usable, log: host.log });
  host.log(
    `RENDER meshing: ${usable ? `${usable.workers} worker(s)` : `main thread only${pool ? " (no worker started)" : ""}`}`,
  );
  // What the root DRIVES: the boot driver primes/warms the chunk stream, the menu frame steps the background.
  host.world.insertResource(RENDER_HANDLES, {
    chunkStream: built.systems.chunkStream,
    menuBackground: built.systems.menuBg,
  });
  return { hot: false, plugin: built.plugin };
}
