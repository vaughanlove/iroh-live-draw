# Zoom-level cache (future)

Status: noted, not built. Current path stays simple full-repaints.

## Idea

Panning + discrete zoom levels only: **0.5x, 1x, 2x, 4x**, where the
number is the scale of the underlying grid squares (higher = more zoomed
in). One cached background layer per level (4 pixmaps). Pan = compositor
blit of the current level's layer (free). Zoom = swap to the nearest
cached layer (repaint that layer in background if stale). Edits repaint
the affected layer(s).

No true-size calibration: the multipliers are grid-relative, not
physical. Deliberately so — one less setup ritual, and grid squares are
already the unit everything is drawn against.

This is the xournal++ bargain, accepted deliberately:

- Pan stays instant on weak CPUs (Android tablet, no WebGPU → CPU 2D).
- Zoom *steps* instead of gliding: a step change may hitch once while its
  layer rasterizes, then pans free again. No continuous-pinch zoom.
- Memory cost is 4 full-screen layers. Evict farthest-from-current first
  under pressure.

## Non-goals (opinionated)

- **No select tool.** The diagrammer will not have selection: pen draws,
  eraser deletes (hit-test), pan moves. Nothing to highlight, drag, or
  transform — which is also what keeps every stroke eligible for the
  cached background (xournal's selection-move lag comes from vector
  re-render of selected elements; we sidestep it entirely).
- No fractional zoom levels, no animated zoom transitions. Steps are the
  price of the cache; continuous zoom is the native/GPU app's job.

## Why not now

Rapid iteration phase: the simple repaint path is always correct and the
zoom-step UX deserves its own design pass (step indicator UI, pinch
quantization, layer rebuild scheduling). Revisit when tablet panning
becomes the bottleneck again.
