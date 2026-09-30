//! Browser GPU canvas (`wasm` feature): wgpu surface on a `<canvas>`,
//! transparent so the CSS engineering grid shows through underneath.
//!
//! Frame protocol from JS, once per rAF:
//! `begin_frame(scroll, zoom)` → `draw_mesh(verts, idx)` × N → `end_frame()`.
//! Meshes batch client-side into ONE upload, ONE pass, ONE MSAA resolve per
//! frame — panning cost is O(visible), never O(board × passes).
use crate::render::{Camera, Renderer};
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

pub struct Frame {
    encoder: wgpu::CommandEncoder,
    frame: wgpu::SurfaceTexture,
}

#[wasm_bindgen]
pub struct PenCanvas {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    renderer: Renderer,
    format: wgpu::TextureFormat,
    samples: u32,
    frame: Option<Frame>,
    ms_view: Option<wgpu::TextureView>,
    cache: std::collections::HashMap<String, crate::render::StrokeMesh>,
    staged: Vec<String>,
    cam: Camera,
    alpha_mode: wgpu::CompositeAlphaMode,
    caps: String,
    // Diagnostics (surfaced to the debug HUD): silent GPU death is the
    // worst failure mode, so every acquire failure is counted, not logged.
    begun: u64,
    dropped: u64,
    drawn: u64,
    last_error: String,
}

#[wasm_bindgen]
impl PenCanvas {
    /// Attach to an existing `<canvas>`. Async: adapter/device negotiation.
    /// `fallback` forces the software adapter (SwiftShader): slower, but
    /// works where the hardware adapter is blocklisted or absent.
    pub async fn new(canvas: HtmlCanvasElement) -> Result<PenCanvas, JsValue> {
        Self::new_with_fallback(canvas, false).await
    }

    pub async fn new_with_fallback(canvas: HtmlCanvasElement, fallback: bool) -> Result<PenCanvas, JsValue> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(|e| JsValue::from_str(&format!("surface: {e:?}")))?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                compatible_surface: Some(&surface),
                force_fallback_adapter: fallback,
                ..Default::default()
            })
            .await
            .map_err(|e| JsValue::from_str(&format!("adapter: {e:?}")))?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .map_err(|e| JsValue::from_str(&format!("device: {e:?}")))?;
        let caps = surface.get_capabilities(&adapter);
        let caps_str = format!("fmt={:?} alpha={:?}", caps.formats, caps.alpha_modes);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| f.is_srgb())
            .unwrap_or(caps.formats[0]);
        // Transparent clear over the CSS grid needs a compositing mode
        // that honors alpha; Auto negotiates opaque on several drivers
        // (opaque black canvas over the paper). Prefer pre-multiplied.
        let alpha_mode = if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::PreMultiplied) {
            wgpu::CompositeAlphaMode::PreMultiplied
        } else {
            caps.alpha_modes.first().copied().unwrap_or(wgpu::CompositeAlphaMode::Auto)
        };
        // SAFETY: surface outlives the canvas element it was created from;
        // the embedder must drop PenCanvas before removing the canvas.
        let surface: wgpu::Surface<'static> = unsafe { std::mem::transmute(surface) };
        let renderer = Renderer::new(&device, format, 4);
        Ok(PenCanvas {
            surface,
            device,
            queue,
            renderer,
            format,
            samples: 4,
            frame: None,
            ms_view: None,
            cache: std::collections::HashMap::new(),
            staged: Vec::new(),
            cam: Camera { scroll_x: 0.0, scroll_y: 0.0, zoom: 1.0, view_w_px: 1.0, view_h_px: 1.0 },
            alpha_mode,
            caps: caps_str,
            begun: 0,
            dropped: 0,
            drawn: 0,
            last_error: String::new(),
        })
    }

    /// "begun dropped drawn last_error" — polled by the debug HUD.
    /// Prefixed with surface caps (formats + alpha modes) for diagnosis.
    pub fn stats(&self) -> String {
        format!("{} | {} {} {} {}", self.caps, self.begun, self.dropped, self.drawn, self.last_error)
    }

    /// Size the surface in device px (call on init + resize). Rebuilds the
    /// cached MSAA target alongside.
    pub fn resize(&mut self, w_px: u32, h_px: u32) {
        let (w_px, h_px) = (w_px.max(1), h_px.max(1));
        self.surface.configure(
            &self.device,
            &wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format: self.format,
                width: w_px,
                height: h_px,
                present_mode: wgpu::PresentMode::AutoVsync,
                alpha_mode: self.alpha_mode,
                view_formats: vec![],
                // Depth 1: input-to-photon latency beats pipelined
                // throughput for a drawing app.
                desired_maximum_frame_latency: 1,
                color_space: wgpu::SurfaceColorSpace::Auto,
            },
        );
        self.cam.view_w_px = w_px as f32;
        self.cam.view_h_px = h_px as f32;
        self.ms_view = if self.samples > 1 {
            let tex = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("pen.msaa"),
                size: wgpu::Extent3d { width: w_px, height: h_px, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: self.samples,
                dimension: wgpu::TextureDimension::D2,
                format: self.format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            });
            Some(tex.create_view(&wgpu::TextureViewDescriptor::default()))
        } else {
            None
        };
    }

    pub fn begin_frame(&mut self, scroll_x: f64, scroll_y: f64, zoom: f64) {
        self.cam.scroll_x = scroll_x;
        self.cam.scroll_y = scroll_y;
        self.cam.zoom = zoom;
        self.renderer.set_camera(&self.queue, &self.cam);
        let encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            other => {
                self.dropped += 1;
                self.last_error = format!("acquire:{other:?}");
                return;
            }
        };
        self.begun += 1;
        self.staged.clear();
        self.frame = Some(Frame { encoder, frame });
    }

    /// Upload once per key (`id:version` from the caller). Re-uploading an
    /// existing key is a no-op; evict stale versions with [`Self::evict`].
    /// This is the pan-smoothness fix: camera moves must never re-upload.
    pub fn retain_mesh(&mut self, key: &str, verts: &[f32], idx: &[u32]) {
        use wgpu::util::DeviceExt as _;
        if self.cache.contains_key(key) || verts.is_empty() || idx.is_empty() {
            return;
        }
        let vbuf = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("pen.retain-v"),
            contents: bytemuck::cast_slice(verts),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let ibuf = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("pen.retain-i"),
            contents: bytemuck::cast_slice(idx),
            usage: wgpu::BufferUsages::INDEX,
        });
        self.cache.insert(
            key.to_string(),
            crate::render::StrokeMesh {
                vertex_buf: vbuf,
                index_buf: ibuf,
                index_count: idx.len() as u32,
            },
        );
    }

    /// Stage a retained mesh for this frame's single pass. Missing keys are
    /// skipped silently (evicted or never uploaded).
    pub fn draw_keyed(&mut self, key: &str) {
        if self.frame.is_none() || !self.cache.contains_key(key) {
            return;
        }
        self.staged.push(key.to_string());
        self.drawn += 1;
    }

    /// Drop a retained mesh (stale version, cleared board). Buffers release
    /// with the entry.
    pub fn evict(&mut self, key: &str) {
        if let Some(mesh) = self.cache.remove(key) {
            mesh.vertex_buf.destroy();
            mesh.index_buf.destroy();
        }
    }

    pub fn clear_cache(&mut self) {
        for (_, mesh) in self.cache.drain() {
            mesh.vertex_buf.destroy();
            mesh.index_buf.destroy();
        }
    }

    pub fn end_frame(&mut self) {
        // wgpu 30 presents on drop: submit work, then release the frame.
        // One pass: opaque paper clear, grid geometry, staged ink.
        // Opaque throughout — compositor alpha proved unreliable across
        // drivers (black canvas in production), so the paper lives in the
        // frame instead of underneath it.
        let Some(fr) = self.frame.take() else { return };
        let staged = std::mem::take(&mut self.staged);
        use wgpu::util::DeviceExt as _;
        // Grid buffers precede the pass: the pass borrow outlives them.
        let (gverts, gidx) = crate::render::grid_mesh(&self.cam);
        let grid: Option<crate::render::StrokeMesh> = if gidx.is_empty() {
            None
        } else {
            let gv = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("pen.grid-v"),
                contents: bytemuck::cast_slice(&gverts),
                usage: wgpu::BufferUsages::VERTEX,
            });
            let gi = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("pen.grid-i"),
                contents: bytemuck::cast_slice(&gidx),
                usage: wgpu::BufferUsages::INDEX,
            });
            Some(crate::render::StrokeMesh {
                vertex_buf: gv,
                index_buf: gi,
                index_count: gidx.len() as u32,
            })
        };
        let view = fr.frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let (target, resolve) = match &self.ms_view {
            Some(ms) => (ms, Some(&view)),
            None => (&view, None),
        };
        let paper = crate::render::PAPER;
        let mut enc = fr.encoder;
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("pen.frame"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    resolve_target: resolve,
                    ops: wgpu::Operations {
                        // Always clear: a frame with zero staged meshes must
                        // not leave last frame's ink behind (deletions).
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: paper[0] as f64,
                            g: paper[1] as f64,
                            b: paper[2] as f64,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            if let Some(gm) = &grid {
                self.renderer.draw(&mut pass, std::slice::from_ref(gm));
            }
            for key in &staged {
                if let Some(mesh) = self.cache.get(key) {
                    self.renderer.draw(&mut pass, std::slice::from_ref(mesh));
                }
            }
        }
        self.queue.submit(std::iter::once(enc.finish()));
        drop(fr.frame);
    }
}

