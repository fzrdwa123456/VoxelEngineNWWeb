#include <windows.h>
#include <stdlib.h>
#include <string.h>

// winctl.exe: native window control tool. Works around NW.js window API unreliability on maximized windows:
// moveTo/setInnerWidth on a maximized window first restores windowed geometry (rcNormalPosition small window)
// causing a flicker frame, and consecutive resizeTo/setInnerWidth calls asynchronously drop sizes (nwjs/nw.js#7303).
//   winctl.exe fill          -- find the game window, clear WS_MAXIMIZE and fill the screen (maximize->fullscreen switch)
//   winctl.exe move x y w h  -- move the window and set the client size (logical pixel args, converted by DPI internally)
//   winctl.exe topmost 0|1   -- cancel/set window topmost (after kiosk fullscreen, cancel HWND_TOPMOST,
//                               restoring normal fullscreen Z-order; the taskbar still yields)
// The window title is fixed to the manifest's "VoxelEngineWeb"; falls back to the foreground window when not found
static HWND find_window(void) {
  HWND hwnd = FindWindowW(NULL, L"VoxelEngineWeb");
  if (hwnd == NULL)
    hwnd = GetForegroundWindow();
  return hwnd;
}

static double dpi_scale(HWND hwnd) {
  UINT dpi = 96;
  typedef UINT(WINAPI* GetDpiForWindow_t)(HWND);
  GetDpiForWindow_t get_dpi = (GetDpiForWindow_t)GetProcAddress(
      GetModuleHandleW(L"user32.dll"), "GetDpiForWindow");
  if (get_dpi != NULL) {
    UINT v = get_dpi(hwnd);
    if (v != 0)
      dpi = v;
  } else {
    HDC dc = GetDC(hwnd);
    if (dc != NULL) {
      dpi = GetDeviceCaps(dc, LOGPIXELSX);
      ReleaseDC(hwnd, dc);
    }
  }
  return dpi / 96.0;
}

// Client size -> window frame size (SetWindowPos's cx/cy are the frame; measured deltas are the most reliable)
static void client_to_outer(HWND hwnd, int* w, int* h) {
  RECT win_rect, client_rect;
  GetWindowRect(hwnd, &win_rect);
  GetClientRect(hwnd, &client_rect);
  *w += (win_rect.right - win_rect.left) - client_rect.right;
  *h += (win_rect.bottom - win_rect.top) - client_rect.bottom;
}

static int do_fill(HWND hwnd) {
    // After clearing WS_MAXIMIZE the window falls back to rcNormalPosition; SetWindowPos fills immediately;
    // both steps complete synchronously with no repaint gap in between (more deterministic than Chromium's async restore)
  LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
  SetWindowLongPtrW(hwnd, GWL_STYLE, style & ~WS_MAXIMIZE);
  int w = GetSystemMetrics(SM_CXSCREEN);
  int h = GetSystemMetrics(SM_CYSCREEN);
  return SetWindowPos(hwnd, NULL, 0, 0, w, h,
                      SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)
             ? 0
             : 1;
}

static int do_move(HWND hwnd, int x, int y, int w, int h) {
  double scale = dpi_scale(hwnd);
  client_to_outer(hwnd, &w, &h);
  return SetWindowPos(hwnd, NULL, (int)(x * scale), (int)(y * scale),
                      (int)(w * scale), (int)(h * scale),
                      SWP_NOZORDER | SWP_NOACTIVATE)
             ? 0
             : 1;
}

static int do_topmost(HWND hwnd, int on) {
  return SetWindowPos(hwnd, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0,
                      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
             ? 0
             : 1;
}

int main(int argc, char* argv[]) {
  if (argc < 2)
    return 1;
  HWND hwnd = find_window();
  if (hwnd == NULL)
    return 1;
  if (strcmp(argv[1], "fill") == 0)
    return do_fill(hwnd);
  if (strcmp(argv[1], "move") == 0 && argc >= 6)
    return do_move(hwnd, atoi(argv[2]), atoi(argv[3]), atoi(argv[4]),
                   atoi(argv[5]));
  if (strcmp(argv[1], "topmost") == 0 && argc >= 3)
    return do_topmost(hwnd, atoi(argv[2]));
  return 1;
}
