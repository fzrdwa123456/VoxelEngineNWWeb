# PORT-TAURI.md — NW.js → Tauri v2 逐文件对照

这份文档只讲**移植**：原来哪个文件干了什么，现在谁干，为什么这么切。
游戏本身的设计（ECS、三条 lane、UI-as-data、资源包格式）没变，看 `AGENTS.md`。

## 一、为什么要这么切

原版的耦合面**非常窄**。全仓库搜 `nw.` / `require(` / `process.`，只有三个文件：

```
src/platform/shell.ts        nw.Window.get() + eval("require")("node:fs") + execFile(cursor.exe)
src/platform/rawinput.ts     require("rawinput.node")（NAPI 原生插件）
src/rendering/textures.ts    node:fs 列目录/读文件 + path
```

其余 100+ 个文件只是 `import { logDebug, readSettings, ... } from "./platform/shell"`。
所以移植的关键不是"改代码"，而是**保住这三个文件的导出 API 形状**，让调用点不用动。

阻碍只有一个：**原版的 `readSettings()` / `resolveTexture()` / `logDebug()` 都是同步的**，
而 Tauri 的命令（`invoke`）是异步的。三条对策：

| 同步读 | 对策 |
|---|---|
| `readSettings()` / `readSettingsChecked()` / `isGpuVsyncDisabled()` / `getWindowMode()` | 启动时 `await preloadShell()` 一次取进内存，之后读内存 |
| `resolveTexture()` / `resolveBytes()` / `resolveAllBytes()` / `listPacks()` | 启动时 `await preloadPacks()` 一次性把包字节取进内存 |
| `logDebug()` / `appendDebugLog()` | 攒批（64 行 / 200ms）后异步发，API 仍是 `void` 同步 |
| `startRawInput()` | Rust 推事件，前端逐条交给 `input.rawDelta()`（判定仍在事件期），每帧 `frameLook()` 应用一次 |

于是 `main.ts` 顶部多了两行 `await` —— 这是**唯一一处启动顺序上的改动**。

## 二、命令一览（Rust → 前端）

`src-tauri/src/lib.rs` 是命令总线，前端 `invoke()` 的名字就在这里：

| 命令 | 参数 | 返回 | 用途 |
|---|---|---|---|
| `preload_shell` | — | `ShellSnapshot` | 设置 + 窗口模式 + vsync 开关 + game root |
| `write_settings` | `value` | `bool` | 写 settings.json（同时更新 Rust 侧缓存） |
| `backup_settings` | — | `String` | 把要覆盖的 settings.json 存成 settings.bad.json |
| `append_log` | `channel`, `lines` | — | 追加 logs\debug.log / renderer.log |
| `preload_packs` | — | `PackSnapshot` | 扫 resourcepacks\ + mods\，返回所有包字节 |
| `show_window` / `focus_window` | — | `bool` / — | 第一帧之后显窗口；显式聚焦 |
| `quit_app` | — | — | 退出（先停原始输入线程） |
| `center_cursor` | — | `bool` | 窗口中心的 SetCursorPos |
| `set_window_mode` | `fullscreen` | `bool` | 窗口/全屏 |
| `window_is_fullscreen` | — | `bool` | 当前是否全屏 |
| `set_vsync_disabled` | `disabled` | `bool` | 写 config\vsync.json（重启生效） |
| `rawinput_start` | — | `RawStats` | 起采集线程 + 推送线程 |
| `rawinput_stats` | — | `RawStats` | 诊断计数 |
| `game_root_of` | — | `String` | 数据目录（排查用） |

事件（Rust → 前端）：

| 事件 | 载荷 | 对应原版 |
|---|---|---|
| `raw-input` | `{dx, dy}` | 原来 `pollDelta()` 拉的原子量，节流 4ms 一批 |
| `win-focus` / `win-blur` | — | 原来 `win.on("focus"/"blur")` |

## 三、Rust 侧文件

```
src-tauri/src/main.rs      入口（release 不带控制台，对应原 launcher.c 的 -mwindows）
src-tauri/src/lib.rs       命令总线 + Builder + 焦点事件转发
src-tauri/src/game.rs      game root / settings.json / 日志 / vsync 开关 / WebView2 参数
src-tauri/src/packs.rs     资源包与 mod 的扫描（只列目录读字节，不做归一化）
src-tauri/src/win.rs       窗口：show / focus / fullscreen / center_cursor
src-tauri/src/rawinput.rs  原始鼠标输入（原 rawinput/src/lib.rs 的直译，NAPI -> Tauri 事件）
```

### rawinput.rs 是怎么变的

采集那一半**逐行照抄**原 `rawinput/src/lib.rs`：`HWND_MESSAGE` 隐藏窗口 +
`RegisterRawInputDevices(RIDEV_INPUTSINK)` + `WM_INPUT` -> `RAWMOUSE.lLastX/Y` -> `AtomicI32`。
Win32 函数仍然是自己 `extern "system"` 声明的（**故意不引入 `windows` crate**，
少一层依赖，也少一处跟工具链较劲的地方）。

变的只是出口：

```rust
// 原来：JS 每帧同步调 NAPI 的 poll_delta()
#[napi] pub fn poll_delta(&self) -> MouseDelta { ACC_DX.swap(0, ...), ACC_DY.swap(0, ...) }

// 现在：多一个节流线程，每 4ms 把累加值取走清零并发事件
std::thread::spawn(move || loop {
    sleep(4ms);
    let (dx, dy) = (ACC_DX.swap(0), ACC_DY.swap(0));
    if dx != 0 || dy != 0 { app.emit("raw-input", MouseDelta { dx, dy }); }
});
```

前端把这个事件直接交给 `PlayerInputSystem.rawDelta(dx, dy)`：接管/宽限/尖峰判定仍在这里（事件期，
rule 3），但**只累加、不应用**；`frame()` 每帧调一次 `input.frameLook()`，把整帧位移变成**一个**
`look` 意图。节流（4 ms 合批）还是必要的：`WM_INPUT` 一秒几百条，一条一个 IPC 事件会把 webview 淹掉。

> 这里曾经是"事件累加进本地 `accDx/accDy`，前端每 8 ms `setInterval` 取走一次"。那个定时器是
> **"按住键转视角不顺滑"的元凶**：Chromium 把 keydown 这类输入任务排在定时器任务之前，按住键
> （自动重复 ~30 次/秒）会把 8 ms 采样挤成 9~12 ms 一档，于是"每帧分到几份"在 0/1/2/3 之间乱跳
> （实测：不按键 122~127 份/秒、90% 的帧恰好 2 份；按住键掉到 84~110 份/秒、只有 ~40% 的帧是 2 份）。
> 改成每帧取一次后，每帧转角度 = 该帧鼠标的真实位移，与主线程在忙什么无关。这是全工程**最后一个
> `setInterval`**，现在前端一个都不剩。

### 鼠标捕获：原生 ClipCursor + 前台门禁 + ESC 桥

原版用浏览器的 pointer lock（`requestPointerLock`），Tauri 版**不碰它**，走 Win32 `ClipCursor` 把系统
光标物理夹在窗口客户区里，配合 `SetCursorPos(中心)` 与一个 4ms 的"光标哨兵"（`win::cursor_sentinel`，
只在"期望的可见性和系统实际不符"时才纠正，稳态零开销）。视觉上等价，但换来三条原版没有的责任：

1. **前台门禁**：`ClipCursor` **不看窗口是不是前台**（浏览器那条 `requestPointerLock` 会自己拒绝），
   而后端原始输入是 `RIDEV_INPUTSINK`（后台也收）。所以"只在前台捕获"必须显式做，三层：
   `PointerLockDeps.focused`（正常路径拒绝）、`enterWorld` 进世界时的自动 relock（不在前台就改开暂停
   菜单）、`win::capture_foreground_check`（系统级兜底：连续两次 tick 前台不是我们 → 放鼠标 + 恢复
   光标 + 发 `capture-lost`，前端按 blur 处理）。
2. **ESC 的默认解锁动作**：浏览器的"ESC 解锁"发生在**浏览器进程**、页面拿到事件之前，`preventDefault()`
   拦不住。Rust 侧装了 `WH_KEYBOARD_LL` 钩子想把 ESC（以及菜单键/Shift+F10 那个上下文菜单手势）吞掉，
   再从 `esc` 事件合成一个真的 `KeyboardEvent` 派发给页面。**但实测这个钩子从未被调用过**
   （`logs\debug.log` 里 `HOOKPROBE seen=0`，多次运行一致）——所以今天真正起作用的是"原生捕获 + 前端
   `preventDefault` + 光标哨兵"这三样，钩子属于"装上但无效、失败即放行"的那部分。
3. **光标可见性归 Rust 管**：CSS 的 `cursor` 只是意图，真正决定屏幕上看不见的是 `SetCursor` 的推送，
   而它的时机不可靠（失焦那一刻的推送会被系统丢掉）。所以前端只告诉 Rust"期望可见/隐藏"
   （`cursor_intent` 命令），哨兵每 4ms 校对一次。

### packs.rs 与 textures.ts 的分工

```
Rust (packs.rs)                          TS (textures.ts)
  列 resourcepacks\ 和 mods\               normalizeKey()：assets/<ns>/textures/x -> x
  文件夹包 -> 递归读成 {rel: base64}        优先级：mods 先、resourcepacks 后
  .zip  包 -> 整个 zip 的 base64            每层一个 Map，overrides 后写覆盖先写
  （不解 zip）                             zip 用 fflate 解（本来就是前端依赖）
```

为什么不全搬到 Rust：归一化和优先级是**纯逻辑**，而且被 `check:ecs` 覆盖着，
搬过去只会引入风险；为什么 zip 不在 Rust 解：那要引入 `zip` + `flate2`，
而前端本来就有 `fflate`。

顺序语义严格对齐原版：每个目录的条目按**名字升序**由 Rust 返回，TS 侧从后往前遍历
（原 `scanPackDir` 就是 `for (let i = entries.length - 1; i >= 0; i--)`）。
内置 `default.zip` 仍然最先入层（最低优先级）。

### settings-diff.ts 为什么单独一个文件

`diffSettings()`（把 settings.json 修成"实际生效的值"）是**纯函数**，
`check:ecs` 要能在 Node 里 `require` 它直接跑。Tauri 版的 `shell.ts` 顶部
import 了 `@tauri-apps/api`（纯 ESM），Node 的 CJS `require` 会炸 —— 所以把这部分
切进零依赖的 `src/platform/settings-diff.ts`，`shell.ts` 只 `export { diffSettings } from ...` 转发。
调用点和断言都还在原位置，只是 `check-ecs.mjs` 的编译清单改成了这一个文件。

## 四、删掉的东西

| 删掉的 | 为什么 |
|---|---|
| `src/nw.d.ts` | NW.js/Node 的全局声明，一个都不存在了 |
| `app/`（NW 清单） | 窗口尺寸/标题/chromium-args 全部搬进 `src-tauri/tauri.conf.json` |
| `launcher/*.c` | `launcher.exe` 的职责（设 `--user-data-dir`、隐藏控制台、转发参数）由 Tauri 二进制自己承担 |
| `scripts/get-nw.mjs` | 不再需要下载 NW.js 运行时 |
| `scripts/rearrange.mjs`（原版） | 打包器整个不需要了；同名新文件只剩"建 game\ 目录 + 可选装示例包" |
| `rawinput/lib/libnode.dll`（29MB）等 | NAPI 插件不再存在，不需要 Node 头文件和导入库 |
| `rcedit` / `resedit` devDependencies | 版本信息与图标由 `tauri build` 自己嵌入 |

## 五、实际构建记录

| 步骤 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `tsc --noEmit -p tsconfig.json` | 0 errors |
| ECS 门禁 | `node scripts/check-ecs.mjs` | 54 assertion groups passed / RESULT: OK |
| 前端产物 | `vite build` | ✓ 67 modules transformed，456ms |
| Rust 检查 | `cargo check`（`x86_64-pc-windows-gnu`） | exit 0，3m42s |
| Rust 链接 | `cargo build`（改了 `crate-type` 之后） | **exit 0，17s -> `voxelengine-tauri.exe`（208MB debug）** |
| 实跑 | vite(1420) + debug exe | **窗口 `VoxelEngine` 显示、主菜单渲染、`BOOT ready in 835ms`** |

实跑那段 `game\logs\debug.log` 的原文（证明每一条链路都通了）：

```
[418ms] PACKS not installed yet (preloadPacks() 还没跑完) — 本次解析走引擎兜底，不写缓存
[833ms] PACKS installed: builtin=0 mods=1 resourcepacks=1 files=11
[833ms] I18N dictionaries loaded (lang/*.json layered merge): zh=0 en=0 ja=0 entries (1 layer(s) of zh.json)
[834ms] BLOCKREG registry loaded: 6 blocks (1 layers of blocks.json) -> [grass, default, missing, ruby, stone, gold]
[848ms] SCHEDULE fixed: 6 systems, 5 batches, 1 parallel pair(s) [...]
[848ms] BOOT render=rAF(60Hz) winFocused=true
[903ms] SETTINGS ok
[921ms] RAWINPUT listener started (Rust thread + raw-input events)
[1487ms] BOOT graphics ready at 639ms
[1683ms] BOOT ready in 835ms
```

三行关键的：`PACKS installed ... files=11` = Rust 扫包 + 前端 fflate 解压这条链通了；
`BLOCKREG ... [grass, default, missing, ruby, stone, gold]` = mod 的 blocks.json 读到了；
`RAWINPUT listener started` = Rust 那条原始输入线程真的起来了。

### 工具链：这台机器没有 MSVC，**GNU 工具链也编出来了**

Tauri 官方文档要求 Windows 上装 Visual Studio 的「使用 C++ 的桌面开发」工作负载（MSVC + Windows SDK）。
本机只有 mingw-w64 的 `x86_64-pc-windows-gnu`（`rustc 1.98.0`，gcc 16.1.0），**实测全程通过**：
`tauri` / `tauri-runtime-wry` / `wry` / `webview2-com` / `windows-targets` 整套依赖，
以及 `tauri-build` 的图标与资源嵌入（`ico` crate）都编过了，最后链接出可运行的 exe。
`webview2-com-sys` 默认走动态链接，用的是它自己 `OUT_DIR` 里那份
`WebView2Loader.dll` 导入库（链接命令里能看到 `-L .../webview2-com-sys-*/out/x64`），
mingw 的 `ld` 认。

过程中**唯一**一个真正的坑，跟 MSVC 无关：

```
error: linking with `x86_64-w64-mingw32-gcc` failed: exit code: 1
ld.exe: error: export ordinal too large: 90414
```

原因：Tauri v2 的模板把 `[lib] crate-type` 写成 `["staticlib", "cdylib", "rlib"]`
（那是给 iOS/Android 准备的）。`cdylib` 在 Windows 下会生成一个"导出全部符号"的
`.def`（链接命令里的 `list.def`），mingw 的 `ld` 的导出序号上限是 65535，
这个 crate 的符号数远超它，于是溢出。桌面版根本不需要 `cdylib`：

```toml
[lib]
crate-type = ["rlib"]     # 原来: ["staticlib", "cdylib", "rlib"]
```

改完 17 秒链接完成。

### 第三个坑：便携目录必须带 WebView2Loader.dll

`tauri build` / `cargo build --release` 会在 `target\release\` 里生成**两个**要一起发布的文件：

```
voxelengine-tauri.exe     8372 KB
WebView2Loader.dll         157 KB   <- 少这个就起不来
```

只拷 exe 的后果非常有迷惑性：进程起来了、有人报告"活着"，但

* 窗口数为 **0**（连隐藏的都没有）
* 线程数 **2**、CPU 时间 **0**
* 加载的模块停在 24 个（USER32/ole32/comctl32 这些静态导入），**没有 WebView2Loader.dll**
* `game\logs\debug.log` **一个字节都不写**（`run()` 里清空日志那步根本没执行）

看起来完全像"卡在加载器阶段"。真凶是 Windows 弹的一个**系统错误框**：

```
voxelengine-tauri.exe - 系统错误
由于找不到 WebView2Loader.dll，无法继续执行代码。
```

关键在于 **那个框是 `csrss.exe` 画的**（`tasklist /v` 里能看到窗口标题挂在 csrss 上），
它**不随失败进程一起消失** —— 所以杀掉应用进程之后框还在，第二次、第三次去看还是同一副假死相。
定位是靠一个对照实验：同一个 exe（SHA256 完全一致）从 `target\release\` 里跑就一切正常，
从只放了 exe 的目录里跑就假死 —— 差别只有那一个 DLL。

`npm run app:portable`（`scripts/package-portable.mjs`）会把两个文件一起拷，
并在缺 DLL 时**直接报错退出**，不再生成一个跑不起来的目录。

### 第五个坑：裸 `cargo build --release` 不嵌前端

Tauri 只在启用 **`tauri/custom-protocol`** feature 时才把 `dist\` 嵌进二进制。
`tauri build` 会自己开它，裸 `cargo build --release` **不会**。

我为了绕开 NSIS 下载超时改用了裸 cargo，结果是：

```
exe = 4216 KB   (正确的大小是 8376 KB)
```

症状**极难定位**，因为它长得跟"卡在加载器"几乎一样：

* 进程活着、**10 个线程**、`msedgewebview2.exe` 的 gpu/network/storage/renderer 子进程全都起来了
  （也就是说 webview 是好的）
* 窗口是隐藏的（`show_window` 永远等不到）、`MainWindowTitle` 是空
* `logs\debug.log` **一行都没有** —— 但 `debug.log` 和 `renderer.log` 是 **0 字节文件**，
  说明 Rust 侧的 `run()` 走到了清空日志那一步
* `logs\boot.log` 也是空的 —— **连 `index.html` 里那个 classic inline 脚本都没跑**，
  这就证明问题不在 JS，而是**页面根本没被加载**

定位靠的是直接搜二进制：Rust 侧的字符串都在（`preload_shell` / `boot_report` /
`tauri://localhost`），但 `assets/index-*.js` 这些**前端产物路径一个都找不到**。

修法两条，任选：

```powershell
npm run app:build     # = tauri build（自己开 feature；NSIS 那步可能因下载超时失败，不影响 exe）
npm run app:exe       # = cargo build --release --features custom-protocol
```

并且 `scripts/package-portable.mjs` 现在会**主动校验**：把 exe 读成二进制、检查
`dist\assets\*` 的文件名是否出现在里面，没有就直接报错退出 —— 这类错误不会再静默通过。

### 第六个坑（我自己引入的回归）：包是异步到的，不能缓存"空结果"

原版 `fs.readFileSync` 是同步的，所以三个"读包"的地方都放心大胆地缓存：

| 位置 | 原版做法 | Tauri 里照搬的后果 |
|---|---|---|
| `ui/i18n.ts` | 模块作用域建三本词典 | `zh=0 en=0 ja=0`，界面显示原始 key（`main.single`） |
| `blockregistry.ts` | 首次调用建注册表并置 `loaded` | 永久只剩 `FALLBACK_DEFS` |
| `ui/background.ts` | 首次调用决定菜单背景并 memo | 永久记成 `"checker"` |

根因：包要 `await preloadPacks()` 才到，而 **ESM 的 `import` 在模块体之前求值** ——
`main.ts` 顶部那两行 await 救不了已经在 import 阶段跑掉的代码。

证据就在日志里，而且自相矛盾得很明显（第一版我没看出来）：

```
[105ms] PACKS not installed yet (preloadPacks() 还没跑完) — 本次解析走引擎兜底，不写缓存
[244ms] I18N dictionaries loaded: zh=0 en=0 ja=0 entries (1 layer(s) of zh.json)
                                         ^^^^^^ 0 词条，却找到了 1 层
```

现在统一由 `rendering/textures.ts` 的 `packsInstalled()` 把关：**包没装好就不建、也不缓存**。
修好之后：

```
[230ms] I18N dictionaries loaded: zh=88 en=88 ja=88 entries (1 layer(s) of zh.json)
```

### 最早期诊断通道：`logs\boot.log`

Tauri 里前端挂掉是**静默**的，这在上面的排查里浪费了最多时间。所以现在有三层网：

1. `index.html` 里一个 **classic inline 脚本**（必须在 module 之前），装 `error` /
   `unhandledrejection` 监听，直接打 `window.__TAURI_INTERNALS__.invoke("boot_report", ...)`
   —— 故意不经过 `@tauri-apps/api`，因为坏掉的可能正是它。第一句就是 `html loaded`。
2. `main.ts` 顶部那两个 `await` 包了 try/catch，失败时 `bootReport` + 写进 `document.title`
   （进程列表里能看到）。
3. Rust 侧 `boot_report` 命令把它们追加到 `logs\boot.log`。

**排查"窗口不出来"的第一步就是看 `game\logs\boot.log`**：
空 = 页面没加载（多半是第五个坑）；只有 `html loaded` = 页面加载了但 module 挂了；
有 `preload failed: ...` = IPC 层的问题。


`cargo build` 出来的 debug exe **不能直接双击运行**：Tauri 在 `debug` 且没有开
`custom-protocol` feature 时，webview 加载的是 `tauri.conf.json` 的 `devUrl`
（`http://localhost:1420`），而不是嵌进去的 `dist\`。所以裸跑 debug exe 会得到一个
空白窗口 —— 现象是"进程活着、有窗口句柄、`debug.log` 是 0 字节"。

正确跑法有两种：

```powershell
npm run app:dev         # = tauri dev，它自己起 vite(1420) 再跑 debug exe
npm run app:build       # = tauri build，release + 嵌入 dist，产物可独立运行
```

手动等价于第一种：

```powershell
npm run dev             # 一个终端跑 vite
src-tauri\target\debug\voxelengine-tauri.exe
```

