//! Stroke model: raw samples in, everything else derives from these.
use serde::{Deserialize, Serialize};

/// One pointer sample. `pressure` is 0..1 (stylus) or negative when the
/// hardware reports none — see [`StrokeOptions::simulate_pressure`].
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct StrokePoint {
    pub x: f64,
    pub y: f64,
    /// Pen pressure 0..1, or < 0 when unknown (mouse, some touch).
    pub pressure: f64,
    /// Sample time in milliseconds (any steady clock).
    pub t_ms: f64,
}

impl StrokePoint {
    pub fn new(x: f64, y: f64, pressure: f64, t_ms: f64) -> Self {
        Self { x, y, pressure, t_ms }
    }

    pub fn dist_to(&self, o: &StrokePoint) -> f64 {
        (self.x - o.x).hypot(self.y - o.y)
    }
}

/// A finished (or in-progress) stroke plus how to ink it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Stroke {
    pub points: Vec<StrokePoint>,
    pub options: StrokeOptions,
    /// sRGB as the app speaks it.
    pub color: [f32; 4],
}

impl Stroke {
    pub fn new(points: Vec<StrokePoint>, options: StrokeOptions, color: [f32; 4]) -> Self {
        Self { points, options, color }
    }
}

/// Inking parameters. Defaults suit a technical pen on the pad.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct StrokeOptions {
    /// Full-pressure line diameter in scene units.
    pub size: f64,
    /// Thinning: negative values widen slow moves (fountain feel),
    /// positive values widen fast moves (ballpoint feel). 0.5 is neutral.
    pub thinning: f64,
    /// Drop samples closer than `size * streamline` to the last kept one.
    /// Higher = smoother, fewer points.
    pub streamline: f64,
    /// Ease-in/out taper length in scene units (pen landing/lifting).
    pub taper_start: f64,
    pub taper_end: f64,
    /// Minimum radius fraction so fast/zero-pressure moves stay visible.
    pub min_width: f64,
    /// Synthesize pressure from velocity when hardware reports none.
    pub simulate_pressure: bool,
    /// Sharpie mode: uniform `size` width everywhere — no pressure
    /// shaping, no taper. Predictable marker lines (upgraded MS Paint).
    #[serde(default)]
    pub monoline: bool,
}

impl Default for StrokeOptions {
    fn default() -> Self {
        Self {
            size: 8.0,
            thinning: 0.5,
            streamline: 0.35,
            taper_start: 24.0,
            taper_end: 24.0,
            min_width: 0.12,
            simulate_pressure: true,
            monoline: false,
        }
    }
}
