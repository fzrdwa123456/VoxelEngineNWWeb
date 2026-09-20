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
  /** 窗口是不是**前台**（`platform/shell.ts` 的 winFocused）。
   *
   *  **捕获必须只在前台开着。** 原生捕获走的是 `ClipCursor`，它**根本不看**窗口是不是前台；浏览器那条
   *  `requestPointerLock` 会被 Chromium 拒（所以老版本可以省掉这个门禁，注释里也正是这么写的）—— 但
   *  Tauri 版换成原生之后，省掉它就等于允许"后台开捕获"：光标被夹在一个后台窗口的矩形里（那块区域上是
   *  别的应用）、视角还在转（原始输入是 RIDEV_INPUTSINK，后台也收）、光标还被全局隐藏。
   *  最容易踩的一处是**进世界时的自动 relock**（加载期间切走，加载完照样捕获）—— 见
   *  `win.rs::capture_foreground_check`，那是系统级兜底，这里是正常路径上的门禁。 */
  focused: () => boolean;
  logDebug: (line: string) => void;
  /** 重试一个被拒绝的锁：**到期时间放进世界**（`DELAYED_INTENTS::schedule`，见 ecs/systems/delays.ts），
   *  由 `ui.delays` 在下一帧应用。这里原来是 `setTimeout(tryLock, 1300)` —— 一个只属于本模块的定时器，
   *  schedule 看不见、暂停时照样跑、也没法在日志里列出来。 */
  scheduleRetry: (delayMs: number, source: string) => void;
  /** 再写一次光标（`reapplyCursor` 的 0 / 120 ms 两次补写）：同样是延时意图，不是本模块的定时器。 */
  scheduleCursor: (delayMs: number) => void;
}

// relock() 仍然**要求窗口在前台**（deps.focused）。老注释说"不需要焦点门禁"是因为浏览器那条
// requestPointerLock 本来就会拒；Tauri 版走原生 ClipCursor，它不看前台 —— 那个假设不成立了。

export class PointerLock {
  /** 诊断：上一次写下去的 CSS 值，只在**变化**时打日志（免得每帧刷屏） */
  private lastCursor: "none" | "default" | null = null;

  constructor(private readonly deps: PointerLockDeps) {}

  relock(source: string): void {
        this.deps.logDebug(`LOCK request [${source}]`);
    this.attempt(source);
  }

  /** 到期重试（由 `ui.delays` 调用）：和 `relock` 同一条路径，只是多一行"这是重试"。 */
  retry(source: string): void {
    this.deps.logDebug(`LOCK retry [${source}]`);
    this.attempt(source);
  }

  private attempt(source: string): void {
      if (this.deps.isUiModal()) return;
      if (!this.deps.focused()) {
        this.deps.logDebug(`LOCK skipped [${source}]: window is not foreground`);
        return;
      }
      const p = this.deps.input.lock();
      if (p) {
        p.catch(() => {
                    this.deps.logDebug(`LOCK rejected [${source}], retrying in 1300ms`);
          this.deps.scheduleRetry(1300, source);
        });
      }
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
    this.deps.scheduleCursor(0);
    // 渲染进程可能慢一拍，补一次
    this.deps.scheduleCursor(120);
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