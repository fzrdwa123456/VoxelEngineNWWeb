// ===== ui.pages: the HOST that turns PAGE DATA into widgets (P1.29) =====
// It owns no widget data of its own: it DIFFS two data sets — the pages plugins contribute and the mounts it
// has already created — and defers the actual spawn/despawn to a COMMAND, because a structural change is only
// legal at a barrier and a system may not make one (iron rule 1). That is the whole mechanism, and it is what
// makes the layout dynamic: a page contributed by a plugin installed at runtime appears within a frame.
//
// It also PAINTS its own two widgets per frame: the entry row (visible iff the page is mounted) and the panel
// (visible iff that page is the one `UI_MODAL.settings` names). Nothing outside this file has to know a page's
// id, which is why a new page needs no code in the ui plugin at all.
import { onUiAction, UI_ACTIONS } from "../../../data/globals/actions";
import { UI_MODAL } from "../../../data/globals/resources";
import {
  UI_PAGE_HOSTS,
  UI_PAGES_MOUNTED,
  type UiPage,
  type UiPageHost,
  type UiPageMount,
} from "../../../data/globals/ui-pages";
import { defineCommand, type Entity, type SystemAccess, type World } from "../../../core/world";
import { setUiText, setUiVisible, spawnButton, spawnPanel, UI_TREE } from "../components";

/** It reads the contributions and the host list, and writes nothing the schedule models (the command applies
 *  the structure). Declared so the report says what it touches. */
export const UI_PAGES_ACCESS: SystemAccess = {
  readsExternal: ["uiPages", "uiPageHosts"],
};

/** A deferred layout operation. The ONE generic deferral in the ui lane: its payload is the work, because
 *  the work is plugin-side (spawn a page, wire its action) while the BARRIER is the core's. */
export const UiLayoutOp = defineCommand<{ apply: (world: World) => void }>("uiLayoutOp", (world, op) => {
  op.apply(world);
});

/** Every entity in the subtree rooted at `root` (children first), for a despawn that leaves nothing behind. */
function subtree(world: World, root: Entity): Entity[] {
  const children = new Map<Entity, Entity[]>();
  for (const e of world.query(UI_TREE).entities()) {
    const parent = world.get(e, UI_TREE)?.parent;
    if (parent === undefined) continue;
    const list = children.get(parent);
    if (list) list.push(e);
    else children.set(parent, [e]);
  }
  const out: Entity[] = [];
  const walk = (e: Entity): void => {
    for (const c of children.get(e) ?? []) walk(c);
    out.push(e);
  };
  walk(root);
  return out;
}

function mountPage(world: World, host: UiPageHost, page: UiPage): void {
  const actions = world.resource(UI_ACTIONS);
  const entry = spawnButton(world, host.settingsPanel, "settings.btn", `${host.id}.page.${page.id}`, "", page.titleKey);
  setUiVisible(world, entry, false); // the host shows it on the next frame
  onUiAction(actions, `${host.id}.page.${page.id}`, () => host.show(page.id));
  const panel = spawnPanel(world, host.root, "settings.panelXl", { hidden: true });
  page.build({ host, pageId: page.id, panel, entry });
  world.resource(UI_PAGES_MOUNTED).set(`${host.id}/${page.id}`, { host, pageId: page.id, panel, entry });
  host.log(`PAGE mounted ${page.id} (${host.id})`);
}

function unmountPage(world: World, key: string, page: UiPage | null): void {
  const mounted = world.resource(UI_PAGES_MOUNTED);
  const m = mounted.get(key);
  if (!m) return;
  page?.dispose?.();
  // Children first: the ECS has no cascade, so an unmount has to take the whole subtree down itself.
  for (const e of subtree(world, m.panel)) world.despawn(e);
  for (const e of subtree(world, m.entry)) world.despawn(e);
  mounted.delete(key);
  m.host.log(`PAGE unmounted ${key}`);
}

/** The host system. `pages` is injected by the root (the registry is the root's, not the world's). */
export class UiPagesSystem {
  private readonly mounted: Map<string, UiPageMount>;
  private readonly hosts: UiPageHost[];

  constructor(
    private readonly world: World,
    private readonly deps: { readonly pages: () => readonly UiPage[] },
  ) {
    this.mounted = world.resource(UI_PAGES_MOUNTED);
    this.hosts = world.resource(UI_PAGE_HOSTS);
  }

  /** ui lane: materialize what is missing, remove what is gone, then paint the two widgets it owns. */
  step(): void {
    const pages = [...this.deps.pages()].sort((a, b) => a.order - b.order);
    const wanted = new Set<string>();
    for (const host of this.hosts) {
      for (const page of pages) {
        if (page.section !== "settings") continue;
        const key = `${host.id}/${page.id}`;
        wanted.add(key);
        if (this.mounted.has(key)) continue;
        this.world.commands.send(UiLayoutOp, { apply: (w) => mountPage(w, host, page) });
      }
    }
    for (const key of [...this.mounted.keys()]) {
      if (wanted.has(key)) continue;
      const gone = this.mounted.get(key)!;
      const page = pages.find((p) => p.id === gone.pageId) ?? null;
      this.world.commands.send(UiLayoutOp, { apply: (w) => unmountPage(w, key, page) });
    }
    this.paint();
  }

  /** The entry row is up iff the page is mounted; the panel is up iff it is the OPEN page. */
  private paint(): void {
    const open = this.world.resource(UI_MODAL).settings ?? null;
    for (const m of this.mounted.values()) {
      setUiVisible(this.world, m.entry, true);
      setUiVisible(this.world, m.panel, open !== null && open === m.pageId);
    }
  }
}

export function createUiPagesSystem(
  ...args: ConstructorParameters<typeof UiPagesSystem>
): UiPagesSystem {
  return new UiPagesSystem(...args);
}
