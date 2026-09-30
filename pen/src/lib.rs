//! Pen: hand-drawn stroke pipeline + renderer.
//!
//! The input side turns raw pointer samples into smoothed, variable-width
//! strokes (the xournal++ feel: pressure shapes the line, velocity shapes
//! the pressure when the hardware has none). The output side turns strokes
//! into filled-polygon meshes and draws them with wgpu over a transparent
//! surface — the app keeps painting its engineering-pad grid underneath in
//! CSS, so ink always sits on paper.
//!
//! Layout: [`model`] (stroke types) → [`smooth`] (filtering) → [`outline`]
//! (centerline → triangle mesh) → [`render`] (wgpu) / [`wasm`] (JS API).
//! [`interop`] converts to and from the Excalidraw freedraw JSON the sync
//! layer already speaks, so the pen can take over the pencil incrementally.
pub mod hit;
pub mod interop;
pub mod model;
pub mod outline;
pub mod render;
pub mod smooth;
#[cfg(feature = "wasm")]
pub mod canvas;
#[cfg(feature = "wasm")]
pub mod wasm;

pub use model::{Stroke, StrokeOptions, StrokePoint};
pub use outline::{Mesh, build_mesh, build_mesh_from};
