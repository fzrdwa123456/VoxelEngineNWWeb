// ===== THE TERRAIN FIELD AS TSL — one copy, shared by the M0 probe and the M1 sampler =====
// WHY IT IS ITS OWN MODULE. `data/world/terrain.ts` is the field the whole world is built from, and a GPU port of
// it MUST NOT be a second copy that can drift: the CPU field is f64 over a 32-bit integer hash, the GPU is f32, and
// a one-block disagreement is not cosmetic (the coarse LOD surface may never sit BELOW the fine one — P1.93 — or the
// body leaves a crack). So the port lives here ONCE, takes every constant from `TERRAIN_NOISE` (the seed, the hill
// stack's own seed, the octaves, the amplitudes — exported as data for exactly this reason), and both the probe that
// MEASURES the agreement and the sampler that USES it import it.
//
// WHAT IS ERASED, AND WHY. TSL's typings are precise per overload, and a port whose whole job is to reproduce the
// CPU's WRAPPING INTEGER hash needs the runtime contract (u32 wraps, f32 maths) rather than a type-level one: every
// intermediate goes through `n()`, which erases the node type, so the emitter cannot silently pick a float overload
// where the CPU takes an integer. The contract is not asserted here — it is MEASURED, by comparing the GPU result
// against `lodSampleGrid` value by value (the probe's `K`, and the sampler's own per-rung self-check).
import {
  add,
  bitXor,
  clamp,
  div,
  float,
  floor,
  mod,
  mul,
  shiftRight,
  sub,
  uint,
} from "three/tsl";
import { TERRAIN_NOISE } from "../../../data/world/terrain";

/** The TSL node shapes this port hands around (see the header: erased on purpose). */
export type U32Node = any;
export type F32Node = any;

/** ERASE a node's type (see the header). */
export const n = (v: unknown): any => v;

/** 2^32 as a reciprocal: the same constant the CPU hash uses (terrain.ts), so the [0,1) mapping matches. */
export const INV_U32 = 2.3283064365386963e-10;

/** ONE NOISE LOOKUP, as TSL. This is `noise2` from data/world/terrain.ts, with the same integer hash: u32
 *  arithmetic wraps identically in WGSL, so the hash is bit-exact, and only the float steps afterwards can
 *  disagree (which is the thing the probe measures). */
export function tslNoise(period: number, x: F32Node, z: F32Node, cell: number, seed: number): F32Node {
  const cells: U32Node = uint(period / cell);
  const fx = div(n(x), n(float(cell)));
  const fz = div(n(z), n(float(cell)));
  const ix = floor(n(fx));
  const iz = floor(n(fz));
  // smoothstep, as terrain.ts: t² (3 - 2t)
  const t = (v: F32Node): F32Node => mul(n(mul(n(v), n(v))), n(sub(n(float(3)), n(mul(n(v), n(float(2)))))));
  const tx = t(sub(n(fx), n(ix)));
  const tz = t(sub(n(fz), n(iz)));
  const x0: U32Node = mod(n(ix.toUint()), n(cells));
  const z0: U32Node = mod(n(iz.toUint()), n(cells));
  const one: U32Node = uint(1);
  const x1: U32Node = mod(n(add(n(x0), n(one))), n(cells));
  const z1: U32Node = mod(n(add(n(z0), n(one))), n(cells));
  const hash = (hx: U32Node, hz: U32Node): F32Node => {
    const ha: U32Node = mul(n(hx), n(uint(0x27d4eb2d)));
    const hb: U32Node = mul(n(hz), n(uint(0x165667b1)));
    const h1: U32Node = bitXor(n(bitXor(n(ha), n(hb))), n(uint(seed >>> 0)));
    const h2: U32Node = mul(n(bitXor(n(h1), n(shiftRight(n(h1), n(uint(15)))))), n(uint(0x85ebca6b)));
    const h3: U32Node = bitXor(n(h2), n(shiftRight(n(h2), n(uint(13)))));
    return mul(n(h3.toFloat()), n(float(INV_U32)));
  };
  const a = hash(x0, z0);
  const b = hash(x1, z0);
  const c = hash(x0, z1);
  const d = hash(x1, z1);
  const top = add(n(a), n(mul(n(sub(n(b), n(a))), n(tx))));
  const bottom = add(n(c), n(mul(n(sub(n(d), n(c))), n(tx))));
  return add(n(top), n(mul(n(sub(n(bottom), n(top))), n(tz))));
}

/** The whole field as TSL: `terrainHeight(x, z)`, built from `TERRAIN_NOISE` so a change to the field cannot
 *  leave the GPU copy behind. */
export function tslTerrainHeight(period: number, x: F32Node, z: F32Node): F32Node {
  const spec = TERRAIN_NOISE;
  const region = mul(
    n(sub(n(tslNoise(period, x, z, spec.regionCell, spec.seed)), n(float(0.5)))),
    n(float(2 * spec.regionAmplitude)),
  );
  let sum: F32Node | null = null;
  for (let i = 0; i < spec.octaves.length; i++) {
    const octave = spec.octaves[i];
    // THE HILL STACK'S OWN SEED, then one offset per octave: `terrainHeight` uses a different seed for the hills
    // than for the region, and MISSING that offset is what the probe's first run caught (a field ~20 blocks off).
    const term = mul(
      n(tslNoise(period, x, z, octave[0], (spec.hillSeed + i * 0x9e3779b1) >>> 0)),
      n(float(octave[1])),
    );
    sum = sum === null ? term : add(n(sum), n(term));
  }
  const hill = mul(n(sub(n(div(n(sum), n(float(spec.octaveWeight)))), n(float(0.5)))), n(float(2 * spec.hillAmplitude)));
  // Math.round is round-half-UP; WGSL's round() is round-half-to-EVEN, so the CPU's rule is spelled out.
  const y = floor(n(add(n(add(n(float(spec.baseY)), n(region))), n(add(n(hill), n(float(0.5)))))));
  return clamp(n(y), n(float(spec.minY)), n(float(spec.maxY)));
}

/** Wrap a block coordinate into the torus, as TSL: `lod.ts`'s `wrapBlock`, for the border cells that reach one
 *  super voxel outside the chunk (negative at the origin). */
export function tslWrap(v: F32Node, period: number): F32Node {
  return mod(n(add(n(mod(n(v), n(float(period)))), n(float(period)))), n(float(period)));
}
