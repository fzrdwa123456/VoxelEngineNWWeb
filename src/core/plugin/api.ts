// ===== What a plugin is HANDED =====
// The api is the only door a plugin needs: the world it contributes into, the registry it files its
// contributions in, and a log sink. It is not a permission model (this project deliberately has none —
// mods are data, and JS has no real sandbox): it is a NARROWING. A plugin that only ever sees this object
// cannot reach into another plugin's internals or into `host/`, and the core keeps the freedom to move
// its own modules around without breaking every plugin.
import type { World } from "../world";
import type { ExtensionPoint } from "../extension/point";
import type { ExtensionRegistry } from "../extension/registry";
import { SLOT_SYSTEMS } from "../extension/slots";
import type { SystemDef } from "../flow/schedule";
import type { Resource } from "../data/resource";

export interface PluginApi {
  /** The id of the plugin this api was created for (it is also the owner tag every contribution gets). */
  readonly id: string;
  /** The world being assembled: `world.query`, `world.resource`, the command queue. */
  readonly world: World;
  /** Read-only use for the rare plugin that has to look at another plugin's contributions. */
  readonly registry: ExtensionRegistry;
  /** File contributions into a slot. Duplicate ids throw (the install catches it and disables the plugin). */
  contribute<T>(point: ExtensionPoint<T>, items: readonly T[]): void;
  /** Declare ONE system this plugin owns. Sugar over `contribute(SLOT_SYSTEMS, [def])`, and the reason a
   *  plugin can own its declarations without naming itself: inside its own `setup` it IS the owner. */
  system(def: SystemDef): void;
  /** One line into debug.log, prefixed with the plugin id by the composition root. */
  log(line: string): void;
  /** Insert a resource THIS plugin owns — ONCE. The framework half of the idempotency contract (see
   *  `Plugin.setup`): a hot re-install calls `setup` again, and an unguarded second insert is exactly what
   *  turns "installed it again" into a throw at the barrier.
   *
   *  The value is only used the FIRST time, and that is deliberate: a resource survives an uninstall (P1.28),
   *  so a re-install keeps the object the world already holds — a plugin must therefore never depend on a
   *  FRESH resource after a re-install. */
  insertResource<T>(resource: Resource<T>, value: T): void;
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
    system(def) {
      registry.contribute(SLOT_SYSTEMS, id, [def]);
    },
    insertResource(resource, value) {
      if (!world.hasResource(resource)) world.insertResource(resource, value);
    },
    log,
  };
}
