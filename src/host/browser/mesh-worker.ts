// ===== The meshing WORKER: one job in, one mesh out (P1.18h) =====
// This file is what makes chunk meshing multi-core. It runs the PURE mesher (`data/world/mesh.ts`) — no
// three.js, no GPU, no block registry, no `VoxelWorld`: it receives BYTES (the chunk's voxels and the
// neighbour solidity planes), returns the four typed arrays and the look slots, and TRANSFERS the buffers
// back instead of copying them.
//
// WHY THE LOOKS COME BACK AS KEYS: a slot key is `(voxel value << 2) | kind` and nothing more, because the
// palette, the block table and the texture resolution behind them are main-thread state (and the pack chain
// is data the worker has no business holding). The main thread turns each key back into its `ChunkFaceSpec`
// — the same `specFor` the in-place scan used — so the material list of a chunk is identical whichever
// thread meshed it.
//
// Vite bundles this file on its own (`new Worker(new URL("./mesh-worker.ts", import.meta.url))` in
// mesh-pool.ts), which is also why the worker is a MODULE worker.
import { meshChunk, type ChunkMeshInput, type MeshResult } from "../../data/world/mesh";

/** What the pool posts in. */
export interface MeshWorkerJob {
  /** Pool-side job id: the result echo, so the pool can retire the slot it gave the job. */
  readonly id: number;
  /** Wrapped chunk key — the pool's key for the caller's own bookkeeping. */
  readonly key: string;
  readonly input: ChunkMeshInput;
}

/** What this worker posts back. */
export interface MeshWorkerReply {
  readonly id: number;
  readonly key: string;
  readonly result: MeshResult;
}

/** A minimal typed view of the worker global (`lib: DOM` gives us `Window`, whose postMessage signature is
 *  the window one, so the two calls this file makes are declared explicitly rather than configured in). */
interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<MeshWorkerJob>) => void): void;
  postMessage(message: MeshWorkerReply, transfer: ArrayBuffer[]): void;
}
const scope = self as unknown as WorkerScope;

scope.addEventListener("message", (event) => {
  const { id, key, input } = event.data;
  const result = meshChunk(input);
  scope.postMessage({ id, key, result }, result.transfer);
});
