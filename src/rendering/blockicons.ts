// ===== MC-style 3D item icons: render the block model into a render target via WebGPU, read back pixels, encode a PNG cache =====
// Bake size = display size x UI scale x devicePixelRatio (1:1 display, zero resampling, same as MC)
// Lighting mimics MC ITEMS_3D (ambient + front/top directional)
import * as THREE from "three/webgpu";
import { resolveTexture } from "./textures";
import { getBlockDef } from "../blockregistry";

/** Block type id (alias from the old blocks.ts; block world removed, registry ids remain strings) */
type BlockType = string;

const HALF_VIEW = 0.85;
const MIN_SIZE = 32;
const MAX_SIZE = 256;

let renderer: THREE.WebGPURenderer | null = null;
let rendererReady: Promise<THREE.WebGPURenderer> | null = null;
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

function getRenderer(): Promise<THREE.WebGPURenderer> {
  if (!rendererReady) {
    rendererReady = (async (): Promise<THREE.WebGPURenderer> => {
      const r = new THREE.WebGPURenderer({ antialias: true });
      await r.init();
      r.setClearColor(0x000000, 0);
      renderer = r;
      return r;
    })();
  }
  return rendererReady;
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

/** Get a block's 3D icon (dataURL); the first call renders async then caches; null on failure (caller keeps the solid-color fallback) */
export function getBlockIcon(type: BlockType, sizePx: number): Promise<string | null> {
  const size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(sizePx)));
  const key = `${type}@${size}`;
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const p = pending.get(key);
  if (p) return p;
  const promise = (async (): Promise<string | null> => {
    try {
      const scene = await buildScene(type);
      const r = await getRenderer();
      const rt = new THREE.WebGLRenderTarget(size, size, { samples: 4, depthBuffer: true });
      rt.texture.colorSpace = THREE.SRGBColorSpace;
      const cam = new THREE.OrthographicCamera(-HALF_VIEW, HALF_VIEW, HALF_VIEW, -HALF_VIEW, 0.1, 10);
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
      cache.set(key, url);
      return url;
    } catch {
      return null;
    }
  })();
  pending.set(key, promise);
  promise.finally(() => pending.delete(key));
  return promise;
}