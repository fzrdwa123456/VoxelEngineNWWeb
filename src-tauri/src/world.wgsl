// ===== The native world's shader (WGSL): one plane at the world's surface height =====
// The unit quad carries no world position of its own: `camera.plane` places and scales it, and the FRAGMENT
// stage gets the WORLD position, so the block grid, the chunk tint and the distance fade are all computed in
// world space and therefore never slide when the plane follows the camera.
struct Camera {
    view_proj: mat4x4<f32>,
    eye: vec4<f32>,
    // (origin.x, origin.y, origin.z, size)
    plane: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct VsOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) world: vec3<f32>,
};

@vertex
fn vs(@location(0) pos: vec3<f32>) -> VsOut {
    let world = vec3<f32>(
        camera.plane.x + pos.x * camera.plane.w,
        camera.plane.y,
        camera.plane.z + pos.z * camera.plane.w,
    );
    var out: VsOut;
    out.clip = camera.view_proj * vec4<f32>(world, 1.0);
    out.world = world;
    return out;
}

const GRASS: vec3<f32> = vec3<f32>(0.36, 0.54, 0.24);
const SKY: vec3<f32> = vec3<f32>(0.529, 0.808, 0.922);

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let block = min(min(fract(in.world.x), 1.0 - fract(in.world.x)),
                    min(fract(in.world.z), 1.0 - fract(in.world.z)));
    let chunk_u = fract(in.world.x / 32.0);
    let chunk_v = fract(in.world.z / 32.0);
    let chunk_line = min(min(chunk_u, 1.0 - chunk_u), min(chunk_v, 1.0 - chunk_v));

    // A per-chunk checker keeps the streaming grid visible without drawing anything extra.
    let checker = (floor(in.world.x / 32.0) + floor(in.world.z / 32.0)) % 2.0;
    var color = GRASS * (0.93 + 0.07 * checker);
    if (block < 0.035) { color = color * 0.84; }
    if (chunk_line < 0.05) { color = color * 0.55; }

    let d = distance(camera.eye.xyz, in.world);
    let fade = clamp(1.0 - d / 700.0, 0.0, 1.0);
    return vec4<f32>(mix(SKY, color, fade), 1.0);
}
