// ===== Turning a thrown value into one log line =====
// A plugin's `setup` is somebody else's code (today: a sibling folder; tomorrow: a mod). When it throws,
// the boot must not lose the reason: `Error` carries a message and a stack, anything else is stringified.

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const firstFrame = error.stack?.split("\n")[1]?.trim();
    return firstFrame ? `${error.message} (${firstFrame})` : error.message;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
