// ===== What a plugin is HANDED =====
// The api is the only door a plugin needs: the world it contributes into, the registry it files its
// contributions in, and a log sink. It is not a permission model (this project deliberately has none —
// mods are data, and JS has no real sandbox): it is a NARROWING. A plugin that only ever sees this object
// cannot reach into another plugin's internals or into `host/`, and the core keeps the freedom to move
// its own modules around without breaking every plugin.
import type { World } from "../world";
import type { ExtensionPoint } from "../extension/point";
import type { ExtensionRegistry } from "../extension/registry";

export interface PluginApi {
  /** The id of the plugin this api was created for (it is also the owner tag every contribution gets). */
  readonly id: string;
  /** The world being assembled: `world.query`, `world.resource`, the command queue. */
  readonly world: World;
  /** Read-only use for the rare plugin that has to look at another plugin's contributions. */
  readonly registry: ExtensionRegistry;
  /** File contributions into a slot. Duplicate ids throw (the install catches it and disables the plugin). */
  contribute<T>(point: ExtensionPoint<T>, items: readonly T[]): void;
  /** One line into debug.log, prefixed with the plugin id by the composition root. */
  log(line: string): void;
}

export function createPluginApi(
  id: string,
  world: World,
  registry: ExtensionRegistry,
  log: (line: string) => void,
): PluginApi {
  return {
    id,
    world,
    registry,
    contribute(point, items) {
      registry.contribute(point, id, items);
    },
    log,
  };
}
