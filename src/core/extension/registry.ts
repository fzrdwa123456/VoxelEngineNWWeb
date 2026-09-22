// ===== The contribution registry =====
// "Who brought what." A plugin contributes values into an extension point under its own id; the registry
// keeps them per (point, id) and makes two mistakes loud instead of silent:
//
//   * the SAME id contributed twice (two plugins claiming one system/resource name) — a wiring bug that
//     would otherwise show up as "whichever registered last wins"
//   * a contribution from an owner that was never installed (a typo in the manifest, or a plugin whose
//     setup ran out of order)
//
// It is deliberately dumb: it does not know what a system or a component IS, it only files them. The
// schedule and the world consume `list(SLOT_SYSTEMS)` / `list(SLOT_RESOURCES)` after every plugin has run.
import type { ExtensionPoint } from "./point";

interface Entry {
  readonly owner: string;
  readonly value: unknown;
}

/** The id a contributed value is filed under: systems/components/resources carry a `name`, a content
 *  declaration (a language, an item) carries an `id`. Both are ids; one of them must be there. */
function idOf(value: unknown): string {
  const v = value as { name?: unknown; id?: unknown };
  if (typeof v.name === "string" && v.name !== "") return v.name;
  if (typeof v.id === "string" && v.id !== "") return v.id;
  return "(anonymous)";
}

export class ExtensionRegistry {
  private readonly byPoint = new Map<string, Map<string, Entry>>();

  private bucket(point: ExtensionPoint<unknown>): Map<string, Entry> {
    let bucket = this.byPoint.get(point.name);
    if (!bucket) {
      bucket = new Map();
      this.byPoint.set(point.name, bucket);
    }
    return bucket;
  }

  /** File one contribution. THROWS on a duplicate id: wiring bugs must not be decided by registration order. */
  contribute<T>(point: ExtensionPoint<T>, owner: string, items: readonly T[]): void {
    const bucket = this.bucket(point as ExtensionPoint<unknown>);
    for (const item of items) {
      const id = idOf(item);
      const existing = bucket.get(id);
      if (existing) {
        throw new Error(
          `extension point "${point.name}": "${id}" is already contributed by "${existing.owner}" ` +
            `(now claimed by "${owner}")`,
        );
      }
      bucket.set(id, { owner, value: item });
    }
  }

  /** Everything contributed into one point, in contribution order. */
  list<T>(point: ExtensionPoint<T>): readonly T[] {
    const bucket = this.byPoint.get(point.name);
    return bucket ? [...bucket.values()].map((e) => e.value as T) : [];
  }

  /** The owner of one id, or null. Used by the report and by the un-install path of a future round. */
  ownerOf<T>(point: ExtensionPoint<T>, id: string): string | null {
    return this.byPoint.get(point.name)?.get(id)?.owner ?? null;
  }

  /** The owners that contributed into a point, in first-contribution order. */
  owners(point: ExtensionPoint<unknown>): readonly string[] {
    const bucket = this.byPoint.get(point.name);
    if (!bucket) return [];
    const seen: string[] = [];
    for (const entry of bucket.values()) if (!seen.includes(entry.owner)) seen.push(entry.owner);
    return seen;
  }

  /** One line per point: how many contributions, and from which owners (the boot log's plugin report). */
  report(): readonly string[] {
    const lines: string[] = [];
    for (const [name, bucket] of this.byPoint) {
      const owners = [...new Set([...bucket.values()].map((e) => e.owner))];
      lines.push(`${name}: ${bucket.size} from [${owners.join(", ")}]`);
    }
    return lines;
  }
}
