#include <windows.h>
#include <stdlib.h>

// Cursor centering tool: Electron has no API to set the system cursor; the renderer cannot move the system cursor,
// so when menus/inventory open the main process calls this tool to move the cursor to screen coords (x, y)
int main(int argc, char* argv[]) {
  if (argc < 3) return 1;
  return SetCursorPos(atoi(argv[1]), atoi(argv[2])) ? 0 : 1;
}