// ===== ui.loading: the loading screen, as DATA + a system =====
// The two drivers (main.ts: the startup, and entering a world) publish what the process is DOING into
// the LOADING_STATE resource through the SetLoadingStage command; this system turns that state into
// widget data once per frame and the reconciler paints it. That split is the same one `ui.toast` uses,
// and for the same reason: the caller is the composition root, which may not write a component, and the
// thing that ends up on screen has to be data before it is pixels.
//
// WHY IT IS IN THE ui LANE. It writes widget data, so it belongs where every other widget-data writer
// is — and the ui lane is also the ONLY lane that runs in `load` mode, which is exactly the mode a
// loading screen is shown in. (The render lane cannot run there: the GPU is not initialised yet during
// the startup, and during a world entry there is nothing worth drawing yet.)
import { LOADING_SEGMENTS, LOADING_STATE, type LoadingState } from "../resources";
import type { SystemAccess, World } from "../World";
import type { LoadingScreen } from "../../ui/loading";
import { UI_STATE, UI_TEXT, setUiActive, setUiText, setUiVisible } from "./widgets";

/** It writes the loading screen's own widgets and nothing else. */
export const UI_LOADING_ACCESS: SystemAccess = {
  writes: [UI_STATE, UI_TEXT],
};

export class UiLoadingSystem {
  private readonly state: LoadingState;
  private readonly screen: LoadingScreen;
  /** What is on screen right now, so a frame that changes nothing writes nothing (the reconciler
   *  diffs the DOM; this skips handing it the same values — the same shape as ui.toast). */
  private shown = false;
  private shownKey = "\u0000";
  private shownPercent = -1;
  private filled = -1;
  private shownNote = "\u0000";
  private shownNoteKey = "\u0000";
  private shownNoteVisible = false;

  constructor(private readonly world: World, screen: LoadingScreen) {
    this.state = world.resource(LOADING_STATE);
    this.screen = screen;
  }

  /** ui lane, once per frame: shows the screen while a loading run is on, hides it for good afterwards. */
  step(): void {
    const loading = this.state;
    if (loading.active !== this.shown) {
      this.shown = loading.active;
      setUiVisible(this.world, this.screen.rootEntity, loading.active);
    }
    if (!loading.active) return;

    if (loading.key !== this.shownKey) {
      this.shownKey = loading.key;
      // A KEY, not a sentence: the reconciler re-derives it every frame, so a language switch
      // re-translates a loading screen that is already up.
      setUiText(this.world, this.screen.statusEntity, loading.key);
    }

    const percent = Math.round(loading.progress * 100);
    if (percent !== this.shownPercent) {
      this.shownPercent = percent;
      setUiText(this.world, this.screen.percentEntity, `${percent}%`, true);
    }

    // The bar is a row of segments and the progress decides how many are ENGAGED — a boolean per
    // segment, never a width (a width would be a style string written from inside a system).
    const filled = Math.round(loading.progress * LOADING_SEGMENTS);
    if (filled !== this.filled) {
      this.filled = filled;
      const segments = this.screen.segmentEntities;
      for (let i = 0; i < segments.length; i++) setUiActive(this.world, segments[i], i < filled);
    }

    // The settings check's outcome: a translated label over the literal list of setting names. Absent
    // (`noteKey === ""`) means the file was already valid and there is nothing to say.
    const noteVisible = loading.noteKey !== "";
    if (noteVisible !== this.shownNoteVisible) {
      this.shownNoteVisible = noteVisible;
      setUiVisible(this.world, this.screen.noteEntity, noteVisible);
    }
    if (!noteVisible) return;
    if (loading.noteKey !== this.shownNoteKey) {
      this.shownNoteKey = loading.noteKey;
      setUiText(this.world, this.screen.noteLabelEntity, loading.noteKey);
    }
    if (loading.noteValue !== this.shownNote) {
      this.shownNote = loading.noteValue;
      setUiText(this.world, this.screen.noteValueEntity, loading.noteValue, true);
    }
  }
}
