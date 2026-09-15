// ===== MC-style game mode switch (F3+F4): survival / creative / spectator, applies on F3 release =====
import { MODE_NAMES, type MoveMode } from "../ecs/components/Player";
import type { Hud } from "./hud";
import { t, onLangChange } from "./i18n";
import { uiStage } from "./uiscale";

const GM_MODES: MoveMode[] = ["walk", "fly", "spectator"];

export class GamemodeController {
  private f3Down = false;
  private f4Down = false;
  private menuOpen = false;
  private sel = 0;
  private readonly menu: HTMLDivElement;
  private readonly itemEls: HTMLDivElement[] = [];
  private readonly title: HTMLDivElement;

  constructor(
    private readonly hud: Hud,
    private readonly input: { mode: MoveMode; setMode(mode: MoveMode): void },
    private readonly logDebug: (line: string) => void,
  ) {
    this.menu = document.createElement("div");
    this.menu.style.cssText =
      "position:fixed;bottom:6.25rem;left:50%;transform:translateX(-50%);z-index:25;display:none;text-align:center;font:0.875rem/1.6 var(--font-ui);";
    this.menu.innerHTML =
      `<div id="gmTitle" style="color:#fff;text-shadow:0 0.0625rem 0.125rem #000;font-weight:600;margin-bottom:0.25rem;"></div>` +
      `<div id="gmItems" style="display:flex;gap:0.5rem;justify-content:center;"></div>`;
    uiStage.appendChild(this.menu);
    this.title = this.menu.querySelector("#gmTitle") as HTMLDivElement;
    const items = this.menu.querySelector("#gmItems") as HTMLDivElement;
    for (const m of GM_MODES) {
      const el = document.createElement("div");
      el.style.cssText =
        "padding:0.25rem 0.875rem;border-radius:0.25rem;color:#fff;background:rgba(0,0,0,.45);border:0.125rem solid transparent;text-shadow:0 0.0625rem 0.125rem #000;";
      items.appendChild(el);
      this.itemEls.push(el);
    }

    const refresh = (): void => {
      this.title.textContent = t("gamemode.title");
      this.itemEls.forEach((el, i) => {
        el.textContent = t(`mode.${GM_MODES[i]}`);
      });
    };
    onLangChange(refresh);
    refresh();

    document.addEventListener("keydown", (ev) => this.onKeyDown(ev));
    document.addEventListener("keyup", (ev) => this.onKeyUp(ev));
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (ev.code === "F3") {
      this.f3Down = true;
      if (this.f4Down) {
        this.open();
        return;
      }
      this.hud.toggleDebug();
    } else if (ev.code === "F4") {
      this.f4Down = true;
      if (this.menuOpen) this.cycle();
      else if (this.f3Down) this.open();
    }
  }

  private onKeyUp(ev: KeyboardEvent): void {
    if (ev.code === "F3") {
      this.f3Down = false;
      if (this.menuOpen) this.apply();
    } else if (ev.code === "F4") {
      this.f4Down = false;
    }
  }

  private open(): void {
    this.sel = GM_MODES.indexOf(this.input.mode);
    this.menu.style.display = "block";
    this.menuOpen = true;
    this.render();
  }

  private cycle(): void {
    this.sel = (this.sel + 1) % GM_MODES.length;
    this.render();
  }

  private render(): void {
    this.itemEls.forEach((el, i) => {
      el.style.borderColor = i === this.sel ? "#fff" : "transparent";
      el.style.background = i === this.sel ? "rgba(255,255,255,.25)" : "rgba(0,0,0,.45)";
    });
  }

  private apply(): void {
    this.menuOpen = false;
    this.menu.style.display = "none";
    const m = GM_MODES[this.sel];
    if (m !== this.input.mode) {
      this.input.setMode(m);
            this.logDebug(`MODE switch -> ${m} (${MODE_NAMES[m]})`);
    }
  }
}