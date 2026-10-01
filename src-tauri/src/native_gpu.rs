// ===== THE NATIVE RENDER THREAD (wgpu) =====
//
// Owns the wgpu surface on the native child window, one pipeline and one plane, and presents in a loop of its
// own — that is the whole point of the module: the frame rate and the present mode are OURS now, not the
// WebView compositor's. The camera is read from the shared pose (`native::current_pose`) every frame, so the
// game's camera drives this renderer exactly the way it drives anything else.
//
// STEP 1 SCOPE (see native.rs): the flat world's visible surface — the terrain-top plane at the world's own
// Y, with a one-block grid, a per-chunk tint and a distance fade into the sky colour — drawn at world
// coordinates that follow the camera, so it behaves like an endless ground. Real chunk meshes, textures and
// block edits come next; the present mode and the frame accounting are already final.
use std::num::NonZeroIsize;
use std::time::Instant;

use raw_window_handle::{
    DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, RawDisplayHandle,
    RawWindowHandle, Win32WindowHandle, WindowsDisplayHandle, WindowHandle,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER,
};

use wgpu::util::DeviceExt;

use crate::native;

/// The terrain-top Y of the flat generator: the plane IS the world's surface (see `data/world/world.ts`).
const TERRAIN_TOP_Y: f32 = 128.0;
/// How big the drawn quad is, in blocks. It follows the camera snapped to the chunk grid, so the ground is
/// endless while the block/chunk pattern stays locked to the world.
const PLANE_SIZE: f32 = 2048.0;
/// The world's chunk size in blocks (the grid the plane's origin snaps to).
const CHUNK_SIZE: f32 = 32.0;

/// The HWND as a raw-window-handle producer (wgpu 30 creates surfaces from `HasWindowHandle`).
///
/// The handle is kept as an ADDRESS, not as an `HWND`: wgpu wants the display handle to be `Debug + Send +
/// Sync`, and a bare `*mut c_void` is none of those. Carrying the address and rebuilding the handle on demand
/// is sound — this wrapper never owns the window, it only names it.
#[derive(Debug, Clone, Copy)]
struct SurfaceWindow(isize);

// SAFETY: the value is an opaque window handle; the Win32 APIs wgpu calls with it are thread-safe, and the
// window itself is kept alive by its parent (see `native::start`).
unsafe impl Send for SurfaceWindow {}
unsafe impl Sync for SurfaceWindow {}

impl SurfaceWindow {
    fn of(hwnd: HWND) -> Self {
        Self(hwnd.0 as isize)
    }
}

impl HasWindowHandle for SurfaceWindow {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let Some(hwnd) = NonZeroIsize::new(self.0) else {
            return Err(HandleError::Unavailable);
        };
        let handle = Win32WindowHandle::new(hwnd);
        // SAFETY: the HWND outlives the surface (both belong to the process; the child window is destroyed
        // only on stop, which also ends this thread).
        Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Win32(handle)) })
    }
}

/// The DISPLAY half: on Windows it is a unit value (there is one desktop), but wgpu needs it to create a
/// surface at all — without it `create_surface` refuses with "No `DisplayHandle` is available".
impl HasDisplayHandle for SurfaceWindow {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        // SAFETY: `WindowsDisplayHandle` carries no pointer (it is a unit struct); nothing to outlive.
        Ok(unsafe {
            DisplayHandle::borrow_raw(RawDisplayHandle::Windows(WindowsDisplayHandle::new()))
        })
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Vertex {
    pos: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct CameraUniform {
    view_proj: [[f32; 4]; 4],
    eye: [f32; 4],
    /// `(origin.x, origin.y, origin.z, size)`: the unit quad below is scaled and placed by this, so the plane
    /// follows the eye without rewriting any vertex data.
    plane: [f32; 4],
}

/// The render thread's entry point. Returns the reason it stopped when that was a failure.
pub fn run(hwnd: HWND) -> Result<(), String> {
    // The display handle has to be given to the INSTANCE as well as to the surface (wgpu requires the two to
    // be identical; on Windows both are the unit `WindowsDisplayHandle`).
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_with_display_handle(Box::new(
        SurfaceWindow::of(hwnd),
    )));
    // SAFETY: both the window and the raw handle outlive the surface (see `SurfaceWindow`).
    let target = unsafe { wgpu::SurfaceTargetUnsafe::from_window(&SurfaceWindow::of(hwnd)) }
        .map_err(|e| format!("window handle unavailable: {e}"))?;
    let surface = unsafe { instance.create_surface_unsafe(target) }
        .map_err(|e| format!("create_surface: {e}"))?;
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: Some(&surface),
        force_fallback_adapter: false,
        apply_limit_buckets: false,
    }))
    .map_err(|e| format!("no adapter: {e}"))?;
    let info = adapter.get_info();
    native::report(format!(
        "{} ({:?}, {:?})",
        info.name, info.backend, info.device_type
    ));

    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("native-world"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::default(),
        memory_hints: Default::default(),
        trace: wgpu::Trace::Off,
        experimental_features: wgpu::ExperimentalFeatures::disabled(),
    }))
    .map_err(|e| format!("no device: {e}"))?;

    let caps = surface.get_capabilities(&adapter);
    let format = caps
        .formats
        .iter()
        .copied()
        .find(|f| f.is_srgb())
        .unwrap_or(caps.formats[0]);

    // ---- the plane: four vertices on the world's surface, moved with the camera ----
    let quad = [
        Vertex { pos: [-0.5, 0.0, -0.5] },
        Vertex { pos: [0.5, 0.0, -0.5] },
        Vertex { pos: [0.5, 0.0, 0.5] },
        Vertex { pos: [-0.5, 0.0, 0.5] },
    ];
    let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("plane"),
        contents: bytemuck::cast_slice(&quad),
        usage: wgpu::BufferUsages::VERTEX,
    });
    let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("plane-indices"),
        contents: bytemuck::cast_slice(&[0u16, 2, 1, 0, 3, 2]),
        usage: wgpu::BufferUsages::INDEX,
    });

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("world"),
        source: wgpu::ShaderSource::Wgsl(include_str!("world.wgsl").into()),
    });

    let camera_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("camera"),
        size: std::mem::size_of::<CameraUniform>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("camera-layout"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        }],
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("camera"),
        layout: &bind_group_layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: camera_buffer.as_entire_binding(),
        }],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("world-layout"),
        bind_group_layouts: &[Some(&bind_group_layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("world"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs"),
            compilation_options: Default::default(),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: std::mem::size_of::<Vertex>() as u64,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &wgpu::vertex_attr_array![0 => Float32x3],
            })],
        },
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            front_face: wgpu::FrontFace::Ccw,
            cull_mode: None,
            ..Default::default()
        },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth32Float,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Less),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: Default::default(),
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: Some(wgpu::BlendState::REPLACE),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    });

    let mut size = (0u32, 0u32);
    let mut depth: Option<(wgpu::Texture, wgpu::TextureView)> = None;
    let mut present = String::from("-");
    let mut last_vsync: Option<bool> = None;

    let mut frames: u64 = 0;
    let mut worst: f32 = 0.0;
    let mut stat_at = Instant::now();
    let mut last = Instant::now();

    while !native::should_stop() {
        let (pose, vsync) = native::current_pose();
        // Follow the parent's client area: the child window IS the surface, so a resize is a resize of the
        // child plus a `configure` — the DWM stretches the last frame in between, which is what makes a drag
        // look live instead of blank.
        let parent_size = native::client_size(parent_of(hwnd));
        if parent_size.0 > 0 && parent_size.1 > 0 && parent_size != size {
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    0,
                    0,
                    parent_size.0 as i32,
                    parent_size.1 as i32,
                    SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
            size = parent_size;
            surface.configure(
                &device,
                &surface_config(format, size.0, size.1, pick_present(&caps, vsync)),
            );
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("depth"),
                size: wgpu::Extent3d {
                    width: size.0,
                    height: size.1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Depth32Float,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            });
            let view = texture.create_view(&Default::default());
            depth = Some((texture, view));
        }
        // The vertical-sync switch, live: a reconfigure with the other present mode.
        if last_vsync != Some(vsync) {
            if size.0 > 0 {
                let mode = pick_present(&caps, vsync);
                surface.configure(&device, &surface_config(format, size.0, size.1, mode));
                present = present_name(mode);
            }
            last_vsync = Some(vsync);
        }
        let (Some((_, depth_view)), true) = (depth.as_ref(), size.0 > 0 && size.1 > 0) else {
            std::thread::sleep(std::time::Duration::from_millis(8));
            continue;
        };

        // The camera: the plane follows the eye, snapped to the chunk grid, so the ground is endless while the
        // block pattern stays locked to WORLD coordinates (the shader's grid comes from the world position).
        let camera = CameraUniform {
            view_proj: view_proj(pose),
            eye: [pose.x, pose.y, pose.z, 1.0],
            plane: [
                (pose.x / CHUNK_SIZE).round() * CHUNK_SIZE,
                TERRAIN_TOP_Y,
                (pose.z / CHUNK_SIZE).round() * CHUNK_SIZE,
                PLANE_SIZE,
            ],
        };
        queue.write_buffer(&camera_buffer, 0, bytemuck::bytes_of(&camera));

        let frame = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                surface.configure(
                    &device,
                    &surface_config(format, size.0, size.1, pick_present(&caps, vsync)),
                );
                continue;
            }
            // Timeout / occluded / a validation error: nothing to draw into this tick.
            _ => {
                std::thread::sleep(std::time::Duration::from_millis(4));
                continue;
            }
        };
        let view = frame.texture.create_view(&Default::default());
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("world"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("world-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // The sky colour the scene has always used (`0x87ceeb`).
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.529,
                            g: 0.808,
                            b: 0.922,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.set_vertex_buffer(0, vertex_buffer.slice(..));
            pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint16);
            pass.draw_indexed(0..6, 0, 0..1);
        }
        queue.submit(Some(encoder.finish()));
        // Presenting moved to the QUEUE in wgpu 30 (the texture is handed over and must not be reused).
        queue.present(frame);

        // Frame accounting: the same shape as the game's own FRAME line, so the two can be compared.
        let now = Instant::now();
        let dt = now.duration_since(last).as_secs_f32() * 1000.0;
        last = now;
        frames += 1;
        if dt > worst {
            worst = dt;
        }
        let elapsed = now.duration_since(stat_at).as_secs_f32();
        if elapsed >= 1.0 {
            let fps = frames as f32 / elapsed;
            native::report_second(frames, fps, worst, &present);
            native::log(&format!(
                "NATIVE {fps:.1}fps avg={:.2}ms max={worst:.1}ms frames={frames} present={present} \
                 size={}x{} eye={:.1}/{:.1}/{:.1}",
                elapsed * 1000.0 / frames.max(1) as f32,
                size.0,
                size.1,
                pose.x,
                pose.y,
                pose.z
            ));
            frames = 0;
            worst = 0.0;
            stat_at = now;
        }
    }
    Ok(())
}

/// The child window's parent (the Tauri window) — used to follow the client area's size.
fn parent_of(hwnd: HWND) -> HWND {
    unsafe { windows::Win32::UI::WindowsAndMessaging::GetParent(hwnd) }.unwrap_or(hwnd)
}

fn surface_config(
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
    present_mode: wgpu::PresentMode,
) -> wgpu::SurfaceConfiguration {
    wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        color_space: wgpu::SurfaceColorSpace::Auto,
        width: width.max(1),
        height: height.max(1),
        present_mode,
        alpha_mode: wgpu::CompositeAlphaMode::Auto,
        view_formats: vec![],
        desired_maximum_frame_latency: 2,
    }
}

/// Vertical sync ON = `Fifo` (the driver waits for the display), OFF = `Immediate` (present and return).
fn pick_present(caps: &wgpu::SurfaceCapabilities, vsync: bool) -> wgpu::PresentMode {
    let wanted = if vsync {
        wgpu::PresentMode::Fifo
    } else {
        wgpu::PresentMode::Immediate
    };
    if caps.present_modes.contains(&wanted) {
        wanted
    } else if vsync {
        wgpu::PresentMode::Fifo
    } else {
        wgpu::PresentMode::AutoNoVsync
    }
}

fn present_name(mode: wgpu::PresentMode) -> String {
    format!("{mode:?}").to_lowercase()
}

// ===== The camera math (column-major, wgpu's 0..1 depth range) =====
// It is the same convention three.js uses (`PerspectiveCamera.projectionMatrix` / `matrixWorldInverse`), so
// the native view matches the web one exactly — that is what makes the two renderers comparable.

fn view_proj(pose: native::Pose) -> [[f32; 4]; 4] {
    let view = view_matrix(pose);
    let proj = perspective(pose.fov_y.to_radians(), aspect(pose), 0.1, 5000.0);
    mul(proj, view)
}

fn aspect(pose: native::Pose) -> f32 {
    if pose.height == 0 {
        1.0
    } else {
        pose.width as f32 / pose.height as f32
    }
}

fn perspective(fov_y: f32, aspect: f32, near: f32, far: f32) -> [[f32; 4]; 4] {
    let f = 1.0 / (fov_y * 0.5).tan();
    [
        [f / aspect, 0.0, 0.0, 0.0],
        [0.0, f, 0.0, 0.0],
        [0.0, 0.0, far / (near - far), -1.0],
        [0.0, 0.0, (far * near) / (near - far), 0.0],
    ]
}

fn view_matrix(pose: native::Pose) -> [[f32; 4]; 4] {
    let (x, y, z, w) = (pose.qx, pose.qy, pose.qz, pose.qw);
    // The camera's rotation (local -> world), row-major.
    let r00 = 1.0 - 2.0 * (y * y + z * z);
    let r01 = 2.0 * (x * y + z * w);
    let r02 = 2.0 * (x * z - y * w);
    let r10 = 2.0 * (x * y - z * w);
    let r11 = 1.0 - 2.0 * (x * x + z * z);
    let r12 = 2.0 * (y * z + x * w);
    let r20 = 2.0 * (x * z + y * w);
    let r21 = 2.0 * (y * z - x * w);
    let r22 = 1.0 - 2.0 * (x * x + y * y);
    // The view is its transpose with the eye folded in: world -> camera.
    [
        [r00, r01, r02, 0.0],
        [r10, r11, r12, 0.0],
        [r20, r21, r22, 0.0],
        [
            -(r00 * pose.x + r10 * pose.y + r20 * pose.z),
            -(r01 * pose.x + r11 * pose.y + r21 * pose.z),
            -(r02 * pose.x + r12 * pose.y + r22 * pose.z),
            1.0,
        ],
    ]
}

fn mul(a: [[f32; 4]; 4], b: [[f32; 4]; 4]) -> [[f32; 4]; 4] {
    let mut out = [[0.0f32; 4]; 4];
    for col in 0..4 {
        for row in 0..4 {
            out[col][row] = a[0][row] * b[col][0]
                + a[1][row] * b[col][1]
                + a[2][row] * b[col][2]
                + a[3][row] * b[col][3];
        }
    }
    out
}
