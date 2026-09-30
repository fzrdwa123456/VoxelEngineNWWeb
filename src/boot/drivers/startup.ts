// ===== The STARTUP driver (driver) =====
// Extracted from boot/main.ts in P1.18e: activate the screen, reveal the window, check the settings
// file, init the GPU, then hand over to the MENU with the screen coming down through the barrier. The
// root supplies the pieces it owns (the loop's kick-off, the reveal, the renderer, the viewport sizing,
// the main menu and the pointer lock); the stage list and the settings check live here.
import { diffSettings, readSettingsChecked, backupSettingsFile, writeSettings, applyWindowModeAtStart, isDiagLogEnabled, getWindowMode, showWindow } from "../../host/desktop/shell";
import { getLang } from "../../data/assets/i18n";
import { getUIScaleMode } from "../../data/globals/uiscale";
import { getFontId } from "../../data/globals/fonts";
import { getBindsAll } from "../../plugins/input/keybinds";
import { getEnabledPacks } from "../../data/assets/textures";
import { FPS_CAP, type LoopState } from "../../data/globals/resources";
import { CANVAS_HOST } from "../../data/globals/gfx";
import { BOOT_FLOW } from "../../data/globals/boot";
import { SetLoadingStage } from "../../data/globals/commands";
import type { BootStage } from "../../data/globals/boot";
import type { World } from "../../core/world";
import type { StageDriver } from "./stage";
import type { WebGPURenderer } from "three/webgpu";

export interface StartupDeps {
  readonly world: World;
  readonly log: (line: string) => void;
  readonly stage: StageDriver;
  readonly renderer: WebGPURenderer;
  readonly loop: LoopState;
  readonly frame: () => void;
  readonly suppressGeometryPause: () => void;
  readonly applyViewportSize: () => void;
  readonly showMainMenu: () => void;
  readonly applyCursor: () => void;
  readonly setLoopMode: (mode: "load" | "game" | "menu") => void;
}

/** The startup, as a call. It resolves when the main menu is up and the screen is down. */
export function createStartupDriver(deps: StartupDeps): () => Promise<void> {
  const bootFlow = deps.world.resource(BOOT_FLOW);
/** Validate the settings FILE against the values that actually took force, repair what cannot be
 *  used, write the corrected file back and report it.
 *
 *  Every config module already validates its own field and silently falls back to a default when it
 *  cannot (`loadLang` ignores a language that is not zh/en/ja, `sanitizeFrameCap` turns a hand-edited
 *  `fpsCap: 1` into 30, `loadBinds` drops a code it does not know). That is the right thing to do at
 *  LOAD time, but it left the file saying one thing while the game used another — so the bad value
 *  survived on disk, unreported, and every launch had to guess again. Comparing the two is what turns
 *  "the game quietly uses 30" into "fpsCap was repaired to 30, on disk, and here is the list".
 *
 *  `inForce` doubles as the SCHEMA: its keys are the settings the engine knows. Anything else in the
 *  file is reported and KEPT — a newer build (or a mod) may have written it, and an older build must
 *  not trim it. */
  const checkSettingsAtBoot = (): { noteKey: string; noteValue: string } => {
  const inForce: Record<string, unknown> = {
    language: getLang(),
    font: getFontId(),
    uiScale: getUIScaleMode(),
    windowMode: getWindowMode(),
    fpsCap: deps.world.resource(FPS_CAP).cap,
    keybinds: getBindsAll(),
    diagLog: isDiagLogEnabled(),
    enabledPacks: getEnabledPacks(),
  };
  const checked = readSettingsChecked();
  if (checked.problem) {
    // Unreadable file. Keep the bytes — a hand-edit typo is worth recovering — and rebuild a complete,
    // valid file from the values in force, so the next launch cannot fail the same way.
    const backup = backupSettingsFile();
    writeSettings({ ...inForce });
    deps.log(`SETTINGS ${checked.problem}; copied to ${backup} and rebuilt from the values in force`);
    return { noteKey: "loading.rebuilt", noteValue: backup };
  }
  const report = diffSettings(checked.settings, inForce);
  if (report.fixed.length === 0 && report.unknown.length === 0) {
    deps.log("SETTINGS ok");
    return { noteKey: "", noteValue: "" };
  }
  if (report.fixed.length > 0) writeSettings(report.merged);
  deps.log(
    `SETTINGS repaired: ${report.fixed.join(", ") || "none"}` +
      (report.unknown.length > 0 ? `; unknown settings kept: ${report.unknown.join(", ")}` : ""),
  );
  // A repair is what the user needs to see; unknown keys are only worth a line when they are all there
  // is to say (nothing was broken, but the file has something this build does not know).
  return report.fixed.length > 0
    ? { noteKey: "loading.fixed", noteValue: report.fixed.join(", ") }
    : { noteKey: "loading.unknown", noteValue: report.unknown.join(", ") };
}

/** The STARTUP flow, as DATA. The order IS the feature and it is now readable in one place; each stage's
 *  work runs after its own announcement has been painted (ecs/boot.ts::runBootFlow). The root font size
 *  is NOT applied here any more: the reconciler applies it (with the font pair) at the top of every frame,
 *  diffed against what it last wrote, so the very first stage already renders at the right size. */
const BOOT_STAGES: readonly BootStage[] = [
  {
    progress: 0,
    key: "loading.settings",
    run: () => {
      // The screen is spawned (hidden) during wiring; this frame is what shows it, and it is also the ONLY
      // place the chain is kicked off. Calling `frame()` directly — instead of scheduling it — keeps this
      // the single place a frame starts from; the call at the END of frame() re-arms it.
      deps.frame();
      // The window is revealed only now, with the loading screen already in the DOM: the manifest hides it
      // at creation ("show": false) precisely so nothing white can flash, and revealing it before the first
      // paint would trade that for a black rectangle.
      showWindow();
      deps.suppressGeometryPause(); // the reveal itself resizes/moves the window
      applyWindowModeAtStart();
      // The settings check's OUTCOME is data (bootFlow.note*), because the stage after this one reports it.
      const settings = checkSettingsAtBoot();
      bootFlow.noteKey = settings.noteKey;
      bootFlow.noteValue = settings.noteValue;
    },
  },
  { progress: 0.2, key: "loading.settings", withNote: true },
  {
    progress: 0.3,
    key: "loading.gpu",
    run: async () => {
      await deps.renderer.init();
      // From here the canvas may be sized (a load frame runs before this point) — and the size comes from
      // the VIEWPORT resource like every later resize, so there is ONE rule for "how big is the canvas".
      deps.loop.rendererReady = true;
      deps.applyViewportSize();
      // The canvas host is read back from the world: "where the game's canvas goes" is world state too.
      deps.world.resource(CANVAS_HOST).appendChild(deps.renderer.domElement);
      deps.log(`BOOT graphics ready at ${(performance.now() - bootFlow.startedAt).toFixed(0)}ms`);
    },
  },
  {
    progress: 1,
    key: "loading.ready",
    // The startup ENDS here: the world is not built at boot any more (`enterWorld()` does that behind this
    // same screen), so the main menu comes up as soon as the GPU can draw. The mode becomes MENU, and the
    // first game frame draws the 3D world over the black clear.
    run: () => {
      deps.renderer.setClearColor(0x000000);
      deps.renderer.clear();
      deps.showMainMenu();
      deps.applyCursor();
      deps.setLoopMode("menu");
      // Last, the startup screen comes down. Through the barrier like everything else, so the screen and
      // the menu swap inside ONE ui lane — a direct flag write here would leave a frame showing neither.
      deps.world.commands.send(SetLoadingStage, { active: false });
    },
  },
];

const boot = async (): Promise<void> => {
  const bootStart = performance.now();
  // ACTIVATE the screen before the first stage — and note this line is load-bearing, not decoration:
  // `ui.loading` only paints while LOADING_STATE.active is true (its root is spawned hidden), so a driver
  // that forgets it leaves the window showing the HUD ALONE — a black page with a crosshair and a
  // hotbar on it, which is exactly how that bug was reported. The command lands on the barrier inside
  // the first stage's renderUi, i.e. before anything is revealed.
  deps.world.commands.send(SetLoadingStage, { active: true });
  await deps.stage.run("boot", BOOT_STAGES);
  deps.log(`BOOT ready in ${(performance.now() - bootStart).toFixed(0)}ms`);
}
  return boot;
}
