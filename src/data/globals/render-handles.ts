// ===== What the RENDER plugin PUBLISHES to the composition root (P1.45) =====
// `PluginHost.instances` goes ONE WAY (root -> plugin). The render plugin needs the other direction: the boot
// driver PRIMES and WARMS the chunk stream by hand (`enterWorld`), so it has to reach the very instance the
// plugin constructed and registered - a second instance would warm nothing and the world would never mesh.
// That is what this resource is: the handles a plugin publishes for the code that DRIVES it, filled by its own
// `plugin.ts` while the catalogue builds it (before the plugins install, so the driver reads it later).
//
// Typed STRUCTURALLY, like every resource in `data/globals` (a data module may not import a plugin type), and
// deliberately narrow: only what the root actually calls.
import { defineResource, type Resource } from "../../core/world";

export interface RenderHandles {
  readonly chunkStream: {
    needsWarmUp(x: number, z: number): boolean;
    prime(x: number, z: number): void;
    warmUp(yieldTo: () => Promise<void>, onProgress?: (done: number, total: number) => void): Promise<void>;
    /** Re-resolve the LOOKS of the chunks a chain change marked stale, in batches, yielding in between
     *  (P1.18i): the PACK RELOAD driver drives this behind the loading screen, the way `warmUp` is driven
     *  behind it on a world entry. Meshes nothing, asks the pool for nothing. Bounded by the system. */
    restyleStale(
      yieldTo: () => Promise<void>,
      onProgress?: (done: number, total: number) => void,
    ): Promise<void>;
    /** Mark the FAR RING's meshes for a look re-resolution and answer how many (P1.97). A chain change has to
     *  call this NEXT TO `VoxelWorld.markAllStale()`: the far ring is procedural and holds no chunk in the
     *  world, so the world's queue can never name it. */
    markFarStale(): number;
    /** How much look work is queued in total — the world's stale chunks PLUS the far ring (P1.97). The reload
     *  bar counts it, so it has to see both. */
    readonly restylePending: number;
    /** The world SIZE changed (P2.02): drop every mesh and every "decided" answer, so the next step rebuilds
     *  the whole window for the new lap. Called by the world-entry driver, before it primes, and only when the
     *  size actually moved. */
    resetForNewWorld(): void;
    /** HOW MANY LOD RUNGS the world in force actually got (P2.03): the ladder is capped by the lap, so a small
     *  world builds fewer rungs than the policy asks for — and the entry says so, instead of leaving the player
     *  to wonder why "6" looks like "2". */
    readonly lodTiers: number;
  };
  /** The MENU frame drives this too (`menuFrame`): the background own step, once per ui frame. */
  readonly menuBackground: { step(): void };
}

export const RENDER_HANDLES: Resource<RenderHandles> = defineResource<RenderHandles>("renderHandles");
