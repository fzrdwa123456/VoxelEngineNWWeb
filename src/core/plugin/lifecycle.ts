// ===== Plugin install: order, the manifest's veto, and failure isolation =====
// Three jobs, all of them about NOT letting one plugin take the process down:
//
//   1. ORDER — `deps` decide who runs first (a topological sort). A missing dependency or a cycle does
//      not throw: that plugin is SKIPPED with a reason, and the rest keep going.
//   2. THE MANIFEST'S VETO — a plugin the manifest disabled is skipped before its `setup` ever runs.
//   3. FAILURE ISOLATION — a `setup` that throws (or files a duplicate id) DISABLES that plugin and is
//      reported. The boot carries on with the rest; the log says exactly which plugin and why.
//
// What it deliberately does NOT do yet: `stop`/`uninstall` (nothing is torn down after boot) and
// re-resolving the schedule at runtime (a hot add/remove has to happen at a barrier — see ROADMAP §P1.19).
import type { World } from "../world";
import type { ExtensionRegistry } from "../extension/registry";
import { createPluginApi, type PluginApi } from "./api";
import type { Plugin } from "./descriptor";
import { describeError } from "./errors";

export interface InstallOptions {
  readonly world: World;
  readonly registry: ExtensionRegistry;
  readonly log: (line: string) => void;
  /** The manifest's veto: a plugin it disabled is skipped (absent = every plugin is wanted). */
  readonly enabled?: (id: string) => boolean;
}

export interface InstallOutcome {
  readonly installed: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  readonly disabled: readonly { readonly id: string; readonly error: string }[];
  /** The plugins that were installed, in install order — what `startPlugins`/`stopPlugins` walk. */
  readonly plugins: readonly Plugin[];
  /** Was this plugin installed? The composition root asks before registering a plugin's systems. */
  has(id: string): boolean;
  /** The api a plugin was installed with (so `start` sees the same door `setup` did). */
  apiOf(id: string): PluginApi | null;
}

/** Kahn's algorithm over `deps`. Unknown deps and cycles are returned as reasons, never thrown. */
function order(
  plugins: readonly Plugin[],
  log: (line: string) => void,
): { readonly ordered: readonly Plugin[]; readonly skipped: { id: string; reason: string }[] } {
  const byId = new Map<string, Plugin>();
  const skipped: { id: string; reason: string }[] = [];
  for (const p of plugins) {
    if (byId.has(p.id)) {
      skipped.push({ id: p.id, reason: `duplicate plugin id (also declared by a later plugin)` });
      log(`PLUGIN ${p.id} skipped: duplicate id`);
      continue;
    }
    byId.set(p.id, p);
  }
  const remaining = new Set(byId.keys());
  const ordered: Plugin[] = [];
  // A dep that is not declared at all is a manifest/typo problem: drop the dependent, keep the rest.
  for (const [id, p] of byId) {
    for (const dep of p.deps ?? []) {
      if (!byId.has(dep)) {
        remaining.delete(id);
        skipped.push({ id, reason: `depends on "${dep}", which is not declared` });
        log(`PLUGIN ${id} skipped: missing dependency "${dep}"`);
      }
    }
  }
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const id of [...remaining]) {
      const p = byId.get(id)!;
      if ((p.deps ?? []).every((d) => !remaining.has(d))) {
        ordered.push(p);
        remaining.delete(id);
        progressed = true;
      }
    }
  }
  for (const id of remaining) {
    skipped.push({ id, reason: "dependency cycle" });
    log(`PLUGIN ${id} skipped: dependency cycle`);
  }
  return { ordered, skipped };
}

export function installPlugins(plugins: readonly Plugin[], options: InstallOptions): InstallOutcome {
  const { world, registry, log, enabled } = options;
  const { ordered, skipped } = order(plugins, log);
  const installed: string[] = [];
  const disabled: { id: string; error: string }[] = [];
  const installedPlugins: Plugin[] = [];
  const apis = new Map<string, PluginApi>();

  for (const plugin of ordered) {
    if (enabled && !enabled(plugin.id)) {
      log(`PLUGIN ${plugin.id} disabled by the manifest — not installed`);
      continue;
    }
    const api = createPluginApi(plugin.id, world, registry, (line) => log(`[${plugin.id}] ${line}`));
    try {
      plugin.setup(api);
      installed.push(plugin.id);
      installedPlugins.push(plugin);
      apis.set(plugin.id, api);
    } catch (error) {
      disabled.push({ id: plugin.id, error: describeError(error) });
      log(`PLUGIN ${plugin.id} FAILED and is disabled: ${describeError(error)}`);
    }
  }
  log(`PLUGIN installed ${installed.length}/${plugins.length}: [${installed.join(", ")}]`);
  return {
    installed,
    skipped,
    disabled,
    plugins: installedPlugins,
    has: (id: string) => installed.includes(id),
    apiOf: (id: string) => apis.get(id) ?? null,
  };
}

/** What `startPlugins`/`stopPlugins` did, for the boot log and for the gate. */
export interface LifecycleOutcome {
  readonly ids: readonly string[];
  readonly failed: readonly { readonly id: string; readonly error: string }[];
}

/** Run every installed plugin's OPTIONAL `start`, in install order, AFTER `world.start()`.
 *
 *  Why it is a separate phase: `setup` may only CONTRIBUTE (the schedule and the resource table are still
 *  being assembled), while `start` may LOOK at the finished world. A plugin whose `start` throws is
 *  disabled — and it is then NOT stopped later, because it never started. */
export function startPlugins(outcome: InstallOutcome, log: (line: string) => void): LifecycleOutcome {
  const ids: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const plugin of outcome.plugins) {
    if (!plugin.start) continue;
    const api = outcome.apiOf(plugin.id);
    if (!api) continue;
    try {
      plugin.start(api);
      ids.push(plugin.id);
    } catch (error) {
      failed.push({ id: plugin.id, error: describeError(error) });
      log(`PLUGIN ${plugin.id} start FAILED and is disabled: ${describeError(error)}`);
    }
  }
  if (ids.length > 0 || failed.length > 0) {
    log(`PLUGIN started ${ids.length}: [${ids.join(", ")}]`);
  }
  return { ids, failed };
}

/** Run `stop` for everything that STARTED, in REVERSE order (a plugin may depend on one installed before
 *  it, so it must be torn down first). Called when the app quits, and — once hot-plugging lands — when a
 *  plugin is uninstalled. */
export function stopPlugins(
  outcome: InstallOutcome,
  started: LifecycleOutcome,
  log: (line: string) => void,
): LifecycleOutcome {
  const ids: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const plugin of [...outcome.plugins].reverse()) {
    if (!started.ids.includes(plugin.id) || !plugin.stop) continue;
    const api = outcome.apiOf(plugin.id);
    if (!api) continue;
    try {
      plugin.stop(api);
      ids.push(plugin.id);
    } catch (error) {
      failed.push({ id: plugin.id, error: describeError(error) });
      log(`PLUGIN ${plugin.id} stop FAILED: ${describeError(error)}`);
    }
  }
  if (ids.length > 0) log(`PLUGIN stopped ${ids.length}: [${ids.join(", ")}]`);
  return { ids, failed };
}
