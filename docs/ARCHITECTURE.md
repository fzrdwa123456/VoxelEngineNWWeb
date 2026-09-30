# 架构说明 — 微内核插件化架构 + DOD

这份文档回答三个问题：**这是什么架构、为什么这样分层、数据为什么长这样。**
代码怎么建怎么跑在 `README.md`；要改代码前必须读的规则在 `AGENTS.md`；计划与欠账在 `ROADMAP.md`。

> 本文档描述**已经存在**的东西。数字和状态截至 **P1.18b 收尾**（插件全部走"文件夹自动发现"、内核不再 import 插件）。

---

## 1. 一句话

**架构 = 微内核（插件）架构**：核心只懂机制，功能一律是贡献进来的插件。
**编程思想 = DOD（数据导向设计）**：数据按"被谁怎么读"来摆，而不是按"它代表什么"来摆。

两者是配套的：微内核决定**代码放哪、谁能看见谁**，DOD 决定**数据长什么样、什么时候能动**。

---

## 2. 层次与职责

```
src/
├── core/       微内核：机制。不认识"方块/玩家/菜单"这些词
│   ├── data/     DOD 底座：entity(句柄) / component(SoA 列 & 冷记录) / query / store / resource(令牌)
│   ├── flow/     执行模型：schedule(三阶段 + after/before + access + 批次 + gap) / boot(BOOT_FLOW 走针)
│   ├── effect/   命令队列（副作用排队成数据，屏障处落盘）+ 与实体无关的命令
│   ├── services/ 无平台依赖的服务：bus(配置变更总线) / perf(采样器) / settings-diff(纯修复)
│   ├── plugin/   ★ 插件机制的实现：descriptor / api / lifecycle / hotplug / teardown / ui-tables
│   ├── extension/★ 扩展点：point(类型令牌) / slots(11 个内置插槽) / registry(谁贡献了什么)
│   └── world.ts  门面：spawn / insert / query / resource / addSystem / stepFixed / render / renderUi
├── plugins/    功能：每个插件自带它拥有的数据，并且**自己构造自己的系统**
│   ├── <id>/plugin.ts   ★ 发现适配器：文件夹存在即被收录；把宿主实例收窄成自己的工厂参数
│   ├── <id>/index.ts    ★ 插件本体：definePlugin({ id, deps, setup }) + api.system(...) 声明
│   ├── player/   components.ts + commands.ts + systems/(input, snapshot, controller, movement, collision, interaction)
│   ├── render/   systems/(camera, chunk-stream, outline, menu-background, diagnostics)
│   ├── ui/       components.ts + systems/(reconcile 是唯一 DOM 写者，另有 hud/loading/bindings/
│   │             navigation/delays/ui-pages)+ views/（建树与注册动作 id 的接线）
│   ├── ui-debug / ui-toast / ui-inventory / ui-keybind / ui-crosshair   四个可选面 + 准星（可热插拔）
│   ├── diagnostics / content-default / world / input                    核心四件
├── host/       唯一有副作用的地方
│   ├── desktop/  shell(Tauri：设置/日志/窗口/vsync) / packs(资源包预载) / debuglog(诊断队列转发)
│   └── browser/  viewport / rawinput / pointerlock / mousecapture / window-guards /
│                 presentation(GPU·DOM 工厂) / chunkmesh(网格化) / blockicons(图标烘焙)
├── data/       纯值：globals(资源形状 + 所有共享表 + 三个"发布句柄"资源) / assets(资源包链产物) / world(体素数据)
├── shared/     类型与纯工具：math/raycast（体素 DDA）、math/view、types/ui
└── boot/       装配根 main.ts：读清单 → 装插件 → 插资源 → start，并持有唯一 rAF 链
                另有 manifest(插件清单) / plugin-catalog(文件夹发现) / plugin-catalog 的 glob
```

**放置规则**（新文件该去哪）：
碰 OS/浏览器/Tauri → `host/`；每 tick 改实体数据 → 所属插件的 `systems/`；实体状态本身 →
所属插件的 `components.ts`；只是被"存着"的值（表、常量、资源形状）→ `data/`；无状态纯函数 →
`shared/`；写 DOM → 只有 `plugins/ui/systems/reconcile.ts` 一个地方。

---

## 3. 依赖方向（微内核的骨头）

| 层 | 拥有 | 可以 import | 绝对不 |
|---|---|---|---|
| `core/` | 机制 | `core/` `shared/` `data/`(**仅类型**) | 游戏词汇、`plugins/`、`host/`、`boot/` |
| `plugins/*` | 一个功能**以及它拥有的数据** | `core/` `shared/` `data/` 自己目录 + **已声明 deps 的兄弟插件** | 别的插件的内部、直接 `host/` |
| `host/` | 外部世界 | `core/` `shared/` | `plugins/`（宿主不认识插件） |
| `data/` | 只有值（以及写这些值的命令） | `core/`(声明机制 `defineResource`/`defineCommand` + 令牌类型) `shared/` | 运行期 import `plugins/`/`host/`、副作用、监听器、模块级可变状态 |
| `shared/` | 类型与纯函数 | 无 | 其它一切 |
| `boot/` | 装配（含内核不能点名的能力的实现，如 `boot/ui-tables.ts`） | 全部 | — |

**判定条款**：核心只做机制 / 有扩展点 / 有注册表 / 有生命周期（可选）/ 依赖必须声明。
只有前两条 → 普通插件架构；全都有 → 微内核级。权限模型**不是**判定项（那是安全，另一个维度）。

**当前实测（门禁逐条 import 解析后计数，P1.18d 起为硬断言）**：`core/ → plugins/` = **0 处**；
`plugins/ → host/` = **0 处**（平台能力一律由宿主注入）；`core/ → data/` **运行期 = 0 处**（仅 6 条
`import type`：插槽载荷形状 + 启动阶段键）；`data/ → plugins|host` **运行期 = 0 处**（仅 1 条
`import type`：`ChunkGeometry`）。两条 type-only 数量都被**钉死**，所以任何一处新增都必须是有意为之。
**走法**：命令写在它写的那个资源旁边（`data/globals/commands.ts`），内核要驱动但不可点名的能力以
**注入 hook** 到场（`UiTablesHook` 是类型，`boot/ui-tables.ts` 是实现，经 `installPlugins` 与热插拔宿主递进来）。

---

## 4. 插件是什么

一个插件 = **一个功能 + 它自己的数据 + 它对插槽的贡献 + 它声明的依赖 + 它自己的构造**。

```
plugins/player/
├── plugin.ts         ★ 发现适配器（文件夹的 opt-in）：宿主实例 → 自己的工厂参数，并发布回根需要的句柄
├── index.ts          definePlugin({ id, deps, setup }) + api.system(...) 声明 + createPlayerPlugin(wiring)
├── components.ts     它拥有的组件 schema（热列 / 冷记录）
├── commands.ts       它拥有的命令（改的都是它自己的组件）
├── systems/          它的系统（每个都声明 reads/writes/after/before）
└── README.md         契约（可选）：贡献了什么、依赖谁
```

**核心声明插槽，插件往里挂**（这是插件架构的心脏；`core/extension/*` + `core/plugin/*`）：

```ts
// core/extension/slots.ts（已实现，共 11 个插槽）
export const SLOT_SYSTEMS    = defineExtensionPoint<SystemDef>("systems");
export const SLOT_COMPONENTS = defineExtensionPoint<{ name: string }>("components");
export const SLOT_RESOURCES  = defineExtensionPoint<Resource<unknown>>("resources");
export const SLOT_COMMANDS   = defineExtensionPoint<{ name: string }>("commands");
export const SLOT_LANGUAGES  = defineExtensionPoint<{ id: string }>("languages");
export const SLOT_BLOCKS     = defineExtensionPoint<BlockEntry>("blocks");
export const SLOT_UI_PAGES   = defineExtensionPoint<UiPage>("uiPages");
export const SLOT_UI_HUD     = defineExtensionPoint<UiHudElement>("uiHud");
export const SLOT_UI_ACTIONS = defineExtensionPoint<{ id; run }>("uiActions");
export const SLOT_UI_SOURCES = defineExtensionPoint<{ id; read }>("uiSources");

// plugins/player/index.ts（插件自己声明它拥有什么）
export const playerPlugin = definePlugin({
  id: "player",
  deps: ["world", "input"],
  setup(api) {
    api.contribute(SLOT_COMPONENTS, [POSITION, ORIENTATION, VIEW, CONTROL, BODY, REACH, ...]);
    api.contribute(SLOT_RESOURCES,  [LOCAL_PLAYER, INPUT_STATE, INPUT_INTENTS, ...]);
    api.contribute(SLOT_COMMANDS,   [Teleport, SelectSlot, SwapSlots]);
    api.system({ name: "player.input", stage: "fixed", ...INPUT_ACCESS, run: () => s.input.step() });
  },
});
```

**清单是数据**（`plugins.json`，从资源包链读取）：装哪些、开关、顺序由插件的 `deps` 决定。
**关掉一个插件 = 它的系统一个都不进排班**（安装期就把它跳过），所以"不想要的子系统"既不花代价也不可能弄坏启动。
启动日志会打印谁贡献了什么（`PLUGIN installed n/m`、`REGISTRY systems: n from [...]`）。

**发现是文件夹，不是名单**（P1.40）：`plugins/<id>/plugin.ts` 存在即被 Vite 的构建期 glob 收录；
`boot/main.ts` 的插件数组现在**只有** `[...discoveredPlugins.map((p) => p.plugin)]` —— 根不再手写任何插件名。

**根与插件的两个方向**（这是"谁能用谁"的全部）：

| 方向 | 机制 | 例子 |
|---|---|---|
| 根 → 插件 | `PluginHost.instances`（按名字给的实例，插件自己收窄类型） | 网格化工厂、原生鼠标捕获、注册表、视图 |
| 插件 → 根 | **发布句柄资源**（插件在 `plugin.ts` 里插入，根在需要时读） | `RENDER_HANDLES`(P1.45)、`PLAYER_HANDLES`、`UI_HANDLES` |

---

## 5. DOD 六条规则

| # | 规则 | 落在哪 | 违反的后果 |
|---|---|---|---|
| 1 | **列，不是对象**：每 tick 被当数学读的字段用 `defineComponent`（一字段一条类型化数组）；低频或含 `Map`/数组的用 `defineRecord` | `core/data/component.ts` + 各插件 `components.ts` | 指针追逐、缓存不友好；"对象化"后批量访问变慢 |
| 2 | **一次解析、多次扫描**：查询缓存并预解析，系统用普通 `for` 扫 `query(...).indices`（EnTT 的"最稀有优先"） | `core/data/query.ts` | 热循环里建集合/闭包 → 分配抖动 |
| 3 | **热路径零分配**：重建原地覆写类型化数组；网格几何容量只增不重建；临时量属于 scratch 而非调用 | `core/data/store.ts`、`host/browser/chunkmesh.ts` | 每帧 GC → 掉帧（老的挖/放卡顿就是这个原因） |
| 4 | **结构变更只在屏障**：spawn/despawn/insert/remove 只在装配期或命令里；调度器在每个系统前后比对 `structuralVersion` | `core/flow/schedule.ts`、`core/effect/command-queue.ts` | 跨系统读到"半个世界"，静默错位 |
| 5 | **"可并行"是算出来的**：系统声明 `reads/writes`，调度推导批次；批次内顺序无关，门禁用"两种注册顺序跑 400 tick 轨迹一致"来证明 | `core/flow/schedule.ts` + 各 `*_ACCESS` | 靠注释维持顺序 → 改一处炸一片 |
| 6 | **数据即程序**：表、调参、资源形状、内容（方块/语言/菜单布局/HUD 元素/页面/热插拔键表）都是数据 | `data/**`、各插件 `data.ts` | 把内容写进代码 → 模组与资源包无从下手 |

**DOD 不是函数式编程**：状态是**故意原地改**的，系统顺序是**加载性**的（纯函数流水线不需要）。
它和 FP 共用的只是那部分纪律：一个值只有一个主人、不缓存别人状态的派生、行为是数据的函数而不是
数据的第二份拷贝。

---

## 6. 启动与帧循环（数据怎么流）

```
boot/main.ts
 1. host 预载：资源包链（mods + resourcepacks）→ 贴图/语言/方块表/主题
 2. host 预载：settings.json + 自检修复（坏值改写并上报）
 3. 建 World、插资源表（体素世界、相机/HUD/渲染器句柄、UI 挂载点、各资源令牌…）
 4. 目录发现 ← `plugins/<id>/plugin.ts`：**每个插件在这里构造自己的系统**，
               并把自己发布的句柄（RENDER/PLAYER/UI_HANDLES）插进世界
 5. 读清单 → 逐插件 install（setup 只贡献；失败隔离；deps 拓扑序）
 6. 读清单 → start（world.start() 之后，可以看装配好的世界）
 7. world.start()：排班 resolve + 未声明依赖报错 + 批次推导
 8. 唯一 rAF 链（boot/main.ts 持有）→ 按模式驱动三条 lane
```

> 顺序是**加载性**的：4 必须在资源表之后（系统的构造函数里解析资源），5 必须在 4 之后（setup 依赖构造）。
> 门禁把这条顺序当作断言守着。

game 帧： accumulating 到 1/120 → stepFixed（屏障 → fixed lane 六个系统）
        → 帧率闸门 → render（屏障 → render lane）→ ui lane（每帧必跑）
menu 帧：菜单背景 + renderUi（只跑屏障 + ui lane）
load 帧：只跑 ui lane（loading 是 widget 数据）

副作用唯一入口：**命令**（`world.commands.send(...)`，在屏障应用）。
设备事件是第三种情况：DOM 监听器在**事件发生时**决定并**排队**，由 `player.input` 的 `step()`
写进组件——顺序仍然是调度算出来的（这是 `AGENTS.md` 铁律 3 的地盘，别动）。

---

## 7. 现状与欠账（诚实清单）

**已经成立的**

- 层次：`core/` / `plugins/` / `host/` / `data/` / `shared/` / `boot/`，副作用 100% 关在 `host/`；
  `core/ → plugins/`、`plugins/ → host/` 都是 **0 处**，`core/ → data/` 与 `data/ → plugins|host`
  **运行期也是 0 处**（各只剩 6 条 / 1 条 `import type`，门禁逐条解析计数并钉死数量）。
- DOD：列存、查询缓存、原地覆写、屏障、批次推导、访问声明（门禁 **71 组断言**）。
- **内核不含游戏词汇**：具体命令跟着它们写的资源走（`data/globals/commands.ts`），内核只留机制
  （`defineCommand` + 队列）；要驱动却不可点名的能力走**注入 hook**（`UiTablesHook` ← `boot/ui-tables.ts`）。
- **插件系统**：11 个插槽 + 注册表（重复 id 会抛并点名双方）+ `definePlugin` + 依赖拓扑安装 +
  清单否决 + 失败隔离 + 三阶段生命周期 + 运行中装卸（F5/F8/F9/F10/F11）+ 卸载回滚与反向依赖守卫。
- **全部 12 个插件走文件夹发现**：`boot/main.ts` 的插件数组只有 `[...discoveredPlugins...]`，
  每个插件的 `plugin.ts` 自己构造系统、自己声明、自己发布根需要的句柄。
- **插件自己拥有数据**：组件 schema、命令、资源令牌、内容（语言集合、方块表）全部由插件声明；
  资源包是一条真数据级插件链（`game/mods` + `game/resourcepacks`：方块表、语言、贴图、背景、主题）。

**还没做的（按建议顺序）**

1. **视图/面板的构造仍在根**（**有意**，不是漏做）：spawn 是结构变更，只能发生在装配期，
   而"什么时候"是根才知道的（加载屏的部件必须在第一次 `renderUi()` 之前存在、F3 面板要在
   `diagnostics` 构造前插进世界）。所以 `Hud` / `LoadingScreen` / 两个菜单 / 拾取环 / 提示条 /
   键位线仍由根 spawn，插件只负责"它们是什么"（各插件导出的 `spawn*` / `create*View` 工厂）。
   **这条规矩的代价（P1.49ac 实测）**：凡是"装配期 spawn 出来、之后不再重新派生"的东西，换资源包时都
   追不上。已经修好的：菜单背景（`refreshBackdrop()` 重写 recipe + 图片）、设置面板的资源包行（总线通知后
   重新渲染）、**语言选择的行**（P1.49ag：改成固定容量的**行池**，由声明集合在总线通知与分区打开时填，
   所以**不需要**屏障，和资源包行同一个形状）。**仍然要重启才生效的一处**：**新方块的快捷栏格子**
   （起始物品在出生时播种一次；方块表与调色板本身已经跟随链条）——这一处是"格子本身要新建"，也就是结构变更，
   正确做法是让一个系统在屏障处重建它（`ui.keybind` 的派生面板就是那个形状），或者按 MC 的做法给一个
   由注册表生成的创造模式物品栏。
2. **四个可选面：已收尾（P1.18c）**。它们现在连**面板**都自己 spawn、系统自己构造（在 `plugin.ts`，即装配期；
   `setup` 不许 spawn —— 铁律 1），根**不构造任何系统**。仍然留在根的是**视图**（HUD/加载屏、两个菜单、
   霜层、F3 面板控件——spawn 是结构变更，"什么时候"属于装配）与插件发布回来的**句柄**。
3. **资源包热重载**：**已实现**（P1.49ab）。触发是 **F7**（`ui.navigation` 从按键边沿发 `ReloadPacks` 命令）
   或**在设置里开关资源包**；驱动在装配根，形状照抄 Minecraft：**重扫（Rust 重新读目录）→ 安装新链 →
   重跑内容阶段（语言/方块表/调色板）→ 丢派生缓存（区块材质、方块图标、菜单背景）→ 把已加载区块标脏**
   （由 chunk stream 按每帧预算重画，不在一次里做完）。失败时**回到上一份快照**，绝不半套生效。
   调色板是**只增不改**的合并（`VoxelWorld.mergePalette`）——体素存的是编号，编号由引擎拥有，所以换包不会
   把世界里已有的方块指到别的方块上。
4. **真游戏内容**（与架构无关）：真实地形（现在是平地三层）、区块淘汰、世界边缘的雾。

**明确不做的**：能力令牌 / 权限授权（L3）。理由见 §9：模组目前是纯数据，没有"陌生人的代码"要防；
而 JS 里没有执行边界时，权限只是纸糊的。

---

## 8. 术语表

| 词 | 在这里的意思 |
|---|---|
| 微内核（microkernel） | 核心只做机制 + 插槽 + 宿主；功能全部可装卸 |
| 插件架构（plugin architecture） | 微内核的通用名；少了"内核最小/生命周期/依赖强制"的严格版 |
| 扩展点 / 插槽（extension point / slot） | 核心声明的可贡献位置：systems、components、resources、commands、languages、blocks、uiPages、uiHud、uiActions、uiSources… |
| 发现（discovery） | `plugins/<id>/plugin.ts` 存在即被收录；构建期 glob，无运行时磁盘查找 |
| 注册表（registry） | 记录"谁贡献了什么"，并检测重复 id 与未声明依赖 |
| 发布句柄（published handles） | 插件 → 根的反方向：`RENDER_HANDLES` / `PLAYER_HANDLES` / `UI_HANDLES` |
| gap（空槽系统） | 只有顺序、没有 run 的"占位系统"：让可选面之间的顺序不依赖"谁装了谁" |
| DOD（数据导向设计） | 按访问模式摆数据：列存、冷热分离、零分配、批次 |
| ECS | 实体 + 组件 + 系统的结构；本项目用它承载 DOD |
| SoA | 一字段一条类型化数组（`POSITION.x[row]`） |
| 冷 / 热 | 每 tick 被当数学读 = 热（列）；低频或含集合 = 冷（记录） |
| 屏障（barrier） | 允许改结构的唯一时刻；命令在这里落盘 |
| 批次（batch） | 互相无数据冲突、也无顺序边的一组系统，可任意序 |
| 宿主（host） | 唯一碰 OS/浏览器/Tauri 的层；插件通过注入的实例间接触及 |

**厂商样板**（不是理论）：微内核/插件宿主 —— VS Code（扩展宿主）、Eclipse/OSGi、Kibana、Grafana、
JupyterLab（插件 + 服务令牌）；前端页面里的分支 —— 微前端（SAP Luigi、Spotify Backstage、
Zalando Mosaic、Module Federation）；要真隔离 —— Wasm/WASI 宿主（Shopify Functions、Extism）。

---

## 9. 当前进度快照（微内核/插件化改造）

这一节是"现在到哪儿了"的**实测**记录，不是计划；计划与欠账在 `ROADMAP.md`。

**已经成立**

| 项 | 证据 |
|---|---|
| 12 个插件全部**文件夹发现** | 启动日志 `PLUGIN installed 12/12`；`PLUGINS` 数组只有 `...discoveredPlugins`；门禁断言"每个插件文件夹都有 `plugin.ts`，且根不再手写任何名字" |
| 扩展点 + 注册表 | 11 个插槽；重复 id 会抛错并点名双方；`REGISTRY …` 一行一行打印谁贡献了什么 |
| 依赖方向被**强制执行** | 门禁：跨插件 import 必须有声明的 `deps`、声明图必须无环、`plugins/ → host/` = 0、`core/ → plugins/` = 0 |
| **声明与构造都归插件** | 22 个系统全部由插件 `api.system(...)` 声明，**22/22 也由各自的 `plugin.ts` 构造**（P1.18c 把最后 4 个可选面——面板一起——搬进插件）；根**不构造任何系统**，门禁断言这条；`RENDER_HANDLES`/`PLAYER_HANDLES`/`UI_HANDLES`/`INVENTORY_HANDLES` 是插件发布回来、根用来驱动/绘制的句柄 |
| 生命周期三阶段 | `setup`（只贡献）→ `startPlugins`（`world.start()` 之后）→ `stopPlugins`（退出时逆序，只对启动过的插件）；另有 `api.onStop` 注册的 teardown（两条离开路径都跑、逆序、恰好一次） |
| 运行中装卸 | `hotplug.ts`：装/卸在屏障处，失败**完整回滚**，反向依赖不许卸，卸载不动"被认领的资源"（P1.28）；F5/F8/F9/F10/F11 |
| 内容变成插件 | 语言集合与方块表由 `content-default` 在安装期从资源包链发现并声明，引擎侧表由**声明**组装 |
| DOD 底座 | 列存、查询缓存、原地覆写、屏障、批次推导、访问声明；门禁 **69 组断言全过** |

**还没做（以及为什么没硬做）**

1. **视图/面板的构造留在根**：spawn 是结构变更 + "什么时候"是装配顺序的一部分（见 §7 第 1 条）。
2. **四个可选面的系统实例由根构造后交给插件**：它们包着根 spawn 的面板，这也是它们能热插拔的原因
   （`createXPlugin(instances)` 的 `setup` 自己就够装）。
3. **资源包热重载**：依赖"内容阶段可重跑"的启动时序。
4. **真游戏内容**（与架构无关）：真实地形、区块淘汰、世界边缘的雾。

**明确不做**：能力令牌 / 权限授权（L3）。理由见 §7：模组目前是纯数据，没有"陌生人的代码"要防；
而 JS 没有执行边界时，权限只是纸糊的。

---

## 10. 可选面（ui 拆分）的当前状态

> 每个"可以关掉、甚至可以运行中开关"的界面都是一个插件；`ui` 本身是必需的那个。

| 插件 | 它拥有 | 可关 | 热插拔 |
|---|---|---|---|
| `ui`（必需） | 10 个 widget 组件 + 17 个资源 + 3 个命令 + **7 个系统**（pages/hud/loading/bindings/navigation/delays/widgets）+ 4 个 slot gap 锚点；`reconcile` 是唯一 DOM 写者 | 机械上可以（窗口空白），实质没意义 | 否 |
| `ui-crosshair` | 1 个 HUD 元素（准星），零系统零资源 | ✅ | **F5** |
| `ui-debug` | F3 面板 + F3/F4 模式环（1 个系统）+ `PICKER_STATE` | ✅ | **F8** |
| `ui-keybind` | 改键页（1 个系统 + 1 个页面 + 视图/拖拽的事件期一半） | ✅ | **F9** |
| `ui-toast` | HUD 提示条（1 个系统 + 顶层面板） | ✅ | **F10** |
| `ui-inventory` | 背包 + 快捷栏（1 个系统 + 1 个 HUD 元素 + 视图） | ✅ | **F11** |

**拆分逼出来的规则（做下一个可选面时必须遵守）**：**一个 `after`/`before` 边不许指向"别的插件
决定装不装"的系统**。可选面之间的顺序改用核心拥有的 4 个 **gap 锚点**
（`ui.slot.bag/debug/toast/keybind`：只有顺序、没有 run），因此任意子集被关掉都不会留下悬挂引用。

**状态跟着表面走**：`PICKER_STATE` 由 `ui-debug` 贡献，`INVENTORY_WIDGETS` 由 `ui-inventory` 贡献，
关掉谁就带走谁的资源与元素（HUD 元素被去掉时 `ui.hud` 会 DESPAWN 整棵子树，而不是留一堆隐藏部件）。

**给下一个人的坑**：注释里的 `before:` / `after:` **字面量**会被门禁的边缘解析器
（`scripts/check-ecs.mjs` 的文本匹配，不是语法解析）当成真边读进去，造出一条幻影自环。
写这段散文时别用方括号形式。
