// ===== The loading screen: the widget tree =====
// Spawned during wiring, like every other surface, and painted by `ui.loading` (ecs/ui/loading.ts) from
// the LOADING_STATE resource. Nothing here ever touches the DOM: it is a tree of widget entities, so the
// screen gets the theme, the i18n re-derivation and the reconciler for free.
//
// WHY IT EXISTS AT ALL. The NW.js window is created hidden and is shown by the startup driver, which
// used to wait for `renderer.init()` — so the user stared at nothing (or at the previous frame of a
// previous run) for the whole GPU startup. The window is now revealed as soon as this screen is on it,
// and both drivers advance the state through their stages (settings check, graphics device; then, on
// the way into a world, terrain and chunk meshes) so the wait has a face.
//
// The tree is deliberately tiny and static: a title, the stage line, a percentage, a segmented bar of
// LOADING_SEGMENTS widgets and a two-part note for the settings check's outcome. Which segments are
// FILLED is data (UI_STATE.active), not a width — a width would mean a system writing a style string.
import type { Entity, World } from "../ecs/World";
import { LOADING_SEGMENTS } from "../ecs/resources";
import { spawnLabel, spawnPanel } from "../ecs/ui/widgets";

export class LoadingScreen {
  /** The whole surface: hidden until LOADING_STATE says a loading screen is running. */
  private readonly root: Entity;
  private readonly status: Entity;
  private readonly percent: Entity;
  private readonly note: Entity;
  private readonly noteLabel: Entity;
  private readonly noteValue: Entity;
  private readonly segments: Entity[] = [];

  constructor(private readonly world: World) {
    // Spawned HIDDEN and shown by the system: the surface owns no visibility flag of its own (that is
    // LOADING_STATE.active), exactly like the toast panel in ui/hud.ts.
    this.root = spawnPanel(world, null, "loading.root", { hidden: true });
    spawnLabel(world, this.root, "loading.title", "loading.title");
    this.status = spawnLabel(world, this.root, "loading.status");
    this.percent = spawnLabel(world, this.root, "loading.status");
    const track = spawnPanel(world, this.root, "loading.track");
    for (let i = 0; i < LOADING_SEGMENTS; i++) {
      this.segments.push(spawnPanel(world, track, "loading.segment"));
    }
    this.note = spawnPanel(world, this.root, "loading.note", { hidden: true });
    this.noteLabel = spawnLabel(world, this.note, "loading.noteText");
    this.noteValue = spawnLabel(world, this.note, "loading.noteText");
  }

  get rootEntity(): Entity {
    return this.root;
  }
  get statusEntity(): Entity {
    return this.status;
  }
  get percentEntity(): Entity {
    return this.percent;
  }
  get noteEntity(): Entity {
    return this.note;
  }
  get noteLabelEntity(): Entity {
    return this.noteLabel;
  }
  get noteValueEntity(): Entity {
    return this.noteValue;
  }
  /** The bar's segments, left to right — index < filled means "engaged". */
  get segmentEntities(): readonly Entity[] {
    return this.segments;
  }
}
