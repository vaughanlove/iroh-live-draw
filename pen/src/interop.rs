//! Bridge to the Excalidraw freedraw JSON the sync layer already speaks.
//!
//! The pen takes over the pencil incrementally: strokes captured with pen
//! geometry serialize to the exact freedraw shape gossip/keeper/CRDT
//! already merge, and incoming freedraw elements deserialize back for
//! pen-side rendering. No transport changes needed during the migration.
use crate::model::{Stroke, StrokeOptions, StrokePoint};

/// Subset of Excalidraw's freedraw element we round-trip.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct FreedrawJson {
    pub id: String,
    #[serde(default)]
    pub points: Vec<[f64; 2]>,
    #[serde(default)]
    pub pressures: Vec<f64>,
    #[serde(default = "default_true")]
    pub simulate_pressure: bool,
    #[serde(default)]
    pub stroke_width: f64,
    #[serde(default = "default_stroke_color")]
    pub stroke_color: String,
    #[serde(default = "default_one")]
    pub version: i64,
}

fn default_true() -> bool {
    true
}
fn default_one() -> i64 {
    1
}
fn default_stroke_color() -> String {
    "#1e1e1e".to_string()
}

/// Excalidraw freedraw → pen stroke. Pressures pair with points by index;
/// missing entries (or `simulate_pressure`) mark pressure unknown (-1) so
/// the input stage synthesizes from velocity.
pub fn from_excalidraw(el: &FreedrawJson, size: f64) -> Stroke {
    let n = el.points.len();
    let points = el
        .points
        .iter()
        .enumerate()
        .map(|(i, &[x, y])| {
            let p = if el.simulate_pressure {
                -1.0
            } else {
                el.pressures.get(i).copied().unwrap_or(-1.0)
            };
            // Excalidraw points are element-local; t is synthetic but
            // ordered, which is all synthesis needs.
            StrokePoint::new(x, y, p, i as f64 * 8.0)
        })
        .collect();
    let _ = n;
    Stroke::new(
        points,
        StrokeOptions {
            size,
            simulate_pressure: el.simulate_pressure || el.pressures.len() != el.points.len(),
            ..StrokeOptions::default()
        },
        parse_color(&el.stroke_color),
    )
}

/// Pen stroke → Excalidraw freedraw body (merged into the live element by
/// the caller, which owns id/version/CRDT claims).
pub fn to_excalidraw(stroke: &Stroke) -> FreedrawJson {
    FreedrawJson {
        id: String::new(),
        points: stroke.points.iter().map(|p| [p.x, p.y]).collect(),
        pressures: stroke.points.iter().map(|p| p.pressure.clamp(0.0, 1.0)).collect(),
        simulate_pressure: false,
        stroke_width: 1.0,
        stroke_color: format_color(&stroke.color),
        version: 1,
    }
}

fn parse_color(s: &str) -> [f32; 4] {
    let h = s.trim_start_matches('#');
    let n = |i: usize| u8::from_str_radix(h.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0) as f32 / 255.0;
    if h.len() >= 6 {
        [n(0), n(2), n(4), 1.0]
    } else {
        [0.12, 0.12, 0.12, 1.0]
    }
}

fn format_color(c: &[f32; 4]) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        (c[0].clamp(0.0, 1.0) * 255.0) as u8,
        (c[1].clamp(0.0, 1.0) * 255.0) as u8,
        (c[2].clamp(0.0, 1.0) * 255.0) as u8
    )
}

/// Parse one element out of a full scene JSON value (as stored/synced).
pub fn parse_element(value: &serde_json::Value) -> Option<FreedrawJson> {
    serde_json::from_value(value.clone()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_preserves_points() {
        let el = FreedrawJson {
            id: "abc".to_string(),
            points: vec![[0.0, 0.0], [10.0, 5.0], [20.0, 0.0]],
            pressures: vec![0.2, 0.9, 0.4],
            simulate_pressure: false,
            stroke_width: 1.0,
            stroke_color: "#1e4620".to_string(),
            version: 3,
        };
        let stroke = from_excalidraw(&el, 8.0);
        assert_eq!(stroke.points.len(), 3);
        assert_eq!(stroke.points[1].pressure, 0.9);
        let back = to_excalidraw(&stroke);
        assert_eq!(back.points.len(), 3);
        assert_eq!(back.points[1], [10.0, 5.0]);
        assert_eq!(back.stroke_color, "#1e4620");
    }

    #[test]
    fn missing_pressures_synthesize() {
        let el = FreedrawJson {
            id: "x".to_string(),
            points: vec![[0.0, 0.0], [30.0, 0.0]],
            pressures: vec![],
            simulate_pressure: true,
            stroke_width: 1.0,
            stroke_color: "#000000".to_string(),
            version: 1,
        };
        let stroke = from_excalidraw(&el, 8.0);
        assert!(stroke.options.simulate_pressure);
        let mesh = crate::outline::build_mesh(&stroke);
        assert!(!mesh.is_empty());
    }
}
