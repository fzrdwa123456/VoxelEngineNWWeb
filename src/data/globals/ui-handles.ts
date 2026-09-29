// ===== What the UI plugin PUBLISHES to the composition root (P1.18b) =====
// The third direction-of-travel resource, after `render-handles.ts` (P1.45) and `player-handles.ts` (P1.18b):
// `PluginHost.instances` goes ONE WAY (root -> plugin), so anything the ROOT drives has to come back the other
// way. The ui plugin constructs its seven lane systems now, and exactly ONE of them is driven from outside:
//
//   * `ui.widgets` (the reconciler) — it OWNS every widget's DOM element, so the key bind DRAG asks it what is
//     under the cursor (`hitTest`). The drag's event-time half lives in `plugins/ui-keybind/views/keybind.ts`
//     and is wired by the root, which is why the root needs this handle.
//
// Everything else the root needs from the widget layer (the F3 panel's entities, the modal trees) it already
// owns: the VIEWS stay root-spawned by design (spawning is a structural change, so it happens at a point in the
// resource table the root decides).
//
// Typed STRUCTURALLY, like every resource in `data/globals`, and deliberately narrow: one method.
import { defineResource, type Resource } from "../../core/world";
import type { UiHit } from "../../shared/types/ui";

export interface UiHandles {
  /** "Which widget is under this point?" — asked by the bind gesture's drag (`ui-keybind`). */
  readonly uiRender: { hitTest(x: number, y: number): UiHit | null };
}

export const UI_HANDLES: Resource<UiHandles> = defineResource<UiHandles>("uiHandles");
