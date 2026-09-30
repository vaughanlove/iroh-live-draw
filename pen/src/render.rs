//! wgpu renderer: meshes in, ink on a transparent surface.
//!
//! The surface is transparent on purpose — the embedder (CSS grid today, a
//! native paper view tomorrow) paints the page underneath, so ink always
//! sits on paper. Camera matches the sheet transform the app already uses:
//! `screen_px = (scene + scroll) * zoom`.
//!
//! The embedder owns instance/adapter/surface (winit, browser canvas, …);
//! this crate owns pipeline, camera uniforms, and per-stroke buffers.
use crate::outline::{Mesh, Vertex};
use wgpu::util::DeviceExt;

/// Camera: which scene rect fills the viewport.
#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub zoom: f64,
    pub view_w_px: f32,
    pub view_h_px: f32,
}

impl Camera {
    /// Project a scene point to wgpu clip space (y-up NDC).
    pub fn project(&self, x: f64, y: f64) -> [f32; 2] {
        let sx = (x + self.scroll_x) * self.zoom;
        let sy = (y + self.scroll_y) * self.zoom;
        [
            (sx as f32 / (self.view_w_px * 0.5)) - 1.0,
            1.0 - (sy as f32 / (self.view_h_px * 0.5)),
        ]
    }

    /// 2x2 scale + translation packed for the shader. Y scale is negative
    /// (scene y grows downward, clip y grows upward).
    pub fn uniforms(&self) -> [f32; 4] {
        let (zx, sy) = (self.zoom as f32, self.scroll_y as f32);
        let (sx, zy) = (self.scroll_x as f32, self.zoom as f32);
        [
            (2.0 * zx) / self.view_w_px,
            -(2.0 * zy) / self.view_h_px,
            (-1.0 + (2.0 * sx * zx) / self.view_w_px),
            (1.0 - (2.0 * sy * zy) / self.view_h_px),
        ]
    }
}

const SHADER: &str = r#"
struct Camera { scale_xy: vec2<f32>, trans_xy: vec2<f32> };
@group(0) @binding(0) var<uniform> cam: Camera;

struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) color: vec4<f32> };

@vertex
fn vs(@location(0) scene: vec2<f32>, @location(1) color: vec4<f32>) -> VsOut {
    var o: VsOut;
    o.pos = vec4<f32>(scene * cam.scale_xy + cam.trans_xy, 0.0, 1.0);
    o.color = color;
    return o;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> { return in.color; }
"#;

/// One uploaded stroke, ready to draw.
pub struct StrokeMesh {
    pub vertex_buf: wgpu::Buffer,
    pub index_buf: wgpu::Buffer,
    pub index_count: u32,
}

/// Renderer owns the pipeline + camera uniform; the embedder drives the
/// render pass with its own surface texture.
pub struct Renderer {
    pipeline: wgpu::RenderPipeline,
    cam_buf: wgpu::Buffer,
    cam_bind: wgpu::BindGroup,
}

impl Renderer {
    /// `format` must match the embedder's surface (usually Bgra8UnormSrgb);
    /// `samples` enables MSAA (4 recommended, 1 to disable).
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat, samples: u32) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("pen"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let cam_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("pen.camera"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pen.camera-layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let cam_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pen.camera-bind"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: cam_buf.as_entire_binding() }],
        });
        let pipe_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("pen.pipe-layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("pen.pipe"),
            layout: Some(&pipe_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Vertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4],
                })],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
            multiview_mask: None,
            cache: None,
        });
        Self { pipeline, cam_buf, cam_bind }
    }

    pub fn set_camera(&self, queue: &wgpu::Queue, cam: &Camera) {
        queue.write_buffer(&self.cam_buf, 0, bytemuck::cast_slice(&cam.uniforms()));
    }

    pub fn upload(&self, device: &wgpu::Device, mesh: &Mesh) -> Option<StrokeMesh> {
        if mesh.is_empty() {
            return None;
        }
        let vertex_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("pen.stroke-v"),
            contents: bytemuck::cast_slice(&mesh.vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let index_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("pen.stroke-i"),
            contents: bytemuck::cast_slice(&mesh.indices),
            usage: wgpu::BufferUsages::INDEX,
        });
        Some(StrokeMesh { vertex_buf, index_buf, index_count: mesh.indices.len() as u32 })
    }

    /// Draw uploaded strokes into the embedder's pass. Clear color is the
    /// embedder's business — pass `None` to keep what's there (paper!).
    pub fn draw<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>, strokes: &'a [StrokeMesh]) {
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.cam_bind, &[]);
        for s in strokes {
            pass.set_vertex_buffer(0, s.vertex_buf.slice(..));
            pass.set_index_buffer(s.index_buf.slice(..), wgpu::IndexFormat::Uint32);
            pass.draw_indexed(0..s.index_count, 0, 0..1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cam() -> Camera {
        Camera { scroll_x: 0.0, scroll_y: 0.0, zoom: 1.0, view_w_px: 200.0, view_h_px: 200.0 }
    }

    #[test]
    fn project_corners() {
        let c = cam();
        assert_eq!(c.project(0.0, 0.0), [-1.0, 1.0]); // scene origin → top-left
        assert_eq!(c.project(100.0, 100.0), [0.0, 0.0]); // viewport center
        assert_eq!(c.project(200.0, 200.0), [1.0, -1.0]);
    }

    #[test]
    fn uniforms_agree_with_project() {
        let c = Camera { scroll_x: 80.0, scroll_y: -128.0, zoom: 1.31, view_w_px: 1280.0, view_h_px: 800.0 };
        let u = c.uniforms();
        for (x, y) in [(0.0, 0.0), (400.0, 900.0), (-80.0, 128.0)] {
            let [px, py] = c.project(x, y);
            let ux = x as f32 * u[0] + u[2];
            let uy = y as f32 * u[1] + u[3];
            assert!((px - ux).abs() < 1e-4, "{x},{y}: {px} vs {ux}");
            assert!((py - uy).abs() < 1e-4, "{x},{y}: {py} vs {uy}");
        }
    }
}

#[cfg(test)]
mod gpu_tests {
    use super::*;
    use crate::model::{Stroke, StrokeOptions, StrokePoint};

    fn device() -> (wgpu::Device, wgpu::Queue) {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .expect("no GPU adapter for render test");
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
            .expect("no GPU device for render test")
    }

    #[test]
    fn draws_ink_transparent_elsewhere() {
        let (device, queue) = device();
        let (w, h) = (64u32, 64u32);
        let format = wgpu::TextureFormat::Rgba8UnormSrgb;
        let samples = 4;
        let renderer = Renderer::new(&device, format, samples);
        let cam = Camera { scroll_x: 0.0, scroll_y: 0.0, zoom: 1.0, view_w_px: w as f32, view_h_px: h as f32 };
        renderer.set_camera(&queue, &cam);

        // Diagonal stroke corner to corner.
        let points: Vec<StrokePoint> = (0..=20)
            .map(|i| StrokePoint::new(8.0 + i as f64 * 2.4, 8.0 + i as f64 * 2.4, 0.7, i as f64 * 8.0))
            .collect();
        let mesh = crate::outline::build_mesh(&Stroke::new(
            points,
            StrokeOptions { size: 8.0, monoline: true, ..StrokeOptions::default() },
            [0.2, 0.5, 0.2, 1.0],
        ));
        assert!(!mesh.is_empty());
        let stroke = renderer.upload(&device, &mesh).expect("upload");

        let out_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("test.out"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let ms_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("test.ms"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: samples,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let out_view = out_tex.create_view(&wgpu::TextureViewDescriptor::default());
            let ms_view = ms_tex.create_view(&wgpu::TextureViewDescriptor::default());
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("test.pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &ms_view,
                    resolve_target: Some(&out_view),
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.0, g: 0.0, b: 0.0, a: 0.0 }),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            renderer.draw(&mut pass, std::slice::from_ref(&stroke));
        }
        // Read back.
        let padded = ((w * 4 + 255) / 256) * 256;
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("test.read"),
            size: (padded * h) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &out_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        queue.submit(std::iter::once(enc.finish()));
        readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        let view = readback.get_mapped_range(..).expect("mapped");
        let px = |x: u32, y: u32| -> [u8; 4] {
            let o = (y * padded + x * 4) as usize;
            [view[o], view[o + 1], view[o + 2], view[o + 3]]
        };
        // On-stroke pixel (diagonal passes through center): inked + opaque.
        let mid = px(32, 32);
        assert!(mid[3] > 200, "center should be opaque, got {mid:?}");
        assert!(mid[1] > mid[0] && mid[1] > mid[2], "greenish ink, got {mid:?}");
        // Corner far from the stroke: transparent (paper shows through).
        let corner = px(2, 60);
        assert!(corner[3] < 40, "corner should be transparent, got {corner:?}");
    }
}
