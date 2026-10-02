// ===== Main menu (title voxelcraft + singleplayer/multiplayer/settings/exit): a WIDGET surface =====
// Background: the pack's backgrounds/background.json picks the mode (see ui/background.ts decision chain):
//   panorama = sphere panorama (root semi-transparent so the canvas shows, drawn by main.ts's menu
//              render loop; the root adds only the dimmer)
//   static   = backgrounds/mainmenu.png covers (missing image falls to black)
//   checker  = no config/invalid config, straight to the procedural magenta/black checkerboard (not
//              overridable)
// The decision is RE-DERIVABLE now (P1.49ab): the root's recipe and its UI_IMAGE are widget DATA that the
// reconciler reads every frame, so `refreshBackdrop()` writes them again and the background follows the chain
// in force. It used to be decided once in the constructor — which is exactly why a resource pack reload left
// the OLD image on screen (the recipe still said `menu.backdropImage` and the URL was still the previous
// chain's) and never showed the new one.
//
// VISIBILITY IS NOT DECIDED HERE. Which surface and which sub-page is up is `UI_MODAL`'s navigation
// fields (`mainMenu`, `settings`, `gen`); this file writes them and `ui.navigation` paints the widget
// trees from them — so the ESC step-back, the painter and this surface all read one answer instead of
// three private fields.
import { buildSettingsPanel, type SettingsCallbacks, type SettingsPanels } from "./menu";
import { resolveTexture, CHECKER_TEXTURE_URL } from "../../../data/assets/textures";
import { menuBgKind } from "../../../data/assets/background";
import type { Entity, World } from "../../../core/world";
import { UI_MODAL } from "../../../data/globals/resources";
import { stepBackSettings } from "../systems/navigation";
import { onUiAction, UI_ACTIONS } from "../../../data/globals/actions";
import { setUiImage, spawnButton, spawnLabel, spawnPanel, UI_LOOK } from "../components";

/** World type (main-menu singleplayer choice; world generation removed, only the selection semantics remain) */
type WorldGenMode = "superflat" | "noise";

export interface MainMenuCallbacks extends SettingsCallbacks {
  onStartSingle: (mode: WorldGenMode) => void;
  onMultiplayer: () => void;
  onExit: () => void;
}

export class MainMenu {
  private readonly world: World;
  private readonly root: Entity;
  private readonly mainPanel: Entity;
  private readonly genPanel: Entity;
  private readonly panels: SettingsPanels;

  constructor(world: World, cb: MainMenuCallbacks) {
    this.world = world;

    // The background decision (shared with main.ts's render loop). The reconciler mounts roots itself
    // (on the UI_MOUNT stage), so this file never touches the DOM to place itself.
    const kind = menuBgKind();
    // The root always carries a UI_IMAGE (an empty one for the panorama) and its recipe is decided again by
    // `refreshBackdrop()` below — the ONE place that answers "which background, which image", so the pack
    // reload can move the menu to a different background without a restart.
    this.root = spawnPanel(world, null, kind === "panorama" ? "menu.backdrop" : "menu.backdropImage", {
      hidden: true,
      image: { url: "", scrim: false },
    });
    this.refreshBackdrop();

    this.mainPanel = spawnPanel(world, this.root, "menu.panel");
    spawnLabel(world, this.mainPanel, "menu.title", "voxelcraft", { raw: true }); // the game's name
    const actions = world.resource(UI_ACTIONS);
    spawnButton(world, this.mainPanel, "menu.btn", "main.single", "", "main.single");
    spawnButton(world, this.mainPanel, "menu.btn", "main.multi", "", "main.multi");
    spawnButton(world, this.mainPanel, "menu.btn", "main.settings", "", "menu.settings");
    spawnButton(world, this.mainPanel, "menu.btn", "main.quit", "", "main.quit");
    onUiAction(actions, "main.single", () => this.showGen(true));
    onUiAction(actions, "main.multi", () => cb.onMultiplayer());
    onUiAction(actions, "main.settings", () => this.panels.show("settings"));
    onUiAction(actions, "main.quit", () => cb.onExit());

    // World type selection page (singleplayer sub-page): superflat / noise world
    this.genPanel = spawnPanel(world, this.root, "menu.panel", { hidden: true });
    spawnLabel(world, this.genPanel, "menu.subTitle", "main.genTitle");
    spawnButton(world, this.genPanel, "menu.btn", "main.gen", "superflat", "main.genSuperflat");
    spawnButton(world, this.genPanel, "menu.btn", "main.gen", "noise", "main.genNoise");
    spawnButton(world, this.genPanel, "menu.btn", "main.genBack", "", "menu.back");
    onUiAction(actions, "main.gen", (mode) => cb.onStartSingle(mode as WorldGenMode));
    onUiAction(actions, "main.genBack", () => this.showGen(false));

    this.panels = buildSettingsPanel(world, this.root, "main", {
      log: cb.log,
      onViewportChange: cb.onViewportChange,
      onWindowModeChange: cb.onWindowModeChange,
      getFpsCap: cb.getFpsCap,
      onFpsCap: cb.onFpsCap,
      isVsyncOn: cb.isVsyncOn,
      onSetVsync: cb.onSetVsync,
      isDiagLogEnabled: cb.isDiagLogEnabled,
      onToggleDiagLog: cb.onToggleDiagLog,
      isFadeOn: cb.isFadeOn,
      onSetFade: cb.onSetFade,
      getWindowMode: cb.getWindowMode,
      onSetWindowMode: cb.onSetWindowMode,
  onSetPacks: cb.onSetPacks,
      onBack: () => this.panels.hideAll(),
    });
  }

  /** The main menu's navigation state, read from the resource it lives in */
  private ui() {
    return this.world.resource(UI_MODAL);
  }

  /** Is a settings sub-panel up? (The ESC step-back question — one answer, not four CSS reads.) */
  get settingsOpen(): boolean {
    return this.ui().settings !== null;
  }

  get genVisible(): boolean {
    return this.ui().gen;
  }

  /** The world-type page is a navigation LEVEL, not a state of its own */
  private showGen(show: boolean): void {
    this.ui().gen = show;
  }

  goBack(): void {
    const ui = this.ui();
    if (ui.settings === null && !ui.gen) return;
    // The SAME ladder ESC uses (one mapping, see ecs/ui/navigation.ts) — it used to be copied here.
    stepBackSettings(ui);
  }

  /** Re-derive the backdrop from the pack chain IN FORCE and write it onto the root widget (P1.49ab).
   *
   *  The choice is two pieces of widget DATA — the root's recipe and its `UI_IMAGE` — and the reconciler reads
   *  both every frame, so writing them again is the whole mechanism. Called by the constructor (the boot) and
   *  by the pack RELOAD driver (after it drops the pack-derived caches), which is what makes a swapped
   *  `background.json` / `mainmenu.png` / `panorama.png` take effect without a restart.
   *
   *  IMPORTANT (the bug this replaces): the panorama case must clear the image, and the image cases must set
   *  it. Leaving the previous chain's URL in place is what kept the old picture on screen forever — the recipe
   *  is opaque (`menu.backdropImage` paints black behind the image), so it also HID the panorama behind it. */
  refreshBackdrop(): void {
    const kind = menuBgKind();
    const look = this.world.get(this.root, UI_LOOK);
    if (look) look.recipe = kind === "panorama" ? "menu.backdrop" : "menu.backdropImage";
    if (kind === "panorama") {
      // This recipe is only a dimmer: nothing is painted, so the canvas (the panorama) shows through.
      setUiImage(this.world, this.root, "", false);
      return;
    }
    // checker uses the procedural checkerboard directly (no config = magenta/black, not overridable);
    // static resolves the pack image (a missing image would have decided checker already).
    setUiImage(
      this.world,
      this.root,
      kind === "checker" ? CHECKER_TEXTURE_URL : resolveTexture("backgrounds/mainmenu.png"),
      true,
    );
  }

  show(): void {
    this.ui().mainMenu = true;
  }

  hide(): void {
    const ui = this.ui();
    ui.mainMenu = false;
    // Same reset as the pause menu's hide(): leaving `gen`/`settings` set kept the world-type page up
    // after entering a world (visible in debug.log's `ESC ... gen=true` line).
    ui.settings = null;
    ui.gen = false;
  }

  /** The widget handles ui.navigation paints from the state (this class no longer touches visibility) */
  get rootEntity(): Entity {
    return this.root;
  }
  get mainPanelEntity(): Entity {
    return this.mainPanel;
  }
  get genPanelEntity(): Entity {
    return this.genPanel;
  }
  get panelEntities() {
    return this.panels.entities;
  }
  get listEntities() {
    return this.panels.lists;
  }
}
