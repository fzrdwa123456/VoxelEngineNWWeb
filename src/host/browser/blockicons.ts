// ===== MC-style 3D item icons: render the block model into a render target via WebGPU, read back pixels, encode a PNG cache =====
// Bake size = display size x UI scale x devicePixelRatio (1:1 display, zero resampling, same as MC)
// Lighting mimics MC ITEMS_3D (ambient + front/top directional)
//
// THE STATE IS A RESOURCE (ecs/presentation.ts::ICON_BAKE): the offscreen renderer and the two caches used
// to be module-level here, i.e. a second GPU object with no owner. Every function below takes that state,
// so the baker is a pure operation on world data and a system can drive it without owning a GPU.
import * as THREE from "three/webgpu";
// The view size and the size clamp are DATA (`data/globals/gfx.ts`), like every other GPU-layer number.
import { ICON_SIZE_MAX, ICON_SIZE_MIN, ICON_VIEW_HALF, type IconBakeState } from "../../data/globals/gfx";
import { resolveTexture } from "../../data/assets/textures";
import { getBlockDef } from "../../data/assets/blockregistry";

/** Block type id (alias from the old blocks.ts; block world removed, registry ids remain strings) */
type BlockType = string;

function getRenderer(bake: IconBakeState): Promise<THREE.WebGPURenderer> {
  if (!bake.rendererReady) {
    bake.rendererReady = (async (): Promise<THREE.WebGPURenderer> => {
      const r = new THREE.WebGPURenderer({ antialias: true });
      await r.init();
      r.setClearColor(0x000000, 0);
      bake.renderer = r;
      return r;
    })();
  }
  return bake.rendererReady;
}

function loadTex(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const t = new THREE.TextureLoader().load(url, () => resolve(t), undefined, reject);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
  });
}

async function buildScene(type: BlockType): Promise<THREE.Scene> {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const dir = new THREE.DirectionalLight(0xffffff, 1);
  dir.position.set(1, 1.5, 0.75);
  scene.add(dir);
  const def = getBlockDef(type);
  if (!def) {
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x4caf50 })));
    return scene;
  }
    // BoxGeometry's 6 material groups = +X -X +Y -Y +Z -Z -> [side, side, top, bottom, side, side]
  const mk = async (tex?: string): Promise<THREE.MeshLambertMaterial> =>
    tex
      ? new THREE.MeshLambertMaterial({ map: await loadTex(resolveTexture(tex)), color: 0xffffff, alphaTest: 0.5 })
      : new THREE.MeshLambertMaterial({ color: new THREE.Color(def.color ?? "#4caf50") });
  const side = await mk(def.side);
  const top = await mk(def.top);
  const bottom = await mk(def.bottom);
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [side, side, top, bottom, side, side]));
  return scene;
}

/** The bake size actually used for a request: rounded and clamped. THE one place that decides it —
 *  the cache key and the render target must agree, or a peek would look for a different entry than
 *  the bake wrote. */
export function clampIconSize(sizePx: number): number {
  return Math.max(ICON_SIZE_MIN, Math.min(ICON_SIZE_MAX, Math.round(sizePx)));
}

/** The cache key for one bake. Exported, and used by BOTH readers below, because a second place
 *  computing this key by hand is exactly how a cache silently stops hitting. */
export function iconCacheKey(type: BlockType, sizePx: number): string {
  return `${type}@${clampIconSize(sizePx)}`;
}

/** The icon for (type, size) IF it is already baked, else null. Synchronous on purpose: a caller that
 *  draws the icon whenever it happens to be ready never has to commit a placeholder to a frame. This
 *  touches no GPU object — it is a Map lookup on the ICON_BAKE resource (the caller is the inventory
 *  system, which asks once per slot per frame). */
export function peekBlockIcon(bake: IconBakeState, type: BlockType, sizePx: number): string | null {
  return bake.cache.get(iconCacheKey(type, sizePx)) ?? null;
}

/** Start (or join) the bake of a block's 3D icon (dataURL), fire and forget: the result lands in
 *  `bake.cache`, and the caller draws it on a LATER frame — that is what keeps a component write off a
 *  promise continuation (the caller is a system, and only a system may write a component). */
export function requestBlockIcon(bake: IconBakeState, type: BlockType, sizePx: number): void {
  void bakeBlockIcon(bake, type, sizePx);
}

/** The bake itself: returns the data URL (also cached), null on failure (the caller keeps the checker). */
export function bakeBlockIcon(
  bake: IconBakeState,
  type: BlockType,
  sizePx: number,
): Promise<string | null> {
  const size = clampIconSize(sizePx);
  const key = iconCacheKey(type, size);
  const cached = bake.cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const p = bake.pending.get(key);
  if (p) return p;
  const promise = (async (): Promise<string | null> => {
    try {
      const scene = await buildScene(type);
      const r = await getRenderer(bake);
      const rt = new THREE.WebGLRenderTarget(size, size, { samples: 4, depthBuffer: true });
      rt.texture.colorSpace = THREE.SRGBColorSpace;
      const cam = new THREE.OrthographicCamera(-ICON_VIEW_HALF, ICON_VIEW_HALF, ICON_VIEW_HALF, -ICON_VIEW_HALF, 0.1, 10);
      cam.position.copy(new THREE.Vector3(1, 0.9, 1).normalize().multiplyScalar(3));
      cam.lookAt(0, 0, 0);
      r.setRenderTarget(rt);
      r.render(scene, cam);
      r.setRenderTarget(null);
      const pixels = await r.readRenderTargetPixelsAsync(rt, 0, 0, size, size);
      rt.dispose();
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
            // WebGPU readback aligns bytesPerRow to 256; non-aligned sizes have row padding — strip it row by row
      const rowBytes = size * 4;
      const paddedRowBytes = Math.ceil(rowBytes / 256) * 256;
      const clamped = new Uint8ClampedArray(rowBytes * size);
      for (let y = 0; y < size; y++) {
        clamped.set(pixels.subarray(y * paddedRowBytes, y * paddedRowBytes + rowBytes), y * rowBytes);
      }
      ctx.putImageData(new ImageData(clamped, size, size), 0, 0);
      const url = canvas.toDataURL("image/png");
      bake.cache.set(key, url);
      return url;
    } catch {
      return null;
    }
  })();
  bake.pending.set(key, promise);
  promise.finally(() => bake.pending.delete(key));
  return promise;
}