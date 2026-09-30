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

/// Grid geometry for the visible rect, memoized across frames.
///
/// The grid is a pure function of the camera rect and viewport size, but
/// `end_frame` ran it every frame — regenerating verts *and* allocating two
/// fresh GPU buffers per frame. Pan/zoom/resize all change the rect, so the
/// memo misses exactly when it matters most, and the miss cost scales with
/// `view_w_px / zoom`: zooming out 10x built a 10x larger grid. Drawing
/// never moves the camera, which is why it felt smooth while pan did not.
struct GridCache {
    key: (f64, f64, f64, u32, u32),
    mesh: crate::render::StrokeMesh,
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
    grid_cache: Option<GridCache>,
    alpha_mode: wgpu::CompositeAlphaMode,
    caps: String,
    // Diagnostics (surfaced to the debug HUD): silent GPU death is the
    // worst failure mode, so every acquire failure is counted, not logged.
    begun: u64,
    dropped: u64,
    drawn: u64,
    last_error: String,
    last_transfer: String,
}

#[wasm_bindgen]
impl PenCanvas {
    /// Attach to an existing `<canvas>`. Async: adapter/device negotiation.
    /// `fallback` forces the software adapter (SwiftShader): slower, but
    /// works where the hardware adapter is blocklisted or absent.
    pub async fn new(canvas: HtmlCanvasElement) -> Result<PenCanvas, JsValue> {
        Self::new_with_fallback(canvas, false).await
    }

    pub async fn new_with_fallback(
        canvas: HtmlCanvasElement,
        fallback: bool,
    ) -> Result<PenCanvas, JsValue> {
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
        let alpha_mode = if caps
            .alpha_modes
            .contains(&wgpu::CompositeAlphaMode::PreMultiplied)
        {
            wgpu::CompositeAlphaMode::PreMultiplied
        } else {
            caps.alpha_modes
                .first()
                .copied()
                .unwrap_or(wgpu::CompositeAlphaMode::Auto)
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
            cam: Camera {
                scroll_x: 0.0,
                scroll_y: 0.0,
                zoom: 1.0,
                view_w_px: 1.0,
                view_h_px: 1.0,
            },
            grid_cache: None,
            alpha_mode,
            caps: caps_str,
            begun: 0,
            dropped: 0,
            drawn: 0,
            last_error: String::new(),
            last_transfer: String::new(),
        })
    }

    /// "begun dropped drawn last_error" — polled by the debug HUD.
    /// Prefixed with surface caps (formats + alpha modes) for diagnosis.
    /// Suffixed with the last transfer sample.
    pub fn stats(&self) -> String {
        format!(
            "{} | {} {} {} {} | tfr={}",
            self.caps, self.begun, self.dropped, self.drawn, self.last_error, self.last_transfer
        )
    }

    /// Size the surface in device px (call on init + resize). Rebuilds the
    /// cached MSAA target alongside.
    ///
    /// Idempotent: a no-op resize returns immediately. Window `resize`
    /// events arrive per-pixel during a drag, and each `surface.configure`
    /// destroys the swapchain (realloc w*h*4 bytes per swap buffer) plus a
    /// 4xMSAA realloc (w*h*16). Doing that per event drops a frame per
    /// event; the early-out costs one integer compare instead.
    pub fn resize(&mut self, w_px: u32, h_px: u32) {
        let (w_px, h_px) = (w_px.max(1), h_px.max(1));
        if self.cam.view_w_px == w_px as f32 && self.cam.view_h_px == h_px as f32 {
            return;
        }
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
                size: wgpu::Extent3d {
                    width: w_px,
                    height: h_px,
                    depth_or_array_layers: 1,
                },
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
        let encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f)
            | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
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
        // TEMPORARY: sample received values for transfer diagnosis.
        self.last_transfer = format!(
            "n={} m={} v0={:?} i0={:?}",
            verts.len(),
            idx.len(),
            &verts[..verts.len().min(6)],
            &idx[..idx.len().min(6)]
        );
        if self.cache.contains_key(key) || verts.is_empty() || idx.is_empty() {
            return;
        }
        let vbuf = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("pen.retain-v"),
                contents: bytemuck::cast_slice(verts),
                usage: wgpu::BufferUsages::VERTEX,
            });
        let ibuf = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
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

    /// TEMPORARY transfer probe: report what Rust actually received for a
    /// key (count + first values). Remove with the red triangle.
    pub fn probe_mesh(&self, key: &str) -> String {
        match self.cache.get(key) {
            None => "missing".to_string(),
            Some(m) => format!("idx={}", m.index_count),
        }
    }

    /// TEMPORARY: what the last retain_mesh call received (first values).
    pub fn last_transfer(&self) -> String {
        self.last_transfer.clone()
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
        let Some(fr) = self.frame.take() else { return };
        let staged = std::mem::take(&mut self.staged);
        use wgpu::util::DeviceExt as _;
        // Grid buffers precede the pass: the pass borrow outlives them.
        // Memoized on the camera rect + viewport: an unchanged rect reuses
        // the live buffers instead of rebuilding and re-uploading them.
        // Hits are the common case (idle, and drawing — which never moves the
        // camera), so those frames stop allocating two buffers each.
        let grid_key = (
            self.cam.scroll_x,
            self.cam.scroll_y,
            self.cam.zoom,
            self.cam.view_w_px as u32,
            self.cam.view_h_px as u32,
        );
        if !self.grid_cache.as_ref().is_some_and(|g| g.key == grid_key) {
            // Explicit destroy before replacing: the wgpu allocator reuses
            // freed ranges, whereas dropping defers release to GC time.
            if let Some(old) = self.grid_cache.take() {
                old.mesh.vertex_buf.destroy();
                old.mesh.index_buf.destroy();
            }
            let (gverts, gidx) = crate::render::grid_mesh(&self.cam);
            if !gidx.is_empty() {
                let gv = self
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("pen.grid-v"),
                        contents: bytemuck::cast_slice(&gverts),
                        usage: wgpu::BufferUsages::VERTEX,
                    });
                let gi = self
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("pen.grid-i"),
                        contents: bytemuck::cast_slice(&gidx),
                        usage: wgpu::BufferUsages::INDEX,
                    });
                self.grid_cache = Some(GridCache {
                    key: grid_key,
                    mesh: crate::render::StrokeMesh {
                        vertex_buf: gv,
                        index_buf: gi,
                        index_count: gidx.len() as u32,
                    },
                });
            }
        }
        let grid: Option<&crate::render::StrokeMesh> =
            self.grid_cache.as_ref().map(|g| &g.mesh);
        let view = fr
            .frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
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
            if let Some(gm) = grid {
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
