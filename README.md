# 📦 VoxelEngineNWWeb — MC 风格体素沙盒游戏

基于 **NW.js + three.js (WebGPU)** 的 Minecraft 风格体素沙盒。浏览器技术栈做桌面游戏：WebGPU 渲染、像素风 UI、完整的键鼠绑定系统与资源包生态，打包为免安装绿色目录。

## ✨ 特性

- 🧱 **体素世界**：准星射线破坏/放置方块，固定步长物理 + 渲染插值（当前为演示规模：固定生成小方块平台，无区块/地形生成/存档，方块 3 种：默认/草方块/缺失兜底）
- 🎮 **游戏模式**：生存（跳跃）/ 创造（双击空格切飞行）/ 观察者三模式
- 🎒 **背包与快捷栏**：E 键开背包，点击格子与选中快捷栏槽交换；方块图标由 3D 相机实时渲染生成
- 🎮 **按键绑定**：可视化 104 键键盘布局（含小键盘/方向键/鼠标五键），点击换绑、拖拽绑定、Esc 解绑、冲突抢占，持久化到配置文件
- 🖱️ **原始鼠标输入**：Rust 原生插件（napi-rs）绕过 Chromium 指针锁定限制——窗口拖出屏幕边缘也能转视角（插件缺失时自动降级，游戏可正常运行）
- 🎨 **资源包系统**：MC 式 zip 资源包，贴图三级回退（用户包 > 内置 default.zip > missing.png 兜底）+ alphaTest 透明
- 🌐 **中/英/日三语**：词典文件化（资源包内 `lang/*.json`），用户资源包放同名文件即可**免构建改文案**；Fusion Pixel 像素字体 / 系统字体切换
- 🔍 **界面缩放**：rem 根字号方案，小/普通/大/自动四档
- 🪟 **窗口模式**：窗口化 / 全屏（kiosk 直连，免重启切换）；GPU 垂直同步开关（写 manifest，重启生效）+ 帧率上限 30–240/无限
- 📊 F3 调试面板（FPS / GPU 耗时 / 物理状态 / 输入日志）
- 👥 多人模式为主菜单占位按钮（未实现，点击弹提示）

## 🛠 技术栈

| 层 | 技术 |
|---|---|
| 渲染 | three.js 0.185 (WebGPURenderer) |
| 运行时 | NW.js 0.115 SDK（Chromium + Node.js 同进程） |
| 语言 | TypeScript + Vite 8 构建 |
| 原生插件 | Rust（napi-rs v3）→ `rawinput.node`，Win32 Raw Input |
| 桌面工具 | C（MinGW gcc）：`launcher.exe` 启动器（传 `--user-data-dir` 隔离用户数据到 `game\data`，保证绿色目录可整体移动） |
| 打包 | 自研 `rearrange.mjs`（绿色目录组装 + rcedit 进程改名 + fflate 打资源包） |

## 📁 目录结构

```
├─ src/            # TypeScript 源码（渲染/UI/输入/设置）
│  └─ assets/      #   贴图 + 语言文件（构建时打进 default.zip）
├─ rawinput/       # Rust 原生鼠标输入插件
├─ launcher/       # C 启动器源码
├─ scripts/        # get-nw 下载器 / rearrange 绿色打包
├─ app/            # NW.js manifest
└─ release/VoxelEngineNWWeb/   # 构建产物（免安装目录）
   └─ game/core/   # NW.js 运行时 + 游戏 + rawinput.node
```

## ⚙️ 环境要求

- **Node.js ≥ 22**（Vite 8 要求 ≥ 20.19，推荐 22+，本项目以 v24 验证）
- **MinGW-w64**（gcc，在 PATH 中）
- Rust 工具链（仅构建 rawinput 插件时需要；Windows 无 VS 时用 GNU 工具链：`rustup default stable-x86_64-pc-windows-gnu`）

## 🚀 构建与运行

```bash
npm install                # 安装依赖
npm run get-nw             # 下载 NW.js SDK 到 nwjs/
npm run build              # tsc + vite + 打包 + 编译启动器
```

构建完成后直接运行：

```
release/VoxelEngineNWWeb/launcher.exe
```

### 🔧 构建原生鼠标插件（可选）

rawinput 插件提供窗口出屏后的原始鼠标输入，**缺失时游戏自动降级、完全可玩**，因此可跳过本节。

构建需要两步准备（产物 `rawinput/lib/` 已被 .gitignore 排除，新环境必须手动准备）：

1. **准备 libnode 链接库**：从已下载的 NW.js 运行时复制 node.dll 并生成导入库——

   ```bash
   mkdir -p rawinput/lib
   cp nwjs/nwjs-sdk-v0.115.0-win-x64/node.dll rawinput/lib/libnode.dll
   # 生成导入库 (MinGW binutils 的 dlltool; DEF 文件可用 pexports/gendef 生成)
   gendef rawinput/lib/libnode.dll
   dlltool -d rawinput/lib/libnode.def -D libnode.dll -l rawinput/lib/libnode.dll.a
   ```

   > 导入库引用名必须保持 `node.dll`——运行时 `.node` 模块从 `core.exe` 旁的 `node.dll` 解析符号。

2. **核对 `.cargo/config.toml` 的 `LIBNODE_PATH`**：当前写死了绝对路径 `E:\VoxelEngineNWWeb\rawinput\lib`，仓库克隆到其他位置时需改为实际路径。

然后构建：

```bash
cd rawinput && cargo build --release && cd ..
```

下次 `npm run build` 时 `rearrange.mjs` 会自动把 `rawinput/target/release/rawinput.node` 复制进 `game/core/`。

### 可选工具

```bash
npm run build:cursor   # 光标定位工具 (cursor.exe)
npm run build:winctl   # 窗口控制备用工具 (winctl.exe)
```

## 📖 运行时目录（绿色版）

游戏首次运行后会在 `release/VoxelEngineNWWeb/game/` 下生成：

```
game/
├─ core/            # NW.js 运行时 + 游戏 (构建产物, 勿手改)
├─ resourcepacks/   # 资源包: default.zip 内置; 用户 zip/文件夹放这里覆盖贴图/语言
├─ config/          # settings.json (语言/字体/键位/缩放/窗口模式等持久化)
├─ data/            # NW.js 用户数据 (localStorage/缓存, 由启动器隔离)
└─ logs/            # debug.log / renderer.log / launcher.log
```

## 🎨 自定义资源包

往 `game/resourcepacks/` 放 zip 或文件夹即可覆盖内置资源（用户包按目录名字典序倒序，后放的胜）：

```
mypack.zip
├─ block/grass_block_top.png   # 覆盖贴图
├─ missing.png                 # 覆盖缺失兜底图
└─ lang/zh.json                # 覆盖语言词典 (免构建改文案)
```

词典格式见 [src/assets/lang/zh.json](src/assets/lang/zh.json)，key 与 UI 一一对应，缺词自动回退中文。
