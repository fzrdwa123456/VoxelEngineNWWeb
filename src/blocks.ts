import * as THREE from "three/webgpu";
import { resolveTexture } from "./textures";
import { getBlockDef } from "./blockregistry";

// 方块 id = 注册表键 (blockregistry.ts, 数据来自资源包 blocks.json), 字符串化后 mod 方块与本体同等
export type BlockType = string;

const HALF = 0.5;

// 6 个面的顶点/法线/UV (每面独立 4 顶点, 不共享), 索引 0,1,2 / 0,2,3
// UV 按"观察者站在面外侧看: 图片上=方块上, 左=右"排列
const FACES: { pos: number[][]; n: number[]; uv: number[][] }[] = [
  { pos: [[HALF, -HALF, -HALF], [HALF, HALF, -HALF], [HALF, HALF, HALF], [HALF, -HALF, HALF]], n: [1, 0, 0], uv: [[1, 0], [1, 1], [0, 1], [0, 0]] }, // +X
  { pos: [[-HALF, -HALF, HALF], [-HALF, HALF, HALF], [-HALF, HALF, -HALF], [-HALF, -HALF, -HALF]], n: [-1, 0, 0], uv: [[1, 0], [1, 1], [0, 1], [0, 0]] }, // -X
  { pos: [[-HALF, HALF, -HALF], [-HALF, HALF, HALF], [HALF, HALF, HALF], [HALF, HALF, -HALF]], n: [0, 1, 0], uv: [[0, 0], [1, 0], [1, 1], [0, 1]] }, // +Y
  { pos: [[-HALF, -HALF, HALF], [-HALF, -HALF, -HALF], [HALF, -HALF, -HALF], [HALF, -HALF, HALF]], n: [0, -1, 0], uv: [[0, 0], [1, 0], [1, 1], [0, 1]] }, // -Y
  { pos: [[-HALF, -HALF, HALF], [HALF, -HALF, HALF], [HALF, HALF, HALF], [-HALF, HALF, HALF]], n: [0, 0, 1], uv: [[0, 0], [1, 0], [1, 1], [0, 1]] }, // +Z
  { pos: [[HALF, -HALF, -HALF], [-HALF, -HALF, -HALF], [-HALF, HALF, -HALF], [HALF, HALF, -HALF]], n: [0, 0, -1], uv: [[1, 0], [0, 0], [0, 1], [1, 1]] }, // -Z
];

function buildGeometry(faces: { f: number; m: number }[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const groups: { start: number; count: number; mat: number }[] = [];
  let base = 0;
  let curMat: number | null = null;
  let groupStart = 0;
  for (const { f, m } of faces) {
    if (m !== curMat) {
      if (curMat !== null) groups.push({ start: groupStart, count: idx.length - groupStart, mat: curMat });
      curMat = m;
      groupStart = idx.length;
    }
    const face = FACES[f];
    for (const p of face.pos) pos.push(p[0], p[1], p[2]);
    for (let i = 0; i < 4; i++) nor.push(face.n[0], face.n[1], face.n[2]);
    for (const u of face.uv) uv.push(u[0], u[1]);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  }
  if (curMat !== null) groups.push({ start: groupStart, count: idx.length - groupStart, mat: curMat });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  for (const gr of groups) g.addGroup(gr.start, gr.count, gr.mat);
  return g;
}

const NEIGHBORS: number[][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export class BlockWorld {
  private readonly blocks = new Map<string, { mesh: THREE.Mesh; type: BlockType }>();
  private readonly scene: THREE.Scene;
  // id -> [side, top, bottom] 材质 (注册表驱动, 按需构建共享缓存; 纯色 def 用 color, 有路径走贴图链)
  private readonly matCache = new Map<string, THREE.MeshLambertMaterial[]>();
  private readonly loader = new THREE.TextureLoader();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  static key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  get(x: number, y: number, z: number): THREE.Mesh | undefined {
    return this.blocks.get(BlockWorld.key(x, y, z))?.mesh;
  }

  getType(x: number, y: number, z: number): BlockType | undefined {
    return this.blocks.get(BlockWorld.key(x, y, z))?.type;
  }

  /** 注册表条目 -> [side, top, bottom] 材质; 未注册 id 返回 null (set 拒绝放置) */
  private mats(type: BlockType): THREE.MeshLambertMaterial[] | null {
    const def = getBlockDef(type);
    if (!def) return null;
    let m = this.matCache.get(type);
    if (!m) {
      const mk = (tex?: string): THREE.MeshLambertMaterial => {
        if (tex) {
          const t = this.loader.load(resolveTexture(tex));
          t.colorSpace = THREE.SRGBColorSpace;
          t.magFilter = THREE.NearestFilter;
          t.minFilter = THREE.NearestFilter;
          // alphaTest: 兜底 1x1 透明时面片直接丢弃; 引用贴图缺失时 resolveTexture 回退 missing.png 深紫正常显示
          return new THREE.MeshLambertMaterial({ map: t, color: 0xffffff, alphaTest: 0.5 });
        }
        return new THREE.MeshLambertMaterial({ color: new THREE.Color(def.color ?? "#4caf50") });
      };
      m = [mk(def.side), mk(def.top), mk(def.bottom)];
      this.matCache.set(type, m);
    }
    return m;
  }

  set(x: number, y: number, z: number, type: BlockType = "default"): void {
    if (!getBlockDef(type)) return; // 未注册 id (手滑 json/旧存档): 拒绝放置
    const mats = this.mats(type);
    if (!mats) return;
    const k = BlockWorld.key(x, y, z);
    if (this.blocks.has(k)) return;
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mats);
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    this.blocks.set(k, { mesh, type });
    this.scene.add(mesh);
    this.refresh(x, y, z);
    for (const [dx, dy, dz] of NEIGHBORS) this.refresh(x + dx, y + dy, z + dz);
  }

  remove(x: number, y: number, z: number): void {
    const k = BlockWorld.key(x, y, z);
    const entry = this.blocks.get(k);
    if (!entry) return;
    this.blocks.delete(k);
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    for (const [dx, dy, dz] of NEIGHBORS) this.refresh(x + dx, y + dy, z + dz);
  }

  /** 面 -> 材质索引: 顶面=1(top), 底面=2(bottom), 侧面=0(side) */
  private faceMaterial(_type: BlockType, f: number): number {
    if (f === 2) return 1;
    if (f === 3) return 2;
    return 0;
  }

  /** 隐藏面剔除: 只保留与空气相邻或与透明方块(引用贴图缺失, alphaTest 丢面片)相邻的面 */
  private refresh(x: number, y: number, z: number): void {
    const entry = this.blocks.get(BlockWorld.key(x, y, z));
    if (!entry) return;
    const faces: { f: number; m: number }[] = [];
    const pushFace = (fi: number): void => {
      faces.push({ f: fi, m: this.faceMaterial(entry.type, fi) });
    };
    const visible = (nx: number, ny: number, nz: number): boolean => {
      const n = this.blocks.get(BlockWorld.key(nx, ny, nz));
      if (!n) return true;
      return getBlockDef(n.type)?.transparent === true;
    };
    if (visible(x + 1, y, z)) pushFace(0);
    if (visible(x - 1, y, z)) pushFace(1);
    if (visible(x, y + 1, z)) pushFace(2);
    if (visible(x, y - 1, z)) pushFace(3);
    if (visible(x, y, z + 1)) pushFace(4);
    if (visible(x, y, z - 1)) pushFace(5);
    entry.mesh.geometry.dispose();
    entry.mesh.geometry = buildGeometry(faces);
  }

  meshes(): THREE.Mesh[] {
    return [...this.blocks.values()].map((e) => e.mesh);
  }

  forEach(cb: (x: number, y: number, z: number) => void): void {
    for (const k of this.blocks.keys()) {
      const [x, y, z] = k.split(",").map(Number);
      cb(x, y, z);
    }
  }
}
