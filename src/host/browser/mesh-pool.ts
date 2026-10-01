// ===== The meshing WORKER POOL: chunk meshing off the main thread (P1.18h) =====
// The other half of `mesh-worker.ts`. It owns N workers, hands out jobs round-robin, and — this is the part
// that keeps the engine's shape — does NOT touch the world, the scene or a geometry: it only answers with a
// QUEUE of finished jobs, which the render lane's `chunk.stream` step drains and applies. Nothing is applied
// from a worker callback, so a mesh still enters the scene inside a lane, in a deterministic order.
//
// WHY A POOL AND NOT ONE WORKER: meshing is one job per chunk; a single worker would serialize the window
// fill, and the units are independent by construction. The count is `hardwareConcurrency - 1` — the main
// thread keeps one core for the frame, the lane and the GPU submission.
//
// WHAT A JOB COSTS: the caller (the system, on the main thread) gathers the bytes — the chunk's voxels and
// the six neighbour planes — and they are TRANSFERRED to the worker, so the bytes are never copied. The
// result's four arrays are transferred back and copied into the chunk's reused GPU attributes.
import {
  type ChunkMeshInput,
  type MeshResult,
} from "../../data/world/mesh";
import type { MeshWorkerJob, MeshWorkerReply } from "./mesh-worker";

/** One finished job, as the lane sees it: the key it was asked for and the mesh (null = the worker failed
 *  or died, and the caller should mesh that chunk on its own thread rather than leave a hole). */
export interface MeshJobDone {
  readonly key: string;
  readonly result: MeshResult | null;
}

/** The capability the render plugin is handed instead of importing `host/` (see ChunkMeshFactory). */
export interface MeshWorkerPool {
  /** Ask for one chunk. False = the pool is saturated (or has no worker left): the caller stops asking this
   *  frame and comes back to that chunk later, which is what keeps a burst from queueing thousands of jobs. */
  request(key: string, input: ChunkMeshInput): boolean;
  /** Jobs finished since the last call — drained by the render lane's step, applied there. */
  take(): MeshJobDone[];
  /** Jobs handed out and not yet taken (the warm-up waits for this to reach 0). */
  readonly inFlight: number;
  /** Live workers (0 = every worker failed to start; the callers fall back to the main thread). */
  readonly workers: number;
  dispose(): void;
}

/** How many jobs one worker may hold at once. Small on purpose: the main thread is the producer, and a deep
 *  queue would only delay the per-frame apply. */
const QUEUE_PER_WORKER = 4;

interface Slot {
  readonly worker: Worker;
  /** Jobs handed to this worker, oldest first: their keys come back with each reply. */
  readonly keys: number[];
  /** Job ids this slot is still waiting for (the reply retires one). */
  busy: number;
}

export function createMeshWorkerPool(
  workerCount: number = Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1),
): MeshWorkerPool {
  const result: MeshJobDone[] = [];
  const slots: Slot[] = [];
  /** id -> the key the caller asked for, so a reply can be matched without trusting the worker's echo. */
  const keyOf = new Map<number, string>();
  let nextId = 1;
  let cursor = 0;

  for (let i = 0; i < workerCount; i++) {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./mesh-worker.ts", import.meta.url), { type: "module" });
    } catch {
      // No worker in this environment (a plain Node host, an old engine): the pool reports fewer workers
      // and the system keeps meshing on the main thread, which is the behaviour it had before P1.18h.
      continue;
    }
    const slot: Slot = { worker, keys: [], busy: 0 };
    worker.addEventListener("message", (event: MessageEvent<MeshWorkerReply>) => {
      const reply = event.data;
      slot.busy--;
      const key = keyOf.get(reply.id);
      keyOf.delete(reply.id);
      if (key !== undefined) result.push({ key, result: reply.result });
    });
    // A worker that throws or dies must not wedge a chunk: the job fails and the caller falls back to the
    // main thread for THAT chunk (`result: null`), which is also how a browser that blocks module workers
    // degrades instead of leaving holes in the world.
    worker.addEventListener("error", () => {
      slot.busy = 0;
      for (const id of [...keyOf.keys()]) {
        const key = keyOf.get(id)!;
        keyOf.delete(id);
        result.push({ key, result: null });
      }
    });
    slots.push(slot);
  }

  const freeSlot = (): Slot | null => {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[(cursor + i) % slots.length];
      if (slot.busy < QUEUE_PER_WORKER) {
        cursor = (cursor + i + 1) % slots.length;
        return slot;
      }
    }
    return null;
  };

  return {
    request(key, input) {
      const slot = freeSlot();
      if (slot === null) return false;
      const id = nextId++;
      keyOf.set(id, key);
      slot.busy++;
      const job: MeshWorkerJob = { id, key, input };
      // The input is built for THIS job and handed over: `planes`/`blocks` are transferred, never copied.
      const transfer: ArrayBuffer[] = [input.planes.buffer];
      if (input.blocks) transfer.push(input.blocks.buffer);
      slot.worker.postMessage(job, transfer);
      return true;
    },
    take() {
      return result.splice(0, result.length);
    },
    get inFlight() {
      let n = 0;
      for (const slot of slots) n += slot.busy;
      return n;
    },
    get workers() {
      return slots.length;
    },
    dispose() {
      for (const slot of slots) slot.worker.terminate();
      slots.length = 0;
      keyOf.clear();
      result.length = 0;
    },
  };
}
