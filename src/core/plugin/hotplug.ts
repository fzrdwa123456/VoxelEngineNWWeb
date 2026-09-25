// ===== Hot-plug: install or uninstall a plugin while the process runs (P1.24) =====
// The boot path (`installPlugins`) assembles the process ONCE: it topologically orders the plugins, honours
// the manifest's veto, isolates a `setup` that throws, and hands the systems it filed to one `world.start()`.
// This module is the same thing WITHOUT the restart — the piece `lifecycle.ts` deliberately left out — and it
// exists because of one observation:
//
//   **A plugin is hot-pluggable exactly when its `setup` alone is enough to install it.**
//
// A plugin whose systems the composition root declares for it (the `declare*Systems(api, instances)` shape)
// can be installed at boot, but not at runtime: nothing would re-run the root's wiring. A plugin that files
// its own systems from `setup` — the shape `plugins/ui-debug` uses — is a value in a catalogue, and plugging
// it in is one call.
//
// WHERE THIS MAY RUN: at a BARRIER, and nowhere else. Installing a plugin means adding systems to the
// schedule, and adding systems re-resolves it. The door is the `HotPlugPlugin` COMMAND (core/effect/commands),
// which the command queue applies at the top of every entry point — before any lane runs — so no system ever
// sees the schedule change underneath it. Calling `hotInstall` from a system would be the same bug as
// spawning an entity there.
//
// WHAT IT REFUSES TO DO, loudly and with a reason instead of half-way:
//   * install something twice, or something this build does not catalogue for runtime install;
//   * install a plugin whose declared `deps` are not installed (the boot reports the same case);
//   * uninstall a plugin another INSTALLED plugin declares as a dep — that would leave a reader of state
//     nobody produces, which is exactly what the reverse-dependency guard is for;
//   * leave a trace of a failed install: the contributions are withdrawn and the systems removed again.
import { defineResource } from "../data/resource";
import type { ExtensionRegistry } from "../extension/registry";
import { SLOT_SYSTEMS } from "../extension/slots";
import type { SystemDef } from "../flow/schedule";
import type { World } from "../world";
import { createPluginApi } from "./api";
import { runTeardowns } from "./teardown";
import type { Plugin } from "./descriptor";
import { describeError } from "./errors";

/** Everything the hot-plug path needs, as ONE value the composition root inserts into the world.
 *
 *  It is a RESOURCE because the code that plugs a plugin in is reached from a lane (the key edge in
 *  `ui.navigation` sends the command), and a global nobody owns is exactly what resources exist to prevent.
 *  The value is WIRING — a catalogue of plugins and the list installed right now — not simulation state. */
export interface HotPlugHost {
  readonly world: World;
  readonly registry: ExtensionRegistry;
  readonly log: (line: string) => void;
  /** The plugins this build allows to be installed at runtime, by id (null = not hot-pluggable here). */
  catalog(id: string): Plugin | null;
  /** The ids installed RIGHT NOW: the boot's list plus everything plugged in since. */
  installed(): readonly string[];
  /** The declared deps of ANY plugin this build knows (boot or catalogue) — the reverse-dependency guard
   *  has to see the boot's plugins too, not only the hot-pluggable ones. */
  depsOf(id: string): readonly string[];
  markInstalled(id: string): void;
  markUninstalled(id: string): void;
}

/** The door itself. `HotPlugPlugin.run` reads it; nothing else does. */
export const HOT_PLUG = defineResource<HotPlugHost>("hotPlug");

export interface HotPlugOutcome {
  readonly ok: boolean;
  readonly id: string;
  readonly action: "install" | "uninstall";
  /** The systems that entered (install) or left (uninstall) the schedule. */
  readonly systems: readonly string[];
  /** Empty on success; otherwise WHY it did not happen, in one line fit for a toast and the log. */
  readonly reason: string;
}

/** The systems one owner filed, in contribution order — the schedule's share of an install/uninstall. */
function systemsOf(registry: ExtensionRegistry, id: string): readonly SystemDef[] {
  return registry.list(SLOT_SYSTEMS).filter((def) => registry.ownerOf(SLOT_SYSTEMS, def.name) === id);
}

function failed(id: string, action: HotPlugOutcome["action"], reason: string): HotPlugOutcome {
  return { ok: false, id, action, systems: [], reason };
}

/** Install ONE plugin now. Same three phases as the boot (`setup` contributes, the systems join the
 *  schedule, `start` may look at the finished world), each of them undoable. */
export function hotInstall(host: HotPlugHost, id: string): HotPlugOutcome {
  const { world, registry } = host;
  if (host.installed().includes(id)) return failed(id, "install", "already installed");
  const plugin = host.catalog(id);
  if (!plugin) return failed(id, "install", "not in this build's hot-plug catalogue");
  const missing = (plugin.deps ?? []).filter((dep) => !host.installed().includes(dep));
  if (missing.length > 0) return failed(id, "install", `deps not installed: [${missing.join(", ")}]`);

  const api = createPluginApi(id, world, registry, (line) => host.log(`[${id}] ${line}`));

  // 1. setup — contributions only, which is all the boot lets it do either.
  try {
    plugin.setup(api);
  } catch (error) {
    registry.withdraw(id);
    const reason = `setup threw: ${describeError(error)}`;
    host.log(`PLUGIN ${id} HOT-INSTALL FAILED (rolled back): ${reason}`);
    return failed(id, "install", reason);
  }

  // 2. the systems it just filed join the schedule. The list is read back FROM THE REGISTRY rather than
  //    returned by setup: the plugin files them under its own id, and this is the same source the boot uses.
  const systems: string[] = [];
  try {
    for (const def of systemsOf(registry, id)) {
      world.hotAddSystem(def);
      systems.push(def.name);
    }
  } catch (error) {
    for (const name of systems) world.hotRemoveSystem(name);
    registry.withdraw(id);
    const reason = `the schedule refused it: ${describeError(error)}`;
    host.log(`PLUGIN ${id} HOT-INSTALL FAILED (rolled back): ${reason}`);
    return failed(id, "install", reason);
  }

  // 3. start — it may now look at the assembled world (the boot's second phase).
  if (plugin.start) {
    try {
      plugin.start(api);
    } catch (error) {
      for (const name of systems) world.hotRemoveSystem(name);
      registry.withdraw(id);
      const reason = `start threw: ${describeError(error)}`;
      host.log(`PLUGIN ${id} HOT-INSTALL FAILED (rolled back): ${reason}`);
      return failed(id, "install", reason);
    }
  }

  host.markInstalled(id);
  host.log(`PLUGIN ${id} HOT-INSTALLED: ${systems.length} system(s) [${systems.join(", ")}]`);
  return { ok: true, id, action: "install", systems, reason: "" };
}

/** Uninstall ONE plugin now: stop it, withdraw its contributions, and undo what they stood for (its
 *  systems leave the schedule — and the RESOURCES it claimed stay in the world, see the note at the loop). */
export function hotUninstall(host: HotPlugHost, id: string): HotPlugOutcome {
  const { world, registry } = host;
  if (!host.installed().includes(id)) return failed(id, "uninstall", "not installed");

  // The reverse-dependency guard. Without it, uninstalling `ui` would leave `render` reading a component
  // schema nobody contributes any more — a crash one frame later, far from the decision that caused it.
  const dependents = host.installed().filter((other) => other !== id && host.depsOf(other).includes(id));
  if (dependents.length > 0) {
    return failed(id, "uninstall", `still needed by [${dependents.join(", ")}]`);
  }

  const plugin = host.catalog(id);
  const api = createPluginApi(id, world, registry, (line) => host.log(`[${id}] ${line}`));
  // `stop` runs BEFORE the withdrawal: a plugin tearing itself down may still need what it contributed.
  // Note it runs even for a plugin that never declared `start` — the boot's `stopPlugins` mirrors `start`,
  // while an UNINSTALL has to close whatever surface the plugin owns either way.
  if (plugin?.stop) {
    try {
      plugin.stop(api);
    } catch (error) {
      host.log(`PLUGIN ${id} stop FAILED (continuing the uninstall): ${describeError(error)}`);
    }
  }

  // WHAT AN UNINSTALL UNDOES, and what it deliberately does NOT (fixed in P1.28):
  //
  //   * the SYSTEMS it declared leave the schedule — that IS the surface going away;
  //   * the RESOURCES it claimed STAY in the world. They were inserted by the composition root's resource
  //     table (boot) or by the plugin's own `setup` when the world had not got them, and the token is a
  //     CLAIM on that object, not ownership of its existence. Removing them was a real defect: the CORE reads
  //     some of these tokens unconditionally (`ShowToast` -> TOAST), so after uninstalling `ui-toast` every
  //     later toast command threw `World.resource: "toast" was never registered` — a frame error per call,
  //     forever. "The surface is off" must never mean "the engine is broken". Keeping the object also makes
  //     a re-install a no-op on the world (`setup`'s `hasResource` guard), i.e. boot and hot-plug stay one
  //     code path.
  // THE PLUGIN'S OWN TEARDOWNS (P1.39), before the withdrawal: `api.onStop` tasks run for EVERY plugin that
  // registered one, including a plugin with no `stop` hook — the surfaces a plugin owns are closed here even
  // if its author forgot to say so in `stop`.
  const torn = runTeardowns(world, id, (line) => host.log(line));
  if (torn > 0) host.log(`PLUGIN ${id} ran ${torn} registered teardown(s)`);
  const withdrawn = registry.withdraw(id);
  const systems: string[] = [];
  for (const entry of withdrawn) {
    if (entry.point === SLOT_SYSTEMS.name && world.hotRemoveSystem(entry.id)) systems.push(entry.id);
  }
  host.markUninstalled(id);
  host.log(`PLUGIN ${id} HOT-UNINSTALLED: ${systems.length} system(s) left the schedule [${systems.join(", ")}]`);
  return { ok: true, id, action: "uninstall", systems, reason: "" };
}
