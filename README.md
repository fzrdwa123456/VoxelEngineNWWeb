# VoxelEngineTauri

VoxelEngine 的 **Tauri v2** 版。前端（TypeScript + three.js WebGPU + 手写 ECS）与原
`VoxelEngineNWWeb` 一致，**壳从 NW.js 换成了 Tauri**（Windows 上是 WebView2）。

> 逐文件的移植对照在 **[docs/PORT-TAURI.md](docs/PORT-TAURI.md)**；
> **架构与编程思想的正式说明在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**
> （微内核插件化架构 + DOD：层次与职责、依赖方向、扩展点、六条 DOD 规则、现状欠账）。
> 改代码前要读的规则、当前目录表与铁律在 `AGENTS.md`；计划与欠账在 `ROADMAP.md`；
> 手测清单在 `docs/TESTING.md`。

## 怎么跑

```powershell
npm install                                # 前端依赖 + @tauri-apps/cli
node scripts/rearrange.mjs --with-packs    # 建 game\ 数据目录，并装仓库里的两个示例包
npm run app:dev                            # = tauri dev：起 vite(1420) + 编译 Rust 壳 + 开窗口
```

发布：

```powershell
npm run app:build        # = tauri build：前端产物 + release 壳（+ NSIS 安装包，见下）
npm run app:exe          # = cargo build --release --features custom-protocol
npm run app:portable     # 打包成 release\VoxelEngineTauri\：exe + WebView2Loader.dll + game\
```

> ⚠️ **不要用裸 `cargo build --release`。** Tauri 只在启用 `tauri/custom-protocol` feature 时
> 才把前端产物嵌进二进制：`tauri build` 自己会开，裸 cargo **不会**。那样出来的 exe 会去找
> `devUrl`，结果是**空白窗口** —— 进程活着、10 个线程、msedgewebview2 各组件都起来了，
> 但页面根本没加载：`logs\debug.log` 一行没有，连 `index.html` 里 inline 脚本那句
> `html loaded` 都不会出现，从外面看跟"卡在加载器"几乎一样。
> 现在 `npm run app:portable` 会**主动检查 exe 里有没有前端产物**，没有就直接报错退出。
>
> ⚠️ **只改前端（.ts/.css）时还要强制重编。** 前端产物是**编译期**嵌进二进制的，而 cargo 不会
> 因为 `dist\` 变了就重编我们的 crate —— 你会看到 `Finished ... in 0.4s`、exe 的时间戳没变，
> 跑起来的还是旧前端（这个坑踩过两次）。这时先清一次：
>
> ```powershell
> cd src-tauri
> cargo clean --release -p voxelengine-tauri     # 注意要在 src-tauri 里、或者带 --manifest-path
> cargo build --release --features custom-protocol
> ```

产物 `release\VoxelEngineTauri\voxelengine-tauri.exe` **双击就能跑**，不需要 Node、不需要 dev server。

> ⚠️ **`WebView2Loader.dll` 必须跟 exe 待在一起。**
> 少了它 Windows 什么窗口都不给，只弹一个
> "voxelengine-tauri.exe - 系统错误：由于找不到 WebView2Loader.dll" 的框；
> 而且那个框是 **`csrss.exe`** 画的 —— **杀掉应用进程它也不会消失**。
> 于是现象看起来像"进程活着、0 CPU、2 个线程、没有窗口、一行日志都不写"的假死。
> `npm run app:portable` 会正确带上它（这个坑真踩过，详见 docs/PORT-TAURI.md）。
>
> NSIS 安装包那一步要从 GitHub 下载 `nsis-3.11.zip`，网络不好会 `timeout: global` 失败。
> **exe 在那之前就已经编好了**，失败只影响安装包，`app:portable` 照常可用。

只验前端（不碰 Rust）：

```powershell
npm run check                          # tsc --noEmit(strict) + check:ecs（54 组断言）
npm run build                          # tsc && vite build -> dist\
node scripts/build-all.mjs --cargo     # 再带上 cargo check
```

## 数据目录

便携布局，跟原版一样是"exe 旁边一个 `game\`"：

```
game\config\settings.json       设置（唯一写入点：write_settings 命令）
                                language / font / uiScale / windowMode / fpsCap / keybinds / diagLog
game\config\vsync.json          GPU vsync 开关（重启生效，对应原版改写 chromium-args）
game\config\settings.bad.json   读不动的设置文件的备份（启动修复时留）
game\logs\debug.log             引擎日志（"日志检测"关掉后只剩事件行，见下）
game\logs\renderer.log          console.error / warn
game\resourcepacks\<包>\        资源包（文件夹或 .zip）
game\mods\<mod>\                mod（blocks.json + block\*.png）
game\saves\
```

**`diagLog`（设置面板里的"日志检测"，默认开）**：开 = `debug.log` 里额外写入诊断探针行
（`FRAME` 帧时间与每帧鼠标采样直方图、`LOOK` 输入计数、`RAWLAG` 事件到达与队列积压、`RAWMON` Rust 侧
每秒统计、`STALL` 卡顿、`PHYS`、`SPACE#`/`MOUSE#`、`HOOKPROBE`）；关 = 这些行一律不写，只留事件记录
（`BOOT`/`SETTINGS`/`LOCK`/`CURSOR`/`GEOMETRY`/`ERROR` 等）。排查"手感/卡顿/输入"这类问题时开着它，
平时关掉可以让日志保持干净、也不再多写盘。开关即时生效，不需要重启。

* **dev**（`cargo` / `tauri dev`）：exe 在 `src-tauri\target\debug\`，往上三级是仓库根，
  数据放 `<仓库根>\game\`（`scripts/rearrange.mjs` 也建在那里，两边必须一致）。
* **release**：exe 旁边的 `game\`；没有就退回 exe 所在目录。
* `VOXEL_GAME_ROOT` 环境变量可强制指定，排查问题时好用。

## 移植改了什么

**只有三个文件 + 一处启动顺序。** 全仓库碰 `nw.` / `require(` / `process.` 的只有：

| 原来（NW.js） | 现在（Tauri v2） |
|---|---|
| `platform/shell.ts`：`eval("require")("node:fs")` 同步读写 + `nw.Window.get()` | 重写：启动一次 `invoke("preload_shell")` 把设置/窗口/vsync 取进内存，**`readSettings()` 保持同步**；窗口操作走自定义命令 |
| `platform/rawinput.ts`：`require("rawinput.node")` 这个 NAPI 插件 | 重写：采集在 Rust（`src-tauri/src/rawinput.rs`），Rust 每 4ms `emit("raw-input")` 推增量；前端逐条做判定（事件期）并累加，**每帧 `frameLook()` 应用一次** —— 视角路径上没有任何定时器 |
| `rendering/textures.ts`：`node:fs` 列目录 + 读 zip | 字节由 Rust 扫好（`packs.rs`）一次性取来，**MC 命名空间归一化/优先级/layering 一行没动** |
| `main.ts` 顶部 `initShell()` | 多了两行 `await preloadShell(); await preloadPacks();` —— Tauri 命令是异步的，而后面所有读都是同步的 |

**除这三个文件外，`src/` 下其余文件、几十处 `logDebug`/`readSettings`/`resolveTexture`
调用点，一个都没改**；`check:ecs` 的 54 组断言全部照常通过。

## 与原版的已知差异

1. **日志是攒批写的。** 原版每行一次同步 `appendFile`；Tauri 里那样会变成每帧一个 IPC，
   所以 `logDebug` 先入内存，满 64 行或 200ms 发给 Rust（关窗前再 flush）。
   代价：崩溃前最后 200ms 的日志可能丢。
2. **`--disable-gpu-vsync` 走环境变量。** WebView2 的参数只能在建窗口之前给，所以开关落在
   `config\vsync.json`，由 `run()` 读出来塞进 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`。
   语义与原版一致：**重启生效**；默认值也一致（默认关掉 vsync）。
3. **全屏不用 kiosk 了。** 原版走 `enterKioskMode()` 并要立刻 `setAlwaysOnTop(false)` 撤销它的
   置顶副作用；Tauri 的 `set_fullscreen()` 没有这个副作用，那两行补丁删掉了。
4. **原始输入的搬运方向反了。** 原来是 JS 每帧 `pollDelta()` 拉 NAPI 原子量，现在 Rust 推事件、
   前端累加。语义（按帧批量消费相对增量）不变，多了 IPC，节流到 4ms 一批。
5. **三个"读包"的地方改成惰性构建。** 原版 `fs.readFileSync` 是同步的，所以
   `i18n` 的词典、`blockregistry` 的注册表、`background` 的菜单背景结论都可以在**模块作用域**
   或首次调用时就建好并缓存。Tauri 的包要 `await preloadPacks()` 才到，而 **ESM 的 import
   在模块体之前求值** —— 照搬原版会把"空结果"永久缓存住。
   第一版就中了这个：词典 `zh=0 en=0 ja=0`，界面把 `main.single` 这种原始 key 直接显示出来。
   现在统一由 `rendering/textures.ts` 的 `packsInstalled()` 把关（**没装好就不建也不缓存**）。
   **同一个坑还踩了第二次**：`main.ts` 原来写的是 `input.rawInputActive = rawInput.available` ——
   原版 `startRawInput()` 是同步 NAPI，`available` 当场为真；Tauri 版它要等
   `invoke("rawinput_start")` 落地才变真，**同步读一次就永久是 false**。后果是原生鼠标捕获
   永远不启用（悄悄退回 `requestPointerLock()`，又撞上 ESC 解锁 + 冷却），raw-input 的视角接管
   也一起失效。现在 `RawInputHandle.ready` 是一个 Promise，调用点必须 await 它。
   **规律：凡是原版靠同步/`require` 拿到的值，移植后都要检查是不是变成异步了。**
6. **多了一条最早期诊断通道 `logs\boot.log`。** Tauri 里前端挂掉是**静默**的（没窗口、没日志），
   所以 `index.html` 里有一个 classic inline 脚本（在 module 之前）直接打 IPC 全局报错，
   `main.ts` 的 preload 也包了 try/catch。内容是 `html loaded` / `error: ...` / `rejection: ...`。
   **排查"窗口不出来"先看这个文件。**
7. **关掉了 WebView2 的浏览器加速键**（`win.rs::disable_browser_accelerator_keys`）。
   WebView2 默认 `AreBrowserAcceleratorKeysEnabled = true`，于是 **F3 会弹出"查找"**
   （本项目里 F3 是调试面板 + F3/F4 游戏模式选择器的热键）、Ctrl+F 弹查找栏、F5 刷新、F12 开 DevTools。
   Tauri 2.11 没暴露这个开关（只有菜单 accelerator），所以走官方的 `with_webview` 拿到
   `ICoreWebView2Controller` 自己设。**代价：Ctrl+C / Ctrl+V / Ctrl+A 也一起关掉**（游戏里不需要）。
   结果写进 `logs\boot.log`。
8. **ESC 由原生钩子吞掉后再合成给页面**（方案 B，`rawinput.rs` 的 `esc_hook`）。
   为什么必须这样：ESC 是浏览器的"默认解锁手势"，由**浏览器进程在把按键交给页面之前**处理
   （`content/browser/renderer_host/render_widget_host_impl.cc` 的 `ForwardKeyboardEvent` →
   `PreHandleKeyboardEvent`；Chrome 层 `exclusive_access_manager.cc:196` 的 `HandleUserKeyEvent`
   只看 keycode，从不查页面有没有 preventDefault）。所以 `main.ts:725` 那个 `preventDefault()`
   （注释引的 #7907）在原生 Chromium/WebView2 上拦不住它 —— 现象就是
   **第 1 次 ESC 只把光标放出来（浏览器解锁），第 2 次才到页面开暂停菜单**。
   现在 `WH_KEYBOARD_LL` 钩子把 ESC **吞掉**（仅当前台窗口属于本进程时），
   经 `esc` 事件推到前端，前端**合成一个真的 KeyboardEvent** 派发到 `document` ——
   于是 `input.ts`/`main.ts` 的监听器、`ui.navigation` 的 ESC 阶梯全都不用改。
   **失败即放行**：钩子没装上就不吞，退回旧行为，日志里会写明。
9. **鼠标捕获不用 Pointer Lock API 了，改走 Win32**（`win.rs::set_mouse_capture` +
   `platform/mousecapture.ts`）。这是最后一块、也是根因那块：
   浏览器的指针锁定**有两条页面管不了的策略** —— ESC 强制解锁，以及解锁之后**一段时间拒绝
   重新锁定**（Blink 的 `kUserEscapeCooldown`，`pointer_lock_controller.cc:273-277`：
   *"Pointer lock cannot be acquired immediately after the user has exited the lock."*）。
   页面无权关闭，Tauri/WebView2 也没暴露开关；NW.js 当年能解决是因为它自带一份**打过补丁的
   Chromium**。所以现在自己捕获：
   * `ClipCursor(客户区)` 把系统光标**物理夹**在窗口里 + `SetCursorPos(中心)`；
   * 光标隐藏仍然交给 CSS（`cursor: none`）—— 光标一定落在 webview 上，够用；
   * **视角旋转强制走 raw input**：`ClipCursor` 把光标夹住后贴边就不动了，`movementX` 会归零
     （和原来"窗口一半在屏幕外"是同一个原因）；
   * **失焦必须释放**（Rust 的 `WindowEvent::Focused(false)` + 前端 `onWinBlur` 两边都做），
     否则 Alt-Tab 之后光标被关在窗口里出不来；
   * **失败即退回** `requestPointerLock()`，原始输入不可用时也走浏览器那套。

   于是 `state.locked` 的含义从"浏览器给了指针锁定"变成"我们自己捕获了鼠标"，
   日志里换成 `MOUSE CAPTURE on/off`，`LOCKCHANGE` / `LOCK rejected` 不再出现。

   光标策略的两条要点（都踩过）：
   * **判据是 `canControl()`，不是 `!isUiModal()`**。加载界面跑在 `load` 模式、不占任何模态面，
     `!isUiModal` 在那时为真 → 光标被藏起来。`canControl` 在鼠标真被捕获之前一直是 false，
     所以启动、配置检查、进世界的加载界面、所有菜单都看得见光标，只有真正在玩时才隐藏。
   * **Alt-Tab 回来要强刷一次光标形状**（`win.rs::nudge_cursor`）。Windows 只在
     `WM_SETCURSOR`（鼠标移动时才发）里决定光标形状，CSS 的 `cursor` 变化不会主动重发它 ——
     失焦期间 CSS 从 `none` 改成 `default`，切回来时不会立刻生效，现象就是
     "**Alt-Tab 回来光标还是隐藏的，动一下鼠标才出现**"。把光标挪 1px 再挪回来即可触发重发。

## 状态（都是实跑出来的）

| 项目 | 结果 |
|---|---|
| `tsc --noEmit`（strict） | **0 errors** |
| `npm run check:ecs` | **54 assertion groups passed / RESULT: OK** |
| `vite build` | **✓ 67 modules transformed，456ms** |
| `cargo check`（`x86_64-pc-windows-gnu`） | **exit 0，3m42s** |
| `cargo build`（链接 exe） | **exit 0，17s → `voxelengine-tauri.exe`** |
| `npm run app:build` | release 3m22s 编成 exe；NSIS 那步下载超时失败（不影响 exe） |
| `npm run app:portable` | **13.7 MB 便携目录，双击可跑**（exe + WebView2Loader.dll + game\） |
| 实跑（dev） | **窗口 `VoxelEngine` 显示、主菜单渲染、包/mod 加载、原始输入线程启动，`BOOT ready in 835ms`** |
| 实跑（release 便携） | **`title='VoxelEngine'`、25 线程、包/mod 加载、`BOOT ready in 434ms`** |

### 工具链：没有 MSVC 也编出来了

Tauri 官方文档要求 Windows 上装 Visual Studio 的「使用 C++ 的桌面开发」工作负载（MSVC + Windows SDK）。
本机只有 mingw-w64 的 `x86_64-pc-windows-gnu`，**实测 `cargo check` 和 `cargo build` 全程通过**，
exe 可以直接运行。唯一一个真的坑跟 MSVC 无关：Tauri 模板的
`[lib] crate-type = ["staticlib", "cdylib", "rlib"]` 里那个 `cdylib` 在 Windows + GNU 下会
`error: export ordinal too large: 90414`（导出全部符号撑爆 mingw 的 ld），桌面版改成
`crate-type = ["rlib"]` 即可。细节见 [docs/PORT-TAURI.md](docs/PORT-TAURI.md)。

### 注意：debug 构建不能双击运行

`cargo build` 的 debug exe 加载的是 `devUrl`（`http://localhost:1420`），不是嵌进去的 `dist\`，
所以裸跑会得到一个空白窗口。用 `npm run app:dev`（tauri dev，自己起 vite）或
`npm run app:build`（release + 嵌入产物，可独立运行）。
