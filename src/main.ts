import * as THREE from "three/webgpu";
import { World } from "./ecs/World";
import { spawnPlayer, POSITION, CONTROL, MOTION, EYE_HEIGHT } from "./ecs/components/Player";
import { PlayerInputSystem } from "./ecs/systems/input";
import { PlayerControllerSystem } from "./ecs/systems/controller";
import { PlayerMovementSystem } from "./ecs/systems/movement";
import { CameraViewSystem } from "./rendering/camera-view";
import { Inventory } from "./ui/inventory";
import { Menu } from "./ui/menu";
import { MainMenu } from "./ui/mainmenu";
import { Hud } from "./ui/hud";
import { GamemodeController } from "./ui/gamemode";
import { PointerLock } from "./platform/pointerlock";
import { t, loadLang, getLang, onLangChange, type Lang } from "./ui/i18n";
import { loadUIScaleMode, getUIScaleMode, onUIScaleModeChange, applyUIScale } from "./ui/uiscale";
import { loadFont, getFontId, onFontChange } from "./ui/fonts";
import { initShell, sendLog, showWindow, getGpuVsyncState, setGpuVsyncState, winFocused, quitApp, onWinFocus, onWinBlur, readSettings, writeSettings, getWindowMode, setWindowMode, applyWindowModeAtStart, onWindowModeChange, type WindowMode } from "./platform/shell";
import { startRawInput, centerCursor } from "./platform/rawinput";
import { DebugLogForwarder } from "./platform/debuglog";
import { PerfSampler } from "./platform/perf";
import { loadBinds, getBind, getBindsAll, onBindsChange, isCapturing, buttonToAction, buttonToCode } from "./platform/keybinds";
import { menuBgKind } from "./ui/background";
import { resolveTexture } from "./rendering/textures";
import { loadBlockRegistry } from "./blockregistry";

// Pixel font (Fusion Pixel, OFL open source): proportional font for general UI, monospace for F3/count panels
import "@fontsource/fusion-pixel-12px-proportional-sc";
import "@fontsource/fusion-pixel-12px-monospaced-sc";

initShell();
// Settings: loaded from settings.json at startup (language/font/UI scale/window mode/keybinds, before any UI is built), written back on change
loadLang(readSettings().language);
loadFont(readSettings().font);
loadUIScaleMode(readSettings().uiScale);
loadBinds(readSettings().keybinds);
const saveSettings = (): void => {
    // Read-modify-write merge, avoids clobbering other settings (windowMode etc.)
  const s = readSettings();
  s.language = getLang();
  s.font = getFontId();
  s.uiScale = getUIScaleMode();
  s.windowMode = getWindowMode();
  s.keybinds = getBindsAll();
  writeSettings(s);
};
onLangChange(saveSettings);
onFontChange(saveSettings);
onUIScaleModeChange(saveSettings);
onWindowModeChange(saveSettings);
onBindsChange(saveSettings);

// Block registry: merge every resource pack's blocks.json (built-in = default.zip entries, user packs can add/change blocks); must run before BlockWorld/inventory
loadBlockRegistry();

const app = document.getElementById("app")!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
// Fog (MC-style distance fade): fog color = sky color, everything blends into the sky past 950 units -> the far=1000 frustum circle edge is invisible; the main-menu panorama is a separate scene, unaffected
scene.fog = new THREE.Fog(0x87ceeb, 500, 950);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(1, 2.6, 1);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGPURenderer({
  antialias: true,
  powerPreference: "high-performance",
  trackTimestamp: true,
});
await renderer.init();
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);
// manifest "show": false -> window shown only after the first frame renders (prevents startup white flash)
showWindow();
// Settings say fullscreen: enter fullscreen (no restart) and hook ESC-exit -> sync back when settings switch to windowed
applyWindowModeAtStart();

// ===== ECS composition: entities + systems registered into the World scheduler =====
const world = new World();
const player = spawnPlayer(world, new THREE.Vector3(0.5, 5.6, 0.5));
const input = new PlayerInputSystem(world, player, renderer.domElement, sendLog);
const controller = new PlayerControllerSystem(world, player, input);
const movement = new PlayerMovementSystem(world, input);
const cameraView = new CameraViewSystem(world, player, camera);

world.addFixed((dt) => cameraView.beginStep()); // freeze the render-interpolation source first...
world.addFixed((dt) => controller.step(dt));     // ...then consume input deltas and apply the view...
world.addFixed((dt) => movement.step(dt));       // ...move the entities...
world.addRender((alpha) => cameraView.render(alpha));
world.addRender((alpha, delta) => diagnostics(alpha, delta));
world.addRender(() => renderer.render(scene, camera));

// Component record shortcuts (stable references — see ecs/components/Player.ts)
const playerPos = world.entities.get(player, POSITION)!;
const playerControl = world.entities.get(player, CONTROL)!;
const playerMotion = world.entities.get(player, MOTION)!;

// Raw mouse input (Rust plugin): takes over view rotation when pointer lock is cancelled with the window partially offscreen.
// An 8ms timer drains the accumulated delta (also drained while the main menu stops the loop, preventing backlog from spinning the view wildly on world entry),
// whether it applies is gated inside input.applyRawInput (discarded when locked/in menus)
const rawInput = startRawInput();
input.rawInputActive = rawInput.available;
setInterval(() => {
  const d = rawInput.poll();
  if (d.dx !== 0 || d.dy !== 0) input.applyRawInput(d.dx, d.dy);
}, 8);


const hud = new Hud();

// Pointer lock manager: referenced by inventory/menu callbacks; declared with let then assigned, avoiding a circular dependency
let pointerLock: PointerLock;

// Inventory (toggled with E; pauses the game and unlocks the mouse while open)
const inv = new Inventory((open) => {
  if (open) {
    input.prepareUnlock();
        sendLog("UNLOCK request (inventory)");
    document.exitPointerLock();
    centerCursor();
    stopLoop();
  } else {
        // Relock on the next event-loop turn: dodges Chromium's "ESC exits lock" default action during the current keydown dispatch,
        // otherwise the synchronous relock at the instant the inventory closes via ESC is immediately unlocked by the default action, and the menu pops erroneously
        setTimeout(() => pointerLock.relock("inventory E"), 0);
    startLoop();
  }
  pointerLock.applyCursor();
});
document.addEventListener("keydown", (ev) => {
  if (ev.code === getBind("inventory") && !isCapturing() && !menu.visible && !menu.settingsVisible && !mainMenu.visible) inv.toggle();
});

pointerLock = new PointerLock({
  fps: input,
  isMenuOpen: () => menu.visible || menu.settingsVisible || mainMenu.visible,
  isInvOpen: () => inv.open,
  sendLog,
});

// Diagnostics: record pointer lock state changes (locked/unlocked done) to verify cursor-centering races
document.addEventListener("pointerlockchange", () => {
    sendLog(`LOCKCHANGE ${document.pointerLockElement ? "locked" : "unlocked"}`);
});

// Settings callbacks (shared by the pause menu and main menu)
const onFpsCap = (cap: number): void => {
  fpsCap = cap;
    sendLog(`FPS cap set to ${cap === 0 ? "unlimited" : cap}`);
};
const onToggleGpuVsync = (on: boolean): boolean => {
  const ok = setGpuVsyncState(on);
  hud.showToast(
    ok
      ? on
        ? t("toast.vsyncOff")
        : t("toast.vsyncOn")
      : t("toast.vsyncFail"),
  );
    sendLog(`GPU vsync ${on ? "disabled" : "enabled"} ${ok ? "written to manifest, restart to apply" : "write failed"}`);
  return ok;
};

// Window mode: runtime enter/leaveFullscreen switch (no restart); exiting fullscreen goes through the settings panel "windowed"
const onSetWindowMode = (mode: WindowMode): void => {
  setWindowMode(mode);
    sendLog(`window mode ${mode === "fullscreen" ? "fullscreen" : "windowed"}`);
};

const menu = new Menu({
  onResume: () => {
        // Back to game: relock the mouse (cooldown after ESC, auto-retry on failure)
        pointerLock.relock("menu resume");
    pointerLock.applyCursor();
        sendLog("RESUME back to game -> relock");
  },
  onFpsCap,
  onToggleGpuVsync,
  getGpuVsyncState: () => getGpuVsyncState(),
  getFpsCap: () => fpsCap,
  getWindowMode: () => getWindowMode(),
  onSetWindowMode,
  onToMainMenu: () => {
        // Back to main menu: stop the loop + clear to black (the background is handled by the main-menu background system; entering the game auto-restores the 3D world on the first frame)
    started = false;
    stopLoop();
    renderer.setClearColor(0x000000);
    renderer.clear();
    mainMenu.show();
    startMenuBgLoop();  // panorama mode: restart the panorama loop
    pointerLock.applyCursor();
        sendLog("MENU back to main menu");
  },
});

// ===== Loading screen: chunk system removed, no streaming preload — element kept for future reuse =====
const loadingEl = document.createElement("div");
loadingEl.style.cssText =
  "position:fixed;inset:0;z-index:95;display:none;flex-direction:column;align-items:center;justify-content:center;" +
  "gap:16px;background:rgba(0,0,0,.85);color:#fff;font-family:var(--font-ui);";
const loadingText = document.createElement("div");
loadingText.style.cssText = "font-size:1.1rem;";
const loadingBar = document.createElement("div");
loadingBar.style.cssText = "width:240px;height:10px;border:2px solid #fff;";
const loadingBarFill = document.createElement("div");
loadingBarFill.style.cssText = "width:0%;height:100%;background:#7fae5f;";
loadingBar.appendChild(loadingBarFill);
loadingEl.append(loadingText, loadingBar);
document.body.appendChild(loadingEl);

let loading = false;

/** Enter world (chunk system removed: no preload, go straight in) */
function enterWithLoading(): void {
  mainMenu.hide();
  loading = false;
  loadingEl.style.display = "none";
  pointerLock.applyCursor();
    pointerLock.relock("world entered after load");
  startLoop();
    sendLog("MAINMENU entering singleplayer");
}

// Main menu: singleplayer picks a world type then enters; multiplayer placeholder; settings/exit
const mainMenu = new MainMenu({
  onStartSingle: (mode) => {
    playerPos.set(0.5, 5.6, 0.5);
    playerMotion.vy = 0;
    sendLog(`MAINMENU entering singleplayer (world type: ${mode === "noise" ? "noise" : "superflat"})`);
    enterWithLoading();
  },
  onMultiplayer: () => {
    hud.showToast(t("toast.multiPlaceholder"));
        sendLog("MAINMENU multiplayer (placeholder)");
  },
  onExit: () => {
        sendLog("MAINMENU quit");
    quitApp();
  },
  getFpsCap: () => fpsCap,
  onFpsCap,
  getGpuVsyncState,
  onToggleGpuVsync,
  getWindowMode,
  onSetWindowMode,
});

// Window leaves the foreground (minimized/switched away/clicking another window): immediately show the pause menu (only while actually playing).
// Re-focus: while playing with no UI open, auto-relock (MC behavior: an open menu does not auto-close, resume manually).
onWinBlur(() => {
  input.prepareUnlock();
  if (document.pointerLockElement) document.exitPointerLock();
  if (started && !mainMenu.visible && !menu.visible && !menu.settingsVisible && !inv.open) {
    menu.show();
    pointerLock.applyCursor();
        sendLog("BLUR lost focus -> pause menu");
  }
});
onWinFocus(() => {
  if (started && !mainMenu.visible && !menu.visible && !menu.settingsVisible && !inv.open && !input.locked) {
        pointerLock.relock("window focus");
        sendLog("FOCUS focused -> relock");
  }
});

// ESC: NW.js 0.112 (#7907) implements this officially — ESC events reach the renderer normally,
// preventDefault() in keydown keeps pointer lock, and the 1.25s relock cooldown is gone.
// (Old Electron builds needed a launcher hook to swallow keys + a stdin pipe + an IPC "backdoor"; deprecated here)
document.addEventListener("keydown", (ev) => {
  if (ev.code !== "Escape") return;
  ev.preventDefault();  // #7907: block the default unlock; we control menu open/close
  sendLog(
    `ESC mainMenu=${mainMenu.visible} menu=${menu.visible} settings=${menu.settingsVisible} ` +
      `lang=${menu.langVisible} pack=${menu.packVisible} keybind=${menu.keybindVisible} gen=${mainMenu.genVisible} capturing=${isCapturing()}`,
  );
  if (mainMenu.visible) {
        // Main menu: ESC steps back through any sub-panel/settings panel; otherwise ignored
    if (mainMenu.settingsVisible || mainMenu.langVisible || mainMenu.packVisible || mainMenu.keybindVisible || mainMenu.genVisible) mainMenu.goBack();
    return;
  }
  if (inv.open) {
    inv.close();
  } else if (menu.settingsVisible || menu.langVisible || menu.packVisible || menu.keybindVisible) {
    menu.goBack();
  } else if (menu.visible) {
    menu.hide();
    pointerLock.relock("ESC closes menu");   // No cooldown, relock immediately
  } else {
        // In game: show the menu + release the mouse directly (pauses even if the cursor was not captured)
    input.prepareUnlock();
        sendLog("UNLOCK request (menu)");
    document.exitPointerLock();
    menu.show();
    centerCursor();
  }
  pointerLock.applyCursor();
});

// F3+F4 game mode switch + F3 debug panel (registers its own keyboard listeners in the constructor)
new GamemodeController(hud, input, sendLog);

// ===== Central mouse-button dispatch: bound actions get their triggers here =====
document.addEventListener("mousedown", (ev) => {
  if (isCapturing()) return; // No accidental triggers while a rebind capture is active
  const action = buttonToAction(ev.button);
  if (!action) return;
  if (action === "inventory") {
    if (!menu.visible && !menu.settingsVisible && !mainMenu.visible) inv.toggle();
    return;
  }
  const code = buttonToCode(ev.button)!;
  input.bindPress(code);
});
document.addEventListener("mouseup", (ev) => {
  const code = buttonToCode(ev.button);
  if (!code) return;
  const action = buttonToAction(ev.button);
  if (!action || action === "break" || action === "place" || action === "inventory") return;
  input.bindRelease(code);
});

// Space shield: whenever any UI is open, Space's browser default (scroll the nearest
// scrollable ancestor of the focused element — e.g. the keybind chip list after clicking
// a chip) is swallowed. Gameplay Space (no UI open) is unaffected; capture mode still
// receives the event and binds it via its own handler (double preventDefault is harmless).
document.addEventListener(
  "keydown",
  (ev) => {
    if (ev.code !== "Space") return;
    const uiOpen =
      mainMenu.visible || menu.visible || menu.settingsVisible ||
      menu.langVisible || menu.packVisible || menu.keybindVisible || inv.open;
    if (uiOpen) ev.preventDefault();
  },
  true,
);

scene.add(new THREE.AmbientLight(0xffffff, 0.5));
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (menuBgCamera) {
    menuBgCamera.aspect = window.innerWidth / window.innerHeight;
    menuBgCamera.updateProjectionMatrix();
  }
});

const timer = new THREE.Timer();
timer.connect(document);  // Page Visibility API: delta=0 when minimized/background, auto-reset on resume

// Render loop: constant requestAnimationFrame (optimal on 60Hz displays, stable frame delivery)
let rafId = 0;
let timerId: ReturnType<typeof setTimeout> | undefined;
let started = false;
// Fixed-step physics: step size + time accumulator (decoupled from frame timing, MC-style fixed tps)
const PHYS_DT = 1 / 120;
let physAcc = 0;
// FPS cap (0 = unlimited): physics still advances at fixed steps; only rendering and stats are gated
let fpsCap = 0;
let renderAcc = 0;
// Performance sampling + debug log forwarding (implemented in their own modules)
const perf = new PerfSampler();
const dbgFwd = new DebugLogForwarder();

function renderFrame(): void {
  timer.update();
  const delta = Math.min(timer.getDelta(), 0.1);

    // Fixed-step physics advance: movement is independent of frame duration, constant per step (removes movement jitter from uneven frame timing)
  physAcc += delta;
  let steps = 0;
  while (physAcc >= PHYS_DT && steps < 12) {
    world.stepFixed(PHYS_DT);
    physAcc -= PHYS_DT;
    steps++;
  }

    // FPS cap gate: skip rendering and stats until the frame budget is reached (physics already advanced above at fixed steps)
  if (fpsCap > 0) {
    const budget = 1 / fpsCap;
    renderAcc += delta;
    if (renderAcc < budget) return;
    renderAcc %= budget;
  }

  // Per-frame systems: view interpolation -> diagnostics -> draw (alpha = remainder of the physics tick)
  world.render(Math.min(physAcc / PHYS_DT, 1), delta);
}

/** Per-frame diagnostics (registered as a render system): stats sampling, PHYS log,
 *  diagnostic queue forwarding, GPU timestamps, F3 panel refresh. */
function diagnostics(_alpha: number, delta: number): void {
  const s = perf.sample(delta);
  if (!s) return;
  const p = playerPos;
  const feet = p.y - EYE_HEIGHT;
  const top = NaN;  // No world — no terrain height
  sendLog(
    `PHYS mode=${playerControl.mode} ground=${playerMotion.onGround} vy=${playerMotion.vy.toFixed(2)} ` +
      `feet=${feet.toFixed(4)} top=${Number.isFinite(top) ? top.toFixed(4) : "none"} ` +
      `gap=${Number.isFinite(top) ? (feet - top).toFixed(4) : "-"} ` +
      `gapE=${Number.isFinite(top) ? (feet - top).toExponential(2) : "-"} ` +
      `xyz=${p.x.toFixed(2)}/${p.y.toFixed(2)}/${p.z.toFixed(2)}`,
  );

  // Diagnostic queue incremental forwarding (SPACE/MOUSE, implemented in debuglog.ts)
  dbgFwd.forward(input);

  // Read the real GPU render time (ms, last frame's total render pass), EMA-smoothed in perf.ts
  renderer
    .resolveTimestampsAsync("render")
    .then((ms) => {
      if (typeof ms === "number" && ms > 0) perf.noteGpu(ms);
    })
    .catch(() => {});

  // F3 debug panel (Hud shows it on demand internally)
  hud.updateDebug({
    fps: s.fps,
    fpsCap,
    x: p.x,
    y: p.y,
    z: p.z,
    blocks: 0,
    gpuMs: s.gpuMs,
    mode: playerControl.mode,
    onGround: playerMotion.onGround,
    vy: playerMotion.vy,
    feet,
    top: Number.isFinite(top) ? top : null,
    logs: [
      { label: t("f3.logMouse"), lines: input.mouseLog },
      { label: t("f3.logSpace"), lines: input.spaceLog },
    ],
  });
}

function stopLoop(): void {
  cancelAnimationFrame(rafId);
  if (timerId !== undefined) clearInterval(timerId);
  timerId = undefined;
}

function startLoop(): void {
  started = true;
  stopLoop();
  stopMenuBgLoop();  // Entering the game: the menu background loop yields
  rafId = requestAnimationFrame(function tick() {
        // Exception guard: log render exceptions without breaking the rAF chain (prevents a frozen frame)
    try {
      renderFrame();
    } catch (err) {
            sendLog(`render error: ${String((err as Error)?.message || err)}`);
    }
    rafId = requestAnimationFrame(tick);
  });
}

// ===== Main-menu panorama background loop (enabled only when menuBgKind()=panorama) =====
// Equirectangular panorama on a sphere's inner wall; the camera sits fixed at the center rotating slowly around Y (MC main-menu style panning).
// Mutually exclusive with the game loop: renders the panorama while the main menu shows, stops on startLoop; shares the same renderer.
let menuBgRaf = 0;
let menuBgScene: THREE.Scene | null = null;
let menuBgCamera: THREE.PerspectiveCamera | null = null;
let menuBgYaw = 0;
let menuBgLastMs = 0;

function startMenuBgLoop(): void {
  if (menuBgRaf || menuBgKind() !== "panorama") return;  // Already running / non-panorama mode
  if (!menuBgScene) {
        // Lazy init: SphereGeometry's default UV is equirectangular; scale(-1,1,1) flips to the inner wall without mirroring
    menuBgScene = new THREE.Scene();
    const tex = new THREE.TextureLoader().load(resolveTexture("backgrounds/panorama.png"));
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.SphereGeometry(50, 64, 32);
    geo.scale(-1, 1, 1);
    menuBgScene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex })));
    menuBgCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
  }
  menuBgLastMs = performance.now();
  const tick = (): void => {
    const now = performance.now();
    menuBgYaw += Math.min((now - menuBgLastMs) / 1000, 0.1) * 0.03;  // Slow spin ~0.03 rad/s, a full turn in ~3.5 min
    menuBgLastMs = now;
    menuBgCamera!.quaternion.setFromEuler(new THREE.Euler(0, menuBgYaw, 0));
    renderer.render(menuBgScene!, menuBgCamera!);
    menuBgRaf = requestAnimationFrame(tick);
  };
  tick();
}

function stopMenuBgLoop(): void {
  if (!menuBgRaf) return;
  cancelAnimationFrame(menuBgRaf);
  menuBgRaf = 0;
}

sendLog(`BOOT render=rAF(60Hz) winFocused=${winFocused()}`);

// Main menu: black clear as fallback (DOM background/panorama handled by the main-menu background system). Entering the game, startLoop's first render restores the 3D world.
applyUIScale();
renderer.setClearColor(0x000000);
renderer.clear();
mainMenu.show();
startMenuBgLoop();  // panorama mode: sphere panorama render loop (returns immediately when non-panorama)
pointerLock.applyCursor();