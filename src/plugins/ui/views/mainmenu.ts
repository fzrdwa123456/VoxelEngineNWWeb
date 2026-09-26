// ===== Main menu (title voxelcraft + singleplayer/multiplayer/settings/exit): a WIDGET surface =====
// Background: the pack's backgrounds/background.json picks the mode (see ui/background.ts decision chain):
//   panorama = sphere panorama (root semi-transparent so the canvas shows, drawn by main.ts's menu
//              render loop; the root adds only the dimmer)
//   static   = backgrounds/mainmenu.png covers (missing image falls to black)
//   checker  = no config/invalid config, straight to the procedural magenta/black checkerboard (not
//              overridable)
// The decision is made ONCE at wiring time (as it was before), because it selects the root's recipe:
// `menu.backdrop` for the panorama, `menu.backdropImage` + a UI_IMAGE for the two painted modes.
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
import { setUiImage, spawnButton, spawnLabel, spawnPanel } from "../components";

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
    this.root = spawnPanel(world, null, kind === "panorama" ? "menu.backdrop" : "menu.backdropImage", {
      hidden: true,
      image: kind === "panorama" ? undefined : { url: "", scrim: true },
    });
    if (kind !== "panorama") {
      // checker uses the procedural checkerboard directly (no config = magenta/black, not overridable);
      // static resolves the pack image (a missing image would have decided checker already).
      setUiImage(
        world,
        this.root,
        kind === "checker" ? CHECKER_TEXTURE_URL : resolveTexture("backgrounds/mainmenu.png"),
        true,
      );
    }

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
      isGpuVsyncDisabled: cb.isGpuVsyncDisabled,
      onToggleGpuVsync: cb.onToggleGpuVsync,
      isDiagLogEnabled: cb.isDiagLogEnabled,
      onToggleDiagLog: cb.onToggleDiagLog,
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
