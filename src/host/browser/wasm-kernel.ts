// ===== Loader for the WASM collision kernel (wasm-bindgen build) =====
//
// `wasm/collision` is compiled with `cargo build` → `wasm-bindgen --target web` → `wasm-opt` (see
// `scripts/build-wasm.mjs`). The generated ESM glue + `.d.ts` land in `src/host/browser/wasm/`, which is why
// this file imports them like any other module: Vite bundles the glue and emits the `.wasm` beside it.
//
// DATA IN, DATA OUT: one call per fixed tick, carrying the bodies and the dense block grid the caller built
// for that tick. The kernel does not call back into JS at all (it used to ask `is_solid` once per block it
// touched), so this layer has no predicate to hand it and no world copy to keep in sync — the grid IS the
// tick's snapshot.
//
// The TS collision in `plugins/player/systems/collision.ts` stays as the fallback: the Node gate has no
// WebAssembly host, and a failed load must degrade instead of freezing the player.
import init, { abi_version, resolve_batch } from "./wasm/collision.js";

/** Bodies per call, as the ABI packs them: 10 f64 in (start xyz, target xyz, half, height, eye, vy). */
const POSE_STRIDE = 10;
/** Results per body: 5 f64 out (x, y, z, vy, onGround). */
const RESULT_STRIDE = 5;

export interface WasmCollisionKernel {
  /** ABI handshake exported by the crate; a mismatch means a stale artifact. */
  readonly abiVersion: number;
  /** Resolve every body against one block grid. `solid` is nx*ny*nz bytes (1 = solid, x fastest then y then
   *  z); returns 5 numbers per body, or null when the answer does not match the request (stale glue). */
  resolveBatch(
    poses: Float64Array,
    ox: number,
    oy: number,
    oz: number,
    nx: number,
    ny: number,
    nz: number,
    solid: Uint8Array,
  ): Float64Array | null;
}

let pending: Promise<WasmCollisionKernel> | null = null;

export function loadWasmKernel(): Promise<WasmCollisionKernel> {
  if (pending !== null) return pending;
  pending = (async () => {
    await init();
    const abi = abi_version();
    return {
      abiVersion: abi,
      resolveBatch(poses, ox, oy, oz, nx, ny, nz, solid) {
        const out = resolve_batch(poses, ox, oy, oz, nx, ny, nz, solid);
        const expected = (poses.length / POSE_STRIDE) * RESULT_STRIDE;
        return out.length === expected ? out : null;
      },
    };
  })();
  return pending;
}
