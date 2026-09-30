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
     * TEMPORARY: what the last retain_mesh call received (first values).
     */
    last_transfer(): string;
    /**
     * Attach to an existing `<canvas>`. Async: adapter/device negotiation.
     * `fallback` forces the software adapter (SwiftShader): slower, but
     * works where the hardware adapter is blocklisted or absent.
     */
    static new(canvas: HTMLCanvasElement): Promise<PenCanvas>;
    static new_with_fallback(canvas: HTMLCanvasElement, fallback: boolean): Promise<PenCanvas>;
    /**
     * TEMPORARY transfer probe: report what Rust actually received for a
     * key (count + first values). Remove with the red triangle.
     */
    probe_mesh(key: string): string;
    /**
     * Size the surface in device px (call on init + resize). Rebuilds the
     * cached MSAA target alongside.
     *
     * Idempotent: a no-op resize returns immediately. Window `resize`
     * events arrive per-pixel during a drag, and each `surface.configure`
     * destroys the swapchain (realloc w*h*4 bytes per swap buffer) plus a
     * 4xMSAA realloc (w*h*16). Doing that per event drops a frame per
     * event; the early-out costs one integer compare instead.
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
     * Suffixed with the last transfer sample.
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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_pencanvas_free: (a: number, b: number) => void;
    readonly __wbg_penstroke_free: (a: number, b: number) => void;
    readonly erase_hit: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly pencanvas_begin_frame: (a: number, b: number, c: number, d: number) => void;
    readonly pencanvas_clear_cache: (a: number) => void;
    readonly pencanvas_draw_keyed: (a: number, b: number, c: number) => void;
    readonly pencanvas_end_frame: (a: number) => void;
    readonly pencanvas_evict: (a: number, b: number, c: number) => void;
    readonly pencanvas_last_transfer: (a: number) => [number, number];
    readonly pencanvas_new: (a: any) => any;
    readonly pencanvas_new_with_fallback: (a: any, b: number) => any;
    readonly pencanvas_probe_mesh: (a: number, b: number, c: number) => [number, number];
    readonly pencanvas_resize: (a: number, b: number, c: number) => void;
    readonly pencanvas_retain_mesh: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly pencanvas_stats: (a: number) => [number, number];
    readonly penstroke_centerline: (a: number) => [number, number];
    readonly penstroke_indices: (a: number) => [number, number];
    readonly penstroke_len: (a: number) => number;
    readonly penstroke_new: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly penstroke_push: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly penstroke_to_json: (a: number) => [number, number];
    readonly penstroke_vertices: (a: number) => [number, number];
    readonly project: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___js_sys_6fff18a125d5dcf7___Function_fn_wasm_bindgen_e91fa3817bc4b7fa___JsValue_____wasm_bindgen_e91fa3817bc4b7fa___sys__Undefined___js_sys_6fff18a125d5dcf7___Function_fn_wasm_bindgen_e91fa3817bc4b7fa___JsValue_____wasm_bindgen_e91fa3817bc4b7fa___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___sys__JsNullable_wgpu_5036807f9837e271___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___sys__JsNullable_wgpu_5036807f9837e271___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true__24: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___sys__JsNullable_wgpu_5036807f9837e271___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true__25: (a: number, b: number, c: any) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
