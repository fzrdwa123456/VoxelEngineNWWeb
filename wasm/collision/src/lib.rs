// ===== The AABB-vs-voxel collision kernel, in Rust (wasm-bindgen build) =====
//
// DATA IN, DATA OUT: one call per tick resolves EVERY body against ONE dense block grid that the caller
// fills for that tick. There is no per-body call and no `is_solid` callback any more — the kernel used to ask
// JS "is this block solid?" once per voxel it touched (one boundary crossing + three `JsValue` boxes per
// block); now the only crossings are two typed arrays in and one out.
//
// Same algorithm as `src/plugins/player/systems/collision.ts` (the fallback the Node gate uses): same substep
// size, skin, per-axis order and `onGround`/`vy` writes — change both together.
//
// ABI:
//   abi_version() -> u32
//   resolve_batch(input, ox, oy, oz, nx, ny, nz, solid) -> Float64Array
//     input:  10 f64 per body — sx,sy,sz, tx,ty,tz, half,height,eye, vy
//     solid:  nx*ny*nz bytes, 1 = solid; index = (x-ox) + nx*((y-oy) + ny*(z-oz))
//     output: 5 f64 per body — x, y, z, vy, onGround
//   A block outside the grid answers AIR: the caller sizes the grid from the swept AABBs plus a margin, so
//   that only happens for bodies moving further than the caller budgeted (it then keeps its TS path).
#![no_main]

use wasm_bindgen::prelude::*;

/// Largest displacement resolved in one sub-step (blocks) — same constant as the TS system.
const MAX_SUBSTEP: f64 = 0.25;
/// Keeps a resolved body just clear of the surface it hit — same constant as the TS system.
const SKIN: f64 = 1e-3;

/// The block grid handed in for this tick, addressed in WORLD block coordinates.
struct Grid<'a> {
    ox: i32,
    oy: i32,
    oz: i32,
    nx: i32,
    ny: i32,
    nz: i32,
    data: &'a [u8],
}

impl Grid<'_> {
    fn solid(&self, x: i32, y: i32, z: i32) -> bool {
        let lx = x - self.ox;
        let ly = y - self.oy;
        let lz = z - self.oz;
        if lx < 0 || ly < 0 || lz < 0 || lx >= self.nx || ly >= self.ny || lz >= self.nz {
            return false;
        }
        let index = (lx + self.nx * (ly + self.ny * lz)) as usize;
        self.data[index] != 0
    }
}

fn floor_i(x: f64) -> i32 {
    let truncated = x as i32;
    if (truncated as f64) > x {
        truncated - 1
    } else {
        truncated
    }
}

fn ceil_f(x: f64) -> f64 {
    let truncated = x as i32 as f64;
    if truncated < x {
        truncated + 1.0
    } else {
        truncated
    }
}

/// Newton's method (kept dependency-free; the value only decides how many sub-steps are taken).
fn sqrt_f(x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    let mut root = x;
    let mut i = 0;
    while i < 40 {
        let next = 0.5 * (root + x / root);
        let delta = next - root;
        root = next;
        if (if delta < 0.0 { -delta } else { delta }) < 1e-12 {
            break;
        }
        i += 1;
    }
    root
}

fn resolve_x(
    grid: &Grid,
    px: &mut f64,
    py: f64,
    pz: f64,
    half: f64,
    height: f64,
    eye: f64,
    delta: f64,
) {
    let feet = py - eye;
    let y0 = floor_i(feet + SKIN);
    let y1 = floor_i(feet + height - SKIN);
    let z0 = floor_i(pz - half + SKIN);
    let z1 = floor_i(pz + half - SKIN);
    let column = if delta > 0.0 {
        floor_i(*px + half)
    } else {
        floor_i(*px - half)
    };
    let mut y = y0;
    while y <= y1 {
        let mut z = z0;
        while z <= z1 {
            if grid.solid(column, y, z) {
                *px = if delta > 0.0 {
                    column as f64 - half - SKIN
                } else {
                    column as f64 + 1.0 + half + SKIN
                };
                return;
            }
            z += 1;
        }
        y += 1;
    }
}

fn resolve_z(
    grid: &Grid,
    pz: &mut f64,
    px: f64,
    py: f64,
    half: f64,
    height: f64,
    eye: f64,
    delta: f64,
) {
    let feet = py - eye;
    let y0 = floor_i(feet + SKIN);
    let y1 = floor_i(feet + height - SKIN);
    let x0 = floor_i(px - half + SKIN);
    let x1 = floor_i(px + half - SKIN);
    let column = if delta > 0.0 {
        floor_i(*pz + half)
    } else {
        floor_i(*pz - half)
    };
    let mut y = y0;
    while y <= y1 {
        let mut x = x0;
        while x <= x1 {
            if grid.solid(x, y, column) {
                *pz = if delta > 0.0 {
                    column as f64 - half - SKIN
                } else {
                    column as f64 + 1.0 + half + SKIN
                };
                return;
            }
            x += 1;
        }
        y += 1;
    }
}

#[allow(clippy::too_many_arguments)]
fn resolve_y(
    grid: &Grid,
    py: &mut f64,
    px: f64,
    pz: f64,
    half: f64,
    height: f64,
    eye: f64,
    delta: f64,
    vy: &mut f64,
    on_ground: &mut bool,
) {
    let x0 = floor_i(px - half + SKIN);
    let x1 = floor_i(px + half - SKIN);
    let z0 = floor_i(pz - half + SKIN);
    let z1 = floor_i(pz + half - SKIN);

    if delta < 0.0 {
        // Falling: the feet layer is what we land on.
        let layer = floor_i(*py - eye);
        let mut x = x0;
        while x <= x1 {
            let mut z = z0;
            while z <= z1 {
                if grid.solid(x, layer, z) {
                    *py = layer as f64 + 1.0 + eye + SKIN;
                    *vy = 0.0;
                    *on_ground = true;
                    return;
                }
                z += 1;
            }
            x += 1;
        }
        return;
    }

    // Rising: the head layer blocks.
    let layer = floor_i(*py - eye + height);
    let mut x = x0;
    while x <= x1 {
        let mut z = z0;
        while z <= z1 {
            if grid.solid(x, layer, z) {
                *py = layer as f64 - height + eye - SKIN;
                *vy = 0.0;
                return;
            }
            z += 1;
        }
        x += 1;
    }
}

/// One body, start pose -> target pose, resolved in sub-steps. Returns (x, y, z, vy, onGround).
#[allow(clippy::too_many_arguments)]
fn resolve_one(
    grid: &Grid,
    sx: f64,
    sy: f64,
    sz: f64,
    tx: f64,
    ty: f64,
    tz: f64,
    half: f64,
    height: f64,
    eye: f64,
    vy_in: f64,
) -> (f64, f64, f64, f64, f64) {
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let distance = sqrt_f(dx * dx + dy * dy + dz * dz);
    let raw_steps = ceil_f(distance / MAX_SUBSTEP);
    let steps = if raw_steps < 1.0 { 1 } else { raw_steps as i32 };
    let step_x = dx / steps as f64;
    let step_y = dy / steps as f64;
    let step_z = dz / steps as f64;

    let mut px = sx;
    let mut py = sy;
    let mut pz = sz;
    let mut vy = vy_in;
    let mut on_ground = false;

    let mut i = 0;
    while i < steps {
        if step_x != 0.0 {
            px += step_x;
            resolve_x(grid, &mut px, py, pz, half, height, eye, step_x);
        }
        if step_z != 0.0 {
            pz += step_z;
            resolve_z(grid, &mut pz, px, py, half, height, eye, step_z);
        }
        if step_y != 0.0 {
            py += step_y;
            resolve_y(
                grid,
                &mut py,
                px,
                pz,
                half,
                height,
                eye,
                step_y,
                &mut vy,
                &mut on_ground,
            );
        }
        i += 1;
    }

    (
        px,
        py,
        pz,
        vy,
        if on_ground { 1.0 } else { 0.0 },
    )
}

#[wasm_bindgen]
pub fn abi_version() -> u32 {
    // Bump the low half when the ABI or the algorithm changes.
    0x0004_0001
}

#[wasm_bindgen]
pub fn resolve_batch(
    input: &[f64],
    ox: i32,
    oy: i32,
    oz: i32,
    nx: u32,
    ny: u32,
    nz: u32,
    solid: &[u8],
) -> Vec<f64> {
    let grid = Grid {
        ox,
        oy,
        oz,
        nx: nx as i32,
        ny: ny as i32,
        nz: nz as i32,
        data: solid,
    };
    let bodies = input.len() / 10;
    let mut out: Vec<f64> = Vec::with_capacity(bodies * 5);
    let mut b = 0usize;
    while b < bodies {
        let o = b * 10;
        let (x, y, z, vy, on_ground) = resolve_one(
            &grid,
            input[o],
            input[o + 1],
            input[o + 2],
            input[o + 3],
            input[o + 4],
            input[o + 5],
            input[o + 6],
            input[o + 7],
            input[o + 8],
            input[o + 9],
        );
        out.push(x);
        out.push(y);
        out.push(z);
        out.push(vy);
        out.push(on_ground);
        b += 1;
    }
    out
}
