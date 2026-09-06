# 📦 VoxelEngineNWWeb — MC 风格第一人称沙盒（纯 ECS 架构）

基于 **NW.js + three.js (WebGPU)** 的 Minecraft 风格第一人称沙盒。浏览器技术栈做桌面游戏：WebGPU 渲染、像素风 UI、完整的键鼠绑定系统与 mod/资源包生态，打包为免安装绿色目录。

> **当前状态**：星球/体素世界系统已拆除重建中——进入世界是空天空（行走会持续下坠，创造模式双击空格飞行可用，Shift ×25 测试疾跑）。方块目前只存在于物品栏 UI；mod/资源包生态完好。
>
> **给 AI / 协作者**：工程地图、目录职责与铁律见 **[AGENTS.md](AGENTS.md)**（英文：两条时钟、稳定组件引用、注册顺序承重、竞态代码勿简化）。

## ✨ 特性

- 🧩 **纯 ECS 架构**：自研轻量调度器（World，120Hz 固定步长 + 每帧渲染双通道）+ 实体存储（spawn/despawn/类型安全组件/Query 查询）+ 查询驱动的系统（新实体挂组件即被自动处理）
- 🚶 **三模式移动**：行走（重力）/ 创造飞行（双击空格切飞行，俯仰可翻越天顶 360°）/ 观察者，固定步长物理 + 渲染插值
- 🧩 **内容 mod 系统**：方块注册表数据驱动（`blocks.json`），`game\mods\` 放文件夹/zip 即可**新增方块**或**改造已有方块**，免构建自带贴图
- 🎨 **资源包系统**：MC 式三层命名空间（`assets/<ns>/...`），资源包可覆盖 mod 与本体的贴图/背景/语言（资源包 > mods 的优先级语义，与 MC 一致）
- 🌐 **中/英/日三语**：词典文件化（`lang/*.json` 多层合并），mod/资源包可增量补词条；Fusion Pixel 像素字体 / 系统字体切换
- 🖼️ **主菜单背景三模式**：球体全景环视（等距柱状全景图）/ 静态图 / 程序化紫黑棋盘格兜底，由资源包 `backgrounds/background.json` 配置
- 🛡️ **全程序化兜底**：缺贴图/缺 mod/缺语言全部落到引擎内置紫黑棋盘格（硬编码 data URL），空环境永不崩溃、永不黑屏
- 🚀 **MC 式多开**：双击多次自动分配独立数据目录（互斥体找槽：data → data2 → data3...），单机联机测试无需复制目录
- 🎮 **游戏模式**：生存（跳跃）/ 创造（双击空格切飞行）/ 观察者三模式
- 🎒 **背包与快捷栏**：E 键开背包，物品栏自动填充注册表方块（mod 新方块自动出现）；方块图标由 3D 相机实时渲染生成
- 🎮 **按键绑定**：可视化 104 键键盘布局（含小键盘/方向键/鼠标五键），点击换绑、拖拽绑定、Esc 解绑、冲突抢占，持久化到配置文件
- 🖱️ **原始鼠标输入**：Rust 原生插件（napi-rs）绕过 Chromium 指针锁定限制——窗口拖出屏幕边缘也能转视角（插件缺失时自动降级）
- 🔍 **界面缩放**：rem 根字号方案，小/普通/大/自动四档
- 🪟 **窗口模式**：窗口化 / 全屏（kiosk 直连，免重启切换）；GPU 垂直同步开关 + 帧率上限 30–240/无限
- 📊 F3 调试面板（FPS / GPU 耗时 / 物理状态 / 输入日志）
- 👥 多人模式为主菜单占位按钮（未实现）

## 🛠 技术栈

| 层 | 技术 |
|---|---|
| 渲染 | three.js 0.185 (WebGPURenderer) |
| 运行时 | NW.js 0.115 普通版（无 DevTools/SDK 工具；Chromium + Node.js 同进程） |
| 语言 | TypeScript + Vite 8 构建 |
| 原生插件 | Rust（napi-rs v3）→ `rawinput.node`，Win32 Raw Input |
| 桌面工具 | C（MinGW gcc）：`launcher.exe` 启动器（多实例槽位分配 + `--user-data-dir` 隔离，保证绿色目录可整体移动） |
| 打包 | 自研 `rearrange.mjs`（绿色目录组装 + rcedit 进程改名） |

## 📁 目录结构

```
├─ src/            # TypeScript 源码（全英文注释）
│  ├─ ecs/         # 父调度器 World + 实体存储 store + 组件(components/) + 系统(systems/)
│  ├─ rendering/   # 相机视角系统、纹理/资源包链解析、3D 图标烘培
│  ├─ platform/    # NW.js 宿主、键位绑定、原始输入、指针锁定、日志、性能采样
│  └─ ui/          # 主菜单/暂停设置/可视化键盘换绑/HUD/背包/三语/缩放/字体
├─ packs/          # 官方示例：方块 mod（blocks.json+贴图）+ 资源包（三语词典/主菜单背景）
├─ rawinput/       # Rust 原生鼠标输入插件
├─ launcher/       # C 启动器源码（多实例槽位分配）
├─ scripts/        # get-nw 下载器 / rearrange 绿色打包
├─ app/            # NW.js manifest 源（rearrange 拷为 game/core/package.json）
├─ AGENTS.md       # AI 协作指南：架构地图 / 数据流 / 铁律（英文）
└─ release/VoxelEngineNWWeb/   # 构建产物（免安装目录）
   └─ game/
      ├─ core/           # NW.js 运行时 + 游戏 + rawinput.node
      ├─ mods/           # 方块 mod（玩家手动放, 构建后为空）
      └─ resourcepacks/  # 资源包（玩家手动放, 构建后为空）
```

> **A 方案（全外部化）**：构建不生成任何内置资源包——`src/assets/` 已移除，语言/背景/方块贴图全部由玩家手动放入 `game\resourcepacks\` 与 `game\mods\`。空环境下游戏依靠程序化兜底（紫黑棋盘格 + key 显示）依然可运行。

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
release/VoxelEngineNWWeb/launcher.exe          # 客户端 1（数据目录 game\data）
release/VoxelEngineNWWeb/launcher.exe          # 再双击 = 客户端 2（自动 game\data2）
release/VoxelEngineNWWeb\launcher.exe --3      # 显式指定槽位 3
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

```
game/
├─ core/            # NW.js 运行时 + 游戏 (构建产物, 勿手改)
├─ mods/            # 方块 mod: 每个文件夹/zip 一个, 放 blocks.json + 贴图
├─ resourcepacks/   # 资源包: 贴图/背景/语言, 优先级最高 (可改 mod 的皮)
├─ config/          # settings.json (语言/字体/键位/缩放/窗口模式等持久化, 多实例共享)
├─ data/            # NW.js 用户数据 实例1 (localStorage/缓存)
├─ data2/ data3/…   # 多开时 launcher 自动分配的独立实例目录
├─ saves/           # 存档 (预留)
└─ logs/            # debug.log / renderer.log / launcher.log / launcher2.log…
```

## 🧩 制作方块 mod

往 `game\mods\你的mod\` 放文件即可（文件夹或 zip 均可，重启生效）：

```
你的mod/
└─ assets/voxel/
   ├─ data/
   │  └─ blocks.json          # 方块定义
   └─ textures/
      └─ block/xxx.png        # mod 自带贴图
```

`blocks.json` 条目格式：

```json
{
  "grass": { "label": "草方块", "top": "block/grass_block_top.png", "side": "block/grass_block_side.png", "bottom": "block/dirt.png" },
  "ruby":  { "label": "红宝石块", "all": "block/dirt.png" },
  "neon":  { "label": "霓虹块", "color": "#ff00aa" }
}
```

| 字段 | 作用 | 缺省 |
|---|---|---|
| `label` | 显示名（物品栏悬停） | 用 id |
| `color` | 纯色方块（CSS 色值） | 绿色 |
| `side` / `top` / `bottom` | 贴图路径（包内相对） | top/bottom 回退 side |
| `all` | 六面同图（简写） | — |

**合并规则**：多个 mod 的 `blocks.json` 逐层合并——不同 id 并集（新增方块）、同 id 高优先级胜（改造方块）。优先级：`resourcepacks` > `mods`（按目录名字典序倒序）。

## 🎨 制作资源包

往 `game\resourcepacks\你的包\` 放文件（与 mod 同构，优先级最高，可覆盖一切）：

```
你的包/
└─ assets/voxel/
   ├─ lang/zh.json                  # 增量词条或覆盖文案
   ├─ backgrounds/                  # 主菜单背景
   │  ├─ background.json            # {"mode": "panorama" | "static"}
   │  ├─ mainmenu.png               # 静态背景图
   │  └─ panorama.png               # 全景图 (2:1 等距柱状)
   └─ textures/block/dirt.png       # 覆盖 mod/本体的同名贴图
```

**路径归一化**：包内 `assets/<命名空间>/` 前缀自动剥除（命名空间可任意命名），`textures/` 分类层可选——以下三种结构等价：

```
assets/voxel/textures/block/dirt.png   ≡   assets/voxel/block/dirt.png   ≡   block/dirt.png
```

**语言词典**：`lang/{zh,en,ja}.json` 多层合并，mod 可增量补词条，缺词回退英文再回退 key。

**背景配置**：`backgrounds/background.json` 的 `mode` 决定主菜单背景——`panorama`（球体环视）需同目录 `panorama.png`；`static` 需 `mainmenu.png`；配置缺失/图缺失一律程序化紫黑棋盘格。
