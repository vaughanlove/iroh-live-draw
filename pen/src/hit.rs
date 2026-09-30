//! Eraser hit-testing: point vs stroke centerline.
//!
//! The eraser doesn't need meshes — distance from the pointer to each
//! centerline segment, against half the line width plus the eraser radius.
//! Runs on raw samples (no smoothing pass): erasing should feel generous,
//! and raw points are what the sync layer stores.
use crate::model::StrokePoint;

/// Minimum distance from (x, y) to the polyline, in scene units.
pub fn dist_to_polyline(points: &[StrokePoint], x: f64, y: f64) -> f64 {
    if points.is_empty() {
        return f64::INFINITY;
    }
    if points.len() == 1 {
        return ((points[0].x - x).powi(2) + ((points[0].y - y).powi(2))).sqrt();
    }
    let mut best = f64::INFINITY;
    for w in points.windows(2) {
        best = best.min(dist_to_segment(x, y, &w[0], &w[1]));
        if best == 0.0 {
            return 0.0;
        }
    }
    best
}

fn dist_to_segment(px: f64, py: f64, a: &StrokePoint, b: &StrokePoint) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-12 {
        return ((px - a.x).powi(2) + (py - a.y).powi(2)).sqrt();
    }
    let t = (((px - a.x) * dx + (py - a.y) * dy) / len2).clamp(0.0, 1.0);
    ((px - (a.x + t * dx)).powi(2) + (py - (a.y + t * dy)).powi(2)).sqrt()
}

/// True when the pointer (with eraser radius) touches the stroke.
/// `width` is the line's rendered diameter in scene units.
pub fn hit_stroke(points: &[StrokePoint], width: f64, x: f64, y: f64, radius: f64) -> bool {
    dist_to_polyline(points, x, y) <= width * 0.5 + radius
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line() -> Vec<StrokePoint> {
        (0..=10).map(|i| StrokePoint::new(i as f64 * 10.0, 0.0, 0.5, i as f64)).collect()
    }

    #[test]
    fn hits_on_line_misses_off() {
        assert!(hit_stroke(&line(), 8.0, 50.0, 2.0, 6.0));
        assert!(!hit_stroke(&line(), 8.0, 50.0, 40.0, 6.0));
        assert!(!hit_stroke(&line(), 8.0, 500.0, 0.0, 6.0));
    }

    #[test]
    fn empty_never_hits_single_point_does() {
        assert!(!hit_stroke(&[], 8.0, 0.0, 0.0, 10.0));
        let dot = vec![StrokePoint::new(5.0, 5.0, 1.0, 0.0)];
        assert!(hit_stroke(&dot, 8.0, 5.0, 5.0, 2.0));
        assert!(!hit_stroke(&dot, 8.0, 50.0, 50.0, 2.0));
    }
}
