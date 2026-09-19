// ===== Pointer lock management =====
import { invoke } from "@tauri-apps/api/core";

export interface PointerLockDeps {
  /** What the lock manager needs from the input system (structural, no concrete class) */
  input: { lock(): Promise<void> | undefined };
  /** Whether a modal UI currently owns the mouse. ONE predicate, supplied by the composition root
   *  from the UI_MODAL resource — it replaced two separate callbacks (isMenuOpen / isInvOpen) whose
   *  OR only existed at the call sites. */
  isUiModal: () => boolean;
  /** Whether the player currently CONTROLS the mouse — i.e. `canControl(INPUT_STATE, UI_MODAL)`.
   *
   *  **This is the cursor's gate, and it is deliberately NOT `!isUiModal`.** The loading screen runs
   *  in `load` mode and owns no modal surface, so `!isUiModal` was TRUE there and the cursor was
   *  hidden while a loading bar was on screen. `canControl` is false until the mouse is actually
   *  captured, so the cursor stays visible through the startup, the settings check, the world entry
   *  and every menu — and is hidden only while a world is actually running under the player's hand. */
  canControl: () => boolean;
  logDebug: (line: string) => void;
}

// All relock() calls come from direct user interaction (clicking singleplayer / E closing the inventory / ESC resuming), so no focus gating anymore:
// Chromium rejects requestPointerLock when the window is not foreground (triggering a 1300ms retry), which naturally prevents "capturing" the mouse.

export class PointerLock {
  /** 诊断：上一次写下去的 CSS 值，只在**变化**时打日志（免得每帧刷屏） */
  private lastCursor: "none" | "default" | null = null;

  constructor(private readonly deps: PointerLockDeps) {}

  relock(source: string): void {
        this.deps.logDebug(`LOCK request [${source}]`);
    const tryLock = (): void => {
      if (this.deps.isUiModal()) return;
      const p = this.deps.input.lock();
      if (p) {
        p.catch(() => {
                    this.deps.logDebug(`LOCK rejected [${source}], retrying in 1300ms`);
          setTimeout(tryLock, 1300);
        });
      }
    };
    tryLock();
  }

    // Cursor: hidden ONLY while the player actually controls the mouse (a world running, no modal UI
    // up). Visible on the loading screen, at the main menu, in the pause menu and in the backpack.
    // (It used to read `isUiModal` inverted, which made the loading screen hide the cursor.)
  /** 窗口重新聚焦之后，逼 Chromium **重新算一次**光标并推下来。
   *
   *  为什么需要（探针证据）：失焦那一刻 CSS 从 `none` 变成 `default`，但那次推送被系统丢掉了
   *  （窗口正在失活）；而 Chromium **缓存的"当前光标"仍然是 NULL** —— 所以事后问它
   *  （Rust 侧发的 `WM_SETCURSOR`）它答的也是 NULL：
   *      `[cursor] focus GAIN before=showing=false hCursor=0` → `after` 还是 0
   *  只有让 CSS **真的变一次**，它才会重算。做法：先写一个和目标不同但等价的字符串
   *  （`auto` 和 `default` 都是箭头，肉眼无差别），下一个宏任务再写回目标值。
   *  `applyCursor()` 每帧都会写同一个值，Chromium 对"值没变"是不推送的 —— 所以必须先变一次。 */
  reapplyCursor(): void {
    const target: "none" | "default" = this.deps.canControl() ? "none" : "default";
    if (target === "none") {
      // 需要隐藏时不需要这套（失败模式是"该显示却一直隐藏"）
      this.applyCursor();
      return;
    }
    // 同样必须 important：主题那条 `*{cursor:inherit !important}` 会把普通内联压掉，
    // 那样这次"强制变化"就变成空操作，Chromium 也就不会重新推光标了。
    // （`auto` 和 `default` 都是箭头，肉眼无差别，但值确实变了。）
    document.body.style.setProperty("cursor", "auto", "important");
    setTimeout(() => this.applyCursor(), 0);
    // 渲染进程可能慢一拍，补一次
    setTimeout(() => this.applyCursor(), 120);
  }

  applyCursor(): void {
    const can = this.deps.canControl();
    const value: "none" | "default" = can ? "none" : "default";
    if (value !== this.lastCursor) {
      this.lastCursor = value;
      // 诊断：CSS 侧的决定。和 boot.log 里 [cursor] 那些系统侧探针配合看，
      // 就能判定"CSS 说可见、系统说隐藏"这种不一致发生在哪一刻。
      this.deps.logDebug(`CURSOR css=${value} canControl=${can}`);
      // 把**期望**交给 Rust：之后由它的哨兵（每 8ms）负责真正显示/隐藏光标，
      // 不再依赖 Chromium 的推送时机，也不怕 Windows 被 Alt 弄进菜单模式。
      void invoke("cursor_intent", { visible: value !== "none" }).catch(() => {});
    }
    // **重要：必须写成 important 内联。** 主题的全局样式表里有一条 `*{cursor:inherit !important}`
    // （用来消掉控件的手型），body 自己也命中 `*` —— 只有"内联 important"才能压过"样式表 important"，
    // 让 body 保住游戏的策略值，其余元素再从 body 继承。
    document.body.style.setProperty("cursor", value, "important");
  }
}