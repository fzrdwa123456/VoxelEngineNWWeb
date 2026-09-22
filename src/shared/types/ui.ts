// ===== Shared UI TYPES =====
// A hit-test result: the widget under a point, when it carries an action. Used by every interaction that
// must ask "what is the cursor over" — the key bind drag being the only one today, and that one lives in
// the INPUT plugin while the system that answers it lives in the UI plugin. The SHAPE therefore lives
// here, so neither plugin has to import the other for a type.
//
// Only TYPES may live in `shared/`: this file is erased at compile time, so `shared/` adds no runtime
// dependency on `core/` even though it names `Entity`.
import type { Entity } from "../../core/world";

export interface UiHit {
  readonly entity: Entity;
  /** The action id the hit widget carries (empty = it carries none). */
  readonly action: string;
  /** The value the action would be dispatched with. */
  readonly value: string;
}
