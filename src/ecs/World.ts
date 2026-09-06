// ===== World: minimal scheduler (the "parent ECS" everything plugs into) =====
// Two lanes, mirroring the game's two clocks:
//   fixed  — MC-style fixed tps, driven by the accumulator (physics, input consumption)
//   render — once per rAF frame (view interpolation, drawing, diagnostics)
// Systems are plain functions registered in execution order; modules never call each
// other directly — they only touch shared state (entities, InputState) and the World.
// `entities` is the pure-ECS half: bare-id entities + typed component storage + queries
// for the many (NPCs, projectiles, ...). The hand-rolled Player stays outside on purpose.
import { EntityStore } from "./store";

export type FixedSystem = (dt: number) => void;
export type RenderSystem = (alpha: number, delta: number) => void;

export class World {
  /** Entity/component storage + queries (spawn/despawn/add/get/query) */
  readonly entities = new EntityStore();

  private readonly fixed: FixedSystem[] = [];
  private readonly renderers: RenderSystem[] = [];

  /** Register a fixed-step system (runs every physics tick, in registration order) */
  addFixed(system: FixedSystem): void {
    this.fixed.push(system);
  }

  /** Register a per-frame system (runs once per rendered frame, in registration order) */
  addRender(system: RenderSystem): void {
    this.renderers.push(system);
  }

  /** Advance all fixed systems by exactly dt (called from the accumulator loop) */
  stepFixed(dt: number): void {
    for (const s of this.fixed) s(dt);
  }

  /** Run all per-frame systems (called once per rendered frame) */
  render(alpha: number, delta: number): void {
    for (const s of this.renderers) s(alpha, delta);
  }
}
