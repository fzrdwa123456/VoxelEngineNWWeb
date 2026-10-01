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
//
// FAILURE IS PER WORKER, AND LOUD (P1.18i). A worker can fail without the main thread noticing: a module
// worker that the engine refuses to load, a script error inside it, a reply that cannot be deserialized. The
// old handler failed EVERY job in the pool and said nothing, so a permanently broken worker looked like a
// slow world and a pool that lost all of its workers looked like a world that simply never meshed. Now a
// failure is reported ONCE per worker (through the injected log), the DEAD WORKER IS DROPPED so the others
// keep taking its jobs, and only that worker's own jobs fall back to the main thread. A pool left with no
// worker reports `workers = 0`, which the chunk stream reads as "mesh on this thread" rather than as
// "saturated forever" — see ChunkStreamSystem.hasPool.
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

export interface MeshWorkerPoolOptions {
  /** The diagnostic sink — the composition root's `debug.log` writer. Absent = silent: the Node gate builds a
   *  pool with no logger and asserts on `workers`/`inFlight` instead. */
  readonly log?: (line: string) => void;
  /** Overrides `hardwareConcurrency - 1` (the gate asks for a fixed count). */
  readonly workerCount?: number;
}

/** How many jobs one worker may hold at once. Small on purpose: the main thread is the producer, and a deep
 *  queue would only delay the per-frame apply. */
const QUEUE_PER_WORKER = 4;

interface Slot {
  readonly worker: Worker;
  /** Job ids this slot is still waiting for — its queue depth AND, on a failure, exactly the jobs to fail. */
  readonly ids: Set<number>;
  /** 1-based creation order, for the log: a slot's POSITION in `slots` changes as its neighbours die, so the
   *  position is not an identity. */
  readonly ordinal: number;
}

export function createMeshWorkerPool(options: MeshWorkerPoolOptions = {}): MeshWorkerPool {
  const log = options.log;
  const workerCount =
    options.workerCount ?? Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1);
  const result: MeshJobDone[] = [];
  const slots: Slot[] = [];
  /** id -> the key the caller asked for, so a reply can be matched without trusting the worker's echo. */
  const keyOf = new Map<number, string>();
  let nextId = 1;
  let cursor = 0;
  let failures = 0;

  for (let i = 0; i < workerCount; i++) {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./mesh-worker.ts", import.meta.url), { type: "module" });
    } catch (err) {
      // No worker in this environment (a plain Node host, an engine that blocks module workers): the pool
      // reports fewer workers and the system keeps meshing on the main thread, which is the behaviour it had
      // before P1.18h. Reported, because "why is this machine not using its cores" needs an answer.
      failures++;
      log?.(`MESH worker ${i + 1}/${workerCount} could not be created: ${describe(err)}`);
      continue;
    }
    const slot: Slot = { worker, ids: new Set<number>(), ordinal: i + 1 };
    worker.addEventListener("message", (event: MessageEvent<MeshWorkerReply>) => {
      const reply = event.data;
      slot.ids.delete(reply.id);
      const key = keyOf.get(reply.id);
      keyOf.delete(reply.id);
      if (key !== undefined) result.push({ key, result: reply.result });
    });
    // A worker that throws, dies, or answers with something that cannot be deserialized must not wedge a
    // chunk: THIS slot's jobs fail (`result: null`, and the caller re-meshes exactly those chunks on the main
    // thread) and the slot is dropped, so the remaining workers keep the throughput up.
    worker.addEventListener("error", (event) => retireSlot(slot, workerCount, event.message));
    worker.addEventListener("messageerror", (event) => retireSlot(slot, workerCount, describe(event.data)));
    slots.push(slot);
  }

  if (failures > 0 && slots.length === 0) {
    log?.(`MESH worker pool empty: every one of ${workerCount} worker(s) failed; meshing is back on the main thread`);
  }

  /** Fail everything one worker was holding, report it once, and drop the worker: a dead worker that stayed in
   *  the rotation would swallow every job handed to it (the chunk is never meshed and never retried — the job
   *  is only retired by a reply that will never come). */
  function retireSlot(slot: Slot, total: number, detail: string): void {
    const at = slots.indexOf(slot);
    if (at < 0) return; // already retired (a failure can fire error AND messageerror)
    slots.splice(at, 1);
    cursor = slots.length > 0 ? cursor % slots.length : 0;
    const lost = slot.ids.size;
    for (const id of slot.ids) {
      const key = keyOf.get(id);
      keyOf.delete(id);
      if (key !== undefined) result.push({ key, result: null });
    }
    slot.ids.clear();
    try {
      slot.worker.terminate();
    } catch {
      // A worker that already died throws on terminate in some engines; nothing to do about it.
    }
    log?.(
      `MESH worker failed (${slot.ordinal}/${total}): ${detail || "no detail"}; ` +
        `${lost} job(s) re-mesh on the main thread; ${slots.length} worker(s) left`,
    );
  }

  const freeSlot = (): Slot | null => {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[(cursor + i) % slots.length];
      if (slot.ids.size < QUEUE_PER_WORKER) {
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
      slot.ids.add(id);
      const job: MeshWorkerJob = { id, key, input };
      // The input is built for THIS job and handed over: `planes`/`blocks` are transferred, never copied.
      const transfer: ArrayBuffer[] = [input.planes.buffer];
      if (input.blocks) transfer.push(input.blocks.buffer);
      try {
        slot.worker.postMessage(job, transfer);
      } catch (err) {
        // A transferable already detached (the input was handed out twice) or a worker in a bad state: retire
        // the slot rather than leaving an id that will never be answered.
        retireSlot(slot, workerCount, describe(err));
        return false;
      }
      return true;
    },
    take() {
      return result.splice(0, result.length);
    },
    get inFlight() {
      let n = 0;
      for (const slot of slots) n += slot.ids.size;
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

/** A one-line reason from whatever an error path handed us (an Error, an ErrorEvent message, a raw value). */
function describe(why: unknown): string {
  if (typeof why === "string") return why;
  if (why instanceof Error) return why.message;
  if (why && typeof why === "object" && "message" in why) return String((why as { message: unknown }).message);
  return String(why ?? "");
}
