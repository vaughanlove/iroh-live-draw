//! Input filtering: streamline + pressure synthesis + smoothing.
//!
//! Raw pointer streams are noisy (jitter) and uneven (event coalescing,
//! 120Hz vs 60Hz). This stage outputs an evenly-spaced, smoothed centerline
//! with a believable pressure per sample — the part of the xournal++ feel
//! that isn't rendering.
use crate::model::{StrokeOptions, StrokePoint};

/// Drop redundant samples and synthesize pressure where missing.
/// Keeps first and last samples unconditionally.
pub fn streamline(points: &[StrokePoint], opts: &StrokeOptions) -> Vec<StrokePoint> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let min_dist = opts.size * opts.streamline;
    let mut out = Vec::with_capacity(points.len());
    out.push(points[0]);
    for pt in &points[1..points.len() - 1] {
        if pt.dist_to(out.last().expect("nonempty")) >= min_dist {
            out.push(*pt);
        }
    }
    out.push(*points.last().expect("nonempty"));
    // Degenerate: everything collapsed — keep the endpoints.
    if out.len() == 2 && out[0] == out[1] {
        out.pop();
    }
    out
}

/// Fill unknown pressures (< 0) from velocity: fast moves thin out, slow
/// moves press in. `thinning` skews fountain-ward (< 0.5) or ballpoint-ward.
pub fn synthesize_pressure(points: &mut [StrokePoint], opts: &StrokeOptions) {
    if !opts.simulate_pressure || points.is_empty() {
        return;
    }
    let unknown: Vec<bool> = points.iter().map(|p| p.pressure < 0.0).collect();
    if !unknown.iter().any(|&u| u) {
        for pt in points.iter_mut() {
            pt.pressure = pt.pressure.clamp(0.0, 1.0);
        }
        return;
    }
    let seed = points.iter().find_map(|p| (p.pressure >= 0.0).then_some(p.pressure)).unwrap_or(0.5);
    // Velocity modulation: rate chases a velocity-derived target.
    let mut rate = seed;
    let mut prev = points[0];
    for (i, pt) in points.iter_mut().enumerate() {
        if i > 0 {
            let dist = pt.dist_to(&prev);
            let dt = (pt.t_ms - prev.t_ms).max(0.1);
            let velocity = dist / dt;
            // velocity 0 → 1, fast → 0.
            let target = 1.0 / (1.0 + velocity.powf(1.0 - opts.thinning) * 0.35);
            rate = 0.275 * target + (1.0 - 0.275) * rate;
        }
        if unknown[i] {
            pt.pressure = rate.min(1.0);
        }
        prev = *pt;
    }
    // Clamp everything into range (real sensors overshoot too).
    for pt in points.iter_mut() {
        pt.pressure = pt.pressure.clamp(0.0, 1.0);
    }
}

/// Chaikin corner-cutting: smooths jitter while preserving intent far
/// better than a moving average (which shrinks and lags fast hooks).
/// One pass halves the corner angle; two passes is the sweet spot.
pub fn chaikin(points: &[StrokePoint], passes: usize) -> Vec<StrokePoint> {
    if points.len() < 3 || passes == 0 {
        return points.to_vec();
    }
    let mut cur = points.to_vec();
    for _ in 0..passes {
        let mut next = Vec::with_capacity(cur.len() * 2);
        next.push(cur[0]);
        for w in cur.windows(2) {
            let (a, b) = (w[0], w[1]);
            next.push(StrokePoint {
                x: a.x * 0.75 + b.x * 0.25,
                y: a.y * 0.75 + b.y * 0.25,
                pressure: a.pressure * 0.75 + b.pressure * 0.25,
                t_ms: a.t_ms * 0.75 + b.t_ms * 0.25,
            });
            next.push(StrokePoint {
                x: a.x * 0.25 + b.x * 0.75,
                y: a.y * 0.25 + b.y * 0.75,
                pressure: a.pressure * 0.25 + b.pressure * 0.75,
                t_ms: a.t_ms * 0.25 + b.t_ms * 0.75,
            });
        }
        next.push(*cur.last().expect("nonempty"));
        cur = next;
    }
    cur
}

/// Full input stage: streamline → pressure → smooth.
pub fn process(points: &[StrokePoint], opts: &StrokeOptions) -> Vec<StrokePoint> {
    let slim = streamline(points, opts);
    let mut with_p = slim;
    synthesize_pressure(&mut with_p, opts);
    chaikin(&with_p, 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pts(raw: &[(f64, f64)]) -> Vec<StrokePoint> {
        raw.iter().enumerate().map(|(i, &(x, y))| StrokePoint::new(x, y, -1.0, i as f64 * 8.0)).collect()
    }

    #[test]
    fn streamline_keeps_endpoints_drops_jitter() {
        let opts = StrokeOptions { size: 10.0, streamline: 0.5, ..StrokeOptions::default() };
        // min_dist = 5; middle points within 5 of start collapse.
        let v = pts(&[(0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (100.0, 0.0)]);
        let out = streamline(&v, &opts);
        assert_eq!(out.len(), 2);
        assert_eq!((out[0].x, out[0].y), (0.0, 0.0));
        assert_eq!((out[1].x, out[1].y), (100.0, 0.0));
    }

    #[test]
    fn pressure_synthesis_fills_unknowns_keeps_known() {
        let opts = StrokeOptions::default();
        let mut v = vec![
            StrokePoint::new(0.0, 0.0, -1.0, 0.0),
            StrokePoint::new(10.0, 0.0, 0.8, 8.0),
            StrokePoint::new(20.0, 0.0, -1.0, 16.0),
        ];
        synthesize_pressure(&mut v, &opts);
        assert!((0.0..=1.0).contains(&v[0].pressure));
        assert_eq!(v[1].pressure, 0.8);
        assert!((0.0..=1.0).contains(&v[2].pressure));
    }

    #[test]
    fn chaikin_preserves_endpoints() {
        let v = pts(&[(0.0, 0.0), (50.0, 50.0), (100.0, 0.0)]);
        let out = chaikin(&v, 2);
        assert_eq!((out[0].x, out[0].y), (0.0, 0.0));
        let last = out[out.len() - 1];
        assert_eq!((last.x, last.y), (100.0, 0.0));
        assert!(out.len() > v.len());
    }
}
