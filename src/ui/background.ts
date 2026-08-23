// ===== 主菜单背景模式: 资源包 backgrounds/background.json 选择静态图/全景 =====
// 配置与图同目录 (backgrounds/), 随资源包链覆盖 (用户包可整套换)。
// 判定链:
//   mode=panorama 且 panorama.png 存在 -> "panorama" (球体内壁+相机慢转, 需专用渲染循环)
//   mode=static 且 mainmenu.png 存在   -> "static"   (DOM 铺满)
//   mode 指定的图缺失 / 无配置 / 坏 JSON / 非法值 -> "checker" (紫黑格子)
//   (静态图自身的链内回退仍由 resolveTexture 承担: mainmenu.png 缺 -> missing.png)
import { resolveBytes } from "../textures";

export type MenuBgKind = "panorama" | "static" | "checker";

const CONFIG_REL = "backgrounds/background.json";
const PANORAMA_REL = "backgrounds/panorama.png";
const STATIC_REL = "backgrounds/mainmenu.png";

type MenuBgMode = "static" | "panorama";

/** 读背景配置; 无文件/坏 JSON/非法值返回 null (= checker 直连) */
function readMode(): MenuBgMode | null {
  const bytes = resolveBytes(CONFIG_REL);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed?.mode === "static" || parsed?.mode === "panorama") return parsed.mode;
  } catch {
    /* 坏文件: 视为无配置 */
  }
  return null;
}

/** 最终生效的背景形态 (mainmenu.ts 的 DOM 层与 main.ts 的渲染循环共用同一判定) */
export function menuBgKind(): MenuBgKind {
  const mode = readMode();
  if (mode === "panorama") {
    return resolveBytes(PANORAMA_REL) ? "panorama" : "checker"; // 全景图缺 = 紫黑格子
  }
  if (mode === "static") {
    return resolveBytes(STATIC_REL) ? "static" : "checker"; // 静态图缺 = 紫黑格子
  }
  return "checker"; // 无配置/坏 JSON/非法值 = 紫黑格子
}
