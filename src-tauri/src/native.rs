// ===== THE NATIVE RENDER LAYER (Rust + wgpu) — step 1: the surface, the camera and the world plane =====
//
// WHY THIS EXISTS: the WebView's compositor owns the window surface and pins the frame rate to the display,
// so the two things this engine kept fighting — a REAL vertical-sync switch (a present mode) and full control
// of the frame rate — are not reachable from the page. This module renders the world on a NATIVE child window
// with wgpu, BEHIND the (transparent) WebView, so the HTML UI keeps its layout/live-resize behaviour while the
// world is drawn by us. See docs/ROADMAP P1.87.
//
// WHAT IS TRUE IN THIS STEP (be honest about it):
//   * the world's visible surface — the flat generator's ground plane at the terrain top, with a visible block
//     grid and per-chunk tint — is generated and drawn by wgpu here, at the RIGHT world coordinates;
//   * the camera comes from the game (the composition root pushes position + orientation + fov + viewport on
//     every frame, exactly the way it pushes anything else);
//   * the present mode follows the existing vertical-sync setting and can be changed AT RUNTIME (that is the
//     switch the browser could not give us);
//   * a `NATIVE` line lands in debug.log once a second with the frame rate, the worst frame and the present
//     mode, so the two renderers can be compared;
//   * NOT YET: block edits (digging/placing), textures, the chunk mesher and 3D UI. The plane is the flat
//     world's surface, which is what the current renderer shows too; the next step replaces it with real
//     chunk meshes generated here.
//
// SAFETY / LIFETIME: the child window is created once, owned by the parent window, and destroyed with it. The
// render thread is stopped by `stop()` (or by the process exiting). Every shared value is behind a Mutex; the
// render thread never touches Tauri state, only the HWND and its own wgpu objects.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, RegisterClassW, SetWindowPos,
    ShowWindow, CS_HREDRAW, CS_VREDRAW, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    SW_SHOW, WINDOW_EX_STYLE, WM_DESTROY, WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS, WS_VISIBLE,
};

/// What the game pushes every frame: where the eye is, where it looks, and the size to draw into.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pose {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Orientation as a quaternion (the camera's own rotation — no Euler round trip).
    pub qx: f32,
    pub qy: f32,
    pub qz: f32,
    pub qw: f32,
    /// Vertical field of view in degrees (the camera's own fov).
    pub fov_y: f32,
    pub width: u32,
    pub height: u32,
}

impl Default for Pose {
    fn default() -> Self {
        Self {
            x: 0.5,
            y: 129.6,
            z: 0.5,
            qx: 0.0,
            qy: 0.0,
            qz: 0.0,
            qw: 1.0,
            fov_y: 75.0,
            width: 1280,
            height: 720,
        }
    }
}

/// The one line `native_stats()` answers with (the front end logs it).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStats {
    pub running: bool,
    pub adapter: String,
    pub present: String,
    pub frames: u64,
    pub fps: f32,
    pub worst_ms: f32,
    pub size: String,
}

struct Shared {
    pose: Mutex<Pose>,
    /// Vertical sync ON means `Fifo` (the panel's cadence); OFF means `Immediate` (no wait at all).
    vsync: AtomicBool,
    stop: AtomicBool,
    /// Last second's numbers, for `native_stats()` and the once-a-second log line.
    frames: Mutex<(u64, f32, f32, String)>,
    adapter: Mutex<String>,
    /// Why the render thread gave up (the front end turns this into "keep the web renderer").
    failure: Mutex<Option<String>>,
    child: Mutex<isize>,
    root: PathBuf,
}

static SHARED: OnceLock<Arc<Shared>> = OnceLock::new();

fn shared() -> Option<&'static Arc<Shared>> {
    SHARED.get()
}

/// The child window's own procedure: it draws nothing itself (wgpu does), so `DefWindowProcW` is the whole
/// implementation. A message loop is NOT needed here — the WebView owns the parent's loop, and this window
/// only has to exist as a surface.
unsafe extern "system" fn child_proc(
    hwnd: HWND,
    msg: u32,
    w: WPARAM,
    l: LPARAM,
) -> LRESULT {
    if msg == WM_DESTROY {
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(hwnd, msg, w, l) }
}

/// **Start the native layer** (idempotent). Creates the child window behind the WebView and spawns the render
/// thread. Answers a one-line summary for the log, or the reason it could not start (the front end then keeps
/// drawing with the web renderer — the fallback is deliberate: a broken native path must never leave a black
/// screen).
pub fn start(window: &WebviewWindow, root: PathBuf, vsync: bool) -> Result<String, String> {
    if let Some(s) = shared() {
        if !s.stop.load(Ordering::SeqCst) {
            return Ok(format!("already running ({})", s.adapter.lock().unwrap()));
        }
    }    let parent = window.hwnd().map_err(|e| format!("no native window: {e}"))?;
    let (w, h) = client_size(parent);
    let child = create_child(parent, w.max(1), h.max(1))?;
    // The webview's HOST window paints its own background (wry registers the class with the configured
    // `backgroundColor`, i.e. opaque black), and that paint lands on top of our child no matter what the PAGE
    // does. Clearing the class brush is what actually lets the native world show through.
    clear_host_background(parent, &root);

    let shared = Arc::new(Shared {
        pose: Mutex::new(Pose::default()),
        vsync: AtomicBool::new(vsync),
        stop: AtomicBool::new(false),
        frames: Mutex::new((0, 0.0, 0.0, "fifo".to_string())),
        adapter: Mutex::new("(starting)".to_string()),
        failure: Mutex::new(None),
        child: Mutex::new(child.0 as isize),
        root,
    });
    let _ = SHARED.set(shared.clone());

    let thread_shared = shared.clone();
    // The HWND is a raw pointer, so it cannot cross into the thread: the ADDRESS goes instead and the handle
    // is rebuilt on the other side (the window is alive for as long as this thread runs — `stop()` destroys it
    // only after setting the stop flag).
    let child_addr = child.0 as isize;
    std::thread::Builder::new()
        .name("native-render".to_string())
        .spawn(move || {
            let child = HWND(child_addr as *mut std::ffi::c_void);
            if let Err(why) = crate::native_gpu::run(child) {
                append(&thread_shared.root, &format!("NATIVE failed: {why}"));
                *thread_shared.failure.lock().unwrap() = Some(why);
                thread_shared.stop.store(true, Ordering::SeqCst);
            }
        })
        .map_err(|e| format!("no render thread: {e}"))?;

    // The render thread reports its adapter asynchronously; wait a moment so the summary is useful — and so a
    // FAILURE is reported instead of a cheerful "starting". The front end treats an `Err` here as "keep the
    // web renderer", so a native layer that cannot come up never leaves a blank screen.
    for _ in 0..200 {
        if let Some(why) = shared.failure.lock().unwrap().clone() {
            return Err(why);
        }
        let adapter = shared.adapter.lock().unwrap().clone();
        if adapter != "(starting)" {
            return Ok(format!("{adapter} · {}x{}", w, h));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    if shared.stop.load(Ordering::SeqCst) {
        return Err(shared
            .failure
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "the render thread stopped".to_string()));
    }
    Ok(format!("starting · {}x{}", w, h))
}

pub fn set_pose(pose: Pose) {
    if let Some(s) = shared() {
        *s.pose.lock().unwrap() = pose;
    }
}

/// The runtime vertical-sync switch: the surface is reconfigured with the other present mode on the next
/// frame. This is the one thing the WebView's compositor could not offer.
pub fn set_vsync(vsync: bool) {
    if let Some(s) = shared() {
        s.vsync.store(vsync, Ordering::SeqCst);
    }
}

pub fn stats() -> NativeStats {
    let Some(s) = shared() else {
        return NativeStats {
            running: false,
            adapter: "(not started)".to_string(),
            present: "-".to_string(),
            frames: 0,
            fps: 0.0,
            worst_ms: 0.0,
            size: "-".to_string(),
        };
    };
    let (frames, fps, worst, present) = {
        let got = s.frames.lock().unwrap();
        (got.0, got.1, got.2, got.3.clone())
    };
    let pose = *s.pose.lock().unwrap();
    NativeStats {
        running: !s.stop.load(Ordering::SeqCst),
        adapter: s.adapter.lock().unwrap().clone(),
        present,
        frames,
        fps,
        worst_ms: worst,
        size: format!("{}x{}", pose.width, pose.height),
    }
}

pub fn stop() {
    if let Some(s) = shared() {
        s.stop.store(true, Ordering::SeqCst);
        if let Ok(mut child) = s.child.lock() {
            if *child != 0 {
                unsafe {
                    let _ = DestroyWindow(HWND(*child as *mut std::ffi::c_void));
                }
                *child = 0;
            }
        }
    }
}

/// The pose the render thread reads (used by `native_gpu`).
pub(crate) fn current_pose() -> (Pose, bool) {
    match shared() {
        Some(s) => (*s.pose.lock().unwrap(), s.vsync.load(Ordering::SeqCst)),
        None => (Pose::default(), true),
    }
}

pub(crate) fn should_stop() -> bool {
    shared().is_none_or(|s| s.stop.load(Ordering::SeqCst))
}

pub(crate) fn report(adapter: String) {
    if let Some(s) = shared() {
        *s.adapter.lock().unwrap() = adapter;
    }
}

pub(crate) fn report_second(frames: u64, fps: f32, worst: f32, present: &str) {
    if let Some(s) = shared() {
        *s.frames.lock().unwrap() = (frames, fps, worst, present.to_string());
    }
}

pub(crate) fn log(line: &str) {
    if let Some(s) = shared() {
        append(&s.root, line);
    }
}

/// **Show or hide the WebView's host window** (P1.87).
///
/// THE FINDING THIS EXISTS FOR, measured: WebView2's *windowed* hosting paints its own opaque surface over a
/// native child window, and `SetDefaultBackgroundColor(A=0)` is not honoured there (the page is transparent,
/// the host is not) — the native world was rendering correctly the whole time, behind an opaque host. The
/// supported cure is WebView2's *visual hosting* (a composition controller), which wry does not use; the cheap
/// one is not to have the two layers on screen at the same time.
///
/// So the hand-off is by MODE: with a world running the webview is shrunk to a 1x1 window in the corner (it
/// stays VISIBLE, which matters — Chromium throttles a hidden page's rAF, and the game loop lives there!), and
/// for the menus, the loading screen and the startup it is restored to the whole client area.
///
/// What this costs, honestly: the HTML HUD (crosshair, hotbar, F3) is part of the page, so it is off screen
/// while the webview is shrunk. Drawing those in wgpu is the 3D-UI step of the same round.
pub fn set_webview_visible(show: bool) {
    let Some(s) = shared() else { return };
    let Ok(child) = s.child.lock().map(|c| *c) else { return };
    if child == 0 {
        return;
    }
    let parent = parent_of(HWND(child as *mut std::ffi::c_void));
    let (w, h) = client_size(parent);
    // `parent_of` is a one-liner over GetParent (shared with the GPU module's resize code).
    fn parent_of(hwnd: HWND) -> HWND {
        unsafe { windows::Win32::UI::WindowsAndMessaging::GetParent(hwnd) }.unwrap_or(hwnd)
    }
    let class: Vec<u16> = "WRY_WEBVIEW\0".encode_utf16().collect();
    let Ok(webview) = (unsafe {
        windows::Win32::UI::WindowsAndMessaging::FindWindowExW(
            Some(parent),
            None,
            PCWSTR(class.as_ptr()),
            PCWSTR::null(),
        )
    }) else {
        return;
    };
    if webview.0.is_null() {
        return;
    }
    let (x, y, cw, ch) = if show { (0, 0, w.max(1), h.max(1)) } else { (0, 0, 1, 1) };
    unsafe {
        let _ = SetWindowPos(
            webview,
            None,
            x,
            y,
            cw as i32,
            ch as i32,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
    append(
        &s.root,
        &format!(
            "NATIVE webview host {} ({}x{})",
            if show { "restored" } else { "shrunk to 1x1 so the native world is visible" },
            cw,
            ch
        ),
    );
}

/// One line into `logs\debug.log`, through the game's own batched sink.
fn append(root: &std::path::Path, line: &str) {
    crate::game::append_log(root, "debug", &[line.to_string()]);
}

/// The parent window's CLIENT size (the area the canvas would have filled).
pub fn client_size(hwnd: HWND) -> (u32, u32) {
    let mut rect = RECT::default();
    if unsafe { GetClientRect(hwnd, &mut rect) }.is_err() {
        return (0, 0);
    }
    (
        (rect.right - rect.left).max(0) as u32,
        (rect.bottom - rect.top).max(0) as u32,
    )
}

/// Create the child window that wgpu draws into. It is pushed to the BOTTOM of the z-order on purpose: the
/// WebView is the sibling above it, and the WebView's default background is made transparent (see
/// `platform/windows/webview.rs`), so the HTML UI floats over the native world.
fn create_child(parent: HWND, width: u32, height: u32) -> Result<HWND, String> {
    let class_name: Vec<u16> = "VoxelNativeSurface\0".encode_utf16().collect();
    let instance = unsafe { GetModuleHandleW(None) }.map_err(|e| format!("no module handle: {e}"))?;
    let class = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(child_proc),
        hInstance: instance.into(),
        lpszClassName: PCWSTR(class_name.as_ptr()),
        ..Default::default()
    };
    // A class already registered on a hot reload is fine: the registration just fails.
    unsafe { RegisterClassW(&class) };

    let child = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            0,
            0,
            width as i32,
            height as i32,
            Some(parent),
            None,
            Some(instance.into()),
            None,
        )
    }
    .map_err(|e| format!("CreateWindowExW failed: {e}"))?;
    if child.0.is_null() {
        return Err("CreateWindowExW returned a null window".to_string());
    }
    unsafe {
        let _ = SetWindowPos(
            child,
            Some(HWND_BOTTOM),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        let _ = ShowWindow(child, SW_SHOW);
    }
    Ok(child)
}

/// **Make the WebView's HOST window stop painting an opaque background.**
///
/// This is the piece that is easy to miss: `SetDefaultBackgroundColor(A=0)` makes the PAGE transparent, but the
/// Win32 window wry hosts it in still paints its own background — the class brush, registered from the
/// configured `backgroundColor` (opaque black) — and that paint covers the native layer behind it. Clearing the
/// class brush (and repainting once) is what lets the world show through; the UI's own panels still paint, so
/// nothing about the interface changes.
///
/// Both windows are cleared: the host's brush paints over our child, and the top-level's paints behind
/// everything (harmless, but one call removes a whole class of surprise). A wry that renamed its class shows up
/// as a line in the log rather than as a black screen with no explanation.
fn clear_host_background(parent: HWND, root: &std::path::Path) {
    use windows::Win32::Graphics::Gdi::InvalidateRect;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, SetClassLongPtrW, GCLP_HBRBACKGROUND,
    };
    let class: Vec<u16> = "WRY_WEBVIEW\0".encode_utf16().collect();
    let found = unsafe { FindWindowExW(Some(parent), None, PCWSTR(class.as_ptr()), PCWSTR::null()) };
    let Ok(webview) = found else {
        append(
            root,
            "NATIVE could not find the webview host window (WRY_WEBVIEW): the native layer stays behind an opaque host",
        );
        return;
    };
    if webview.0.is_null() {
        append(
            root,
            "NATIVE the webview host window is null: the native layer stays behind an opaque host",
        );
        return;
    }
    unsafe {
        SetClassLongPtrW(webview, GCLP_HBRBACKGROUND, 0);
        SetClassLongPtrW(parent, GCLP_HBRBACKGROUND, 0);
        let _ = InvalidateRect(Some(webview), None, true);
        let _ = InvalidateRect(Some(parent), None, true);
    }
    append(
        root,
        "NATIVE cleared the webview host's background brush (the page is transparent where it paints nothing)",
    );
}
