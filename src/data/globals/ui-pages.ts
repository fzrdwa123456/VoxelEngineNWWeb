// ===== UI PAGES: layout as DATA, and a host that materializes it (P1.29) =====
// The problem this solves: the settings panel used to be built by ONE burst of imperative `spawn` calls
// during view wiring, with the mount (which panel, which action-id prefix, how to open a sub-page) living in
// that function's locals. So a surface contributed LATER (a plugin installed while the game runs) could
// never get an entry: nobody remembered where it belonged, and nothing re-ran the layout.
//
// Now a `UiPage` is DATA a plugin contributes (SLOT_UI_PAGES) and the ui lane's HOST SYSTEM materializes it:
// it diffs the contributed pages against what is mounted and sends a `UiLayoutOp` COMMAND, which runs at a
// barrier — the only place a structural change is legal. A page therefore appears/disappears within a frame
// of its plugin being installed/uninstalled, and the layout stops being a one-shot piece of code.
//
// A HOST is registered by the view that owns the container (`buildSettingsPanel`), one per menu: it is the
// ONLY thing that has to be known at wiring time, and it is generic — it knows nothing about any page.
import { defineResource } from "../../core/data/resource";
import { defineCommand, type Entity, type World } from "../../core/world";

/** A deferred LAYOUT operation: the ui lane's ONE generic deferral. Its payload IS the work, because the work
 *  is plugin-side (mount a page, build a HUD element) while the BARRIER is the core's — and a system may not
 *  spawn or despawn (iron rule 1), which is the whole reason this exists. It is DATA (not a ui-pages private)
 *  because two hosts use it: the page host and `ui.hud`. */
export const UiLayoutOp = defineCommand<{ apply: (world: World) => void }>("uiLayoutOp", (world, op) => {
  op.apply(world);
});

/** Where a page appears. `settings` = a tab inside the settings panel (the only section today); adding
 *  another one is a data change here plus a host registration, not a new mechanism. */
export type UiPageSection = "settings";

/** A container a page may be mounted into. Registered during wiring by the view that owns it. */
export interface UiPageHost {
  readonly world: World;
  /** The action-id namespace of the menu that owns the container ("pause" | "main"). */
  readonly id: string;
  /** The panel the page's ENTRY row is added to. */
  readonly settingsPanel: Entity;
  /** The container the entry rows are appended to. The VIEW decides where that container sits (so page rows
   *  land where the layout wants them); the DATA decides how many there are. Appending to `settingsPanel`
   *  directly put every page row after the Back button, because creation order IS render order. */
  readonly rowContainer: Entity;
  /** The widget the page's PANEL is a child of (hiding the menu hides the page). */
  readonly root: Entity;
  /** Open a page by id (writes `UI_MODAL.settings`), or go back to the list with null. */
  readonly show: (page: string | null) => void;
  readonly log: (line: string) => void;
}

/** What a page is handed when it is mounted: the widgets the HOST created for it. */
export interface UiPageMount {
  readonly host: UiPageHost;
  /** The page this mount belongs to (the host paints the panel by comparing it with UI_MODAL.settings). */
  readonly pageId: string;
  /** The page's own container (an empty panel the page fills). */
  readonly panel: Entity;
  /** The row in the settings list that opens the page — created by the host, shown by the host. */
  readonly entry: Entity;
}

/** What the host REMEMBERS about a mount: the page descriptor included, because by the time it is unmounted
 *  the plugin that contributed it is already gone — and its `dispose` still has to run. */
export interface MountedPage extends UiPageMount {
  readonly page: UiPage;
}

/** A page a plugin contributes. `build` runs at a BARRIER (inside the mount command), so it may spawn. */
export interface UiPage {
  readonly id: string;
  readonly section: UiPageSection;
  /** Row order inside the section (lower first). */
  readonly order: number;
  /** i18n key of the entry row's label. */
  readonly titleKey: string;
  build(mount: UiPageMount): void;
  /** Undo what `build` did (spawned widgets, registered specs). Runs at a barrier too. */
  dispose?(): void;
}

/** The containers pages may be mounted into — filled by the views during wiring. */
export const UI_PAGE_HOSTS = defineResource<UiPageHost[]>("uiPageHosts");

/** What is mounted right now, keyed `hostId/pageId`. The host system's diff state, i.e. world data. */
export const UI_PAGES_MOUNTED = defineResource<Map<string, MountedPage>>("uiPagesMounted");
