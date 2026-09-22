# 架构说明 — 微内核插件化架构 + DOD

这份文档回答三个问题：**这是什么架构、为什么这样分层、数据为什么长这样。**
代码怎么建怎么跑在 `README.md`；要改代码前必须读的规则在 `AGENTS.md`；计划与欠账在 `ROADMAP.md`。

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
│   ├── flow/     执行模型：schedule(三阶段 + after/before + access + 批次) / boot(BOOT_FLOW 走针)
│   ├── effect/   命令队列（副作用排队成数据，屏障处落盘）+ 命令定义
│   ├── services/ 无平台依赖的服务：bus(配置变更总线) / perf(采样器) / settings-diff(纯修复)
│   └── world.ts  门面：spawn / insert / query / resource / addSystem / stepFixed / render / renderUi
├── plugins/    功能：每个插件自带它拥有的数据
│   ├── player/   components.ts + systems/（input, snapshot, controller, movement, collision, interaction）
│   ├── render/   systems/（camera, chunk-stream, outline, menu-background, diagnostics）
│   ├── ui/       components.ts + systems/（reconcile 是唯一 DOM 写者，另有 hud/loading/inventory/
│   │             bindings/picker/toast/keybind/navigation/delays）+ views/（建树与注册动作 id 的接线）
│   └── input/    keybinds（键位表 + 校验 + 设置文件）+ bind-gesture（改键手势的事件期一半）
├── host/       唯一有副作用的地方
│   ├── desktop/  shell(Tauri：设置/日志/窗口/vsync) / packs(资源包预载) / debuglog(诊断队列转发)
│   └── browser/  viewport / rawinput / pointerlock / mousecapture / window-guards /
│                 presentation(GPU·DOM 工厂) / chunkmesh(网格化) / blockicons(图标烘焙)
├── data/       纯值：globals(资源形状 + 所有共享表) / assets(资源包链产物) / world(体素数据)
├── shared/     类型与纯工具：math/raycast（体素 DDA）
└── boot/       装配根 main.ts：读清单 → 装插件 → 插资源 → start，并持有唯一 rAF 链
```

**放置规则**（新文件该去哪）：
碰 OS/浏览器/Tauri → `host/`；每 tick 改实体数据 → 所属插件的 `systems/`；实体状态本身 →
所属插件的 `components.ts`；只是被"存着"的值（表、常量、资源形状）→ `data/`；无状态纯函数 →
`shared/`；写 DOM → 只有 `plugins/ui/systems/reconcile.ts` 一个地方。

---

## 3. 依赖方向（微内核的骨头）

| 层 | 拥有 | 可以 import | 绝对不 |
|---|---|---|---|
| `core/` | 机制 | `core/` `shared/` | 游戏词汇、`plugins/`、`host/`、`boot/` |
| `plugins/*` | 一个功能**以及它拥有的数据** | `core/` `shared/` `data/` 自己目录 | 别的插件的内部、直接 `host/` |
| `host/` | 外部世界 | `core/` `shared/` | `plugins/`（宿主不认识插件） |
| `data/` | 只有值 | `core/` `shared/` | 副作用、监听器、模块级可变状态 |
| `shared/` | 类型与纯函数 | 无 | 其它一切 |
| `boot/` | 装配 | 全部 | — |

**判定条款**：核心只做机制 / 有扩展点 / 有注册表 / 有生命周期（可选）/ 依赖必须声明。
只有前两条 → 普通插件架构；全都有 → 微内核级。权限模型**不是**判定项（那是安全，另一个维度）。

---

## 4. 插件是什么

一个插件 = **一个功能 + 它自己的数据 + 它对插槽的贡献 + 它声明的依赖**。

```
plugins/player/
├── index.ts          definePlugin({ id, deps, systems, resources, components, commands })
├── components.ts     它拥有的组件 schema（热列 / 冷记录）
├── data.ts           它私有的常量表
├── systems/          它的系统（每个都声明 reads/writes/after/before）
└── README.md         契约：贡献了什么、依赖谁
```

**核心声明插槽，插件往里挂**（这是插件架构的心脏；**P1.18 已实现**：`core/extension/*` + `core/plugin/*`）：

```ts
// core/extension/slots.ts（已实现：四个插槽）
export const SLOT_SYSTEMS    = defineExtensionPoint<SystemDef>("systems");
export const SLOT_COMPONENTS = defineExtensionPoint<{ name: string }>("components");
export const SLOT_RESOURCES  = defineExtensionPoint<Resource<unknown>>("resources");
export const SLOT_COMMANDS   = defineExtensionPoint<{ name: string }>("commands");

// plugins/player/index.ts（已实现：插件自己声明它拥有什么）
export const playerPlugin = definePlugin({
  id: "player",
  deps: ["world"],
  setup(api) {
    api.contribute(SLOT_COMPONENTS, [POSITION, ORIENTATION, VIEW, CONTROL, BODY, REACH]);
    api.contribute(SLOT_RESOURCES,  [LOCAL_PLAYER, INPUT_STATE, INPUT_INTENTS]);
    api.contribute(SLOT_COMMANDS,   [Teleport, SelectSlot, SwapSlots]);
  },
});
```

**清单是数据**（`plugins.json`，从资源包链读取）：装哪些、开关、顺序由插件的 `deps` 决定。
**关掉一个插件 = 它的系统一个都不进排班**（`boot/main.ts` 用 `installOutcome.has(id)` 把关），
所以"不想要的子系统"既不花代价也不可能弄坏启动。启动日志里会打印谁贡献了什么
（`PLUGIN installed n/m`、`REGISTRY systems: 21 from [...]`）。

一个已经存在的原型：`plugins/ui` 的**动作表**（`UI_ACTIONS`：id → 处理器）和**绑定源表**
（`UI_SOURCES`：id → 取值器）——界面各自注册，reconciler 只按 id 派发，它不认识"设置面板"。

---

## 5. DOD 六条规则

| # | 规则 | 落在哪 | 违反的后果 |
|---|---|---|---|
| 1 | **列，不是对象**：每 tick 被当数学读的字段用 `defineComponent`（一字段一条类型化数组）；低频或含 `Map`/数组的用 `defineRecord` | `core/data/component.ts` + 各插件 `components.ts` | 指针追逐、缓存不友好；"对象化"后批量访问变慢 |
| 2 | **一次解析、多次扫描**：查询缓存并预解析，系统用普通 `for` 扫 `query(...).indices` | `core/data/query.ts` | 热循环里建集合/闭包 → 分配抖动 |
| 3 | **热路径零分配**：重建原地覆写类型化数组；网格几何容量只增不重建；临时量属于 scratch 而非调用 | `core/data/store.ts`、`host/browser/chunkmesh.ts` | 每帧 GC → 掉帧（老的挖/放卡顿就是这个原因） |
| 4 | **结构变更只在屏障**：spawn/despawn/insert/remove 只在装配期或命令里；调度器在每个系统前后比对 `structuralVersion` | `core/flow/schedule.ts`、`core/effect/command-queue.ts` | 跨系统读到"半个世界"，静默错位 |
| 5 | **"可并行"是算出来的**：系统声明 `reads/writes`，调度推导批次；批次内顺序无关，门禁用"两种注册顺序跑 400 tick 轨迹一致"来证明 | `core/flow/schedule.ts` + 各 `*_ACCESS` | 靠注释维持顺序 → 改一处炸一片 |
| 6 | **数据即程序**：表、调参、资源形状、内容（方块/语言/菜单布局）都是数据 | `data/**`、各插件 `data.ts` | 把内容写进代码 → 模组与资源包无从下手 |

**DOD 不是函数式编程**：状态是**故意原地改**的，系统顺序是**加载性**的（纯函数流水线不需要）。
它和 FP 共用的只是那部分纪律：一个值只有一个主人、不缓存别人状态的派生、行为是数据的函数而不是
数据的第二份拷贝。

---

## 6. 启动与帧循环（数据怎么流）

```
boot/main.ts
 1. host 预载：资源包链（mods + resourcepacks）→ 贴图/语言/方块表/主题
 2. host 预载：settings.json + 自检修复（坏值改写并上报）
 3. 读插件清单（目标：game/plugins.json；缺失用内置默认）
 4. 建 World（core）
 5. 逐插件 install：注册组件/资源/系统/命令/界面动作（目标：按 deps 拓扑序）
 6. world.start()：排班 resolve + 未声明依赖报错 + 批次推导
 7. 读清单 → start
 8. 唯一 rAF 链（boot/main.ts 持有）→ 按模式驱动三条 lane

game 帧： accumulating 到 1/120 → stepFixed（屏障 → fixed lane 六个系统）
        → 帧率闸门 → render（屏障 → render lane）→ ui lane（每帧必跑）
menu 帧：菜单背景 + renderUi（只跑屏障 + ui lane）
load 帧：只跑 ui lane（loading 是 widget 数据）
```

副作用唯一入口：**命令**（`world.commands.send(...)`，在屏障应用）。
设备事件是第三种情况：DOM 监听器在**事件发生时**决定并**排队**，由 `player.input` 的 `step()`
写进组件——顺序仍然是调度算出来的（这是 `AGENTS.md` 铁律 3 的地盘，别动）。

---

## 7. 现状与欠账（诚实清单）

**已经成立的**
- 层次：`core/` / `plugins/` / `host/` / `data/` / `shared/` / `boot/`，副作用 100% 关在 `host/`
- DOD：列存、查询缓存、原地覆写、屏障、批次推导、访问声明（门禁 57 组断言在守）
- **插件系统（P1.18）**：扩展点 + 注册表（重复 id 会抛）+ `definePlugin` + 依赖拓扑安装 + 清单否决 +
  失败隔离；六个插件各有 `index.ts` 声明自己拥有的组件/资源/命令；**清单关掉一个插件，它的系统就不进排班**
- 一个真数据级插件链：`game/mods` + `game/resourcepacks`（方块表、语言、贴图、背景、主题）
- 三个真扩展点原型：`UI_ACTIONS`、`UI_SOURCES`、`registerKeybindPanel`

**还没做的（按建议顺序）**
1. **P1.18b 收尾**：系统的**构造**仍在 `boot/main.ts`（闭包捕获了 wiring），把构造也搬进各插件；
   然后关掉 **21 处跨界 import**（16 处插件↔插件 + 5 处插件→`host`，清单见 `AGENTS.md`），
   并把门禁里的"棘轮计数"升级成**方向规则**（未声明的跨插件 import 直接失败）。
2. **生命周期（L2，可选）**：`install/start/stop` + 运行中重排（**只能在屏障处**）。想要"运行中开关玩法"才做。
3. **内容数据化**：方块/物品/语言/菜单布局 → `plugins/content-default/`，并让资源包支持热重载。玩家能直接感知。
4. **真问题**（与架构无关，见 `ROADMAP.md`）：真实地形、按体素值选方块材质、区块淘汰、世界边缘的雾。

**明确不做的**：能力令牌 / 权限授权（L3）。理由：模组目前是纯数据，没有"陌生人的代码"要防；
而 JS 里没有执行边界时，权限只是纸糊的。

---

## 8. 术语表

| 词 | 在这里的意思 |
|---|---|
| 微内核（microkernel） | 核心只做机制 + 插槽 + 宿主；功能全部可装卸 |
| 插件架构（plugin architecture） | 微内核的通用名；少了"内核最小/生命周期/依赖强制"的严格版 |
| 扩展点 / 插槽（extension point / slot） | 核心声明的可贡献位置：systems、components、resources、commands、views、uiActions… |
| 注册表（registry） | 记录"谁贡献了什么"，并检测重复 id 与未声明依赖 |
| DOD（数据导向设计） | 按访问模式摆数据：列存、冷热分离、零分配、批次 |
| ECS | 实体 + 组件 + 系统的结构；本项目用它承载 DOD |
| SoA | 一字段一条类型化数组（`POSITION.x[row]`） |
| 冷 / 热 | 每 tick 被当数学读 = 热（列）；低频或含集合 = 冷（记录） |
| 屏障（barrier） | 允许改结构的唯一时刻；命令在这里落盘 |
| 批次（batch） | 互相无数据冲突、也无顺序边的一组系统，可任意序 |
| 宿主（host） | 唯一碰 OS/浏览器/Tauri 的层；插件通过注入的服务间接触及 |

**厂商样板**（不是理论）：微内核/插件宿主 —— VS Code（扩展宿主）、Eclipse/OSGi、Kibana、Grafana、
JupyterLab（插件 + 服务令牌）；前端页面里的分支 —— 微前端（SAP Luigi、Spotify Backstage、
Zalando Mosaic、Module Federation）；要真隔离 —— Wasm/WASI 宿主（Shopify Functions、Extism）。
