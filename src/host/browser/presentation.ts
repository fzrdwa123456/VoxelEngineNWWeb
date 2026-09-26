// ===== The factories that BUILD the presentation objects =====
// The TOKENS and the state SHAPES live in `data/globals/gfx.ts` (pure data). What is left here is the
// behaviour that constructs those objects: `document.createElement` for the UI mount root, a THREE.Group
// wrapper for the chunk-mesh cache, and the plain state records for the icon baker, the chunk material,
// the menu background and the target outline. All of it is the boundary's job (this file is under
// `logic/host/`), and the composition root calls these once during wiring and inserts the results.
//
// Note what the factories do NOT do: none of them touches the scene or the DOM of the page beyond the one
// element it owns. The scene lights, the chunk group and the outline mesh are the composition root's wiring
// (main.ts), which is why this module never constructs a three.js object it was not handed.
import type * as THREE from "three/webgpu";
import {
  type BlockOutlineState,
  type ChunkMaterialState,
  type ChunkMeshCache,
  type IconBakeState,
  type MenuBackgroundState,
} from "../../data/globals/gfx";

/** The cache is created around the group the composition root built (kept as an argument so this module
 *  never constructs a three.js object itself). */
export function createChunkMeshCache(group: THREE.Group): ChunkMeshCache {
  return {
    group,
    meshes: new Map(),
    empty: new Set(),
    wantedKeys: null,
    lastPcx: Number.NaN,
    lastPcz: Number.NaN,
  };
}

export function createMenuBackground(): MenuBackgroundState {
  return { scene: null, camera: null, yaw: 0, lastMs: 0, appliedAspect: Number.NaN };
}

/** THE UI MOUNT ROOT's factory. `ui/uiscale.ts` used to create the element and append it to `document.body`
 *  at IMPORT time (a DOM side effect of a config module); the mount point is world state like the canvas
 *  host, so the composition root creates it here and inserts it as UI_MOUNT. The styles are the ones the
 *  stage always had: fixed, filling the viewport, inside the root font size's rem base. */
export function createUiMount(): HTMLElement {
  const stage = document.createElement("div");
  stage.style.cssText = "position:fixed;inset:0;overflow:hidden;z-index:1;";
  document.body.appendChild(stage);
  return stage;
}

export function createIconBake(): IconBakeState {
  return { renderer: null, rendererReady: null, cache: new Map(), pending: new Map() };
}

export function createChunkMaterial(): ChunkMaterialState {
  return { material: null, materials: new Map() };
}

/** The factory takes the MESH the composition root built and added to the scene, exactly like
 *  `createChunkMeshCache(group)`: this module never constructs a three.js object it was not handed. The
 *  mesh's flags are set by the caller (invisible until a hit, `matrixAutoUpdate` off because the outline
 *  write sets the matrix itself). */
export function createBlockOutline(mesh: THREE.LineSegments): BlockOutlineState {
  return { mesh };
}
