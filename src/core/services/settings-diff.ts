// The **pure** repair logic for settings.json.
//
// Why it is a separate file: this logic has to be requirable directly by `check:ecs` in Node. In the
// NW.js version it lived in platform/shell.ts (that file only touched nw/DOM, so Node could import it);
// the Tauri version's shell.ts imports @tauri-apps/api (ESM) at the top, which Node's CJS require blows
// up on. So the pure half was cut out and put here — it has not one import, so anyone can run it.
//
// shell.ts still re-exports it, and not one call site's import path changed.

/** The outcome of comparing the file with the values that actually took force. */
export interface SettingsDiff {
  /** Settings whose file value was unusable; `merged` carries the value in force instead */
  readonly fixed: readonly string[];
  /** Settings the engine does not know. KEPT as they are (a newer version's key, or a mod's) — a
   *  forward-compatible file must not be trimmed by an older build. */
  readonly unknown: readonly string[];
  /** The whole file with the repaired values written back, ready for writeSettings() */
  readonly merged: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Repair a settings file AGAINST THE VALUES IN FORCE.
 *
 *  Every config module validates its own field when it loads it and silently falls back to a default
 *  (`loadLang` ignores a language that is not zh/en/ja, `sanitizeFrameCap` sends a hand-edited
 *  `fpsCap: 1` to 30, and so on). That is the right behaviour at load time, but it left the FILE
 *  saying one thing while the game used another — so the bad value survived on disk, unreported, and
 *  the next launch had to guess again. Comparing the two answers this: the values in force ARE the
 *  sanitised ones, so any key whose file value differs from it was invalid, and the fix is simply to
 *  write the value in force back.
 *
 *  `inForce` doubles as the schema — its keys are the settings the engine knows. One nesting level is
 *  supported because `keybinds` is the only map-valued setting: an entry whose code the bind table
 *  refused is reported and rewritten per ACTION, and an action the engine does not know is kept.
 *
 *  Pure: no file I/O, so the Node gate can drive it. */
export function diffSettings(
  raw: Record<string, unknown>,
  inForce: Record<string, unknown>,
): SettingsDiff {
  const merged: Record<string, unknown> = { ...raw };
  const fixed: string[] = [];
  const unknown: string[] = [];

  for (const [key, value] of Object.entries(raw)) {
    const known = inForce[key];
    if (known === undefined) {
      unknown.push(key);
      continue;
    }
    if (isPlainObject(value) && isPlainObject(known)) {
      const out: Record<string, unknown> = { ...value };
      let changed = false;
      for (const [entry, entryValue] of Object.entries(value)) {
        const knownEntry = known[entry];
        if (knownEntry === undefined) {
          unknown.push(`${key}.${entry}`);
          continue;
        }
        if (entryValue !== knownEntry) {
          out[entry] = knownEntry;
          changed = true;
          fixed.push(`${key}.${entry}`);
        }
      }
      if (changed) merged[key] = out;
      continue;
    }
    if (value !== known) {
      merged[key] = known;
      fixed.push(key);
    }
  }

  return { fixed, unknown, merged };
}
