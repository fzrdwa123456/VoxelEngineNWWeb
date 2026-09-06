import { getBlockIcon } from "../rendering/blockicons";
import { allBlockIds, getBlockDef } from "../blockregistry";
import { t, onLangChange } from "./i18n";
import { uiStage } from "./uiscale";

/** Block type id (alias from the old blocks.ts; block world removed, registry ids remain strings) */
type BlockType = string;

export interface InvItem {
  type: BlockType;
  count: number;
}

const HOTBAR = 9;
const BAG = 27;
const TOTAL = HOTBAR + BAG;

export class Inventory {
  private readonly slots: (InvItem | null)[] = new Array(TOTAL).fill(null);
  private selected = 0;
  private readonly hotbarEls: HTMLDivElement[] = [];
  private readonly bagEls: HTMLDivElement[] = [];
  private readonly panel: HTMLDivElement;
  private readonly onToggle: (open: boolean) => void;
  private readonly title: HTMLDivElement;
  private iconSize = 40;
  open = false;

  constructor(onToggle: (open: boolean) => void) {
    this.onToggle = onToggle;
        // Initial inventory = the registry's first 9 blocks (mod blocks appear automatically; select to place)
    allBlockIds()
      .slice(0, HOTBAR)
      .forEach((id, i) => {
        this.slots[i] = { type: id, count: 64 };
      });

    const hotbar = document.createElement("div");
    hotbar.style.cssText =
      "position:fixed;bottom:0.25rem;left:50%;transform:translateX(-50%);z-index:31;display:flex;gap:0.1875rem;";
    for (let i = 0; i < HOTBAR; i++) {
      const el = this.makeSlot();
      hotbar.appendChild(el);
      this.hotbarEls.push(el);
    }
    uiStage.appendChild(hotbar);

    this.panel = document.createElement("div");
    this.panel.style.cssText =
      "position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;";
    const inner = document.createElement("div");
    inner.style.cssText = "background:rgba(20,20,30,.92);border:0.125rem solid #555;border-radius:0.375rem;padding:0.875rem;";
    const title = document.createElement("div");
    title.style.cssText = "color:#eee;font:600 1rem/1.5 var(--font-ui);margin-bottom:0.5rem;text-align:center;";
    this.title = title;
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(9,3rem);gap:0.1875rem;";
    for (let i = HOTBAR; i < TOTAL; i++) {
      const el = this.makeSlot();
      grid.appendChild(el);
      this.bagEls.push(el);
    }
    inner.append(title, grid);
    this.panel.appendChild(inner);
    uiStage.appendChild(this.panel);

    document.addEventListener("keydown", (ev) => {
      if (ev.repeat) return;
      if (ev.code.startsWith("Digit")) {
        const n = Number(ev.code.slice(5));
        if (n >= 1 && n <= HOTBAR) {
          this.selected = n - 1;
          this.render();
        }
      }
    });
    this.bagEls.forEach((el, i) => {
      el.addEventListener("click", () => this.swap(i + HOTBAR, this.selected));
    });

    this.render();

    const refresh = (): void => {
      this.title.textContent = t("inv.title");
    };
    onLangChange(refresh);
    refresh();
  }

  private makeSlot(): HTMLDivElement {
    const el = document.createElement("div");
    el.style.cssText =
      "width:3rem;height:3rem;background:rgba(0,0,0,.35);border:0.125rem solid rgba(255,255,255,.25);border-radius:0.25rem;position:relative;display:flex;align-items:center;justify-content:center;";
    const icon = document.createElement("div");
    icon.style.cssText = "width:2.5rem;height:2.5rem;background-size:cover;background-position:center;";
    el.appendChild(icon);
    const count = document.createElement("div");
    count.style.cssText =
      "position:absolute;right:0.125rem;bottom:0;color:#fff;font:600 0.75rem/1.4 var(--font-mono);text-shadow:0 0.0625rem 0.0625rem #000;";
    el.appendChild(count);
    return el;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  close(): void {
    this.setOpen(false);
  }

  private setOpen(o: boolean): void {
    if (this.open === o) return;
    this.open = o;
    this.panel.style.display = o ? "flex" : "none";
    this.onToggle(o);
  }

  private swap(a: number, b: number): void {
    const t = this.slots[a];
    this.slots[a] = this.slots[b];
    this.slots[b] = t;
    this.render();
  }

    /** Block type of the currently selected hotbar slot (null when empty-handed) */
  selectedType(): BlockType | null {
    const it = this.slots[this.selected];
    return it ? it.type : null;
  }

    /** Bake and backfill the slot icon async at the current icon size (size-guarded, so a stale size after a scale switch cannot overwrite) */
  private fetchIcon(el: HTMLDivElement, i: number): void {
    const icon = el.children[0] as HTMLDivElement;
    const it = this.slots[i];
    if (!it) return;
    const size = this.iconSize;
    getBlockIcon(it.type, size).then((url) => {
      const cur = this.slots[i];
      if (url && cur && cur.type === it.type && this.iconSize === size) {
        icon.style.backgroundColor = "transparent";
        icon.style.backgroundImage = `url(${url})`;
      }
    });
  }

    /** Re-bake all filled slot icons when the scale changes */
  private refreshIcons(): void {
    this.hotbarEls.forEach((el, i) => this.fetchIcon(el, i));
    this.bagEls.forEach((el, i) => this.fetchIcon(el, i + HOTBAR));
  }

  private render(): void {
    const draw = (el: HTMLDivElement, i: number): void => {
      const icon = el.children[0] as HTMLDivElement;
      const count = el.children[1] as HTMLDivElement;
      const it = this.slots[i];
      if (!it) {
        icon.style.backgroundColor = "transparent";
        icon.style.backgroundImage = "none";
        count.textContent = "";
      } else {
                // Solid-color fallback = registry color (no texture def); overwritten when the 3D icon arrives async
        icon.style.backgroundColor = getBlockDef(it.type)?.color ?? "#4caf50";
        icon.style.backgroundImage = "none";
        el.title = getBlockDef(it.type)?.label ?? it.type;  // Tooltip shows the block name
        count.textContent = it.count > 1 ? `${it.count}` : "";
        this.fetchIcon(el, i);
      }
    };
    this.hotbarEls.forEach((el, i) => {
      draw(el, i);
      el.style.borderColor = i === this.selected ? "#fff" : "rgba(255,255,255,.25)";
      el.style.background = i === this.selected ? "rgba(255,255,255,.2)" : "rgba(0,0,0,.35)";
    });
    this.bagEls.forEach((el, i) => draw(el, i + HOTBAR));
  }
}