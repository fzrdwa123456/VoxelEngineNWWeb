// ===== THE WINDOWS WEBVIEW HOST (P1.80) =====
//
// The two things the WebView2 HOST (not the page, not the pointer) needs from Win32:
//
//   1. the LAUNCH ARGUMENTS - WebView2 reads them from an environment variable before the webview is
//      created. **This list is the ONE source of truth (P1.81)**: it used to be duplicated in
//      `tauri.conf.json`, and the two copies had already drifted apart (the config carried the three
//      `ms*` flags below and this list did not, so switching vsync off silently re-enabled those
//      components - wry's own default is replaced, not extended, by anything that sets the variable).
//      The config key is gone; the backend publishes the whole list at startup.
//   2. `SetAreBrowserAcceleratorKeysEnabled(false)` + no default context menus, which Tauri 2.11
//      does not expose (wry does).
//
// Both are WebView2 concepts, so both live here rather than in `game.rs`/`lib.rs`, which now ask
// `crate::platform` for them and never name a WebView2 variable.
//
// A port implements `crate::platform::WebviewBackend` for its own webview host (WKWebView,
// WebKitGTK, the Android/iOS system webview) - and most of these methods are a no-op there.

use std::path::PathBuf;

use tauri::WebviewWindow;

use crate::platform::WebviewBackend;

/// The WebView2 backend. A unit struct: the two switches are set once, on the host.
pub struct WindowsWebview;

/// The **base** arguments WebView2 is launched with - the complete list, because a non-empty
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` **replaces** whatever the host was configured with
/// (wry's default included), so anything that appends must repeat the base verbatim.
///
/// The last flag is not optional: wry passes `--disable-features=msWebOOUI,msPdfOOUI,
/// msSmartScreenProtection` by default (`tauri-utils` documents exactly this), and setting the
/// variable replaces that default - so it has to be spelled out here or those three components come
/// back the moment anything appends to this list.
///
/// `--force_high_performance_gpu` (P2.07) is Chromium's switch for the OUTER half of the GPU choice.
/// `WebGPURenderer` already asks for the discrete adapter (`powerPreference: "high-performance"`,
/// `src/boot/main.ts`), but that is only a request inside the WebView: on a hybrid laptop Windows picks
/// the adapter for the **WebView2 process** and defaults to the power-saving one, so the engine was
/// running on the integrated GPU with the discrete one idle (the user's report, seen in Task Manager).
/// The per-app route (Windows Settings -> Display -> Graphics -> `msedgewebview2.exe` -> High
/// performance) fixes it too and is what the user did first; this flag makes it the default for every
/// install. The informed-consent cost: the discrete GPU is used ALWAYS, so battery life on a laptop
/// suffers, and on a machine whose only adapter is the integrated one Chromium simply ignores it.
/// `boot.log` prints the argument list in force, and the GPU stage of the startup now prints WHICH
/// adapter WebGPU actually got, so both halves are verifiable from the logs.
const BROWSER_ARGS_BASE: &str = "--autoplay-policy=no-user-gesture-required \
--no-user-gesture-required --enable-gpu-rasterization --ignore-gpu-blocklist \
--force_high_performance_gpu \
--disable-gesture-requirement-for-presentation \
--disable-blink-features=RateLimitPointerLockRequests \
--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// The environment variable the WebView2 loader reads **before the webview is created**
/// (`game::apply_browser_args` runs before `tauri::Builder` for exactly that reason).
const BROWSER_ARGS_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

impl WebviewBackend for WindowsWebview {
    fn browser_args_base(&self) -> &'static str {
        BROWSER_ARGS_BASE
    }

    fn publish_browser_args(&self, args: &str) {
        std::env::set_var(BROWSER_ARGS_ENV, args);
    }

    fn browser_args_in_force(&self) -> String {
        std::env::var(BROWSER_ARGS_ENV).unwrap_or_default()
    }

    fn disable_browser_accelerator_keys(&self, window: &WebviewWindow, log_root: PathBuf) {
        disable_browser_accelerator_keys(window, log_root)
    }
}

/// ===== Option A: turn off WebView2's **browser accelerator keys** =====
///
/// WebView2 defaults to `AreBrowserAcceleratorKeysEnabled = true`, so these keys are taken over by
/// the browser:
///   F3 -> pops up "Find" (in this project F3 is the debug panel / the F3+F4 game-mode picker hotkey!)
///   Ctrl+F -> find bar, F5 -> reload, F12 -> DevTools, Ctrl+P -> print ...
///
/// Tauri 2.11 does **not** expose this switch (in `tauri-2.11.5/src` there is only the menu
/// accelerator, no `accelerator_keys`). wry does (`with_browser_accelerator_keys`, landing on
/// `SetAreBrowserAcceleratorKeysEnabled(false)`), so this goes through Tauri's official
/// `with_webview` to obtain `ICoreWebView2Controller` and set it once.
///
/// The cost (informed consent): **Ctrl+C / Ctrl+V / Ctrl+A and the like are disabled with it**.
/// The game does not need them.
/// The result is written to logs\boot.log, so it is easy to confirm whether it was set or not.
pub fn disable_browser_accelerator_keys(window: &WebviewWindow, log_root: std::path::PathBuf) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    // The closure must be 'static, so root has to be moved in; the outer Err branch still needs
    // it, so keep a copy first.
    let root_for_outer_log = log_root.clone();
    match window.with_webview(move |webview| {
        // SAFETY: with_webview guarantees this callback runs while the webview is alive, and on
        // the right thread.
        // On Windows `PlatformWebview::controller()` **returns** ICoreWebView2Controller directly
        // (not a raw pointer — that is the macOS branch's signature).
        let result = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.Settings())
                .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
                .and_then(|settings3| settings3.SetAreBrowserAcceleratorKeysEnabled(false))
                // **WebView2's own context menu must be disabled as well**. It is popped up by the
                // **host** (not by the page), so preventDefault on the page's `contextmenu` cannot
                // block it; and it pops a window on the menu key / Shift+F10 / right-click —
                // Windows gives that popup a **visible cursor**, our 8ms cursor sentinel then
                // presses it back to hidden, and what the player sees is "the mouse flashes".
                // In the game right-click is "place a block", so no context menu is needed at all.
                .and_then(|_| {
                    webview
                        .controller()
                        .CoreWebView2()
                        .and_then(|core| core.Settings())
                        .and_then(|settings| settings.SetAreDefaultContextMenusEnabled(false))
                })
        };
        let line = match result {
            Ok(()) => "webview2: browser accelerator keys + DEFAULT CONTEXT MENUS disabled".to_string(),
            Err(e) => format!("webview2: FAILED to disable browser accelerator keys / context menus: {e}"),
        };
        crate::game::append_boot(&log_root, &line);
    }) {
        Ok(()) => {}
        Err(e) => crate::game::append_boot(
            &root_for_outer_log,
            &format!("webview2: with_webview failed: {e}"),
        ),
    }
}
