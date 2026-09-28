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
npm run app:windows      # 一条龙：前端门禁 + release 构建 + 打包 -> release\VoxelEngineTauri\
npm run app:android      # 一条龙：前端门禁 + 交叉编译 + Gradle -> release\VoxelEngineTauri-android\
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
npm run check                          # tsc --noEmit(strict) + check:ecs（69 组断言）
npm run build                          # tsc && vite build -> dist\
node scripts/build-all.mjs --cargo     # 再带上 cargo check
```

## 一条龙构建（两个平台各一条命令）

```powershell
npm run app:windows                     # 桌面：门禁 -> cargo release -> release\VoxelEngineTauri\
npm run app:windows -- --debug          # 桌面 debug：嵌了前端的 debug exe（**可双击运行**，不打包）
npm run app:windows -- --skip-frontend  # 信任现有 dist\（快速重打包）
npm run app:windows -- --skip-build     # 只重打包已编好的 exe
npm run app:windows -- --no-packs       # 不带示例包

npm run app:android                     # 安卓：门禁 -> 交叉编译 -> Gradle -> release\VoxelEngineTauri-android\
npm run app:android -- --release        # release APK（小很多）
npm run app:android -- --target all     # 全部 ABI
```

**两条链的第一步都是同一个"前端门禁"**：`tsc --noEmit` + `check:ecs`（69 组）+ `vite build`。
**这一步不能省**：`tauri-codegen` 用 `include_bytes!` 把 `dist\` 嵌进二进制，cargo 会追踪它，
但前提是 **`dist\` 已经重新生成过** —— 跳过它就会把**上一次的前端**编进 exe / `.so`，而且不报错。
（`npm run app:build` = `tauri build` 白拿这一步，因为 Tauri 会跑 `beforeBuildCommand`；
裸 `cargo build` 和安卓链都不会，所以现在由脚本负责。）

细粒度的老命令仍然保留：`app:exe`（只编译）、`app:portable`（只打包）。

## 安卓（实验性：能启动，还不能玩）

```
npm run app:android                     # debug APK，arm64-v8a（现代手机都是）
npm run app:android -- --release        # release APK（小很多）
npm run app:android -- --target all     # 全部 ABI（4 次 Rust 编译 + 4 个包，慢）
npm run app:android -- --skip-frontend  # 信任现有 dist\（快速重打包）
npm run app:android -- --skip-build     # 只把已编好的 APK 重新发布到 release\
```

产物：`release\VoxelEngineTauri-android\VoxelEngine-<abi>-<profile>.apk`（+ 一份 README.txt）。
装法：把 APK 传手机点安装，或 `adb install -r <apk>`。

需要三件事：
1. **Android SDK + NDK + JDK 17**，并设好 `ANDROID_HOME` / `JAVA_HOME`（`NDK_HOME` 可省，脚本取
   `%ANDROID_HOME%\ndk\` 里最新那个）
2. **WebGPU**：渲染器**没有 WebGL 回退**，设备不支持就是黑屏。手机 Chrome 打开 `chrome://gpu` 看
   "WebGPU"（Chrome 和系统 WebView 是同一份 Chromium）
3. 首次 clone 后先跑一次 `npm run tauri -- android init`（`src-tauri/gen/` 被 gitignore，脚本会自己打补丁）

**现在能用的**：加载屏、主菜单、所有 DOM 界面（点按 = 点击）。
**现在不能用的**：**没有触摸操作** —— 没摇杆、没视角拖动、没屏上按钮，所以能进世界但不能玩。

脚本自己处理的三件麻烦事（换台机器也需要）：
- 生成的安卓工程里 Gradle 用 `services.gradle.org`（这里只有 ~20KB/s）→ 换腾讯镜像；Maven → 阿里云
- 安卓那层"胶水"（`tauri.settings.gradle`、`app/tauri.build.gradle.kts`、`generated/*.kt`）**不在
  `android init` 里**，是构建期由 CLI 生成的 → 脚本会调一次 CLI 生成它（并在符号链接那步失败，属预期）
- Tauri 用**符号链接**把 `.so` 放进 `jniLibs`，Windows 没开开发者模式就会失败 → 脚本改成**真实复制**，
  并断开 Gradle 对 CLI 任务的依赖

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
| `platform/rawinput.ts`：`require("rawinput.node")` 这个 NAPI 插件 | 重写：采集在 Rust（`src-tauri/src/rawinput_session.rs` + 平台采集器 `src-tauri/src/platform/windows/rawinput.rs`），Rust 每 4ms `emit("raw-input")` 推增量；前端逐条做判定（事件期）并累加，**每帧 `frameLook()` 应用一次** —— 视角路径上没有任何定时器 |
| `rendering/textures.ts`：`node:fs` 列目录 + 读 zip | 字节由 Rust 扫好（`packs.rs`）一次性取来，**MC 命名空间归一化/优先级/layering 一行没动** |
| `main.ts` 顶部 `initShell()` | 多了两行 `await preloadShell(); await preloadPacks();` —— Tauri 命令是异步的，而后面所有读都是同步的 |

**除这三个文件外，`src/` 下其余文件、几十处 `logDebug`/`readSettings`/`resolveTexture`
调用点，一个都没改**；`check:ecs` 的断言组全部照常通过（现在是 69 组）。

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
   永远不启用（P1.72 之后连"悄悄退回 `requestPointerLock()`"这条回退都删了：捕获直接拒绝，
   因为没有 raw input 就没有视角来源），raw-input 的视角接管也一起失效。现在
   `RawInputHandle.ready` 是一个 Promise，调用点必须 await 它。
   **规律：凡是原版靠同步/`require` 拿到的值，移植后都要检查是不是变成异步了。**
6. **多了一条最早期诊断通道 `logs\boot.log`。** Tauri 里前端挂掉是**静默**的（没窗口、没日志），
   所以 `index.html` 里有一个 classic inline 脚本（在 module 之前）直接打 IPC 全局报错，
   `main.ts` 的 preload 也包了 try/catch。内容是 `html loaded` / `error: ...` / `rejection: ...`。
   **排查"窗口不出来"先看这个文件。**
7. **关掉了 WebView2 的浏览器加速键**（`platform/windows/webview.rs::disable_browser_accelerator_keys`）。
   WebView2 默认 `AreBrowserAcceleratorKeysEnabled = true`，于是 **F3 会弹出"查找"**
   （本项目里 F3 是调试面板 + F3/F4 游戏模式选择器的热键）、Ctrl+F 弹查找栏、F5 刷新、F12 开 DevTools。
   Tauri 2.11 没暴露这个开关（只有菜单 accelerator），所以走官方的 `with_webview` 拿到
   `ICoreWebView2Controller` 自己设。**代价：Ctrl+C / Ctrl+V / Ctrl+A 也一起关掉**（游戏里不需要）。
   结果写进 `logs\boot.log`。
8. **ESC 现在是普通按键；原生钩子只剩"右键菜单手势"那一半。**
    （P1.72 之前）ESC 是浏览器的"默认解锁手势"，由**浏览器进程在把按键交给页面之前**处理
    （`content/browser/renderer_host/render_widget_host_impl.cc` 的 `ForwardKeyboardEvent` →
    `PreHandleKeyboardEvent`；Chrome 层 `exclusive_access_manager.cc:196` 的 `HandleUserKeyEvent`
    只看 keycode，从不查页面有没有 preventDefault），所以 `preventDefault()` 拦不住它，只能靠
    `WH_KEYBOARD_LL` 钩子把 ESC 吞掉再合成一个 KeyboardEvent 给页面。
    现在**引擎完全不用 Pointer Lock API**（见第 9 条），ESC 就是普通按键、一次就能开暂停菜单，
    所以钩子的 ESC 那一半已删除（P1.72）；保留的是**菜单键 / Shift+F10**：Windows 收到它们会进入
    菜单模式并把光标换成箭头（DOM 的 `contextmenu` preventDefault 拦不住操作系统这一步），
    钩子在 Windows/Chromium 看到之前就把它吞掉。**失败即放行**（钩子没装上就不吞，日志里写
    `MENU HOOK installed / NOT installed`），且只在本窗口是前台时才吞。
9. **鼠标捕获不用 Pointer Lock API 了，改走 Win32 + 中心锁**（`cursor_session.rs::set_mouse_capture` +
    `platform/mousecapture.ts`）。浏览器的指针锁定有两条页面管不了的策略 —— ESC 强制解锁、解锁后
    一段时间拒绝重新锁定（Blink 的 `kUserEscapeCooldown`，`pointer_lock_controller.cc:273-277`），
    而且**解锁后光标会被放回"上锁前的位置"**，所以"菜单光标落在准星上"根本没法在它上面实现。
    P1.72 起**彻底不用它**（连回退都删了：原始输入不可用时捕获直接拒绝，而不是偷偷换机制）。现在：
    * **中心锁（P1.76/P1.77，抄 SDL3 = 抄 MC）**：捕获期间 `ClipCursor` 把系统光标夹在
      **准星上的 1×1 像素框**里（远程桌面自动放宽到 5×1，就是 SDL 的 `remote_desktop_adjustment`，
      开关 `SDL_HINT_MOUSE_RELATIVE_MODE_CENTER` 默认开）→ **指针物理上不能移动**，于是
      "菜单出现时光标在准星上"变成裁剪的副产品，而不是靠"移动"实现。
      这也让 P1.70→P1.75 那一整串居中补丁（欠账 / 结算 / 在看不见的时刻付账 / 干脆不居中）全部作废，
      `hand_back_warp` 恒为空操作（保留只作保险）。
      ⚠️ 它**故意反转了 P1.63 的不变式**（"交给 `ClipCursor` 的矩形必须包含指针"）：现在是
      "指针在框外也没关系，夹进来就是机制"。当年那个拖窗口会拽指针的问题，按 SDL 的办法兜住：
      **窗口拖拽/缩放会话期间整个释放裁剪**（`CLIP_POSTPONED` + `win-session`，前端同时暂停），
      而且"用户手按着边框时的捕获请求"本来就拒绝。
    * **视角旋转强制走 raw input**：`WM_INPUT` 的增量与光标位置无关（这也是"顶到边不冻"的原因）。
    * **鼠标按键也走 raw（P1.76）**：同一批 `WM_INPUT` 包里的 `usButtonFlags`（SDL 就是这么做的），
      所以**叠加层（Win+; / 输入法候选窗）挡着时左右键照样破坏/放置**。归属明确：
      捕获期间 raw 拥有按键、光标自由时 DOM 拥有（一次点击永不重复计数）；`releaseCapture()` 会
      清掉按住的鼠标绑定，防止"按下后释放落到别的窗口"卡住。
    * **叠加层不暂停（P1.75）**：检测到"别人一直在画光标"就**停止推形状、但保住捕获** —— 不暂停、
      视角继续转，叠加层那个系统光标也被钉在准星上直到它关闭。
    * **失焦必须释放**（Rust 的 `WindowEvent::Focused(false)` + 前端 `onWinBlur` 两边都做），
      否则 Alt-Tab 之后光标被关在窗口里出不来。
    * **锁屏解锁后光标什么时候出现，交回 Windows 默认（P1.78）**：解锁后系统会有一段时间
      "句柄装了但不画"，要等真实鼠标输入才画。P1.73 曾用一次净位移为 0 的 `SendInput` 强行让它
      立刻出现，按需求已删除。

    于是 `state.locked` 的含义从"浏览器给了指针锁定"变成"我们自己捕获了鼠标"，
    日志里换成 `MOUSE CAPTURE on/off`，`LOCKCHANGE` / `LOCK rejected` 不再出现。

    光标策略的两条要点（都踩过）：
    * **判据是 `canControl()`，不是 `!isUiModal()`**。加载界面跑在 `load` 模式、不占任何模态面，
      `!isUiModal` 在那时为真 → 光标被藏起来。`canControl` 在鼠标真被捕获之前一直是 false，
      所以启动、配置检查、进世界的加载界面、所有菜单都看得见光标，只有真正在玩时才隐藏。
    * **Alt-Tab 回来要强刷一次光标形状**（`platform/pointerlock.ts::nudgeCursor` 的两步 CSS
      `auto`→`default`，加 Rust 的 `refresh_cursor`）。Windows 只在 `WM_SETCURSOR`（鼠标移动时才发）
      里决定光标形状，CSS 的 `cursor` 变化不会主动重发它 —— 失焦期间 CSS 从 `none` 改成
      `default`，切回来时不会立刻生效，现象就是"**Alt-Tab 回来光标还是隐藏的，动一下鼠标才出现**"。

## 状态（都是实跑出来的）

| 项目 | 结果 |
|---|---|
| `tsc --noEmit`（strict） | **0 errors** |
| `npm run check:ecs` | **69 assertion groups passed / RESULT: OK** |
| `rustc --test src-tauri/src/cursor_model.rs` | **29 passed**（纯规则层，不需要窗口/GPU） |
| `vite build` | **✓ 132 modules transformed，478ms** |
| `cargo check` / `cargo build`（`x86_64-pc-windows-gnu`） | **exit 0**，只有两个既有警告 |
| `npm run app:windows` | **一条龙：门禁 → release exe → 13.8 MB 便携目录（25 文件）** |
| `npm run app:windows -- --debug` | **可双击运行的 debug exe**（219 MB，嵌了前端；实测启动出窗口且前端日志正常） |
| `npm run app:build` | release 编成 exe；NSIS 那步要从 GitHub 下 nsis-3.11.zip，网络不好会超时（不影响 exe） |
| `npm run app:android` | **一条龙：交叉编译 → Gradle → `release\VoxelEngineTauri-android\`，APK 133.7 MB**（arm64-v8a / minSdk 24） |
| 实跑（dev） | **窗口 `VoxelEngine` 显示、主菜单渲染、包/mod 加载、原始输入线程启动，`BOOT ready in 835ms`** |
| 实跑（release 便携） | **`title='VoxelEngine'`、25 线程、包/mod 加载、`BOOT ready in 434ms`** |

### 工具链：没有 MSVC 也编出来了，但 `cdylib` 有个只出现在 debug 的坑

Tauri 官方文档要求 Windows 上装 Visual Studio 的「使用 C++ 的桌面开发」工作负载（MSVC + Windows SDK）。
本机只有 mingw-w64 的 `x86_64-pc-windows-gnu`，**实测 `cargo check` / `cargo build` 全程通过**，
exe 可以直接运行。唯一一个真的坑跟 MSVC 无关，是**模板的 crate-type**：

```toml
# Tauri 模板默认（这里不要照抄）
crate-type = ["staticlib", "cdylib", "rlib"]
```

`crate-type` 是**属于整个 package** 的（Cargo 不支持按目标区分），所以清单里写了 `cdylib`，
**每一次桌面构建也会去链接那个 `.dll`**，而 Windows + GNU 工具链**链接不了 debug 的那一份**：

```
ld.exe: error: export ordinal too large: 90913
```

release 能扛过去（LTO + `opt-level="s"` + `strip` 把导出符号数压到 binutils 的 ordinal 上限之下），
但 debug 不行 —— 而 debug 正是 `tauri dev` 用的 profile，所以**模板那行会连带弄坏 `npm run app:dev`**。

所以这里的做法是：**清单只留 `crate-type = ["rlib"]`**，安卓需要的 `.so` 由
`scripts/build-android.mjs` 用 **`cargo rustc --lib --crate-type cdylib`** 单独产出（一次调用级别的
覆盖，不碰清单、不影响桌面）。细节见 [docs/PORT-TAURI.md](docs/PORT-TAURI.md)。

### debug 构建：默认不能双击，但现在有一条命令

裸 `cargo build` 的 debug exe 加载的是 `devUrl`（`http://localhost:1420`），不是嵌进去的 `dist\`，
所以直接双击会得到**空白窗口**（进程活着、WebView2 都起来了、日志一行没有，看起来像"卡在加载器"）。
三种可用方式：

| 想干什么 | 用什么 |
|---|---|
| 开发（热重载） | `npm run app:dev`（tauri dev 自己起 vite） |
| **一个能双击的 debug exe** | `npm run app:windows -- --debug`（debug profile + 嵌入产物） |
| 发布 | `npm run app:windows`（release + 嵌入产物 + 打包） |
