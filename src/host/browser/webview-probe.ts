// ===== DID THE WEBVIEW2 LAUNCH ARGUMENTS ACTUALLY TAKE EFFECT? =====
//
// The list itself is published by Rust (`platform/windows/webview.rs::BROWSER_ARGS_BASE`) and logged as
// `BOOT webview args: ...` — but that line only proves the arguments were HANDED to the WebView2 loader.
// Chromium is free to ignore any switch, and WebView2 is not a browser: there is no `chrome://gpu` here.
//
// So this probe asks the PAGE what it can actually observe, and says plainly what cannot be observed:
//   * autoplay policy — `navigator.getAutoplayPolicy` (Chromium 110+) answers "allowed" when
//     `--autoplay-policy=no-user-gesture-required` took effect;
//   * WebGPU availability — `navigator.gpu` (the engine's only backend; after removing
//     `--ignore-gpu-blocklist` this is the check that says whether the GPU is still allowed);
//   * sandbox state and GPU rasterisation — NO page-visible query exists, so they are reported as
//     "not observable"; the argument list in the log is the only evidence.
//
// Nothing here changes behaviour: it reads and returns lines for the startup to log.

interface AutoplayNavigator extends Navigator {
  getAutoplayPolicy?: (type: string) => string;
}

/** One line per probe, for `debug.log` / `boot.log`. */
export function probeWebviewFlags(): readonly string[] {
  const lines: string[] = [];
  const nav = navigator as AutoplayNavigator;
  for (const kind of ["mediaelement", "audiocontext"]) {
    try {
      const policy = nav.getAutoplayPolicy?.(kind);
      lines.push(`WEBVIEW probe: autoplay(${kind}) = ${policy ?? "unavailable"}`);
    } catch (err) {
      lines.push(`WEBVIEW probe: autoplay(${kind}) threw ${String(err)}`);
    }
  }
  const gpu = (navigator as Navigator & { gpu?: unknown }).gpu;
  lines.push(`WEBVIEW probe: WebGPU = ${typeof gpu === "object" && gpu !== null ? "present" : "MISSING"}`);
  lines.push("WEBVIEW probe: sandbox / GPU rasterisation are NOT observable from the page (argument list only)");
  return lines;
}
