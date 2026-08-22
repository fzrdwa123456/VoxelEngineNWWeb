// ===== 暂停菜单 + 共享设置面板 (帧率上限/垂直同步/语言/界面缩放/窗口模式), 主菜单也复用设置面板 =====
import { t, getLang, setLang, onLangChange } from "./i18n";
import { getUIScaleMode, setUIScaleMode, onUIScaleModeChange, onResizeMerged, getCurrentScale, uiStage } from "./uiscale";
import { getFontId, setFontId, onFontChange, type FontId } from "./fonts";
import { listPacks } from "../textures";
import { onWindowModeChange, type WindowMode, sendLog } from "../shell";
import { getBind, setBind, beginCapture, endCapture, getCapturing, onBindsChange, codeDisplayName, codeToButton, buttonToCode, type BindAction } from "../keybinds";

// 按键绑定面板渲染器注册表: buildSettingsPanel 会被暂停菜单/主菜单各实例化一次,
// 各自持有独立的 DOM 与 renderBinds。文档级键盘捕获监听器是共享状态,
// 必须让所有实例一起重绘 —— 否则会刷到隐藏面板, 可见面板芯片停留在选中态 (跨实例失同步 bug)
const keybindRenderers = new Set<() => void>();

// ===== 键帽全局注册表与免捕获拖拽绑定 (跨面板实例, 模块级) =====
// 全局键帽注册表: 两套面板 DOM 各自注册, elementFromPoint 命中的是可见实例的元素,
// 落点探测/hover 必须查这张跨实例表 —— 只查单实例闭包内的表会全部落空
const capRegistry: { code: string; el: HTMLButtonElement }[] = [];

// 免捕获拖拽绑定状态: 按住互动按钮直接拖到键帽上松开即绑定, 无需先点选进入捕获态。
// 左右键都可起手; button 记录发起键 —— 进行中另一只键的按下/松开必须被无视 (防打断/误绑)。
// 位移超过阈值判定为拖拽; 普通点击仍走原生 click 的选中切换
let chipDrag: {
  action: BindAction;
  button: number;
  anchorX: number;
  anchorY: number;
  moved: boolean;
} | null = null;
let capHoverEl: HTMLButtonElement | null = null;

function showCapLine(x1: number, y1: number, x2: number, y2: number): void {
  let svg = document.getElementById("cap-line-svg") as SVGSVGElement | null;
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "cap-line-svg";
    svg.setAttribute(
      "style",
      "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;display:none;",
    );
    const lineEl = document.createElementNS("http://www.w3.org/2000/svg", "line");
    lineEl.setAttribute("stroke", "#4a9eff");
    lineEl.setAttribute("stroke-width", "2");
    lineEl.setAttribute("stroke-linecap", "round");
    svg.appendChild(lineEl);
    document.body.appendChild(svg);
  }
  svg.style.display = "block";
  const line = svg.querySelector("line") as SVGLineElement;
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
}

function hideCapLine(): void {
  const svg = document.getElementById("cap-line-svg");
  if (svg) svg.style.display = "none";
  if (capHoverEl) {
    capHoverEl.style.outline = "";
    capHoverEl = null;
  }
}

/** 落点探测: 命中任意实例注册的键帽, 返回码与实际命中的键帽元素。
 *  高亮必须用这里带回的 el —— 按 code 回查会命中注册顺序靠前的隐藏面板孪生键帽 */
function capHitAtPoint(x: number, y: number): { code: string; el: HTMLButtonElement } | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  for (const c of capRegistry) {
    if (c.el === el || c.el.contains(el)) return { code: c.code, el: c.el };
  }
  return null;
}

// 捕获态吞掉一切合成 click: 物理按下已经作为输入完成绑定,
// 其后浏览器合成的 click 不得再触发任何面板交互 (芯片重选/键帽点选/返回按钮)。
// 注意: 捕获态在 mousedown 阶段就已结束, 合成 click 到达时状态已空 ——
// 因此还需要一次性抑制标志 suppressNextClick 配合 (onCaptureMouseDown 设置)。
// chipDrag = 免捕获拖拽进行中: 同样吞掉一切点击 (防止另一只键的点击误触芯片/返回)。
// 捕获相位注册: 先于所有元素自身的 onclick 执行; 两者皆无时零影响。
let suppressNextClick = false;

// 置位一次性吞除标志。清零时机按置位时机分两路:
// - mousedown 置位 (捕获态绑定): 不能当场排 timeout —— 用户按住期间 timeout 会先于
//   click 到期, 标志被提前清掉导致合成 click 放行、芯片自动重进捕获态 (回归)。
//   由下面的全局 mouseup 兜底在松手后排队清零。
// - mouseup 置位 (拖拽松手): 当场排 timeout —— 合成 click 紧随 mouseup 同步派发、
//   先于 timeout 消费; 多键/无 click 路径由 timeout 清零。全局兜底监听器在拖拽
//   处理器之前注册, 本次 mouseup 看到的还是旧值, 帮不上忙, 必须自己排。
function armSuppressNextClick(schedSelf: boolean): void {
  suppressNextClick = true;
  if (schedSelf) {
    setTimeout(() => {
      suppressNextClick = false;
    }, 0);
  }
}

// 松手后兜底 (仅捕获态路径需要): 标志在 mousedown 置位, 松手时若仍活着
// (无合成 click 可消费, 如拖拽中按过第二个鼠标键破坏了 Chromium 的 click 合成),
// 0ms 定时器清掉, 防止残留标志吞掉下一次真实点击
document.addEventListener("mouseup", () => {
  if (!suppressNextClick) return;
  setTimeout(() => {
    suppressNextClick = false;
  }, 0);
});
document.addEventListener(
  "click",
  (ev) => {
    if (getCapturing() || chipDrag || suppressNextClick) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (!chipDrag) suppressNextClick = false; // 消费即清 (拖拽中不消费, 保持原语义)
    }
  },
  true,
);

// 免捕获芯片拖拽: 全局单份 move/up 处理 (元素级 mousedown 只负责记录起点)
document.addEventListener("mousemove", (ev) => {
  if (!chipDrag) return;
  if (
    !chipDrag.moved &&
    Math.hypot(ev.clientX - chipDrag.anchorX, ev.clientY - chipDrag.anchorY) < 6
  ) {
    return; // 阈值内视为普通点击
  }
  chipDrag.moved = true;
  showCapLine(chipDrag.anchorX, chipDrag.anchorY, ev.clientX, ev.clientY);
  const hit = capHitAtPoint(ev.clientX, ev.clientY);
  const hitEl = hit?.el ?? null;
  if (capHoverEl !== hitEl) {
    if (capHoverEl) capHoverEl.style.outline = "";
    capHoverEl = hitEl;
    if (capHoverEl) capHoverEl.style.outline = "2px solid #fff";
  }
});

document.addEventListener("mouseup", (ev) => {
  if (!chipDrag) return;
  if (ev.button !== chipDrag.button) return; // 非发起键的松开: 无视, 不打断进行中的拖拽
  const { action, anchorX, anchorY } = chipDrag;
  chipDrag = null;
  hideCapLine();
  const dragged = Math.hypot(ev.clientX - anchorX, ev.clientY - anchorY) >= 6;
  if (!dragged) return; // 普通点击: 交给原生 click 走选中切换
  armSuppressNextClick(true); // mouseup 置位: 当场排 timeout 兜底 (合成 click 先到先消费)
  if (getCapturing()) return; // 拖拽中途进入了捕获态(异常路径), 放弃绑定
  const code = capHitAtPoint(ev.clientX, ev.clientY)?.code ?? null;
  sendLog(`KBCAP 拖拽松手 action=${action} code=${code ?? "未命中"}`);
  if (!code) return; // 空白处松开: 无操作
  setBind(action, code);
  let panels = 0;
  keybindRenderers.forEach((r) => {
    r();
    panels++;
  });
  sendLog(`KBCAP 拖拽绑定完成 (${code}, panels=${panels})`);
});

// 捕获态 / 免捕获拖拽进行中: 禁止一切滚轮滚动 (防止绑定选项列表位置漂移干扰操作)。
// passive:false 必须显式声明 —— Chrome 对 document 级 wheel 监听默认被动化, 否则 preventDefault 无效
document.addEventListener(
  "wheel",
  (ev) => {
    if (getCapturing() || chipDrag) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  },
  { passive: false },
);

export interface SettingsCallbacks {
  getFpsCap: () => number;
  onFpsCap: (cap: number) => void;
  getGpuVsyncState: () => boolean;
  onToggleGpuVsync: (on: boolean) => boolean;
  getWindowMode: () => WindowMode;
  onSetWindowMode: (mode: WindowMode) => void;
}

// 暂停菜单回调: 设置面板六项 + 回到游戏/回到主菜单
export interface MenuCallbacks extends SettingsCallbacks {
  onResume: () => void;
  onToMainMenu: () => void;
}

// 共享设置面板: 帧率上限滑条 + 垂直同步开关 + 语言合集 + 资源包合集 + 按键绑定 + 窗口模式 + 界面缩放 + 返回 (暂停菜单/主菜单共用)
// 返回 { settingsPanel, langPanel, packPanel, keybindPanel } 四个面板, 调用方挂到同一根容器切换显示
export function buildSettingsPanel(
  opts: SettingsCallbacks & { onBack: () => void },
): { settingsPanel: HTMLDivElement; langPanel: HTMLDivElement; packPanel: HTMLDivElement; keybindPanel: HTMLDivElement } {
  const btnStyle =
    "display:block;width:100%;padding:0.625rem;margin:0.375rem 0;font:0.9375rem var(--font-ui);color:#fff;" +
    "background:#444;border:none;border-radius:0.375rem;cursor:pointer;";

  const settingsPanel = document.createElement("div");
  settingsPanel.style.cssText =
    "width:17.5rem;background:#222;border-radius:0.625rem;padding:1.25rem;text-align:center;color:#fff;" +
    "font:1rem var(--font-ui);box-shadow:0 0.25rem 1.25rem rgba(0,0,0,.5);display:none;";

  const sTitle = document.createElement("div");
  sTitle.style.cssText = "font-size:1.375rem;margin-bottom:0.875rem;";
  settingsPanel.appendChild(sTitle);

  const capLabel = document.createElement("div");
  capLabel.style.cssText = "text-align:left;font-size:0.9375rem;margin:0.5rem 0 0.25rem;";
  settingsPanel.appendChild(capLabel);

  const capValue = document.createElement("div");
  capValue.style.cssText =
    "text-align:center;font-size:1.25rem;font-weight:600;color:#fff;margin:0.125rem 0 0.375rem;";
  settingsPanel.appendChild(capValue);

  const CAP_MIN = 30;
  const CAP_MAX = 240; // 拉满 = 无限
  const capSlider = document.createElement("input");
  capSlider.type = "range";
  capSlider.min = String(CAP_MIN);
  capSlider.max = String(CAP_MAX);
  capSlider.step = "2";
  capSlider.value = String(Math.max(CAP_MIN, Math.min(CAP_MAX, opts.getFpsCap() || CAP_MAX)));
  capSlider.style.cssText = "width:100%;margin:0 0 0.625rem;accent-color:#4a9eff;cursor:pointer;";
  const renderCap = (): void => {
    capValue.textContent = Number(capSlider.value) >= CAP_MAX ? t("settings.unlimited") : `${capSlider.value} FPS`;
  };
  capSlider.oninput = () => {
    renderCap();
    opts.onFpsCap(Number(capSlider.value) >= CAP_MAX ? 0 : Number(capSlider.value));
  };
  settingsPanel.appendChild(capSlider);

  let gpuVsyncOn = opts.getGpuVsyncState();
  const gpuBtn = document.createElement("button");
  gpuBtn.style.cssText = btnStyle;
  gpuBtn.onmouseover = () => (gpuBtn.style.background = "#555");
  gpuBtn.onmouseout = () => (gpuBtn.style.background = "#444");
  const renderGpuBtn = (): void => {
    gpuBtn.textContent = gpuVsyncOn ? t("settings.vsyncOff") : t("settings.vsyncOn");
  };
  gpuBtn.onclick = () => {
    const next = !gpuVsyncOn;
    if (opts.onToggleGpuVsync(next)) {
      gpuVsyncOn = next;
      renderGpuBtn();
    }
  };
  settingsPanel.appendChild(gpuBtn);

  // 语言与字体合集: 按钮进入子面板 (左: 语言, 右: 字体)
  const langBtn = document.createElement("button");
  langBtn.style.cssText = btnStyle;
  langBtn.onmouseover = () => (langBtn.style.background = "#555");
  langBtn.onmouseout = () => (langBtn.style.background = "#444");
  langBtn.onclick = () => {
    settingsPanel.style.display = "none";
    langPanel.style.display = "block";
  };
  settingsPanel.appendChild(langBtn);

  // 语言与字体子面板: 左右双栏, 与设置面板同级切换
  const langPanel = document.createElement("div");
  langPanel.style.cssText =
    "width:34rem;background:#222;border-radius:0.625rem;padding:1.25rem;text-align:center;color:#fff;" +
    "font:1rem var(--font-ui);box-shadow:0 0.25rem 1.25rem rgba(0,0,0,.5);display:none;";

  const langTitle = document.createElement("div");
  langTitle.style.cssText = "font-size:1.375rem;margin-bottom:0.875rem;";
  langPanel.appendChild(langTitle);

  const choiceWrap = document.createElement("div");
  choiceWrap.style.cssText = "display:flex;gap:1.25rem;margin-bottom:0.875rem;";
  langPanel.appendChild(choiceWrap);

  const colStyle = "flex:1;text-align:left;";
  const colLabelStyle = "font-size:0.9375rem;color:#bbb;margin-bottom:0.5rem;";
  const langChoiceStyle =
    "display:block;width:100%;padding:0.625rem;margin:0.375rem 0;font:0.9375rem var(--font-ui);color:#fff;" +
    "background:#444;border:none;border-radius:0.375rem;cursor:pointer;text-align:center;";

  // 左栏: 语言
  const langCol = document.createElement("div");
  langCol.style.cssText = colStyle;
  const langColLabel = document.createElement("div");
  langColLabel.style.cssText = colLabelStyle;
  langCol.appendChild(langColLabel);
  const zhBtn = document.createElement("button");
  zhBtn.style.cssText = langChoiceStyle;
  zhBtn.onmouseover = () => (zhBtn.style.background = getLang() === "zh" ? "#3b83d6" : "#555");
  zhBtn.onmouseout = () => (zhBtn.style.background = getLang() === "zh" ? "#4a9eff" : "#444");
  zhBtn.onclick = () => setLang("zh");
  langCol.appendChild(zhBtn);
  const enBtn = document.createElement("button");
  enBtn.style.cssText = langChoiceStyle;
  enBtn.onmouseover = () => (enBtn.style.background = getLang() === "en" ? "#3b83d6" : "#555");
  enBtn.onmouseout = () => (enBtn.style.background = getLang() === "en" ? "#4a9eff" : "#444");
  enBtn.onclick = () => setLang("en");
  langCol.appendChild(enBtn);
  const jaBtn = document.createElement("button");
  jaBtn.style.cssText = langChoiceStyle;
  jaBtn.onmouseover = () => (jaBtn.style.background = getLang() === "ja" ? "#3b83d6" : "#555");
  jaBtn.onmouseout = () => (jaBtn.style.background = getLang() === "ja" ? "#4a9eff" : "#444");
  jaBtn.onclick = () => setLang("ja");
  langCol.appendChild(jaBtn);
  choiceWrap.appendChild(langCol);

  // 右栏: 字体
  const fontCol = document.createElement("div");
  fontCol.style.cssText = colStyle;
  const fontColLabel = document.createElement("div");
  fontColLabel.style.cssText = colLabelStyle;
  fontCol.appendChild(fontColLabel);
  const fontChoiceStyle = langChoiceStyle;
  const mkFontBtn = (id: FontId): HTMLButtonElement => {
    const b = document.createElement("button");
    b.style.cssText = fontChoiceStyle;
    b.onmouseover = () => (b.style.background = getFontId() === id ? "#3b83d6" : "#555");
    b.onmouseout = () => (b.style.background = getFontId() === id ? "#4a9eff" : "#444");
    b.onclick = () => setFontId(id);
    return b;
  };
  const pixelBtn = mkFontBtn("pixel");
  const systemBtn = mkFontBtn("system");
  fontCol.appendChild(pixelBtn);
  fontCol.appendChild(systemBtn);
  choiceWrap.appendChild(fontCol);

  // 按当前语言/字体刷新高亮 (切换后立即重绘)
  const renderLang = (): void => {
    zhBtn.style.background = getLang() === "zh" ? "#4a9eff" : "#444";
    enBtn.style.background = getLang() === "en" ? "#4a9eff" : "#444";
    jaBtn.style.background = getLang() === "ja" ? "#4a9eff" : "#444";
  };
  const renderFont = (): void => {
    pixelBtn.style.background = getFontId() === "pixel" ? "#4a9eff" : "#444";
    systemBtn.style.background = getFontId() === "system" ? "#4a9eff" : "#444";
  };

  const langBackBtn = document.createElement("button");
  langBackBtn.style.cssText = btnStyle;
  langBackBtn.onmouseover = () => (langBackBtn.style.background = "#555");
  langBackBtn.onmouseout = () => (langBackBtn.style.background = "#444");
  langBackBtn.onclick = () => {
    langPanel.style.display = "none";
    settingsPanel.style.display = "block";
  };
  langPanel.appendChild(langBackBtn);

  // 资源包合集: 按钮进入资源包子面板 (列出 game\resourcepacks\ 下的包)
  const packBtn = document.createElement("button");
  packBtn.style.cssText = btnStyle;
  packBtn.onmouseover = () => (packBtn.style.background = "#555");
  packBtn.onmouseout = () => (packBtn.style.background = "#444");
  packBtn.onclick = () => {
    settingsPanel.style.display = "none";
    packPanel.style.display = "block";
    renderPacks();
  };
  settingsPanel.appendChild(packBtn);

  // 资源包子面板: 列出 resourcepacks 目录下的资源包 (内置 default.zip + 用户 zip/文件夹)
  const packPanel = document.createElement("div");
  packPanel.style.cssText =
    "width:17.5rem;background:#222;border-radius:0.625rem;padding:1.25rem;text-align:center;color:#fff;" +
    "font:1rem var(--font-ui);box-shadow:0 0.25rem 1.25rem rgba(0,0,0,.5);display:none;";

  const packTitle = document.createElement("div");
  packTitle.style.cssText = "font-size:1.375rem;margin-bottom:0.875rem;";
  packPanel.appendChild(packTitle);

  const packList = document.createElement("div");
  packList.style.cssText = "max-height:12.5rem;overflow-y:auto;margin-bottom:0.375rem;";
  packPanel.appendChild(packList);

  const packEmpty = document.createElement("div");
  packEmpty.style.cssText = "font-size:0.9375rem;color:#999;padding:0.5rem 0;";
  packPanel.appendChild(packEmpty);

  const renderPacks = (): void => {
    packList.textContent = "";
    const packs = listPacks();
    packEmpty.style.display = packs.length ? "none" : "block";
    packEmpty.textContent = t("settings.packsEmpty");
    for (const p of packs) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0.625rem;margin:0.25rem 0;" +
        "background:#333;border-radius:0.375rem;font-size:0.875rem;";
      const name = document.createElement("span");
      name.textContent = p.name;
      name.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      const meta = document.createElement("span");
      meta.style.cssText = "flex-shrink:0;margin-left:0.5rem;color:#aaa;font-size:0.75rem;";
      meta.textContent = `${p.builtin ? t("settings.packsBuiltin") + " · " : ""}${p.fileCount}`;
      row.append(name, meta);
      packList.appendChild(row);
    }
  };

  const packBackBtn = document.createElement("button");
  packBackBtn.style.cssText = btnStyle;
  packBackBtn.onmouseover = () => (packBackBtn.style.background = "#555");
  packBackBtn.onmouseout = () => (packBackBtn.style.background = "#444");
  packBackBtn.onclick = () => {
    packPanel.style.display = "none";
    settingsPanel.style.display = "block";
  };
  packPanel.appendChild(packBackBtn);

  // 按键绑定: 按钮进入子面板 (各动作一行, 点击换绑, Esc 取消)
  const keybindBtn = document.createElement("button");
  keybindBtn.style.cssText = btnStyle;
  keybindBtn.onmouseover = () => (keybindBtn.style.background = "#555");
  keybindBtn.onmouseout = () => (keybindBtn.style.background = "#444");
  keybindBtn.onclick = () => {
    settingsPanel.style.display = "none";
    keybindPanel.style.display = "block";
    renderBinds();
  };
  settingsPanel.appendChild(keybindBtn);

  // 按键绑定子面板: 动作芯片 + 可视化键盘 (完整 104 键 ANSI 布局, 固定 QWERTY 参照几何 = KeyboardEvent.code 物理位置)
  // 交互: 点动作芯片选中 → 点键盘按键完成绑定; 冲突抢占由 setBind 处理
  const keybindPanel = document.createElement("div");
  keybindPanel.style.cssText =
    "width:40rem;background:#222;border-radius:0.625rem;padding:1.25rem;text-align:center;color:#fff;" +
    "font:1rem var(--font-ui);box-shadow:0 0.25rem 1.25rem rgba(0,0,0,.5);display:none;";

  const kbTitle = document.createElement("div");
  kbTitle.style.cssText = "font-size:1.375rem;margin-bottom:0.375rem;";
  keybindPanel.appendChild(kbTitle);

  const kbHint = document.createElement("div");
  kbHint.style.cssText = "font-size:0.75rem;color:#999;margin-bottom:0.625rem;";
  keybindPanel.appendChild(kbHint);

  // 动作芯片行: 显示动作名+当前键, 点击选中/取消
  const KB_ACTIONS: { action: BindAction; labelKey: string }[] = [
    { action: "forward", labelKey: "bind.forward" },
    { action: "back", labelKey: "bind.back" },
    { action: "left", labelKey: "bind.left" },
    { action: "right", labelKey: "bind.right" },
    { action: "jump", labelKey: "bind.jump" },
    { action: "sneak", labelKey: "bind.sneak" },
    { action: "inventory", labelKey: "bind.inventory" },
    { action: "break", labelKey: "bind.break" },
    { action: "place", labelKey: "bind.place" },
  ];

  // 左右两栏: 左=键盘板 (主区+导航区+下方小键盘横排), 右=互动按钮竖排栏 (固定上限高度, 内部滚动)
  const kbFlex = document.createElement("div");
  kbFlex.style.cssText = "display:flex;gap:0.75rem;align-items:flex-start;margin-bottom:0.625rem;";
  keybindPanel.appendChild(kbFlex);

  const kbBoard = document.createElement("div");
  kbBoard.style.cssText = "flex:1 1 auto;min-width:0;user-select:none;";
  kbFlex.appendChild(kbBoard);

  const kbSide = document.createElement("div");
  kbSide.style.cssText =
    "width:11rem;flex-shrink:0;max-height:20rem;display:flex;flex-direction:column;gap:0.375rem;" +
    "background:#1a1a1a;border-radius:0.5rem;padding:0.625rem;overflow:hidden;";
  kbFlex.appendChild(kbSide);

  // 标题 + 滚动芯片列表 (高度跟随左板, 动作增多时内部滚动不撑破面板)
  const kbSideTitle = document.createElement("div");
  kbSideTitle.style.cssText = "font-size:0.9375rem;color:#bbb;text-align:center;";
  kbSide.appendChild(kbSideTitle);

  const chipList = document.createElement("div");
  chipList.id = "kb-chip-list";
  chipList.style.cssText =
    "flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:0.375rem;padding-right:0.5rem;";
  kbSide.appendChild(chipList);

  // 细滚动条样式 (全局只注入一次)
  if (!document.getElementById("kb-chip-scrollbar")) {
    const st = document.createElement("style");
    st.id = "kb-chip-scrollbar";
    st.textContent =
      "#kb-chip-list::-webkit-scrollbar{width:6px}" +
      "#kb-chip-list::-webkit-scrollbar-thumb{background:#444;border-radius:3px}" +
      "#kb-chip-list::-webkit-scrollbar-track{background:transparent}";
    document.head.appendChild(st);
  }

  const chipStyle =
    "width:100%;padding:0.4375rem 0.625rem;font:0.8125rem var(--font-ui);color:#fff;border:none;" +
    "border-radius:0.3125rem;cursor:pointer;background:#444;text-align:center;";
  const kbChips = new Map<BindAction, HTMLButtonElement>();
  for (const { action } of KB_ACTIONS) {
    const chip = document.createElement("button");
    chip.style.cssText = chipStyle;
    chip.dataset.action = action; // 免捕获拖拽的落点识别标记
    // 拖拽起点: 按住互动按钮移动超过阈值即进入免捕获拖拽绑定
    chip.addEventListener("mousedown", (ev) => {
      // 捕获态: 放行冒泡到 document 的即时绑定处理器 (左/右键都能绑);
      // 拖拽进行中: 忽略其他按键起手 (防劫持覆盖) —— 不掐断事件, 不影响任何下游
      if (getCapturing() || chipDrag) return;
      if (ev.button !== 0) return; // 仅左键可发起拖拽 (右键拖拽已移除)
      ev.preventDefault(); // 防止拖动时选中文字
      chipDrag = { action, button: ev.button, anchorX: ev.clientX, anchorY: ev.clientY, moved: false };
    });
    chip.onclick = () => {
      sendLog(`KBCAP 点击互动按钮 action=${action} capturing=${getCapturing() ?? "null"}`);
      if (getCapturing() === action) endCapture();
      else beginCapture(action);
      renderBinds();
    };
    chipList.appendChild(chip);
    kbChips.set(action, chip);
  }

  // 可视键盘主区: [code, 宽度单位u], code="" 为空占位。
  // 每行合计 18.5u (主区15 + 间隔0.5 + 导航区3), flex-grow 按比例分宽
  const KB_ROWS: [string, number][][] = [
    // 功能键行 (PrtSc 组已移到底部右侧塔)
    [["Escape",1],["",1],["F1",1],["F2",1],["F3",1],["F4",1],["",0.5],["F5",1],["F6",1],["F7",1],["F8",1],["",0.5],["F9",1],["F10",1],["F11",1],["F12",1]],
    // 主区数字行 (导航区已移到底部右侧塔)
    [["Backquote",1],["Digit1",1],["Digit2",1],["Digit3",1],["Digit4",1],["Digit5",1],["Digit6",1],["Digit7",1],["Digit8",1],["Digit9",1],["Digit0",1],["Minus",1],["Equal",1],["Backspace",2]],
    // Tab 行
    [["Tab",1.5],["KeyQ",1],["KeyW",1],["KeyE",1],["KeyR",1],["KeyT",1],["KeyY",1],["KeyU",1],["KeyI",1],["KeyO",1],["KeyP",1],["BracketLeft",1],["BracketRight",1],["Backslash",1.5]],
    // Caps 行
    [["CapsLock",1.75],["KeyA",1],["KeyS",1],["KeyD",1],["KeyF",1],["KeyG",1],["KeyH",1],["KeyJ",1],["KeyK",1],["KeyL",1],["Semicolon",1],["Quote",1],["Enter",2.25]],
    // Shift 行 (方向键已移到底部区)
    [["ShiftLeft",2.25],["KeyZ",1],["KeyX",1],["KeyC",1],["KeyV",1],["KeyB",1],["KeyN",1],["KeyM",1],["Comma",1],["Period",1],["Slash",1],["ShiftRight",2.75]],
    // 底行 (方向键已移到底部区)
    [["ControlLeft",1.25],["MetaLeft",1.25],["AltLeft",1.25],["Space",6.25],["AltRight",1.25],["MetaRight",1.25],["ContextMenu",1.25],["ControlRight",1.25]],
  ];

  const capMainStyle =
    "font-family:var(--font-ui);font-size:0.6875rem;line-height:1.15;white-space:nowrap;overflow:hidden;max-width:100%;";

  // code -> 键帽主元素 (渲染高亮/印字用); "" 为空占位不进表
  const capMains = new Map<string, HTMLElement>();
  const capKeys = new Map<string, HTMLButtonElement>();

  // 网格键帽助手 (底部区 Grid 用): 创建按键并注册高亮表, 追加到容器。
  // 不写死高度: 单行键由 grid-auto-rows 撑高, 跨行键 (+/⏎) 自动拉伸占满区域
  const mkCapKey = (
    parent: HTMLElement,
    code: string,
    area: string,
  ): void => {
    const key = document.createElement("button");
    key.style.cssText =
      `grid-area:${area};padding:0.0625rem;color:#fff;border:none;` +
      "border-radius:0.25rem;cursor:pointer;background:#3a3a3a;display:flex;" +
      "align-items:center;justify-content:center;overflow:hidden;";
    key.onclick = () => {
      const sel = getCapturing();
      if (!sel) return;
      setBind(sel, code);
      endCapture();
      renderBinds();
    };
    const main = document.createElement("span");
    main.style.cssText = capMainStyle;
    main.textContent = codeDisplayName(code);
    key.append(main);
    parent.appendChild(key);
    capMains.set(code, main);
    capKeys.set(code, key);
    capRegistry.push({ code, el: key }); // 跨实例落点探测用
  };

  for (const row of KB_ROWS) {
    const rowEl = document.createElement("div");
    rowEl.style.cssText = "display:flex;gap:0.125rem;margin-bottom:0.125rem;";
    for (const [code, unit] of row) {
      if (code === "") {
        const spacer = document.createElement("div");
        spacer.style.cssText = `flex:${unit} ${unit} 0%;min-width:0;`;
        rowEl.appendChild(spacer);
        continue;
      }
      const key = document.createElement("button");
      key.style.cssText =
        `flex:${unit} ${unit} 0%;min-width:0;height:1.8rem;padding:0.0625rem;color:#fff;border:none;` +
        "border-radius:0.25rem;cursor:pointer;background:#3a3a3a;display:flex;align-items:center;" +
        "justify-content:center;overflow:hidden;";
      key.onclick = () => {
        const sel = getCapturing();
        if (!sel) return; // 未选动作时点键盘无操作
        setBind(sel, code);
        endCapture();
        renderBinds();
      };
      const main = document.createElement("span");
      main.style.cssText = capMainStyle;
      key.append(main);
      rowEl.appendChild(key);
      capMains.set(code, main);
      capKeys.set(code, key);
      capRegistry.push({ code, el: key });
    }
    kbBoard.appendChild(rowEl);
  }

  // 底部区: 右侧塔 (左) + 标准小键盘 (中) + 鼠标键 (右), 靠左对齐, 底边对齐
  const kbBottom = document.createElement("div");
  kbBottom.style.cssText =
    "display:flex;gap:1.25rem;justify-content:flex-start;align-items:flex-end;margin-top:0.25rem;";
  kbBoard.appendChild(kbBottom);

  // 方向键簇: ↑ 居中在上, ← ↓ → 在下 (轨道宽度与主区格子对齐)
  const towerGrid = document.createElement("div");
  towerGrid.style.cssText =
    "display:grid;grid-template-columns:repeat(3,2.2rem);grid-auto-rows:1.8rem;gap:0.125rem;";
  mkCapKey(towerGrid, "PrintScreen", "1 / 1 / 2 / 2");
  mkCapKey(towerGrid, "ScrollLock", "1 / 2 / 2 / 3");
  mkCapKey(towerGrid, "Pause", "1 / 3 / 2 / 4");
  mkCapKey(towerGrid, "Insert", "2 / 1 / 3 / 2");
  mkCapKey(towerGrid, "Home", "2 / 2 / 3 / 3");
  mkCapKey(towerGrid, "PageUp", "2 / 3 / 3 / 4");
  mkCapKey(towerGrid, "Delete", "3 / 1 / 4 / 2");
  mkCapKey(towerGrid, "End", "3 / 2 / 4 / 3");
  mkCapKey(towerGrid, "PageDown", "3 / 3 / 4 / 4");
  mkCapKey(towerGrid, "ArrowUp", "4 / 2 / 5 / 3");
  mkCapKey(towerGrid, "ArrowLeft", "5 / 1 / 6 / 2");
  mkCapKey(towerGrid, "ArrowDown", "5 / 2 / 6 / 3");
  mkCapKey(towerGrid, "ArrowRight", "5 / 3 / 6 / 4");
  kbBottom.appendChild(towerGrid);

  // 小键盘: 标准 4 列网格, + 与 ⏎ 跨两行还原真实形状, 0 占两列 (轨道宽度与主区格子对齐)
  const numGrid = document.createElement("div");
  numGrid.style.cssText =
    "display:grid;grid-template-columns:repeat(4,2.2rem);grid-auto-rows:1.8rem;gap:0.125rem;";
  const NUM_GRID: { code: string; area: string }[] = [
    { code: "NumLock", area: "1 / 1 / 2 / 2" },
    { code: "NumpadDivide", area: "1 / 2 / 2 / 3" },
    { code: "NumpadMultiply", area: "1 / 3 / 2 / 4" },
    { code: "NumpadSubtract", area: "1 / 4 / 2 / 5" },
    { code: "Numpad7", area: "2 / 1 / 3 / 2" },
    { code: "Numpad8", area: "2 / 2 / 3 / 3" },
    { code: "Numpad9", area: "2 / 3 / 3 / 4" },
    { code: "NumpadAdd", area: "2 / 4 / 4 / 5" },
    { code: "Numpad4", area: "3 / 1 / 4 / 2" },
    { code: "Numpad5", area: "3 / 2 / 4 / 3" },
    { code: "Numpad6", area: "3 / 3 / 4 / 4" },
    { code: "Numpad1", area: "4 / 1 / 5 / 2" },
    { code: "Numpad2", area: "4 / 2 / 5 / 3" },
    { code: "Numpad3", area: "4 / 3 / 5 / 4" },
    { code: "NumpadEnter", area: "4 / 4 / 6 / 5" },
    { code: "Numpad0", area: "5 / 1 / 6 / 3" },
    { code: "NumpadDecimal", area: "5 / 3 / 6 / 4" },
  ];
  for (const n of NUM_GRID) {
    mkCapKey(numGrid, n.code, n.area);
  }
  kbBottom.appendChild(numGrid);

  // 鼠标键: 五键完整布局。6 半列轨道: 上排主键各跨 2 轨, 下排侧键各跨 3 轨铺满整行无空位
  const mouseGrid = document.createElement("div");
  mouseGrid.style.cssText =
    "display:grid;grid-template-columns:repeat(6,1.1rem);grid-auto-rows:1.8rem;gap:0.125rem;";
  mkCapKey(mouseGrid, "MouseLeft", "1 / 1 / 2 / 3");
  mkCapKey(mouseGrid, "MouseMiddle", "1 / 3 / 2 / 5");
  mkCapKey(mouseGrid, "MouseRight", "1 / 5 / 2 / 7");
  mkCapKey(mouseGrid, "MouseX1", "2 / 1 / 3 / 4");
  mkCapKey(mouseGrid, "MouseX2", "2 / 4 / 3 / 7");
  kbBottom.appendChild(mouseGrid);

  // 键帽印字: 优先 OS 实际布局 (Keyboard Map API), 失败回退 QWERTY 参照字母。
  // 位置永远正确 (code 即物理位置), 印字只是尽量贴近用户键帽
  let layoutLegends: Map<string, string> | null = null;

  const legendFor = (code: string): string => {
    const real = layoutLegends?.get(code);
    if (real) return real.length === 1 ? real.toUpperCase() : real;
    return codeDisplayName(code);
  };

  const renderBinds = (): void => {
    // 动作芯片: 名称 + 当前键 (位置名), 选中态蓝色
    for (const { action, labelKey } of KB_ACTIONS) {
      const chip = kbChips.get(action)!;
      const code = getBind(action);
      const sel = getCapturing() === action;
      chip.textContent = sel
        ? t(labelKey)
        : `${t(labelKey)} · ${code ? codeDisplayName(code) : t("bind.unbound")}`;
      chip.style.background = sel ? "#4a9eff" : "#444";
    }
    // 键盘键帽: 主字=布局印字, 蓝底=被绑定 (绑定详情看上方动作芯片)
    // 印字超宽时启动来回滚动动画 (marquee), 看全内容后滑回
    const byCode = new Map<string, BindAction>();
    for (const { action } of KB_ACTIONS) {
      const code = getBind(action);
      if (code) byCode.set(code, action);
    }
    for (const [code, main] of capMains) {
      const key = capKeys.get(code)!;
      const boundAction = byCode.get(code);
      main.textContent = legendFor(code);
      key.style.background = boundAction ? (getCapturing() ? "#2f6cb3" : "#4a9eff") : "#3a3a3a";

      // 溢出检测: 文本宽 > 键帽宽 → 来回滚动
      const over = main.scrollWidth - key.clientWidth;
      if (over > 1) {
        main.style.justifyContent = "flex-start";
        main.style.setProperty("--cap-shift", `${-over - 2}px`);
        main.style.animation = "capScroll 2.4s ease-in-out infinite alternate";
      } else if (main.style.animation) {
        main.style.animation = "";
        main.style.justifyContent = "";
        main.style.removeProperty("--cap-shift");
      }
    }
  };
  keybindRenderers.add(renderBinds);

  // 键帽滚动动画定义 (全局只注入一次); 滑动距离由各键的 --cap-shift 变量承载
  if (!document.getElementById("cap-scroll-kf")) {
    const st = document.createElement("style");
    st.id = "cap-scroll-kf";
    st.textContent =
      "@keyframes capScroll{from{transform:translateX(0)}to{transform:translateX(var(--cap-shift))}}";
    document.head.appendChild(st);
  }

  // 异步获取 OS 键盘布局印字, 到货后重绘键帽 (失败静默回退参照字母)
  void (async () => {
    try {
      const kbApi = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
      if (kbApi?.getLayoutMap) {
        layoutLegends = await kbApi.getLayoutMap();
        keybindRenderers.forEach((r) => r());
      }
    } catch {
      /* 回退参照字母 */
    }
  })();

  // 物理按键捕获: 选中互动按钮期间拦截所有按键, 按下即绑定。
  // preventDefault 阻止聚焦按钮被 Space/Enter 激活 (否则会误触发"再点芯片=取消");
  // stopImmediatePropagation 挡住后注册的 main.ts ESC 处理器与 F3/F4
  // (更早注册的背包 E 键靠 isCapturing() 让路)。
  // Esc = 解绑该动作 (鼠标码/键盘码统一清空; 本来就未绑定时等于普通取消), 且不关菜单。
  const onCaptureKey = (ev: KeyboardEvent): void => {
    const action = getCapturing();
    // 拖拽中按 Esc: 取消本次拖拽 (藏线+清状态), 停留在当前面板不触发返回
    if (!action && chipDrag && ev.code === "Escape") {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      endCapture();
      chipDrag = null;
      hideCapLine();
      sendLog("KBCAP Esc 取消拖拽");
      return;
    }
    sendLog(`KBCAP keydown code=${ev.code} capturing=${action ?? "null"}`);
    if (!action) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    endCapture();
    if (ev.code === "Escape") {
      setBind(action, "");
    } else {
      setBind(action, ev.code);
    }
    try {
      // 所有两栏面板实例一起重绘 (可见的那个必然包含在内)
      let panels = 0;
      keybindRenderers.forEach((r) => {
        r();
        panels++;
      });
      sendLog(`KBCAP renderBinds 完成 (code=${ev.code}, panels=${panels})`);
    } catch (e) {
      sendLog(`KBCAP renderBinds 异常!! ${e instanceof Error ? e.stack : String(e)}`);
    }
  };
  document.addEventListener("keydown", onCaptureKey);

  // ===== 捕获态物理输入: 键盘任意键 + 全部鼠标键 (含左键) 按下即绑定对应码 =====
  // preventDefault 阻止聚焦按钮被 Space/Enter 激活与中键自动滚动;
  // stopImmediatePropagation 挡住后注册的 main.ts ESC 处理器与 F3/F4
  // (更早注册的背包 E 键靠 isCapturing() 让路)。Esc = 解绑该动作, 且不关菜单。
  const onCaptureMouseDown = (ev: MouseEvent): void => {
    const action = getCapturing();
    sendLog(`KBCAP mousedown button=${ev.button} capturing=${action ?? "null"}`);
    if (!action) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    endCapture();
    // 一次性抑制标志: 合成 click 到达时捕获态已空, 由 click 屏蔽层按此标志拦截。
    // 仅左键会合成 click (右/中/侧键只产生 contextmenu/auxclick); mousedown 置位,
    // 清零走全局 mouseup 兜底 (当场排会被按住时长抢先清掉)
    if (ev.button === 0) armSuppressNextClick(false);
    const code = buttonToCode(ev.button); // 左/中/右/X1/X2 统一立即绑定
    if (!code) return;
    setBind(action, code);
    let panels = 0;
    keybindRenderers.forEach((r) => {
      r();
      panels++;
    });
    sendLog(`KBCAP mousedown 绑定完成 (${code}, panels=${panels})`);
  };
  document.addEventListener("mousedown", onCaptureMouseDown);
  onBindsChange(renderBinds);
  onBindsChange(renderBinds);

  const kbBackBtn = document.createElement("button");
  kbBackBtn.style.cssText = btnStyle;
  kbBackBtn.onmouseover = () => (kbBackBtn.style.background = "#555");
  kbBackBtn.onmouseout = () => (kbBackBtn.style.background = "#444");
  kbBackBtn.onclick = () => {
    endCapture(); // 离开面板时取消未完成的选中
    keybindPanel.style.display = "none";
    settingsPanel.style.display = "block";
  };
  keybindPanel.appendChild(kbBackBtn);

  // 界面缩放: 小/普通/大/自动 (MC 式 GUI Scale)
  const scaleLabel = document.createElement("div");
  scaleLabel.style.cssText = "text-align:left;font-size:0.9375rem;margin:0.5rem 0 0.25rem;";
  settingsPanel.appendChild(scaleLabel);

  const scaleRow = document.createElement("div");
  scaleRow.style.cssText = "display:flex;gap:0.375rem;margin:0 0 0.375rem;";
  const scaleBtnStyle =
    "flex:1;padding:0.5rem;font:0.875rem var(--font-ui);color:#fff;border:none;border-radius:0.375rem;cursor:pointer;";
  const mkScaleBtn = (mode: "small" | "normal" | "large" | "auto"): HTMLButtonElement => {
    const b = document.createElement("button");
    b.style.cssText = scaleBtnStyle;
    b.onmouseover = () => (b.style.background = getUIScaleMode() === mode ? "#3b83d6" : "#555");
    b.onmouseout = () => (b.style.background = getUIScaleMode() === mode ? "#4a9eff" : "#444");
    b.onclick = () => setUIScaleMode(mode);
    return b;
  };
  const scaleBtns: Record<"small" | "normal" | "large" | "auto", HTMLButtonElement> = {
    small: mkScaleBtn("small"),
    normal: mkScaleBtn("normal"),
    large: mkScaleBtn("large"),
    auto: mkScaleBtn("auto"),
  };
  const renderScale = (): void => {
    (Object.keys(scaleBtns) as (keyof typeof scaleBtns)[]).forEach((k) => {
      scaleBtns[k].textContent = t(`uiScale.${k}`);
      scaleBtns[k].style.background = getUIScaleMode() === k ? "#4a9eff" : "#444";
    });
  };
  // 缩放标签实时显示当前生效倍率 (auto 随窗口变化)
  const renderScaleLabel = (): void => {
    scaleLabel.textContent = `${t("settings.uiScale")}: ${t(`uiScale.${getUIScaleMode()}`)} (${getCurrentScale().toFixed(2)}x)`;
  };
  onResizeMerged(renderScaleLabel);
  scaleRow.append(scaleBtns.small, scaleBtns.normal, scaleBtns.large, scaleBtns.auto);
  settingsPanel.appendChild(scaleRow);

  // 窗口模式: 窗口化 / 全屏 (NW.js 运行时切换, 免重启)
  const wmLabel = document.createElement("div");
  wmLabel.style.cssText = "text-align:left;font-size:0.9375rem;margin:0.5rem 0 0.25rem;";
  settingsPanel.appendChild(wmLabel);

  const wmRow = document.createElement("div");
  wmRow.style.cssText = "display:flex;gap:0.375rem;margin:0 0 0.375rem;";
  const wmBtnStyle =
    "flex:1;padding:0.5rem;font:0.875rem var(--font-ui);color:#fff;border:none;border-radius:0.375rem;cursor:pointer;";
  const mkWmBtn = (mode: WindowMode): HTMLButtonElement => {
    const b = document.createElement("button");
    b.style.cssText = wmBtnStyle;
    b.onmouseover = () => (b.style.background = opts.getWindowMode() === mode ? "#3b83d6" : "#555");
    b.onmouseout = () => (b.style.background = opts.getWindowMode() === mode ? "#4a9eff" : "#444");
    b.onclick = () => opts.onSetWindowMode(mode);
    return b;
  };
  const wmBtns: Record<WindowMode, HTMLButtonElement> = {
    windowed: mkWmBtn("windowed"),
    fullscreen: mkWmBtn("fullscreen"),
  };
  const renderWm = (): void => {
    (Object.keys(wmBtns) as WindowMode[]).forEach((k) => {
      wmBtns[k].textContent = t(`windowMode.${k}`);
      wmBtns[k].style.background = opts.getWindowMode() === k ? "#4a9eff" : "#444";
    });
  };
  wmRow.append(wmBtns.windowed, wmBtns.fullscreen);
  settingsPanel.appendChild(wmRow);

  onUIScaleModeChange(renderScale);
  onWindowModeChange(renderWm);
  onFontChange(renderFont);

  const backBtn = document.createElement("button");
  backBtn.style.cssText = btnStyle;
  backBtn.onmouseover = () => (backBtn.style.background = "#555");
  backBtn.onmouseout = () => (backBtn.style.background = "#444");
  backBtn.onclick = () => {
    settingsPanel.style.display = "none";
    opts.onBack();
  };
  settingsPanel.appendChild(backBtn);

  const refresh = (): void => {
    sTitle.textContent = t("menu.settings");
    capLabel.textContent = t("settings.fpsCap");
    renderCap();
    renderGpuBtn();
    langBtn.textContent = t("settings.languageFont");
    langTitle.textContent = t("settings.languageFont");
    langColLabel.textContent = t("settings.language");
    fontColLabel.textContent = t("settings.font");
    zhBtn.textContent = t("lang.zh");
    enBtn.textContent = t("lang.en");
    jaBtn.textContent = t("lang.ja");
    pixelBtn.textContent = t("fonts.pixel");
    systemBtn.textContent = t("fonts.system");
    renderLang();
    renderFont();
    packBtn.textContent = t("settings.resourcepacks");
    packTitle.textContent = t("settings.resourcepacks");
    packBackBtn.textContent = t("menu.back");
    if (packPanel.style.display === "block") renderPacks();
    renderScale();
    renderScaleLabel();
    wmLabel.textContent = t("settings.windowMode");
    renderWm();
    backBtn.textContent = t("menu.back");
    langBackBtn.textContent = t("menu.back");
    keybindBtn.textContent = t("settings.keybinds");
    kbTitle.textContent = t("settings.keybinds");
    kbHint.textContent = t("bind.hint");
    kbSideTitle.textContent = t("settings.bindOptions");
    kbBackBtn.textContent = t("menu.back");
    renderBinds();
  };
  onLangChange(refresh);
  refresh();

  return { settingsPanel, langPanel, packPanel, keybindPanel };
}

export class Menu {
  visible = false;

  private readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly settingsPanel: HTMLDivElement;
  private readonly langPanel: HTMLDivElement;
  private readonly packPanel: HTMLDivElement;
  private readonly keybindPanel: HTMLDivElement;
  private readonly onResume: () => void;
  private readonly onToMainMenu: () => void;
  private readonly title: HTMLDivElement;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly settingsBtn: HTMLButtonElement;
  private readonly toMainMenuBtn: HTMLButtonElement;

  constructor(cb: MenuCallbacks) {
    const {
      onResume,
      onFpsCap,
      onToggleGpuVsync,
      getGpuVsyncState,
      getFpsCap,
      getWindowMode,
      onSetWindowMode,
      onToMainMenu,
    } = cb;
    this.onResume = onResume;
    this.onToMainMenu = onToMainMenu;

    const btnStyle =
      "display:block;width:100%;padding:0.625rem;margin:0.375rem 0;font:0.9375rem var(--font-ui);color:#fff;" +
      "background:#444;border:none;border-radius:0.375rem;cursor:pointer;";

    this.root = document.createElement("div");
    this.root.style.cssText =
      "position:fixed;inset:0;z-index:30;display:none;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.55);";
    uiStage.appendChild(this.root);

    this.panel = document.createElement("div");
    this.panel.style.cssText =
      "width:17.5rem;background:#222;border-radius:0.625rem;padding:1.25rem;text-align:center;color:#fff;" +
      "font:1rem var(--font-ui);box-shadow:0 0.25rem 1.25rem rgba(0,0,0,.5);";
    this.root.appendChild(this.panel);

    this.title = document.createElement("div");
    this.title.style.cssText = "font-size:1.375rem;margin-bottom:0.875rem;";
    this.panel.appendChild(this.title);

    this.resumeBtn = document.createElement("button");
    this.resumeBtn.style.cssText = btnStyle;
    this.resumeBtn.onmouseover = () => (this.resumeBtn.style.background = "#555");
    this.resumeBtn.onmouseout = () => (this.resumeBtn.style.background = "#444");
    this.resumeBtn.onclick = () => {
      this.hide();
      this.onResume();
    };
    this.panel.appendChild(this.resumeBtn);

    this.settingsBtn = document.createElement("button");
    this.settingsBtn.style.cssText = btnStyle;
    this.settingsBtn.onmouseover = () => (this.settingsBtn.style.background = "#555");
    this.settingsBtn.onmouseout = () => (this.settingsBtn.style.background = "#444");
    this.settingsBtn.onclick = () => {
      this.panel.style.display = "none";
      this.settingsPanel.style.display = "block";
    };
    this.panel.appendChild(this.settingsBtn);

    this.toMainMenuBtn = document.createElement("button");
    this.toMainMenuBtn.style.cssText = btnStyle;
    this.toMainMenuBtn.onmouseover = () => (this.toMainMenuBtn.style.background = "#555");
    this.toMainMenuBtn.onmouseout = () => (this.toMainMenuBtn.style.background = "#444");
    this.toMainMenuBtn.onclick = () => {
      this.hide();
      this.onToMainMenu();
    };
    this.panel.appendChild(this.toMainMenuBtn);

    const panels = buildSettingsPanel({
      getFpsCap,
      onFpsCap,
      getGpuVsyncState,
      onToggleGpuVsync,
      getWindowMode,
      onSetWindowMode,
      onBack: () => {
        this.panel.style.display = "block";
      },
    });
    this.settingsPanel = panels.settingsPanel;
    this.langPanel = panels.langPanel;
    this.packPanel = panels.packPanel;
    this.keybindPanel = panels.keybindPanel;
    this.root.appendChild(this.settingsPanel);
    this.root.appendChild(this.langPanel);
    this.root.appendChild(this.packPanel);
    this.root.appendChild(this.keybindPanel);

    const refresh = (): void => {
      this.title.textContent = t("menu.paused");
      this.resumeBtn.textContent = t("menu.resume");
      this.settingsBtn.textContent = t("menu.settings");
      this.toMainMenuBtn.textContent = t("menu.toMainMenu");
    };
    onLangChange(refresh);
    refresh();
  }

  get settingsVisible(): boolean {
    return this.settingsPanel.style.display === "block";
  }

  get langVisible(): boolean {
    return this.langPanel.style.display === "block";
  }

  get packVisible(): boolean {
    return this.packPanel.style.display === "block";
  }

  get keybindVisible(): boolean {
    return this.keybindPanel.style.display === "block";
  }

  goBack(): void {
    if (this.packVisible) {
      this.packPanel.style.display = "none";
      this.settingsPanel.style.display = "block";
    } else if (this.langVisible) {
      this.langPanel.style.display = "none";
      this.settingsPanel.style.display = "block";
    } else if (this.keybindVisible) {
      this.keybindPanel.style.display = "none";
      this.settingsPanel.style.display = "block";
    } else if (this.settingsVisible) {
      this.settingsPanel.style.display = "none";
      this.panel.style.display = "block";
    }
  }

  show(): void {
    this.visible = true;
    this.root.style.display = "flex";
  }

  hide(): void {
    this.visible = false;
    this.root.style.display = "none";
  }
}