// ===== Debug log incremental forwarding =====
// Forwards new entries of the input system's diagnostic queues (shaped "XXX#seq ...") to debug.log in order.
// One cursor per queue, managed uniformly here, replacing the per-queue boilerplate loops in main.ts.
import { sendLog } from "./shell";

/** The diagnostic queues this forwarder consumes (satisfied by the player input system) */
export interface DiagnosticQueues {
  spaceLog: readonly string[];
  mouseLog: readonly string[];
}

export class DebugLogForwarder {
  private cursors = new Map<string, number>();

    /** Forward a queue's new entries: label is both the line prefix and the cursor key */
  private forwardQueue(label: string, lines: readonly string[]): void {
    let last = this.cursors.get(label) ?? 0;
    if (last > lines.length) last = 0;  // Queue wrapped around; cursor invalid, reset
    for (const line of lines) {
      const m = new RegExp(`^${label}#(\\d+)`).exec(line);
      if (m && Number(m[1]) > last) {
        sendLog(line);
        last = Number(m[1]);
      }
    }
    this.cursors.set(label, last);
  }

    /** Forward all of the input system's diagnostic queues (called once per stats frame) */
  forward(queues: DiagnosticQueues): void {
    this.forwardQueue("SPACE", queues.spaceLog);
    this.forwardQueue("MOUSE", queues.mouseLog);
  }
}
