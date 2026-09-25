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
  };
  /** The MENU frame drives this too (`menuFrame`): the background own step, once per ui frame. */
  readonly menuBackground: { step(): void };
}

export const RENDER_HANDLES: Resource<RenderHandles> = defineResource<RenderHandles>("renderHandles");
