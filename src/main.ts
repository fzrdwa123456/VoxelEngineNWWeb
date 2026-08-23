import * as THREE from "three/webgpu";
import { FirstPersonCamera, EYE_HEIGHT } from "./camera";
import { BlockWorld } from "./blocks";
import { Inventory } from "./ui/inventory";
import { Menu } from "./ui/menu";
import { MainMenu } from "./ui/mainmenu";
import { Hud } from "./ui/hud";
import { GamemodeController } from "./ui/gamemode";
import { initBlockEdit } from "./blockedit";
import { PointerLock } from "./pointerlock";
import { t, loadLang, getLang, onLangChange, type Lang } from "./ui/i18n";
import { loadUIScaleMode, getUIScaleMode, onUIScaleModeChange, applyUIScale } from "./ui/uiscale";
import { loadFont, getFontId, onFontChange } from "./ui/fonts";
import { initShell, sendLog, showWindow, getGpuVsyncState, setGpuVsyncState, winFocused, quitApp, onWinFocus, onWinBlur, readSettings, writeSettings, getWindowMode, setWindowMode, applyWindowModeAtStart, onWindowModeChange, type WindowMode } from "./shell";
import { startRawInput, centerCursor } from "./rawinput";
import { DebugLogForwarder } from "./debuglog";
import { PerfSampler } from "./perf";
import { loadBinds, getBind, getBindsAll, onBindsChange, isCapturing, buttonToAction, buttonToCode } from "./keybinds";
import { menuBgKind } from "./ui/background";
import { resolveTexture } from "./textures";
import { loadBlockRegistry } from "./blockregistry";

// 像素字体 (Fusion Pixel, OFL 开源): 比例字体 UI 通用, 等宽字体 F3/数量面板
import "@fontsource/fusion-pixel-12px-proportional-sc";
import "@fontsource/fusion-pixel-12px-monospaced-sc";

initShell();
// 设置: 启动时从 settings.json 载入 (语言/字体/界面缩放/窗口模式/按键绑定, 需在任何 UI 构建前), 变更时写回
loadLang(readSettings().language);
loadFont(readSettings().font);
loadUIScaleMode(readSettings().uiScale);
loadBinds(readSettings().keybinds);
const saveSettings = (): void => {
  // 读-改-写合并, 避免覆盖其他设置项 (windowMode 等)
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

// 方块注册表: 合并所有资源包的 blocks.json (本体=default.zip 条目, 用户包可增改方块), 需在 BlockWorld/物品栏构建前
loadBlockRegistry();

const app = document.getElementById("app")!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
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
// manifest "show": false -> 首帧渲染完成才显示窗口 (防启动闪白)
showWindow();
// 设置里存的是全屏: 进入全屏 (免重启), 并挂 ESC 退出全屏 -> 设置回窗口化的同步
applyWindowModeAtStart();

const fps = new FirstPersonCamera(camera, renderer.domElement, sendLog);

// 原始鼠标输入 (Rust 插件): 窗口半在屏幕外 pointer lock 被 Chromium 取消时接管视角旋转。
// 8ms 定时取走累计增量 (主菜单等停循环期间也持续排空, 防止积压导致进游戏瞬间视角狂转),
// 应用与否由 camera.applyRawInput 内部门控 (锁定态/菜单态丢弃)
const rawInput = startRawInput();
fps.rawInputActive = rawInput.available;
setInterval(() => {
  const d = rawInput.poll();
  if (d.dx !== 0 || d.dy !== 0) fps.applyRawInput(d.dx, d.dy);
}, 8);

const world = new BlockWorld(scene);
// 出生平台: 全部用注册表兜底方块 missing (引擎内置, 永远存在, 紫黑棋盘格)。
// 不再偏好 grass —— 平台语义就是"引擎保底的可站立地面", 与任何 mod 内容解耦;
// 玩家脚下想站什么, 自己放 (注册表第一个方块在物品栏第 1 格)
{
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) {
      world.set(x, 0, z, "missing");
    }
  }
  world.set(2, 0, 0, "missing");
}
fps.setWorld(world);

const hud = new Hud();

// 鼠标锁定管理: 背包/菜单回调都引用, 用 let 声明后赋值, 避免环形依赖
let pointerLock: PointerLock;

// 背包/物品栏 (E 键开关, 打开时暂停游戏并解锁鼠标)
const inv = new Inventory((open) => {
  if (open) {
    fps.prepareUnlock();
    sendLog("UNLOCK 请求 (背包)");
    document.exitPointerLock();
    centerCursor();
    stopLoop();
  } else {
    // 下一轮事件循环再重锁: 避开当前 keydown 事件分发后的 Chromium"ESC 退出锁定"默认动作,
    // 否则背包按 ESC 关闭瞬间的同步锁定会被默认动作立即解锁, 并误触发弹菜单
    setTimeout(() => pointerLock.relock("背包E"), 0);
    startLoop();
  }
  pointerLock.applyCursor();
});
document.addEventListener("keydown", (ev) => {
  if (ev.code === getBind("inventory") && !isCapturing() && !menu.visible && !menu.settingsVisible && !mainMenu.visible) inv.toggle();
});

pointerLock = new PointerLock({
  fps,
  isMenuOpen: () => menu.visible || menu.settingsVisible || mainMenu.visible,
  isInvOpen: () => inv.open,
  sendLog,
});

// 诊断: 记录 pointer lock 状态变化时刻 (锁定/解锁完成), 用于核对光标居中竞态
document.addEventListener("pointerlockchange", () => {
  sendLog(`LOCKCHANGE ${document.pointerLockElement ? "已锁定" : "已解锁"}`);
});

// 设置回调 (暂停菜单/主菜单共用)
const onFpsCap = (cap: number): void => {
  fpsCap = cap;
  sendLog(`FPS上限 已设为 ${cap === 0 ? "不限制" : cap}`);
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
  sendLog(`GPU垂直同步 ${on ? "关闭" : "开启"} ${ok ? "已写入 manifest, 重启生效" : "写入失败"}`);
  return ok;
};

// 窗口模式: 运行时 enter/leaveFullscreen 切换 (免重启), 退出全屏走设置面板"窗口化"
const onSetWindowMode = (mode: WindowMode): void => {
  setWindowMode(mode);
  sendLog(`窗口模式 ${mode === "fullscreen" ? "全屏" : "窗口化"}`);
};

const menu = new Menu({
  onResume: () => {
    // 回到游戏: 重新锁定鼠标 (ESC 后有冷却, 失败自动重试)
    pointerLock.relock("菜单回游戏");
    pointerLock.applyCursor();
    sendLog("RESUME 回到游戏 -> 重锁");
  },
  onFpsCap,
  onToggleGpuVsync,
  getGpuVsyncState: () => getGpuVsyncState(),
  getFpsCap: () => fpsCap,
  getWindowMode: () => getWindowMode(),
  onSetWindowMode,
  onToMainMenu: () => {
    // 回到主菜单: 停循环 + 清成黑色 (背景由主菜单背景系统承担, 进游戏首帧自动恢复 3D)
    started = false;
    stopLoop();
    renderer.setClearColor(0x000000);
    renderer.clear();
    mainMenu.show();
    startMenuBgLoop(); // panorama 模式: 重新起全景循环
    pointerLock.applyCursor();
    sendLog("MENU 回到主菜单");
  },
});

// 主界面: 单人模式进入游戏; 多人模式占位; 设置/退出
const mainMenu = new MainMenu({
  onStartSingle: () => {
    mainMenu.hide();
    pointerLock.applyCursor();
    pointerLock.relock("主菜单进游戏");
    startLoop();
    sendLog("MAINMENU 进入单人模式");
  },
  onMultiplayer: () => {
    hud.showToast(t("toast.multiPlaceholder"));
    sendLog("MAINMENU 多人模式（占位）");
  },
  onExit: () => {
    sendLog("MAINMENU 退出游戏");
    quitApp();
  },
  getFpsCap: () => fpsCap,
  onFpsCap,
  getGpuVsyncState,
  onToggleGpuVsync,
  getWindowMode,
  onSetWindowMode,
});

// 窗口离开前台 (最小化/切走/点击其他窗口): 立即弹暂停菜单 (仅真在游玩时)。
// 重新聚焦: 游玩中且无任何界面则自动重锁 (MC 行为: 菜单开着不自动关, 需手动继续)。
onWinBlur(() => {
  fps.prepareUnlock();
  if (document.pointerLockElement) document.exitPointerLock();
  if (started && !mainMenu.visible && !menu.visible && !menu.settingsVisible && !inv.open) {
    menu.show();
    pointerLock.applyCursor();
    sendLog("BLUR 失焦 -> 弹暂停菜单");
  }
});
onWinFocus(() => {
  if (started && !mainMenu.visible && !menu.visible && !menu.settingsVisible && !inv.open && !fps.locked) {
    pointerLock.relock("窗口聚焦");
    sendLog("FOCUS 聚焦 -> 重锁");
  }
});

// ESC: NW.js 0.112 (#7907) 官方已实现 —— ESC 事件正常到达渲染层,
// keydown 里 preventDefault() 可保持 pointer lock, 且 1.25s 重锁冷却已移除。
// (旧 Electron 版需 launcher 钩子吞键 + stdin 管道 + IPC 的"接口后门", 此处已废弃)
document.addEventListener("keydown", (ev) => {
  if (ev.code !== "Escape") return;
  ev.preventDefault(); // #7907: 拦截默认退出锁定, 由我们控制弹菜单/关菜单
  sendLog(
    `ESC mainMenu=${mainMenu.visible} menu=${menu.visible} settings=${menu.settingsVisible} ` +
      `lang=${menu.langVisible} pack=${menu.packVisible} keybind=${menu.keybindVisible} capturing=${isCapturing()}`,
  );
  if (mainMenu.visible) {
    // 主界面: ESC 在任意子面板/设置面板里逐级返回, 其余忽略
    if (mainMenu.settingsVisible || mainMenu.langVisible || mainMenu.packVisible || mainMenu.keybindVisible) mainMenu.goBack();
    return;
  }
  if (inv.open) {
    inv.close();
  } else if (menu.settingsVisible || menu.langVisible || menu.packVisible || menu.keybindVisible) {
    menu.goBack();
  } else if (menu.visible) {
    menu.hide();
    pointerLock.relock("ESC关菜单"); // 无冷却, 立即重锁
  } else {
    // 游戏内: 直接弹菜单 + 释放鼠标 (光标未捕获也能暂停)
    fps.prepareUnlock();
    sendLog("UNLOCK 请求 (菜单)");
    document.exitPointerLock();
    menu.show();
    centerCursor();
  }
  pointerLock.applyCursor();
});

// F3+F4 游戏模式切换 + F3 调试面板 (构造时自注册键盘监听)
new GamemodeController(hud, fps, sendLog);

// 左键破坏 / 右键放置
initBlockEdit({ fps, world, camera, inv, sendLog });

// ===== 鼠标键集中分发: 绑定到鼠标的动作从这里获得物理触发 =====
// 移动/跳跃/潜行 → 伪码注入相机按键状态 (keyup 时释放); 背包 → 开关;
// 破坏/放置跳过 (blockedit 有专用 mousedown 通道, 避免双重触发)
document.addEventListener("mousedown", (ev) => {
  if (isCapturing()) return; // 换绑选中期间不误触发
  const action = buttonToAction(ev.button);
  if (!action || action === "break" || action === "place") return;
  const code = buttonToCode(ev.button)!;
  if (action === "inventory") {
    if (!menu.visible && !menu.settingsVisible && !mainMenu.visible) inv.toggle();
    return;
  }
  fps.bindPress(code);
});
document.addEventListener("mouseup", (ev) => {
  const code = buttonToCode(ev.button);
  if (!code) return;
  const action = buttonToAction(ev.button);
  if (!action || action === "break" || action === "place" || action === "inventory") return;
  fps.bindRelease(code);
});

scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const dir = new THREE.DirectionalLight(0xffffff, 1);
dir.position.set(5, 10, 7);
scene.add(dir);

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
timer.connect(document); // Page Visibility API: 最小化/后台时 delta=0, 恢复自动重置

// 渲染循环: 恒定 requestAnimationFrame (60Hz 显示器最优, 帧送达稳定平滑)
let rafId = 0;
let timerId: ReturnType<typeof setTimeout> | undefined;
let started = false;
// 固定步长物理: 步长与时间累加器 (与帧时序解耦, MC 式固定 tps)
const PHYS_DT = 1 / 120;
let physAcc = 0;
// FPS 上限 (0=不限制): 物理仍按固定步长推进, 只门控渲染与统计
let fpsCap = 0;
let renderAcc = 0;
// 性能采样 + 调试日志转发 (实现见各自模块)
const perf = new PerfSampler();
const dbgFwd = new DebugLogForwarder();

function renderFrame(): void {
  timer.update();
  const delta = Math.min(timer.getDelta(), 0.1);

  // 固定步长推进物理: 移动量与帧时长无关, 每步恒定 (消除帧时序不均导致的移动抖动)
  physAcc += delta;
  let steps = 0;
  while (physAcc >= PHYS_DT && steps < 12) {
    fps.stepPhysics(PHYS_DT);
    physAcc -= PHYS_DT;
    steps++;
  }
  // 渲染插值: 相机位置在上一物理态与当前物理态间插值, 帧到达不均也平滑
  fps.syncCamera(Math.min(physAcc / PHYS_DT, 1));

  // FPS 上限门控: 未到帧率预算则跳过渲染与统计 (物理已在上方按固定步长推进)
  if (fpsCap > 0) {
    const budget = 1 / fpsCap;
    renderAcc += delta;
    if (renderAcc < budget) return;
    renderAcc %= budget;
  }

  const s = perf.sample(delta);
  if (s) {
    const p = fps.position;
    const feet = p.y - EYE_HEIGHT;
    const top = fps.groundTop();
    sendLog(
      `PHYS 模式=${fps.mode} 地面=${fps.onGround} vy=${fps.vy.toFixed(2)} ` +
        `feet=${feet.toFixed(4)} 顶=${Number.isFinite(top) ? top.toFixed(4) : "无"} ` +
        `差=${Number.isFinite(top) ? (feet - top).toFixed(4) : "-"} ` +
        `差e=${Number.isFinite(top) ? (feet - top).toExponential(2) : "-"} ` +
        `xyz=${p.x.toFixed(2)}/${p.y.toFixed(2)}/${p.z.toFixed(2)}`,
    );

    // 诊断队列增量转发 (SPACE/MOUSE, 实现在 debuglog.ts)
    dbgFwd.forward(fps);

    // 读取 GPU 真实渲染耗时 (ms, 最近一帧总渲染 pass 时间), EMA 平滑在 perf.ts
    renderer
      .resolveTimestampsAsync("render")
      .then((ms) => {
        if (typeof ms === "number" && ms > 0) perf.noteGpu(ms);
      })
      .catch(() => {});

    // F3 调试面板 (Hud 内部按需显示)
    hud.updateDebug({
      fps: s.fps,
      fpsCap,
      x: p.x,
      y: p.y,
      z: p.z,
      blocks: world.meshes().length,
      gpuMs: s.gpuMs,
      mode: fps.mode,
      onGround: fps.onGround,
      vy: fps.vy,
      feet,
      top: Number.isFinite(top) ? top : null,
      logs: [
        { label: t("f3.logMouse"), lines: fps.mouseLog },
        { label: t("f3.logSpace"), lines: fps.spaceLog },
      ],
    });
  }

  renderer.render(scene, camera);
}

function stopLoop(): void {
  cancelAnimationFrame(rafId);
  if (timerId !== undefined) clearInterval(timerId);
  timerId = undefined;
}

function startLoop(): void {
  started = true;
  stopLoop();
  stopMenuBgLoop(); // 进游戏: 菜单背景循环让位
  rafId = requestAnimationFrame(function tick() {
    renderFrame();
    rafId = requestAnimationFrame(tick);
  });
}

// ===== 主菜单全景背景循环 (仅 menuBgKind()=panorama 时启用) =====
// 球体内壁贴等距柱状全景图, 相机固定球心绕 Y 轴慢转 (MC 主菜单式环视)。
// 与游戏循环互斥: 主菜单显示期间渲染全景, startLoop 时停; 共用同一个 renderer。
let menuBgRaf = 0;
let menuBgScene: THREE.Scene | null = null;
let menuBgCamera: THREE.PerspectiveCamera | null = null;
let menuBgYaw = 0;
let menuBgLastMs = 0;

function startMenuBgLoop(): void {
  if (menuBgRaf || menuBgKind() !== "panorama") return; // 已在跑 / 非 panorama 模式
  if (!menuBgScene) {
    // 懒初始化: SphereGeometry 默认 UV 即等距柱状映射; scale(-1,1,1) 翻转到内壁且不镜像
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
    menuBgYaw += Math.min((now - menuBgLastMs) / 1000, 0.1) * 0.03; // 慢转 ~0.03 rad/s, 一圈约 3.5 分钟
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

sendLog(`BOOT 渲染=rAF(60Hz) world=${world.meshes().length} 方块 winFocused=${winFocused()}`);

// 主界面: 黑色清屏兜底 (DOM 背景/全景由主菜单背景系统承担)。进游戏 startLoop 首帧 render 自动恢复 3D 世界。
applyUIScale();
renderer.setClearColor(0x000000);
renderer.clear();
mainMenu.show();
startMenuBgLoop(); // panorama 模式: 球体全景渲染循环 (非 panorama 内部直接返回)
pointerLock.applyCursor();