// ===== Pointer lock management =====

export interface PointerLockDeps {
  /** What the lock manager needs from the input system (structural, no concrete class) */
  input: { lock(): Promise<void> | undefined; clickLockAllowed: boolean };
  isMenuOpen: () => boolean;
  isInvOpen: () => boolean;
  logDebug: (line: string) => void;
}

// All relock() calls come from direct user interaction (clicking singleplayer / E closing the inventory / ESC resuming), so no focus gating anymore:
// Chromium rejects requestPointerLock when the window is not foreground (triggering a 1300ms retry), which naturally prevents "capturing" the mouse.

export class PointerLock {
  constructor(private readonly deps: PointerLockDeps) {}

  relock(source: string): void {
        this.deps.logDebug(`LOCK request [${source}]`);
    const tryLock = (): void => {
      if (this.deps.isMenuOpen() || this.deps.isInvOpen()) return;
      const p = this.deps.input.lock();
      if (p) {
        p.catch(() => {
                    this.deps.logDebug(`LOCK rejected [${source}], retrying in 1300ms`);
          setTimeout(tryLock, 1300);
        });
      }
    };
    tryLock();
  }

    // Cursor: hidden while the game runs (no main menu; crosshair HUD), shown when menus/inventory are open
  applyCursor(): void {
    const uiOpen = this.deps.isMenuOpen() || this.deps.isInvOpen();
    document.body.style.cursor = uiOpen ? "default" : "none";
    this.deps.input.clickLockAllowed = !uiOpen;
  }
}