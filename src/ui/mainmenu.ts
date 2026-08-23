// ===== 主界面 (标题 voxelcraft + 单人/多人/设置/退出) =====
// 背景: 资源包内的 missing.png (与贴图同一条覆盖链, 用户包可换图) 铺满整个主菜单,
// 读不到时黑色兜底。视频/全景/3D 场景留待扩展: 需要主菜单专用渲染循环。
import { buildSettingsPanel, type SettingsCallbacks } from "./menu";
import { t, onLangChange } from "./i18n";
import { uiStage } from "./uiscale";
import { resolveTexture, FALLBACK_TEXTURE_URL } from "../textures";

export interface MainMenuCallbacks extends SettingsCallbacks {
  onStartSingle: () => void;
  onMultiplayer: () => void;
  onExit: () => void;
}

export class MainMenu {
  visible = false;

  private readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly settingsPanel: HTMLDivElement;
  private readonly langPanel: HTMLDivElement;
  private readonly packPanel: HTMLDivElement;
  private readonly keybindPanel: HTMLDivElement;
  private readonly singleBtn: HTMLButtonElement;
  private readonly multiBtn: HTMLButtonElement;
  private readonly settingsBtn: HTMLButtonElement;
  private readonly quitBtn: HTMLButtonElement;

  constructor(cb: MainMenuCallbacks) {
    const btnBase =
      "display:block;width:100%;padding:0.75rem;margin:0.5rem 0;font:1rem var(--font-ui);color:#fff;" +
      "background:linear-gradient(#6a6a6a,#4d4d4d);border:0.125rem solid #1a1a1a;border-top-color:#7a7a7a;" +
      "border-left-color:#7a7a7a;box-shadow:inset 0 0.0625rem 0 rgba(255,255,255,.15),0 0.125rem 0.25rem rgba(0,0,0,.6);" +
      "cursor:pointer;text-shadow:0 0.125rem 0 rgba(0,0,0,.5);";
    const btnHover = "filter:brightness(1.25);";
    const btnDown = "transform:translateY(0.0625rem);";
    const mkBtn = (onClick: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.style.cssText = btnBase;
      // hover/按下用单独属性, 不重写 cssText (避免冲掉布局系统的 translate 偏移)
      b.onmouseover = () => (b.style.filter = "brightness(1.25)");
      b.onmouseout = () => {
        b.style.filter = "";
        b.style.transform = "";
      };
      b.onmousedown = () => (b.style.transform = "translateY(0.0625rem)");
      b.onmouseup = () => (b.style.filter = "brightness(1.25)");
      b.onclick = onClick;
      return b;
    };

    this.root = document.createElement("div");
    this.root.style.cssText =
      "position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;" +
      "background:#000 center/cover no-repeat;image-rendering:pixelated;";
    // 背景图: 资源包 missing.png (用户包可覆盖); 原半透明压暗层由伪透明实现 ——
    // 图片上叠暗化: 用第二个渐变层, 无图时纯黑兜底。
    // image-rendering:pixelated: 2x2 紫黑棋盘格最近邻放大 (对齐游戏内贴图 NearestFilter),
    // 否则 CSS 默认双线性插值会把棋盘糊成"纯紫渐变" (黑色被混合稀释)
    const bgUrl = resolveTexture("missing.png");
    const hasBg = bgUrl !== FALLBACK_TEXTURE_URL; // resolveTexture 读不到时返回 1x1 透明兜底 URL
    if (hasBg) {
      this.root.style.backgroundImage = `linear-gradient(rgba(0,0,0,.5),rgba(0,0,0,.5)), url(${bgUrl})`;
    }
    uiStage.appendChild(this.root);

    this.panel = document.createElement("div");
    this.panel.style.cssText =
      "width:18.75rem;text-align:center;font-family:var(--font-ui);";
    this.root.appendChild(this.panel);

    this.title = document.createElement("div");
    this.title.textContent = "voxelcraft";
    this.title.style.cssText =
      "font-size:3.25rem;font-weight:800;color:#fff;margin-bottom:1.75rem;letter-spacing:0.125rem;" +
      "text-shadow:0 0.25rem 0 #2a2a2a,0 0.375rem 0.75rem rgba(0,0,0,.6);";
    this.panel.appendChild(this.title);

    this.singleBtn = mkBtn(cb.onStartSingle);
    this.panel.appendChild(this.singleBtn);
    this.multiBtn = mkBtn(cb.onMultiplayer);
    this.panel.appendChild(this.multiBtn);
    this.settingsBtn = mkBtn(() => {
      this.panel.style.display = "none";
      this.settingsPanel.style.display = "block";
    });
    this.panel.appendChild(this.settingsBtn);
    this.quitBtn = mkBtn(cb.onExit);
    this.panel.appendChild(this.quitBtn);

    const panels = buildSettingsPanel({
      getFpsCap: cb.getFpsCap,
      onFpsCap: cb.onFpsCap,
      getGpuVsyncState: cb.getGpuVsyncState,
      onToggleGpuVsync: cb.onToggleGpuVsync,
      getWindowMode: cb.getWindowMode,
      onSetWindowMode: cb.onSetWindowMode,
      onBack: () => {
        this.settingsPanel.style.display = "none";
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
      this.singleBtn.textContent = t("main.single");
      this.multiBtn.textContent = t("main.multi");
      this.settingsBtn.textContent = t("menu.settings");
      this.quitBtn.textContent = t("main.quit");
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