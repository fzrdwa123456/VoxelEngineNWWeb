// ===== Main menu (title voxelcraft + singleplayer/multiplayer/settings/exit) =====
// Background: the pack's backgrounds/background.json picks the mode (see ui/background.ts decision chain):
//   panorama = sphere panorama (root transparent so the canvas shows, drawn by main.ts's menu render loop)
//   static   = backgrounds/mainmenu.png covers (missing image falls to black)
//   checker  = no config/invalid config, straight to the procedural magenta/black checkerboard (not overridable)
import { buildSettingsPanel, type SettingsCallbacks } from "./menu";
import { t, onLangChange } from "./i18n";
import { uiStage } from "./uiscale";
import { resolveTexture, CHECKER_TEXTURE_URL } from "../rendering/textures";
import { menuBgKind } from "./background";

/** World type (main-menu singleplayer choice; world generation removed, only the selection semantics remain) */
type WorldGenMode = "superflat" | "noise";

export interface MainMenuCallbacks extends SettingsCallbacks {
  onStartSingle: (mode: WorldGenMode) => void;
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
  private readonly genPanel: HTMLDivElement;
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
            // hover/pressed use separate properties, not rewriting cssText (avoids wiping the layout system's translate offset)
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
      "image-rendering:pixelated;";
        // Background form decision (shared with main.ts's render loop): panorama lets the canvas show + semi-transparent dimmer;
        // static/checker set a DOM background image. checker uses the procedural checkerboard directly (no config = magenta/black, not overridable)
    const kind = menuBgKind();
    if (kind === "panorama") {
      this.root.style.background = "rgba(0,0,0,.35)";  // Dimmer only; the panorama is rendered by the canvas
    } else if (kind === "checker") {
      this.root.style.background = "#000 center/cover no-repeat";
      this.root.style.backgroundImage = `linear-gradient(rgba(0,0,0,.5),rgba(0,0,0,.5)), url(${CHECKER_TEXTURE_URL})`;
    } else {
            // static: when background.ts decides static the image must exist (a missing image would decide checker), no further fallback needed
      this.root.style.background = "#000 center/cover no-repeat";
      const bgUrl = resolveTexture("backgrounds/mainmenu.png");
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

    this.singleBtn = mkBtn(() => {
            // Singleplayer -> pick a world type first (superflat/noise), then enter the world
      this.panel.style.display = "none";
      this.genPanel.style.display = "block";
    });
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

        // World type selection page (singleplayer sub-page): superflat / noise world
    this.genPanel = document.createElement("div");
    this.genPanel.style.cssText =
      "display:none;width:18.75rem;text-align:center;font-family:var(--font-ui);";
    const genTitle = document.createElement("div");
    genTitle.style.cssText =
      "font-size:1.4rem;font-weight:700;color:#fff;margin-bottom:1rem;" +
      "text-shadow:0 0.125rem 0 rgba(0,0,0,.5);";
    this.genPanel.appendChild(genTitle);
    const genSuperflatBtn = mkBtn(() => cb.onStartSingle("superflat"));
    this.genPanel.appendChild(genSuperflatBtn);
    const genNoiseBtn = mkBtn(() => cb.onStartSingle("noise"));
    this.genPanel.appendChild(genNoiseBtn);
    const genBackBtn = mkBtn(() => {
      this.genPanel.style.display = "none";
      this.panel.style.display = "block";
    });
    this.genPanel.appendChild(genBackBtn);
    this.root.appendChild(this.genPanel);

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
      genTitle.textContent = t("main.genTitle");
      genSuperflatBtn.textContent = t("main.genSuperflat");
      genNoiseBtn.textContent = t("main.genNoise");
      genBackBtn.textContent = t("menu.back");
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

  get genVisible(): boolean {
    return this.genPanel.style.display === "block";
  }

  goBack(): void {
    if (this.genVisible) {
      this.genPanel.style.display = "none";
      this.panel.style.display = "block";
    } else if (this.packVisible) {
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