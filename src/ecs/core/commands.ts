// ===== Commands: the deferred write path into the ECS =====
// Anything that is NOT a system — the DOM/UI layer, the composition root, an event handler — must
// not touch component columns or the entity store directly. It sends a COMMAND instead, and the
// command runs at the next barrier: the point between two systems where structural changes are
// legal and where the store's columns are allowed to move.
//
// That single rule buys three things at once:
//   1. a system can never observe the ECS half-updated by a click handler;
//   2. a query can never be invalidated in the middle of the loop that iterates it;
//   3. "who is allowed to change what" becomes greppable — every mutation outside a system is a
//      `world.commands.send(...)` call, and the concrete commands live in src/ecs/commands.ts.
//
// Commands are defined with defineCommand(name, run), which gives them a name for logs/errors and
// a typed payload.

import type { World } from "../World";

export interface CommandType<P> {
  readonly name: string;
  /** phantom type carrier (never read at runtime) */
  readonly _payload?: P;
  /** Apply the command. Runs at a barrier, so structural changes are legal here. */
  run(world: World, payload: P): void;
}

export function defineCommand<P>(
  name: string,
  run: (world: World, payload: P) => void,
): CommandType<P> {
  return { name, run };
}

export class Commands {
  private readonly queue: Array<(world: World) => void> = [];

  constructor(private readonly world: World) {}

  /** Queue a command for the next barrier. Safe to call from anywhere, including DOM handlers. */
  send<P>(type: CommandType<P>, payload: P): void {
    this.queue.push((world) => type.run(world, payload));
  }

  /** Commands waiting for the next barrier */
  get pending(): number {
    return this.queue.length;
  }

  /** Apply every queued command. Called by World between systems — never from inside one.
   *  Commands queued BY a command are deferred to the following barrier, so a flush can't loop. */
  flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    for (const apply of batch) apply(this.world);
  }
}
