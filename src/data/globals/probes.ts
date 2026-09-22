// ===== The DIAGNOSTIC PROBE table =====
// Which debug.log lines exist only to be READ by someone debugging, i.e. which lines the "Diagnostic log"
// switch may suppress. Why the switch exists: to chase "the view is not smooth while a key is held", probe
// lines were hung off the input / frame / cursor / key-bind paths (`FRAME`/`LOOK`/`RAWLAG`/`RAWMON`/
// `STALL`/`PHYS`/`SPACE#`/`MOUSE#`/`HOOKPROBE`/`KBCAP`/`RAWINPUT takeover`). They are useful — next time
// this class of problem comes up, read the log — but several of them fire on ordinary mouse activity and
// would write to disk forever.
//
// DIAGNOSTIC vs EVENT, the rule this table draws: a line belongs here when it exists only to be read by
// someone debugging (a periodic measurement, or a trace of an ordinary input that already works), and it
// is an event record when it is the only trace of something that CHANGED state (a lock, a menu opening,
// the sign-in to a world, an error). So `KBCAP mousedown` (one line per click of a working UI) is a probe,
// while `LOCK request` / `ESC modal=…` / `MOUSE CAPTURE on` stay — they answer "why did the game do that",
// which is what the log is for even with the switch off.
//
// The table is DATA (a policy list); the switch and its ONE filter point are behaviour and live in
// `logic/host/window/shell.ts` — inside `logDebug`, the single place every probe line passes through, so
// adding a probe means adding its prefix HERE and nothing else. `appendDebugLog` (the error/console
// channel) is unaffected and always writes.
//
// THE PREFIX MUST BE THE LINE'S OWN FIRST TOKEN, character for character. The table carried a stale
// `"LOOK#"` for a long time while `player.input` actually printed `LOOK raw=…` (only `SPACE#`/`MOUSE#`
// carry a sequence number), so with the switch OFF that one line kept reaching the disk every second —
// the exact flood the switch exists to stop, and the only probe line that escaped it. `check:ecs` pins
// each emitted probe line's own prefix to this table, so a rename cannot silently reopen the hole.

/** The probe lines' prefixes (`SPACE#`/`MOUSE#` carry a sequence number, so match by prefix). */
export const PROBE_PREFIXES: readonly string[] = [
  "PHYS ",
  "FRAME ",
  "STALL ",
  "LOOK ",
  "RAWLAG ",
  "RAWMON ",
  "HOOKPROBE ",
  "SPACE#",
  "MOUSE#",
  // The key bind gestures: one line per mousedown / click / bind / drag release. A trace of a UI that
  // already works — it was the loudest thing left in a log with the switch off, because a click writes it.
  "KBCAP ",
  // The raw-input takeover transitions ("movementX is suspended now / handed back"). Their effect is
  // visible in LOOK/RAWLAG (`dTO` vs `app`), so this is a reading, not a state record. The two BOOT
  // lines ("RAWINPUT listener started" / "RAWINPUT active=…") deliberately stay events: they are written
  // once and say whether the native channel exists at all.
  "RAWINPUT takeover",
  "RAWINPUT hands back",
];
