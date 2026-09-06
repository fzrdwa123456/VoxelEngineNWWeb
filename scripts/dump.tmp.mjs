// 原始转储: 每 mesh 逐 (轴,平面) 四边形直方图 + 样本
import * as THREE from "three/webgpu";
import { ChunkWorld } from "../src/chunk.ts";
const w = new ChunkWorld({ add() {}, remove() {} }, () => new THREE.MeshLambertMaterial({ color: 0x888888 }), () => false, (x, y, z) => (y <= 4 ? 'missing' : undefined));
w.fillChunk(0, 0, 0, "missing");
for (const [cx, cz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
  w.generateChunk(cx, 0, cz, (x, y, z) => (y <= 4 ? "missing" : undefined));
}
for (const m of w.meshes()) {
  const idx = m.geometry.getIndex(), pos = m.geometry.getAttribute("position");
  const hist = {};
  for (let i = 0; i < idx.count; i += 6) {
    const q = [0, 1, 2, 3].map(k => {
      const vi = idx.getX(i + k);
      return [pos.getX(vi) + m.position.x, pos.getY(vi) + m.position.y, pos.getZ(vi) + m.position.z];
    });
    let axis = -1;
    for (let k = 0; k < 3; k++) if (q.every(p => p[k] === q[0][k])) { axis = k; break; }
    const ax = [0, 1, 2].filter(a => a !== axis);
    const u0 = Math.min(...q.map(p => p[ax[0]])), u1 = Math.max(...q.map(p => p[ax[0]]));
    const v0 = Math.min(...q.map(p => p[ax[1]])), v1 = Math.max(...q.map(p => p[ax[1]]));
    const key = (axis < 0 ? "BAD" : "xyz"[axis]) + "@" + q[0][axis] + " u:" + u0 + "-" + u1 + " v:" + v0 + "-" + v1;
    hist[key] = (hist[key] || 0) + 1;
  }
  console.log("mesh", m.position.toArray().join(","), "quads:", idx.count / 6);
  for (const k of Object.keys(hist).sort()) console.log("   ", k, "x" + hist[k]);
}
