// ===== VoxelEngineNWWeb 绿色启动器 (NW.js 版, 简版) =====
// 启动 game\core\core.exe (NW.js 改名) 并传 --user-data-dir 到 game\data
// (localStorage/缓存落 game\data, 绿色版可整体移动)。
// 无钩子/无管道: ESC 交给 NW.js 0.112 (#7907: keydown preventDefault 保持锁定)。
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

  // game\data 作为 NW.js user-data-dir (localStorage/缓存), game\logs 留渲染层日志
  // MC 式多开: Chromium 对同一 user-data-dir 有进程单例锁, 双击两次第二个实例会静默退出。
  // 解法: 每个实例分配独立数据目录 ——
  //   显式参数 --N (如 --2): 固定用 game\dataN
  //   无参数: 命名互斥体自动找空槽 (第1个 game\data, 第2个 game\data2, 第3个 game\data3...)
  //          互斥体随进程退出自动释放, 下次启动重新从 data 开始填
  wchar_t gameDir[MAX_PATH], dataDir[MAX_PATH], logDir[MAX_PATH], logPath[MAX_PATH];
  int slot = 0; // 0 = data, N = dataN
  for (int i = 1; i < argc; i++) {
    if (argv[i][0] == L'-' && argv[i][1] == L'-' && argv[i][2] >= L'2' && argv[i][2] <= L'9' && argv[i][3] == L'\0') {
      slot = argv[i][2] - L'0'; // "--2" -> 槽位 2 (显式指定, 不做占用检查)
      break;
    }
  }
  HANDLE hMutex = NULL;
  if (slot == 0) {
    // 自动找空槽: 尝试 data, data2, data3... 直到拿到没人占用的互斥体
    for (;; slot++) {
      wchar_t mutexName[64];
      wsprintfW(mutexName, L"VoxelEngineNWWeb_instance_%d", slot);
      hMutex = CreateMutexW(NULL, TRUE, mutexName);
      if (hMutex && GetLastError() != ERROR_ALREADY_EXISTS) break; // 空槽, 互斥体保持持有直到 launcher 退出
      if (hMutex) CloseHandle(hMutex);
      if (slot >= 16) { slot = 0; hMutex = NULL; break; } // 上限保护: 都满则挤默认槽 (靠 Chromium 自身行为)
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

  // 命令行: core.exe --user-data-dir="<game>\dataN" [透传外部参数 (实例槽位参数除外)]
  wchar_t cmdline[4096];
  int pos = wsprintfW(cmdline, L"\"%s\" --user-data-dir=\"%s\"", target, dataDir);
  for (int i = 1; i < argc; i++) {
    if (argv[i][0] == L'-' && argv[i][1] == L'-' && argv[i][2] >= L'2' && argv[i][2] <= L'9' && argv[i][3] == L'\0') {
      continue; // --N 已转成槽位, 不透传
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