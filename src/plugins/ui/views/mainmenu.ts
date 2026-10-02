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
import { onUiSource, SOURCE_WORLD_SIZE, UI_SOURCES } from "../../../data/globals/sources";
import { setUiImage, setUiText, spawnButton, spawnLabel, spawnPanel, spawnSlider, UI_LOOK } from "../components";
import { CHUNK_SIZE } from "../../../data/world/chunk";
import {
  sanitizeWorldChunks,
  WORLD_CHUNKS_MAX,
  WORLD_CHUNKS_MIN,
  WORLD_CHUNKS_STEP,
  WORLD_SIZE_PRESETS,
} from "../../../data/world/size";

/** World type (main-menu singleplayer choice; world generation removed, only the selection semantics remain) */
type WorldGenMode = "superflat" | "noise";

export interface MainMenuCallbacks extends SettingsCallbacks {
  onStartSingle: (mode: WorldGenMode) => void;
  onMultiplayer: () => void;
  onExit: () => void;
  /** THE WORLD SIZE (P2.02): the lap, in chunks per side. Read from the value in force (the world-entry driver
   *  is the only thing that APPLIES it) and set through a command. */
  getWorldSize: () => number;
  onSetWorldSize: (chunks: number) => void;
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
    // ===== THE WORLD's XZ SIZE (P2.02) =====
    // How far you walk before the world repeats. It matters because the lap is what an LOD ring is allowed to
    // reach (a ring at radius R needs `R < lap/2`, or the far edge shows the same terrain twice — see
    // data/world/size.ts), so a world meant to carry five or six tiers wants a bigger lap. TWO WAYS TO SAY IT,
    // one value: the preset buttons (the tiers the LOD ladder wants) and a slider for anything else, and the
    // slider is BOUND to the value in force (UI_BIND) so a preset click moves it and the label can never
    // disagree with the world the next entry will build. The change applies on the NEXT world entry — the lap
    // cannot move under a world that is already streaming (the entry resets the voxel map and every mesh).
    spawnLabel(world, this.genPanel, "menu.subTitle", "main.xzTitle");
    spawnLabel(world, this.genPanel, "settings.rowMeta", "main.xzHint");
    const sizeRow = spawnPanel(world, this.genPanel, "settings.btnRow");
    for (const preset of WORLD_SIZE_PRESETS) {
      // An EMPTY key still OWNS UI_TEXT, and the number is then written RAW: "1024" is a size, not a sentence a
      // dictionary could hold (the same call the FPS cap's value label makes).
      const btn = spawnButton(world, sizeRow, "settings.btn", `main.genSize.${preset}`, "", "");
      setUiText(world, btn, `${preset * CHUNK_SIZE}`, true);
      onUiAction(actions, `main.genSize.${preset}`, () => {
        cb.onSetWorldSize(preset);
        renderSize(preset); // HANDED the value: it arrives in the world through a command (next barrier)
      });
    }
    // The slider shares the settings panel's row recipe ON PURPOSE: `settings.range` starts invisible and is
    // revealed by hovering a `settings.optRow` (theme.ts), so putting it in anything else would leave the
    // "custom" half of this control permanently invisible.
    const sizeCtl = spawnPanel(world, this.genPanel, "settings.optRow");
    spawnSlider(
      world,
      sizeCtl,
      "settings.range",
      "main.genSize",
      "",
      {
        min: WORLD_CHUNKS_MIN,
        max: WORLD_CHUNKS_MAX,
        step: WORLD_CHUNKS_STEP,
        initial: cb.getWorldSize(),
      },
      SOURCE_WORLD_SIZE, // BOUND: the slider IS the value in force, presets included
    );
    onUiSource(world.resource(UI_SOURCES), SOURCE_WORLD_SIZE, cb.getWorldSize);
    const sizeValue = spawnLabel(world, sizeCtl, "settings.value", "", { raw: true });
    /** The size, as the player sees it: the LAP in blocks, both axes. `raw: true` — "2048 × 2048 格" is surface
     *  formatting, not a dictionary entry (the same call the FPS cap's label makes about "unlimited"). The value
     *  is HANDED in wherever a click produced it and sanitised with the SAME rule the command applies, so the
     *  label cannot show a size the world will not get (`snapToRange`'s rule for the cap: one declaration). */
    const renderSize = (chunks: number): void => {
      const n = sanitizeWorldChunks(chunks);
      setUiText(world, sizeValue, `${n * CHUNK_SIZE} × ${n * CHUNK_SIZE} 格`, true);
    };
    renderSize(cb.getWorldSize()); // the value in force at wiring (the panel is built once)
    onUiAction(actions, "main.genSize", (value) => {
      // The element reports a STRING; the command sanitises it, so a value the grid cannot express can never
      // reach the world.
      cb.onSetWorldSize(Number(value));
      renderSize(Number(value));
    });
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
