//! Centerline → triangle mesh: variable-width outline with taper + caps.
//!
//! For each centerline sample the radius is pressure-shaped, the direction
//! gives a normal, and left/right offsets form a triangle strip. Round caps
//! are triangle fans. Output is a plain vertex + index list the wgpu
//! renderer (or a JS embedder) can draw with zero further processing.
use crate::model::{Stroke, StrokeOptions};
use crate::smooth;

/// 2D vertex in scene units + premultiplied-ish sRGB color; the renderer
/// passes color straight through with alpha blending.
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
pub struct Vertex {
    pub pos: [f32; 2],
    pub color: [f32; 4],
}

/// Indexed triangle mesh for one stroke.
#[derive(Clone, Debug, Default)]
pub struct Mesh {
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u32>,
}

impl Mesh {
    pub fn is_empty(&self) -> bool {
        self.indices.len() < 3 || self.vertices.is_empty()
    }

    /// Axis-aligned bounds in scene units (for culling / hit-testing).
    pub fn bounds(&self) -> Option<[f64; 4]> {
        if self.vertices.is_empty() {
            return None;
        }
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for v in &self.vertices {
            let (x, y) = (v.pos[0] as f64, v.pos[1] as f64);
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
        Some([min_x, min_y, max_x, max_y])
    }
}

fn radius_for(pressure: f64, opts: &StrokeOptions) -> f64 {
    if opts.monoline {
        return (opts.size * 0.5).max(0.25);
    }
    // pressure^thinning-ish shaping with a floor so fast moves stay inked.
    let shaped = pressure.max(0.0).powf(1.0 - opts.thinning.min(0.9));
    let r = opts.size * 0.5 * shaped;
    r.max(opts.size * 0.5 * opts.min_width).max(0.25)
}

fn taper_factor(dist_from_start: f64, total_len: f64, opts: &StrokeOptions) -> f64 {
    let mut f: f64 = 1.0;
    if opts.taper_start > 0.0 && dist_from_start < opts.taper_start {
        let t = dist_from_start / opts.taper_start;
        f = f.min(t * t * (3.0 - 2.0 * t)); // smoothstep landing
    }
    let dist_from_end = total_len - dist_from_start;
    if opts.taper_end > 0.0 && dist_from_end < opts.taper_end {
        let t = (dist_from_end / opts.taper_end).max(0.0);
        f = f.min(t * t * (3.0 - 2.0 * t)); // smoothstep lift
    }
    f.max(0.0)
}

/// Build the mesh for a whole stroke (runs the input stage internally).
pub fn build_mesh(stroke: &Stroke) -> Mesh {
    let pts = smooth::process(&stroke.points, &stroke.options);
    build_mesh_from(Stroke::new(pts, stroke.options, stroke.color))
}

/// Build the mesh from an already-processed centerline (streaming fast
/// path: skip re-running the input stage when the caller cached it).
pub fn build_mesh_from(stroke: Stroke) -> Mesh {
    let mut pts = stroke.points;
    if pts.is_empty() {
        return Mesh::default();
    }
    if pts.len() == 1 {
        // A tap is a dot, not an empty stroke: full-pressure fan, no taper
        // (a pencil leaves a mark when it lands).
        return build_dot(&pts[0], &stroke.options, stroke.color);
    }
    if pts.len() == 2 {
        // Two samples carry no interior: taper would pinch both ends to
        // zero and the strip would vanish. A midpoint guarantees nonzero
        // width in the middle (micro-drags read as nubs, not nothing).
        let (a, b) = (pts[0], pts[1]);
        pts.insert(
            1,
            crate::model::StrokePoint {
                x: (a.x + b.x) * 0.5,
                y: (a.y + b.y) * 0.5,
                pressure: (a.pressure + b.pressure) * 0.5,
                t_ms: (a.t_ms + b.t_ms) * 0.5,
            },
        );
    }
    let opts = &stroke.options;
    // Arc-length table for taper + total length.
    let mut cum = Vec::with_capacity(pts.len());
    cum.push(0.0);
    for w in pts.windows(2) {
        cum.push(cum.last().expect("nonempty") + w[0].dist_to(&w[1]));
    }
    let total = *cum.last().expect("nonempty");
    let span = total.max(1e-6);
    // Tapers scale down on short spans so micro-strokes read as nubs, not
    // nothing (a 1px drag tapered over 24 units would vanish entirely).
    // Monoline skips taper outright: markers start and end full-width.
    let (ts, te) = if opts.monoline {
        (0.0, 0.0)
    } else {
        (
            opts.taper_start.min(span * 0.5),
            opts.taper_end.min(span * 0.5),
        )
    };
    let opts_eff = StrokeOptions { taper_start: ts, taper_end: te, ..*opts };
    let opts = &opts_eff;

    // Offsets per sample.
    let mut left = Vec::with_capacity(pts.len());
    let mut right = Vec::with_capacity(pts.len());
    for (i, pt) in pts.iter().enumerate() {
        let (dx, dy) = stroke_dir(&pts, i);
        let r = radius_for(pt.pressure, opts) * taper_factor(cum[i], span, opts);
        let r = r.max(0.0);
        left.push((pt.x - dy * r, pt.y + dx * r));
        right.push((pt.x + dy * r, pt.y - dx * r));
    }

    let mut mesh = Mesh::default();
    let color = stroke.color;
    let push = |mesh: &mut Mesh, p: (f64, f64)| -> u32 {
        mesh.vertices.push(Vertex { pos: [p.0 as f32, p.1 as f32], color });
        (mesh.vertices.len() - 1) as u32
    };
    // Start cap: fan facing away from the body (no overlap → safe for
    // translucent ink).
    {
        let c = (pts[0].x, pts[0].y);
        let r = radius_for(pts[0].pressure, opts) * taper_factor(0.0, span, opts);
        let (dx, dy) = stroke_dir(&pts, 0);
        let back = (dy).atan2(dx) + std::f64::consts::PI;
        let center = push(&mut mesh, c);
        let steps = cap_steps(r);
        let mut prev = None;
        for s in 0..=steps {
            let ang = back - std::f64::consts::FRAC_PI_2
                + std::f64::consts::PI * (s as f64 / steps as f64);
            let p = push(&mut mesh, (c.0 + ang.cos() * r, c.1 + ang.sin() * r));
            if let Some(q) = prev {
                mesh.indices.extend([center, q, p]);
            }
            prev = Some(p);
        }
    }
    // Body strip.
    let mut strip: Vec<u32> = Vec::with_capacity(pts.len() * 2);
    for i in 0..pts.len() {
        strip.push(push(&mut mesh, left[i]));
        strip.push(push(&mut mesh, right[i]));
    }
    for i in 0..pts.len() - 1 {
        let (l0, r0) = (strip[2 * i], strip[2 * i + 1]);
        let (l1, r1) = (strip[2 * i + 2], strip[2 * i + 3]);
        mesh.indices.extend([l0, r0, l1, r1, r0, l1]);
    }
    // End cap: fan facing away from the body.
    {
        let last = pts.len() - 1;
        let c = (pts[last].x, pts[last].y);
        let r = radius_for(pts[last].pressure, opts) * taper_factor(span, span, opts);
        let (dx, dy) = stroke_dir(&pts, last);
        let facing = (dy).atan2(dx); // forward: cap extends past the tip
        let center = push(&mut mesh, c);
        let steps = cap_steps(r);
        let mut prev = None;
        for s in 0..=steps {
            let ang = facing - std::f64::consts::FRAC_PI_2
                + std::f64::consts::PI * (s as f64 / steps as f64);
            let p = push(&mut mesh, (c.0 + ang.cos() * r, c.1 + ang.sin() * r));
            if let Some(q) = prev {
                mesh.indices.extend([center, q, p]);
            }
            prev = Some(p);
        }
    }
    mesh
}

/// Unit stroke direction at sample `i` (central differences, clamped ends).
fn stroke_dir(pts: &[crate::model::StrokePoint], i: usize) -> (f64, f64) {
    let a = if i == 0 { &pts[0] } else { &pts[i - 1] };
    let b = if i + 1 >= pts.len() { &pts[pts.len() - 1] } else { &pts[i + 1] };
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let len = dx.hypot(dy).max(1e-9);
    (dx / len, dy / len)
}

/// Cap fan resolution scales with radius (tiny radii need no fan).
fn cap_steps(r: f64) -> usize {
    if r < 0.75 {
        1
    } else if r < 3.0 {
        3
    } else {
        6
    }
}

/// Dot mesh for single-sample strokes (taps): a filled fan at full radius.
fn build_dot(pt: &crate::model::StrokePoint, opts: &StrokeOptions, color: [f32; 4]) -> Mesh {
    let mut mesh = Mesh::default();
    let r = radius_for(pt.pressure.max(0.0), opts);
    let push = |mesh: &mut Mesh, p: (f64, f64)| -> u32 {
        mesh.vertices.push(Vertex { pos: [p.0 as f32, p.1 as f32], color });
        (mesh.vertices.len() - 1) as u32
    };
    let center = push(&mut mesh, (pt.x, pt.y));
    // 4 fans minimum so even tiny dots read round.
    let steps = cap_steps(r).max(4) * 2;
    let mut prev = None;
    for s in 0..=steps {
        let ang = 2.0 * std::f64::consts::PI * (s as f64 / steps as f64);
        let p = push(&mut mesh, (pt.x + ang.cos() * r, pt.y + ang.sin() * r));
        if let Some(q) = prev {
            mesh.indices.extend([center, q, p]);
        }
        prev = Some(p);
    }
    mesh
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Stroke, StrokeOptions, StrokePoint};

    fn line(n: usize) -> Stroke {
        let points = (0..n)
            .map(|i| StrokePoint::new(i as f64 * 10.0, 0.0, 0.9, i as f64 * 8.0))
            .collect();
        Stroke::new(points, StrokeOptions::default(), [0.0, 0.0, 0.0, 1.0])
    }

    #[test]
    fn degenerate_inputs() {
        let opts = StrokeOptions::default();
        assert!(build_mesh(&Stroke::new(vec![], opts, [0.0, 0.0, 0.0, 1.0])).is_empty());
        // A lone sample is a tap: it inks a dot, not nothing.
        let one = Stroke::new(vec![StrokePoint::new(10.0, 10.0, 0.8, 0.0)], opts, [0.0, 0.0, 0.0, 1.0]);
        let dot = build_mesh(&one);
        assert!(!dot.is_empty());
        let [min_x, min_y, max_x, max_y] = dot.bounds().expect("dot bounds");
        assert!(min_x <= 10.0 && max_x >= 10.0 && min_y <= 10.0 && max_y >= 10.0);
        assert!(max_x - min_x > 0.5 && max_y - min_y > 0.5);
    }

    #[test]
    fn straight_line_mesh_is_well_formed() {
        let mesh = build_mesh(&line(6));
        assert!(!mesh.is_empty());
        assert_eq!(mesh.indices.len() % 3, 0);
        let n = mesh.vertices.len() as u32;
        assert!(mesh.indices.iter().all(|&i| i < n));
        // Bounds contain the centerline, expanded by radius.
        let [min_x, min_y, max_x, max_y] = mesh.bounds().expect("bounds");
        assert!(min_x <= 0.0 && max_x >= 50.0);
        assert!(min_y < 0.0 && max_y > 0.0);
    }

    #[test]
    fn taper_pinches_ends() {
        let no_taper = Stroke::new(
            line(8).points,
            StrokeOptions { taper_start: 0.0, taper_end: 0.0, ..StrokeOptions::default() },
            [0.0, 0.0, 0.0, 1.0],
        );
        let tapered = Stroke::new(
            line(8).points,
            StrokeOptions { taper_start: 1000.0, taper_end: 1000.0, ..StrokeOptions::default() },
            [0.0, 0.0, 0.0, 1.0],
        );
        let b0 = build_mesh(&no_taper).bounds().expect("b0");
        let b1 = build_mesh(&tapered).bounds().expect("b1");
        // Heavy taper shrinks the inked footprint in the normal direction.
        assert!(b1[3] - b1[1] < b0[3] - b0[1]);
    }

    #[test]
    fn micro_stroke_reads_as_nub() {
        let opts = StrokeOptions::default();
        let pts = vec![
            StrokePoint::new(0.0, 0.0, 0.8, 0.0),
            StrokePoint::new(1.0, 0.5, 0.8, 8.0),
        ];
        let mesh = build_mesh(&Stroke::new(pts, opts, [0.0, 0.0, 0.0, 1.0]));
        assert!(!mesh.is_empty());
    }

    #[test]
    fn monoline_holds_constant_width() {
        // Wildly varying pressures, dead-flat width.
        let points = (0..8)
            .map(|i| StrokePoint::new(i as f64 * 10.0, 0.0, [0.05, 1.0, 0.3, 0.9][i % 4], i as f64 * 8.0))
            .collect();
        let stroke = Stroke::new(
            points,
            StrokeOptions { size: 10.0, monoline: true, ..StrokeOptions::default() },
            [0.0, 0.0, 0.0, 1.0],
        );
        let mesh = build_mesh(&stroke);
        assert!(!mesh.is_empty());
        let [_, min_y, _, max_y] = mesh.bounds().expect("bounds");
        assert!((max_y - min_y - 10.0).abs() < 1e-6);
    }

    #[test]
    fn split_pipeline_agrees() {
        // build_mesh_from on a processed centerline == build_mesh whole.
        let raw: Vec<StrokePoint> = (0..12)
            .map(|i| StrokePoint::new(i as f64 * 9.0, (i as f64).sin() * 6.0, -1.0, i as f64 * 8.0))
            .collect();
        let opts = StrokeOptions::default();
        let whole = build_mesh(&Stroke::new(raw.clone(), opts, [0.0, 0.0, 0.0, 1.0]));
        let center = crate::smooth::process(&raw, &opts);
        let split = build_mesh_from(Stroke::new(center, opts, [0.0, 0.0, 0.0, 1.0]));
        assert_eq!(whole.vertices.len(), split.vertices.len());
        assert_eq!(whole.indices, split.indices);
    }

    #[test]
    fn deterministic() {
        let a = build_mesh(&line(10));
        let b = build_mesh(&line(10));
        assert_eq!(a.vertices.len(), b.vertices.len());
        assert_eq!(a.indices, b.indices);
    }
}
