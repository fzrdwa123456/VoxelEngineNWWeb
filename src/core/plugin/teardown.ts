// ===== What a plugin leaves behind, taken down by the FRAMEWORK (P1.39) =====
// "Leave nothing behind" used to be every plugin's own job: each one hand-wrote a `stop` that closed its
// surface, and forgetting it left a frozen panel, a live rubber band, or a bag that could still be opened —
// all three really happened. This is the framework half: a plugin REGISTERS a teardown NEXT TO the thing it
// undoes (inside `setup`, where the surface is created), and the framework runs the registered tasks when the
// plugin LEAVES — an uninstall (F8/F9/F10/F11) or the app quitting — at the barrier, in REVERSE registration
// order, exactly once.
//
// It is a RESOURCE, like every other piece of per-world state: the tasks have to survive from `setup` (which
// may be a HOT install, whose api object is not the boot's) to the uninstall that runs them, and module-level
// state would be shared by every World in the process.
import { defineResource } from "../data/resource";
import type { World } from "../world";

/** Teardown tasks by plugin id. Inserted lazily: a world whose plugins registered none never gets the map. */
export const PLUGIN_TEARDOWNS = defineResource<Map<string, (() => void)[]>>("pluginTeardowns");

function taskMap(world: World): Map<string, (() => void)[]> {
  if (!world.hasResource(PLUGIN_TEARDOWNS)) world.insertResource(PLUGIN_TEARDOWNS, new Map());
  return world.resource(PLUGIN_TEARDOWNS);
}

/** File one teardown task for `id` — what `PluginApi.onStop` calls. */
export function registerTeardown(world: World, id: string, task: () => void): void {
  const map = taskMap(world);
  const list = map.get(id);
  if (list) list.push(task);
  else map.set(id, [task]);
}

/** Run and FORGET every task `id` registered, in reverse order; returns how many ran.
 *
 *  FORGET is the point: a leave path that runs twice (a `stop` at quit plus an uninstall, a retried uninstall)
 *  must not tear a surface down twice, and a plugin that is installed again starts with a clean list.
 *
 *  A task that throws is reported and does not stop the others — the same isolation `plugin.stop` gets, for
 *  the same reason: one broken teardown must not leave the REST of the surface up. */
export function runTeardowns(world: World, id: string, onError?: (line: string) => void): number {
  if (!world.hasResource(PLUGIN_TEARDOWNS)) return 0;
  const map = world.resource(PLUGIN_TEARDOWNS);
  const list = map.get(id);
  if (!list || list.length === 0) return 0;
  map.delete(id);
  let ran = 0;
  for (const task of [...list].reverse()) {
    try {
      task();
      ran++;
    } catch (error) {
      onError?.(`PLUGIN ${id} teardown FAILED: ${String((error as Error)?.message ?? error)}`);
    }
  }
  return ran;
}
