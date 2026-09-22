// ===== Extension points: the slots a plugin may contribute into =====
// This is the heart of the plugin architecture. A plugin does not reach into another plugin and does not
// touch the host: it contributes VALUES into a named slot, and the core decides what to do with them.
//
// The token is a typed handle, not a string key (same idea as `Resource<T>` in core/data/resource.ts):
// `SLOT_SYSTEMS` is a `ExtensionPoint<SystemDef>`, so a plugin that contributes the wrong shape fails to
// compile, and the registry can name the point in an error without the caller repeating the string.

export interface ExtensionPoint<T> {
  /** The name used in errors, reports and the boot log. */
  readonly name: string;
  /** Phantom carrier: it is what makes the point generic at the type level (never read at runtime). */
  readonly __type?: T;
}

/** Declare an extension point. Called once per slot, in `slots.ts` — a plugin NEVER declares one. */
export function defineExtensionPoint<T>(name: string): ExtensionPoint<T> {
  return { name };
}
