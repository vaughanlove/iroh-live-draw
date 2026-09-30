/* tslint:disable */
/* eslint-disable */

export class PenCanvas {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    begin_frame(scroll_x: number, scroll_y: number, zoom: number): void;
    clear_cache(): void;
    /**
     * Stage a retained mesh for this frame's single pass. Missing keys are
     * skipped silently (evicted or never uploaded).
     */
    draw_keyed(key: string): void;
    end_frame(): void;
    /**
     * Drop a retained mesh (stale version, cleared board). Buffers release
     * with the entry.
     */
    evict(key: string): void;
    /**
     * Attach to an existing `<canvas>`. Async: adapter/device negotiation.
     * `fallback` forces the software adapter (SwiftShader): slower, but
     * works where the hardware adapter is blocklisted or absent.
     */
    static new(canvas: HTMLCanvasElement): Promise<PenCanvas>;
    static new_with_fallback(canvas: HTMLCanvasElement, fallback: boolean): Promise<PenCanvas>;
    /**
     * Size the surface in device px (call on init + resize). Rebuilds the
     * cached MSAA target alongside.
     */
    resize(w_px: number, h_px: number): void;
    /**
     * Upload once per key (`id:version` from the caller). Re-uploading an
     * existing key is a no-op; evict stale versions with [`Self::evict`].
     * This is the pan-smoothness fix: camera moves must never re-upload.
     */
    retain_mesh(key: string, verts: Float32Array, idx: Uint32Array): void;
    /**
     * "begun dropped drawn last_error" — polled by the debug HUD.
     * Prefixed with surface caps (formats + alpha modes) for diagnosis.
     */
    stats(): string;
}

/**
 * One in-progress stroke. Push samples as the pointer moves; pull the mesh
 * whenever (every frame is fine — the mesh is cached and only rebuilt when
 * new samples arrive, so per-frame cost is a pointer handoff, not O(N)).
 */
export class PenStroke {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Processed centerline as flat [x, y] (smoothed, Rust-side identical
     * to what meshing uses). Sharpie mode strokes this directly: one path,
     * no triangle seams, perfectly mono overlaps.
     */
    centerline(): Float64Array;
    indices(): Uint32Array;
    len(): number;
    constructor(size: number, r: number, g: number, b: number, a: number, monoline: boolean);
    /**
     * pressure < 0 (mouse) synthesizes from velocity downstream.
     */
    push(x: number, y: number, pressure: number, t_ms: number): void;
    /**
     * Scene JSON the sync layer already speaks (points + pressures).
     */
    to_json(): string;
    /**
     * Interleaved [x, y, r, g, b, a] vertices (scene units).
     */
    vertices(): Float32Array;
}

/**
 * Batch eraser hit-test over freedraw elements with ABSOLUTE scene points:
 * `[{"id", "points": [[x,y]..], "width"}]` → JSON array of hit ids.
 * `width` is the Excalidraw strokeWidth; rendered diameter runs ~6× that
 * (measured), which is what the pointer is tested against.
 */
export function erase_hit(elements_json: string, x: number, y: number, radius: number): string;

/**
 * Scene → CSS-pixel projection matching the sheet transform.
 */
export function project(x: number, y: number, scroll_x: number, scroll_y: number, zoom: number): Float64Array;
