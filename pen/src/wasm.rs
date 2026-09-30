//! JS API surface (`wasm` feature): geometry + camera for a web embedder.
//!
//! Deliberately GPU-free: the browser already has a renderer (or will get
//! one via wgpu's WebGPU backend, owned by the embedder). This module hands
//! JS flat vertex/index buffers and the scene→screen projection, so the
//! pencil can move to pen geometry before native takes over rendering.
use crate::model::{Stroke, StrokeOptions, StrokePoint};
use crate::outline::build_mesh;
use wasm_bindgen::prelude::*;

/// One in-progress stroke. Push samples as the pointer moves; pull the mesh
/// whenever (every frame is fine — the mesh is cached and only rebuilt when
/// new samples arrive, so per-frame cost is a pointer handoff, not O(N)).
#[wasm_bindgen]
pub struct PenStroke {
    stroke: Stroke,
    cached_processed: Option<Vec<StrokePoint>>,
    cached_mesh: Option<crate::outline::Mesh>,
}

#[wasm_bindgen]
impl PenStroke {
    #[wasm_bindgen(constructor)]
    pub fn new(size: f64, r: f32, g: f32, b: f32, a: f32, monoline: bool) -> PenStroke {
        PenStroke {
            stroke: Stroke::new(
                Vec::new(),
                StrokeOptions { size, monoline, ..StrokeOptions::default() },
                [r, g, b, a],
            ),
            cached_processed: None,
            cached_mesh: None,
        }
    }

    /// pressure < 0 (mouse) synthesizes from velocity downstream.
    pub fn push(&mut self, x: f64, y: f64, pressure: f64, t_ms: f64) {
        self.stroke.points.push(StrokePoint::new(x, y, pressure, t_ms));
        self.cached_processed = None;
        self.cached_mesh = None;
    }

    pub fn len(&self) -> usize {
        self.stroke.points.len()
    }

    fn processed(&mut self) -> &[StrokePoint] {
        if self.cached_processed.is_none() {
            let pts = crate::smooth::process(&self.stroke.points, &self.stroke.options);
            self.cached_processed = Some(pts);
        }
        self.cached_processed.as_ref().expect("just built")
    }

    fn mesh(&mut self) -> &crate::outline::Mesh {
        if self.cached_mesh.is_none() {
            let pts = self.processed().to_vec();
            let stroke = Stroke::new(pts, self.stroke.options, self.stroke.color);
            // Bypass build_mesh's own process() (already processed): the
            // mesh entry point below takes a centerline directly.
            self.cached_mesh = Some(crate::outline::build_mesh_from(stroke));
        }
        self.cached_mesh.as_ref().expect("just built")
    }

    /// Processed centerline as flat [x, y] (smoothed, Rust-side identical
    /// to what meshing uses). Sharpie mode strokes this directly: one path,
    /// no triangle seams, perfectly mono overlaps.
    pub fn centerline(&self) -> Vec<f64> {
        crate::smooth::process(&self.stroke.points, &self.stroke.options)
            .iter()
            .flat_map(|p| [p.x, p.y])
            .collect()
    }

    /// Interleaved [x, y, r, g, b, a] vertices (scene units).
    pub fn vertices(&self) -> Vec<f32> {
        build_mesh(&self.stroke)
            .vertices
            .iter()
            .flat_map(|v| [v.pos[0], v.pos[1], v.color[0], v.color[1], v.color[2], v.color[3]])
            .collect()
    }

    pub fn indices(&self) -> Vec<u32> {
        build_mesh(&self.stroke).indices
    }

    /// Scene JSON the sync layer already speaks (points + pressures).
    pub fn to_json(&self) -> String {
        serde_json::to_string(&crate::interop::to_excalidraw(&self.stroke)).unwrap_or_default()
    }
}

/// Scene → CSS-pixel projection matching the sheet transform.
#[wasm_bindgen]
pub fn project(x: f64, y: f64, scroll_x: f64, scroll_y: f64, zoom: f64) -> Vec<f64> {
    vec![(x + scroll_x) * zoom, (y + scroll_y) * zoom]
}

/// Batch eraser hit-test over freedraw elements with ABSOLUTE scene points:
/// `[{"id", "points": [[x,y]..], "width"}]` → JSON array of hit ids.
/// `width` is the Excalidraw strokeWidth; rendered diameter runs ~6× that
/// (measured), which is what the pointer is tested against.
#[wasm_bindgen]
pub fn erase_hit(elements_json: &str, x: f64, y: f64, radius: f64) -> String {
    #[derive(serde::Deserialize)]
    struct Target {
        id: String,
        #[serde(default)]
        points: Vec<[f64; 2]>,
        #[serde(default = "default_width")]
        width: f64,
    }
    fn default_width() -> f64 {
        1.0
    }
    let targets: Vec<Target> = serde_json::from_str(elements_json).unwrap_or_default();
    let hits: Vec<&str> = targets
        .iter()
        .filter(|t| {
            let pts: Vec<StrokePoint> = t
                .points
                .iter()
                .map(|&[px, py]| StrokePoint::new(px, py, 0.5, 0.0))
                .collect();
            crate::hit::hit_stroke(&pts, t.width * 6.0, x, y, radius)
        })
        .map(|t| t.id.as_str())
        .collect();
    serde_json::to_string(&hits).unwrap_or_default()
}
