// ===== THE DISPLAY's refresh rate (P1.86) =====
//
// The frame pacing is locked to the panel's real refresh rate, so the number has to come from the operating
// system, not from a measurement the page makes:
//
//   * a rAF-derived measurement CANNOT work any more — the launch arguments lift Chromium's display-rate
//     limit, so rAF fires several times per refresh and what a delta measures is the machine, not the panel;
//   * and the answer has to be RATIO-EXACT. A 59.94Hz panel answered as "60" makes a cap of 60 drift against
//     the display: one duplicated frame every ~16 seconds, which reads as a stutter nobody can explain.
//     DWM's own timing ratio gives 60000/1001, so this returns MILLI-HZ (59940), not whole Hz.
//
// Windows only, and it is not part of the three backend traits: "how fast does this display refresh" is a
// question the composition root asks, not a capability the cursor/device/webview halves own. A port that has
// no answer returns 0, which the front end reads as "unknown" and paces at a plain 60 — never as "uncapped".
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{DwmGetCompositionTimingInfo, DWM_TIMING_INFO};

/// The refresh rate of the display the composition engine is presenting to, in milli-Hz, or 0 when the
/// platform cannot answer.
///
/// `DwmGetCompositionTimingInfo(NULL, ...)` describes the DESKTOP's composition (one window is composited by
/// one DWM), and `rateRefresh` carries the refresh rate as an exact numerator/denominator pair — which is
/// where 59.94 survives. `qpcRefreshPeriod` (in QPC ticks) would need `QueryPerformanceFrequency` and is
/// therefore only a cross-check, not the source.
///
/// This runs on the MAIN thread (it is called from `preload_shell` and from the window-mode command), which
/// is what DWM's API expects. It only reads.
pub fn display_refresh_milli_hz() -> u32 {
    // SAFETY: the struct is `Default`-initialised and `cbSize` is set as the API requires; the call only
    // READS the desktop's timing state and writes into our own struct.
    unsafe {
        let mut info = DWM_TIMING_INFO::default();
        info.cbSize = std::mem::size_of::<DWM_TIMING_INFO>() as u32;
        if DwmGetCompositionTimingInfo(HWND::default(), &mut info).is_err() {
            return 0;
        }
        let (num, den) = (info.rateRefresh.uiNumerator, info.rateRefresh.uiDenominator);
        if num == 0 || den == 0 {
            return 0;
        }
        ((num as u64 * 1000) / den as u64) as u32
    }
}
