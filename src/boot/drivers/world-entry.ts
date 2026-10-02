// ===== Entering a world: the ONE place a world is built (driver) =====
// Extracted from boot/main.ts in P1.18e: the sequence is the SAME (Teleport -> screen up -> prime ->
// warm-up -> screen down -> mode "game" -> capture), and the root now only supplies what it owns - the
// loop state, the menus, the pointer lock, the window queries and the spawn point.
import { RENDER_HANDLES } from "../../data/globals/render-handles";
import { VOXEL } from "../../data/globals/resources";
import { Teleport } from "../../plugins/player/commands";
import { HUMANOID_BODY } from "../../plugins/player/components";
import { WORLD_MAX_Y } from "../../data/world/world";
import type { LoopState } from "../../data/globals/resources";
import { SetLoadingStage } from "../../data/globals/commands";
import type { Entity, World } from "../../core/world";
import type { StageDriver } from "./stage";
import type { BootStage } from "../../data/globals/boot";

/** Everything the entry reaches that the ROOT built. Arrows, so the two menus and the pointer lock may be
 *  created after this factory runs - the values are read when the entry is actually taken. */
export interface WorldEntryDeps {
  readonly world: World;
  readonly log: (line: string) => void;
  readonly stage: StageDriver;
  readonly loop: LoopState;
  readonly player: Entity;
  readonly spawn: { readonly x: number; readonly y: number; readonly z: number };
  readonly setLoopMode: (mode: "load" | "game" | "menu") => void;
  readonly hideMainMenu: () => void;
  readonly showPauseMenu: () => void;
  readonly relock: (reason: string) => void;
  readonly applyCursor: () => void;
  readonly winFocused: () => boolean;
  readonly winWindowMoving: () => boolean;
  readonly windowSessionActiveNow: () => Promise<boolean>;
}

/** The entry, as a call: it resolves when the world is ready and the display has been handed over. */
export function createWorldEntry(deps: WorldEntryDeps): (mode: string) => Promise<void> {
// ===== Entering a world: the ONE place a world is built =====
// There is no world-entry loading screen in the old sense and no boot-time preload any more: the
// SPAWN WINDOW IS GENERATED AND MESHED HERE, behind the same screen the startup uses (`LOADING_STATE` +
// `ui.loading`, whose text is a stage key and whose bar is data). Why here and not at boot:
//   * the startup no longer spends ~1.6 s building a world the user may never enter (it reaches the
//     main menu right after the GPU is ready), and chunk data is only allocated if a world is entered;
//   * the work is where the user expects to wait for it, and a screen that covers real work is honest —
//     the boot screen used to cover it, which made "entering a world" instant but the STARTUP long;
//   * a future world type, save game or respawn simply has more to do in the same place.
// The loop is put in `load` mode (the ui lane only: nothing simulated, nothing drawn) until the
// world is ready, which is what keeps the screen up with no panorama drawn behind it.
/** Enter the world: build the window around the spawn point behind the loading screen, then play.
 *  A RE-entry into a window that is still built skips the screen entirely (see `needsWarmUp`). */
const enterWorld = async (mode: string): Promise<void> => {
  const entryStart = performance.now();
  // The entry watches the window for fiddling of its own (P1.62e): a drag during the loading is remembered
  // and makes this entry start on the pause menu instead of capturing behind the user's back.
  deps.loop.geometryDuringLoad = false;
  // The menu stops owning the display first: `hide()` publishes into UI_MODAL, so ui.navigation takes
  // it down in the same ui lane that paints the screen.
  deps.hideMainMenu();
  // Back to spawn. Through the barrier — and it has to be applied BEFORE the warm-up, because
  // `chunkStream.step()` reads POSITION to decide which window to build.
  deps.world.commands.send(Teleport, { entity: deps.player, x: deps.spawn.x, y: deps.spawn.y, z: deps.spawn.z });
  deps.log(`MAINMENU entering singleplayer (world type: ${mode === "noise" ? "noise" : "superflat"})`);

  // **THE GROUND IS A NOISE FIELD, SO THE SPAWN Y IS A QUESTION, NOT A CONSTANT (P1.92).** The root knows
  // the spawn COLUMN and the LEVEL the surface rolls around; where the ground actually is has to be asked of
  // the generated world — and asked with `WORLD_MAX_Y` as the ceiling, because `topSolidY` scans DOWNWARDS
  // and a ceiling below the local hill would answer "inside the mountain". Reads do not generate (see
  // world.ts), so this runs AFTER `prime`/on an already-warm window, and it is sent as a command so the
  // barrier applies it exactly like the entry Teleport above.
  const snapToSurface = (): void => {
    const surface = deps.world
      .resource(VOXEL)
      .topSolidY(Math.floor(deps.spawn.x), Math.floor(deps.spawn.z), WORLD_MAX_Y - 1);
    if (surface === null) return; // an all-air column: the root's Y is as good as any
    deps.world.commands.send(Teleport, {
      entity: deps.player,
      x: deps.spawn.x,
      y: surface + HUMANOID_BODY.eyeHeight,
      z: deps.spawn.z,
    });
  };

  if (deps.world.resource(RENDER_HANDLES).chunkStream.needsWarmUp(deps.spawn.x, deps.spawn.z)) {
    // ACTIVATE the screen: the same trap as the startup's first stage — the root is spawned hidden and
    // `ui.loading` paints nothing while LOADING_STATE.active is false (which the END of boot() left it as).
    // Forgetting this line is invisible to a type-checker and to every "is the screen painted" test
    // that drives the system rather than the driver, which is why the gate now asserts it per driver.
    // The NOTE is cleared in the same breath: it belongs to the startup's settings check, and a stale
    // "repaired settings" line has no business on a world entry.
    deps.world.commands.send(SetLoadingStage, { active: true, noteKey: "", noteValue: "" });
    // …and the loop has to BE in `load` mode for the whole entry: the entry is driven from the main
    // menu, so without this line every frame in between is a MENU frame, which draws the panorama
    // behind an opaque screen for nothing (and `loadFrame` — the mode's own body — would never run).
    deps.setLoopMode("load");
    // The entry's stages, as DATA (ecs/boot.ts): the work of a stage runs after its own announcement has
    // been painted, so the bar never claims to be doing something it has not started.
    const stages: readonly BootStage[] = [
      { progress: 0, key: "world.spawn" },
      {
        progress: 0.15,
        key: "world.terrain",
        // Generate (no meshing) the spawn window: collision needs real blocks on the very first tick.
        run: () => {
          deps.world.resource(RENDER_HANDLES).chunkStream.prime(deps.spawn.x, deps.spawn.z);
          snapToSurface(); // …and the ground is where the field says it is (see above)
        },
      },
      {
        progress: 0.2,
        key: "world.chunks",
        run: () =>
          deps.world.resource(RENDER_HANDLES).chunkStream.warmUp(deps.stage.paint, (done, total) => {
            // The bar owns almost the whole entry: the GPU was paid for at boot.
            deps.world.commands.send(SetLoadingStage, { progress: total > 0 ? 0.2 + 0.75 * (done / total) : 0.2 });
          }),
      },
      { progress: 1, key: "world.ready" },
    ];
    await deps.stage.run("world", stages);
    deps.log(`WORLD ready at ${(performance.now() - entryStart).toFixed(0)}ms`);
  } else {
    // Nothing to build: the world is already on screen behind the menu, so it comes back at once.
    snapToSurface(); // the window is warm, so the surface is already answerable
    deps.world.renderUi(); // the barrier applies the Teleport before the first game frame reads it
    deps.log("WORLD already warm, entering without a screen");
  }

  // Hand the display over in ONE ui lane: the screen comes down and the world is drawn by the very
  // next frame (a game frame draws the scene BEFORE its ui lane runs, so there is no empty frame).
  deps.world.commands.send(SetLoadingStage, { active: false });
  deps.setLoopMode("game");
  deps.applyCursor();
  // **Entering a world must be a DELIBERATE "give me the mouse" moment.** Two things can make it wrong,
  // and both end in the same place: no capture, and the pause menu.
  //   * the window is not FOREGROUND: the relock would open native capture on a background window (the
  //     cursor clamped into a screen region another app is over; raw input is collected in the background
  //     too, so the view keeps turning; and the cursor is globally hidden) — and no blur event will come to
  //     the rescue, because focus was lost long ago;
  //   * the user has a HAND ON THE WINDOW (P1.62e): holding a title bar or a border produces NO geometry
  //     event until it MOVES, so the game used to come up "playing" with a hand on the frame and pause only
  //     on the first movement. `winWindowMoving()` is the platform's own view of that (pushed as
  //     `win-session`), and `geometryDuringLoad` covers "they fiddled with it at some point while it was
  //     loading" — where there was nothing to pause yet.
  // **ASK THE PLATFORM, DO NOT TRUST THE PUSHED FLAG (P1.62f).** `win-session` is an EVENT, and a push is
  // only current if the JS event loop has been idle since it happened - while THIS decision is taken at the
  // end of the entry, whose stages generate and mesh the spawn window in long synchronous stretches. That is
  // exactly how a world entered with a hand on the title bar still captured the mouse while the platform's
  // own log (boot.log, `[cursor] window session moving=true`) said otherwise 158ms earlier. The query gives
  // the value at THIS instant, and awaiting it also lets any queued push drain on the way.
  const moving = await deps.windowSessionActiveNow();
  const pushed = deps.winWindowMoving();
  const fiddled = deps.loop.geometryDuringLoad;
  if (deps.winFocused() && !moving && !fiddled) {
    deps.relock("world entered");
  } else {
    deps.showPauseMenu();
    const why = !deps.winFocused()
      ? "not foreground"
      : moving
        ? "the window is being moved/resized"
        : "the window was moved during loading";
    // The values go in the line: if this ever fires wrongly again it says whether the QUERY was wrong or the
    // PUSH was late (they are both in the log, and the platform's own `window session` line is in boot.log).
    deps.log(`WORLD entered while ${why} -> pause menu (no capture) [moving=${moving} pushed=${pushed} fiddled=${fiddled}]`);
  }
}
  return enterWorld;
}
