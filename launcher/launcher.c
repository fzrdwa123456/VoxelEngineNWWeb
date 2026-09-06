// ===== VoxelEngineNWWeb portable launcher (NW.js edition, simplified) =====
// Launches game\core\core.exe (renamed NW.js) and passes --user-data-dir pointing to game\data
// (localStorage/cache land in game\data; the portable folder can be moved as a whole).
// No hooks/no pipes: ESC is left to NW.js 0.112 (#7907: keydown preventDefault keeps the lock).
#include <windows.h>
#include <wchar.h>

static void die(const wchar_t *extra, DWORD err) {
  wchar_t msg[600];
  wsprintfW(msg, L"%s\nGetLastError = %lu", extra, err);
  MessageBoxW(NULL, msg, L"VoxelEngineNWWeb Launcher", MB_OK | MB_ICONERROR);
  ExitProcess(1);
}

int wmain(int argc, wchar_t *argv[]) {
  wchar_t self[MAX_PATH];
  if (GetModuleFileNameW(NULL, self, MAX_PATH) == 0) die(L"GetModuleFileNameW failed", GetLastError());
  wchar_t *slash = wcsrchr(self, L'\\');
  if (slash) *slash = L'\0';

  wchar_t target[MAX_PATH];
  wsprintfW(target, L"%s\\game\\core\\core.exe", self);
  if (GetFileAttributesW(target) == INVALID_FILE_ATTRIBUTES) {
    wchar_t msg[600];
    wsprintfW(msg, L"core.exe not found:\n%s", target);
    MessageBoxW(NULL, msg, L"VoxelEngineNWWeb Launcher", MB_OK | MB_ICONERROR);
    return 1;
  }

    // game\data as the NW.js user-data-dir (localStorage/cache); game\logs keeps renderer-side logs
    // MC-style multi-instance: Chromium has a process singleton lock per user-data-dir; launching twice exits the second instance silently.
    // Fix: assign each instance its own data directory —
    //   explicit arg --N (e.g. --2): fixed use of game\dataN
    //   no arg: a named mutex finds a free slot automatically (1st game\data, 2nd game\data2, 3rd game\data3...)
    //          the mutex releases on process exit; the next start fills from data again
  wchar_t gameDir[MAX_PATH], dataDir[MAX_PATH], logDir[MAX_PATH], logPath[MAX_PATH];
  int slot = 0; // 0 = data, N = dataN
  for (int i = 1; i < argc; i++) {
    if (argv[i][0] == L'-' && argv[i][1] == L'-' && argv[i][2] >= L'2' && argv[i][2] <= L'9' && argv[i][3] == L'\0') {
      slot = argv[i][2] - L'0';  // "--2" -> slot 2 (explicit, no occupancy check)
      break;
    }
  }
  HANDLE hMutex = NULL;
  if (slot == 0) {
        // Find a free slot: try data, data2, data3... until one's mutex is unowned
    for (;; slot++) {
      wchar_t mutexName[64];
      wsprintfW(mutexName, L"VoxelEngineNWWeb_instance_%d", slot);
      hMutex = CreateMutexW(NULL, TRUE, mutexName);
      if (hMutex && GetLastError() != ERROR_ALREADY_EXISTS) break;  // Free slot; keep holding the mutex until the launcher exits
      if (hMutex) CloseHandle(hMutex);
      if (slot >= 16) { slot = 0; hMutex = NULL; break; }  // Cap: all full -> squeeze into the default slot (rely on Chromium's own behavior)
    }
  }
  wsprintfW(gameDir, L"%s\\game", self);
  if (slot == 0) wsprintfW(dataDir, L"%s\\game\\data", self);
  else wsprintfW(dataDir, L"%s\\game\\data%d", self, slot);
  wsprintfW(logDir, L"%s\\game\\logs", self);
  if (slot == 0) wsprintfW(logPath, L"%s\\game\\logs\\launcher.log", self);
  else wsprintfW(logPath, L"%s\\game\\logs\\launcher%d.log", self, slot);
  CreateDirectoryW(gameDir, NULL);
  CreateDirectoryW(dataDir, NULL);
  CreateDirectoryW(logDir, NULL);

  HANDLE hLog = CreateFileW(logPath, GENERIC_WRITE, FILE_SHARE_READ, NULL,
                            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (hLog == INVALID_HANDLE_VALUE) die(L"cannot create launcher.log", GetLastError());

    // Command line: core.exe --user-data-dir="<game>\dataN" [forwarded external args (instance slot args excepted)]
  wchar_t cmdline[4096];
  int pos = wsprintfW(cmdline, L"\"%s\" --user-data-dir=\"%s\"", target, dataDir);
  for (int i = 1; i < argc; i++) {
    if (argv[i][0] == L'-' && argv[i][1] == L'-' && argv[i][2] >= L'2' && argv[i][2] <= L'9' && argv[i][3] == L'\0') {
      continue;  // --N already became a slot; do not forward
    }
    pos += wsprintfW(cmdline + pos, L" %s", argv[i]);
  }

  STARTUPINFOW si;
  ZeroMemory(&si, sizeof(si));
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdOutput = hLog;
  si.hStdError = hLog;

  PROCESS_INFORMATION pi;
  ZeroMemory(&pi, sizeof(pi));
  if (!CreateProcessW(target, cmdline, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
    CloseHandle(hLog);
    die(L"CreateProcessW failed", GetLastError());
  }

  CloseHandle(hLog);
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hProcess);
  CloseHandle(pi.hThread);
  return (int)code;
}