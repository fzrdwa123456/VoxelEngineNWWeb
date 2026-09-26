// ===== ui.pages: the HOST that turns PAGE DATA into widgets (P1.29) =====
// It owns no widget data of its own: it DIFFS two data sets — the pages plugins contribute and the mounts it
// has already created — and defers the actual spawn/despawn to a COMMAND, because a structural change is only
// legal at a barrier and a system may not make one (iron rule 1). That is the whole mechanism, and it is what
// makes the layout dynamic: a page contributed by a plugin installed at runtime appears within a frame.
//
// The deferral itself (`UiLayoutOp`) is DATA now, next to the pages it carries: the same command mounts a page
// and builds a HUD element (`ui.hud`), so the ui lane has ONE generic layout barrier and not two ways to say
// "spawn this at the next barrier".
//
// It paints the ENTRY rows (up iff their page is mounted). The PANEL's visibility is NOT its business: it runs
// FIRST in the lane, so it would read the PREVIOUS frame's `UI_MODAL.settings` — and in the frame where ESC
// steps back (an in-lane write, unlike a button's command) the panel would stay visible while the settings
// list came up: one frame with both, i.e. a visible flicker. Modal visibility has ONE painter,
// `ui.navigation` (see the ui conventions in AGENTS.md), and the page panel is part of that tree.
import { onUiAction, UI_ACTIONS } from "../../../data/globals/actions";
import { UI_MODAL } from "../../../data/globals/resources";
import {
  UI_PAGE_HOSTS,
  UI_PAGES_MOUNTED,
  UiLayoutOp,
  type UiPage,
  type MountedPage,
  type UiPageHost,
} from "../../../data/globals/ui-pages";
import type { SystemAccess, World } from "../../../core/world";
import { setUiSelected, setUiText, setUiVisible, spawnButton, spawnPanel, subtreeOf, UI_TREE } from "../components";

/** It reads the contributions and the host list, and writes nothing the schedule models (the command applies
 *  the structure). Declared so the report says what it touches. */
export const UI_PAGES_ACCESS: SystemAccess = {
  readsExternal: ["uiPages", "uiPageHosts"],
};

function mountPage(world: World, host: UiPageHost, page: UiPage): void {
  const actions = world.resource(UI_ACTIONS);
  const key = `${host.id}/${page.id}`;
  const action = `${host.id}.page.${page.id}`;
  // INTO THE VIEW'S ROW CONTAINER, not the settings list: the position is the layout's decision, the NUMBER
  // of rows is the data's.
  const entry = spawnButton(world, host.rowContainer, "settings.btn", action, "", page.titleKey);
  setUiVisible(world, entry, false); // the host shows it on the next frame
  // LAYOUT-NEUTRAL: the page panel is a SECTION of the settings box now (P1.49), so it must not impose a
  // width of its own - the box and the content area decide.
  const panel = spawnPanel(world, host.root, "settings.pageRows", { hidden: true });
  // RECORDED BEFORE ANYTHING CAN THROW: an unrecorded mount is retried every frame (that is how one bad line
  // became a flood of `frame error`s and a hidden entry row leaked per frame).
  world.resource(UI_PAGES_MOUNTED).set(key, { host, pageId: page.id, page, panel, entry });
  // THE ACTION IS REGISTERED ONCE PER (host, page) — the handler is identical on every mount, and the action
  // table REFUSES a duplicate id (the rule that stops "whoever registers last wins"). Registering it again
  // threw inside the barrier command and took the whole ui lane down with it: the second install could never
  // mount, every frame, forever.
  if (!actions.has(action)) onUiAction(actions, action, () => host.show(page.id));
  try {
    page.build({ host, pageId: page.id, panel, entry });
  } catch (error) {
    // FAILURE ISOLATION: a page that cannot build must not be retried every frame, and must not kill the lane
    // that paints every other surface. Logged, and left unreachable (its entry row stays hidden).
    host.log(`PAGE mount FAILED ${page.id}: ${String((error as Error)?.message ?? error)}`);
  }
  host.log(`PAGE mounted ${page.id} (${host.id})`);
}

function unmountPage(world: World, key: string): void {
  const mounted = world.resource(UI_PAGES_MOUNTED);
  const m = mounted.get(key);
  if (!m) return;
  // `m.page`, NOT a lookup in the current contributions: the plugin was uninstalled before this runs, so the
  // page is no longer in that list — and `dispose` was silently skipped, leaking its global specs.
  m.page.dispose?.();
  // Children first: the ECS has no cascade, so an unmount has to take the whole subtree down itself.
  for (const e of subtreeOf(world, m.panel)) world.despawn(e);
  for (const e of subtreeOf(world, m.entry)) world.despawn(e);
  mounted.delete(key);
  m.host.log(`PAGE unmounted ${key}`);
}

/** The host system. `pages` is injected by the root (the registry is the root's, not the world's). */
export class UiPagesSystem {
  private readonly mounted: Map<string, MountedPage>;
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
      this.world.commands.send(UiLayoutOp, { apply: (w) => unmountPage(w, key) });
    }
    this.paintEntries();
  }

  /** The ENTRY rows: up iff their page is mounted. The PANEL is NOT painted here — see the note. */
  private paintEntries(): void {
    // A page row is a NAV ITEM now (P1.49): always visible, and selected while its page is the open section.
    const current = this.world.resource(UI_MODAL).settings;
    for (const m of this.mounted.values()) {
      setUiVisible(this.world, m.entry, true);
      setUiSelected(this.world, m.entry, current === m.pageId);
    }
  }
}

export function createUiPagesSystem(
  ...args: ConstructorParameters<typeof UiPagesSystem>
): UiPagesSystem {
  return new UiPagesSystem(...args);
}
