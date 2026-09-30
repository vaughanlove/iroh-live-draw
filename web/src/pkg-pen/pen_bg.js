export class PenCanvas {
    static __wrap(ptr) {
        const obj = Object.create(PenCanvas.prototype);
        obj.__wbg_ptr = ptr;
        PenCanvasFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PenCanvasFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pencanvas_free(ptr, 0);
    }
    /**
     * @param {number} scroll_x
     * @param {number} scroll_y
     * @param {number} zoom
     */
    begin_frame(scroll_x, scroll_y, zoom) {
        wasm.pencanvas_begin_frame(this.__wbg_ptr, scroll_x, scroll_y, zoom);
    }
    clear_cache() {
        wasm.pencanvas_clear_cache(this.__wbg_ptr);
    }
    /**
     * Stage a retained mesh for this frame's single pass. Missing keys are
     * skipped silently (evicted or never uploaded).
     * @param {string} key
     */
    draw_keyed(key) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.pencanvas_draw_keyed(this.__wbg_ptr, ptr0, len0);
    }
    end_frame() {
        wasm.pencanvas_end_frame(this.__wbg_ptr);
    }
    /**
     * Drop a retained mesh (stale version, cleared board). Buffers release
     * with the entry.
     * @param {string} key
     */
    evict(key) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.pencanvas_evict(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * TEMPORARY: what the last retain_mesh call received (first values).
     * @returns {string}
     */
    last_transfer() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.pencanvas_last_transfer(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Attach to an existing `<canvas>`. Async: adapter/device negotiation.
     * `fallback` forces the software adapter (SwiftShader): slower, but
     * works where the hardware adapter is blocklisted or absent.
     * @param {HTMLCanvasElement} canvas
     * @returns {Promise<PenCanvas>}
     */
    static new(canvas) {
        const ret = wasm.pencanvas_new(canvas);
        return ret;
    }
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {boolean} fallback
     * @returns {Promise<PenCanvas>}
     */
    static new_with_fallback(canvas, fallback) {
        const ret = wasm.pencanvas_new_with_fallback(canvas, fallback);
        return ret;
    }
    /**
     * TEMPORARY transfer probe: report what Rust actually received for a
     * key (count + first values). Remove with the red triangle.
     * @param {string} key
     * @returns {string}
     */
    probe_mesh(key) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.pencanvas_probe_mesh(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Size the surface in device px (call on init + resize). Rebuilds the
     * cached MSAA target alongside.
     *
     * Idempotent: a no-op resize returns immediately. Window `resize`
     * events arrive per-pixel during a drag, and each `surface.configure`
     * destroys the swapchain (realloc w*h*4 bytes per swap buffer) plus a
     * 4xMSAA realloc (w*h*16). Doing that per event drops a frame per
     * event; the early-out costs one integer compare instead.
     * @param {number} w_px
     * @param {number} h_px
     */
    resize(w_px, h_px) {
        wasm.pencanvas_resize(this.__wbg_ptr, w_px, h_px);
    }
    /**
     * Upload once per key (`id:version` from the caller). Re-uploading an
     * existing key is a no-op; evict stale versions with [`Self::evict`].
     * This is the pan-smoothness fix: camera moves must never re-upload.
     * @param {string} key
     * @param {Float32Array} verts
     * @param {Uint32Array} idx
     */
    retain_mesh(key, verts, idx) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(verts, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(idx, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        wasm.pencanvas_retain_mesh(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
    }
    /**
     * "begun dropped drawn last_error" — polled by the debug HUD.
     * Prefixed with surface caps (formats + alpha modes) for diagnosis.
     * Suffixed with the last transfer sample.
     * @returns {string}
     */
    stats() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.pencanvas_stats(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) PenCanvas.prototype[Symbol.dispose] = PenCanvas.prototype.free;

/**
 * One in-progress stroke. Push samples as the pointer moves; pull the mesh
 * whenever (every frame is fine — the mesh is cached and only rebuilt when
 * new samples arrive, so per-frame cost is a pointer handoff, not O(N)).
 */
export class PenStroke {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PenStrokeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_penstroke_free(ptr, 0);
    }
    /**
     * Processed centerline as flat [x, y] (smoothed, Rust-side identical
     * to what meshing uses). Sharpie mode strokes this directly: one path,
     * no triangle seams, perfectly mono overlaps.
     * @returns {Float64Array}
     */
    centerline() {
        const ret = wasm.penstroke_centerline(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    indices() {
        const ret = wasm.penstroke_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {number}
     */
    len() {
        const ret = wasm.penstroke_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} size
     * @param {number} r
     * @param {number} g
     * @param {number} b
     * @param {number} a
     * @param {boolean} monoline
     */
    constructor(size, r, g, b, a, monoline) {
        const ret = wasm.penstroke_new(size, r, g, b, a, monoline);
        this.__wbg_ptr = ret;
        PenStrokeFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * pressure < 0 (mouse) synthesizes from velocity downstream.
     * @param {number} x
     * @param {number} y
     * @param {number} pressure
     * @param {number} t_ms
     */
    push(x, y, pressure, t_ms) {
        wasm.penstroke_push(this.__wbg_ptr, x, y, pressure, t_ms);
    }
    /**
     * Scene JSON the sync layer already speaks (points + pressures).
     * @returns {string}
     */
    to_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.penstroke_to_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Interleaved [x, y, r, g, b, a] vertices (scene units).
     * @returns {Float32Array}
     */
    vertices() {
        const ret = wasm.penstroke_vertices(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) PenStroke.prototype[Symbol.dispose] = PenStroke.prototype.free;

/**
 * Batch eraser hit-test over freedraw elements with ABSOLUTE scene points:
 * `[{"id", "points": [[x,y]..], "width"}]` → JSON array of hit ids.
 * `width` is the Excalidraw strokeWidth; rendered diameter runs ~6× that
 * (measured), which is what the pointer is tested against.
 * @param {string} elements_json
 * @param {number} x
 * @param {number} y
 * @param {number} radius
 * @returns {string}
 */
export function erase_hit(elements_json, x, y, radius) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(elements_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.erase_hit(ptr0, len0, x, y, radius);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Scene → CSS-pixel projection matching the sheet transform.
 * @param {number} x
 * @param {number} y
 * @param {number} scroll_x
 * @param {number} scroll_y
 * @param {number} zoom
 * @returns {Float64Array}
 */
export function project(x, y, scroll_x, scroll_y, zoom) {
    const ret = wasm.project(x, y, scroll_x, scroll_y, zoom);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}
export function __wbg_Window_a2a6c4d665047b14(arg0) {
    const ret = arg0.Window;
    return ret;
}
export function __wbg_WorkerGlobalScope_2664448a7c667d67(arg0) {
    const ret = arg0.WorkerGlobalScope;
    return ret;
}
export function __wbg___wbindgen_debug_string_0e68cf47c9cbd9b0(arg0, arg1) {
    const ret = debugString(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_is_function_fcda5e3902d732fe(arg0) {
    const ret = typeof(arg0) === 'function';
    return ret;
}
export function __wbg___wbindgen_is_null_5160b3e381865372(arg0) {
    const ret = arg0 === null;
    return ret;
}
export function __wbg___wbindgen_is_string_c4f7cb494a2a21f1(arg0) {
    const ret = typeof(arg0) === 'string';
    return ret;
}
export function __wbg___wbindgen_is_undefined_8c687d0b90d5b524(arg0) {
    const ret = arg0 === undefined;
    return ret;
}
export function __wbg___wbindgen_throw_5d9e815e6fdf150f(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
}
export function __wbg__wbg_cb_unref_997e73d32238e655(arg0) {
    arg0._wbg_cb_unref();
}
export function __wbg_beginRenderPass_3c53642423af50dc() { return handleError(function (arg0, arg1) {
    const ret = arg0.beginRenderPass(arg1);
    return ret;
}, arguments); }
export function __wbg_call_6bcf8d3e20937e46() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.call(arg1, arg2);
    return ret;
}, arguments); }
export function __wbg_configure_1e2c1c9edad07d26() { return handleError(function (arg0, arg1) {
    arg0.configure(arg1);
}, arguments); }
export function __wbg_createBindGroupLayout_b1bd63b4e88459d8() { return handleError(function (arg0, arg1) {
    const ret = arg0.createBindGroupLayout(arg1);
    return ret;
}, arguments); }
export function __wbg_createBindGroup_f539b26ca341308f(arg0, arg1) {
    const ret = arg0.createBindGroup(arg1);
    return ret;
}
export function __wbg_createBuffer_d800e9b1d41b2ee5() { return handleError(function (arg0, arg1) {
    const ret = arg0.createBuffer(arg1);
    return ret;
}, arguments); }
export function __wbg_createCommandEncoder_3352d1ffc36c6fc0(arg0, arg1) {
    const ret = arg0.createCommandEncoder(arg1);
    return ret;
}
export function __wbg_createPipelineLayout_6eab52c327118937(arg0, arg1) {
    const ret = arg0.createPipelineLayout(arg1);
    return ret;
}
export function __wbg_createRenderPipeline_0ebb7ebc653e9207() { return handleError(function (arg0, arg1) {
    const ret = arg0.createRenderPipeline(arg1);
    return ret;
}, arguments); }
export function __wbg_createShaderModule_cefa51336cb288ae(arg0, arg1) {
    const ret = arg0.createShaderModule(arg1);
    return ret;
}
export function __wbg_createTexture_ed7e9fc04dd54d84() { return handleError(function (arg0, arg1) {
    const ret = arg0.createTexture(arg1);
    return ret;
}, arguments); }
export function __wbg_createView_da41c2d2cb212715() { return handleError(function (arg0, arg1) {
    const ret = arg0.createView(arg1);
    return ret;
}, arguments); }
export function __wbg_destroy_637537007d9eaa44(arg0) {
    arg0.destroy();
}
export function __wbg_document_c7f486c52d63d24e(arg0) {
    const ret = arg0.document;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_drawIndexed_638959aae942557c(arg0, arg1, arg2, arg3, arg4, arg5) {
    arg0.drawIndexed(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4, arg5 >>> 0);
}
export function __wbg_end_b57473834b877409(arg0) {
    arg0.end();
}
export function __wbg_finish_09ec094c10f41e7b(arg0) {
    const ret = arg0.finish();
    return ret;
}
export function __wbg_finish_ec1c191f66a895b1(arg0, arg1) {
    const ret = arg0.finish(arg1);
    return ret;
}
export function __wbg_getContext_5ff6bd600503b094() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.getContext(getStringFromWasm0(arg1, arg2));
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_getContext_e0c05ffee530bdcf() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.getContext(getStringFromWasm0(arg1, arg2));
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_getCurrentTexture_9f3b84d0eaa6cd95() { return handleError(function (arg0) {
    const ret = arg0.getCurrentTexture();
    return ret;
}, arguments); }
export function __wbg_getMappedRange_fb54c6327b2d8d20() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.getMappedRange(arg1, arg2);
    return ret;
}, arguments); }
export function __wbg_getPreferredCanvasFormat_0ef5034c8902201b(arg0) {
    const ret = arg0.getPreferredCanvasFormat();
    return (__wbindgen_enum_GpuTextureFormat.indexOf(ret) + 1 || 102) - 1;
}
export function __wbg_get_95e4d462165c92ae(arg0, arg1) {
    const ret = arg0[arg1 >>> 0];
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_gpu_afdd4387c7afe5f9(arg0) {
    const ret = arg0.gpu;
    return ret;
}
export function __wbg_instanceof_Window_a3b8566f0a9c5d1a(arg0) {
    let result;
    try {
        result = arg0 instanceof Window;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_label_7add8cb37a6ef98f(arg0, arg1) {
    const ret = arg1.label;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_length_31bdaf014f5fbde2(arg0) {
    const ret = arg0.length;
    return ret;
}
export function __wbg_mapAsync_b0597127f5037286(arg0, arg1, arg2, arg3) {
    const ret = arg0.mapAsync(arg1 >>> 0, arg2, arg3);
    return ret;
}
export function __wbg_navigator_d217ca64c4bbff48(arg0) {
    const ret = arg0.navigator;
    return ret;
}
export function __wbg_navigator_d25c0f071226f233(arg0) {
    const ret = arg0.navigator;
    return ret;
}
export function __wbg_new_12e5d807044fbfe3() { return handleError(function (arg0, arg1) {
    const ret = new OffscreenCanvas(arg0 >>> 0, arg1 >>> 0);
    return ret;
}, arguments); }
export function __wbg_new_bebc3f4757acf305() {
    const ret = new Object();
    return ret;
}
export function __wbg_new_typed_6f8b0d724fe26c07(arg0, arg1) {
    try {
        var state0 = {a: arg0, b: arg1};
        var cb0 = (arg0, arg1) => {
            const a = state0.a;
            state0.a = 0;
            try {
                return wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___js_sys_6fff18a125d5dcf7___Function_fn_wasm_bindgen_e91fa3817bc4b7fa___JsValue_____wasm_bindgen_e91fa3817bc4b7fa___sys__Undefined___js_sys_6fff18a125d5dcf7___Function_fn_wasm_bindgen_e91fa3817bc4b7fa___JsValue_____wasm_bindgen_e91fa3817bc4b7fa___sys__Undefined_______true_(a, state0.b, arg0, arg1);
            } finally {
                state0.a = a;
            }
        };
        const ret = new Promise(cb0);
        return ret;
    } finally {
        state0.a = 0;
    }
}
export function __wbg_new_typed_7d4574ab4b8446c8() {
    const ret = new Object();
    return ret;
}
export function __wbg_new_with_byte_offset_and_length_492c969e8b5da8a4(arg0, arg1, arg2) {
    const ret = new Uint8Array(arg0, arg1 >>> 0, arg2 >>> 0);
    return ret;
}
export function __wbg_onSubmittedWorkDone_1190213cee1ecf7e(arg0) {
    const ret = arg0.onSubmittedWorkDone();
    return ret;
}
export function __wbg_pencanvas_new(arg0) {
    const ret = PenCanvas.__wrap(arg0);
    return ret;
}
export function __wbg_prototypesetcall_ae9f5e7459250748(arg0, arg1, arg2) {
    Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
}
export function __wbg_querySelectorAll_fdbf93e11103921d() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.querySelectorAll(getStringFromWasm0(arg1, arg2));
    return ret;
}, arguments); }
export function __wbg_queueMicrotask_85c90f6987555d65(arg0) {
    const ret = arg0.queueMicrotask;
    return ret;
}
export function __wbg_queueMicrotask_f6a1fa10b81d1fc0(arg0) {
    queueMicrotask(arg0);
}
export function __wbg_queue_7b62c28143d44293(arg0) {
    const ret = arg0.queue;
    return ret;
}
export function __wbg_requestAdapter_a539af006419f2e9(arg0, arg1) {
    const ret = arg0.requestAdapter(arg1);
    return ret;
}
export function __wbg_requestDevice_5cb8a582e55d08cb(arg0, arg1) {
    const ret = arg0.requestDevice(arg1);
    return ret;
}
export function __wbg_resolve_35ec7e0c6af4c82c(arg0) {
    const ret = Promise.resolve(arg0);
    return ret;
}
export function __wbg_setBindGroup_11bdbb60cc8b54b9() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
    arg0.setBindGroup(arg1 >>> 0, arg2, getArrayU32FromWasm0(arg3, arg4), arg5, arg6 >>> 0);
}, arguments); }
export function __wbg_setBindGroup_418c3e0eb6943ce0(arg0, arg1, arg2) {
    arg0.setBindGroup(arg1 >>> 0, arg2);
}
export function __wbg_setIndexBuffer_241097e303986c14(arg0, arg1, arg2, arg3, arg4) {
    arg0.setIndexBuffer(arg1, __wbindgen_enum_GpuIndexFormat[arg2], arg3, arg4);
}
export function __wbg_setPipeline_b6f981027e02cd16(arg0, arg1) {
    arg0.setPipeline(arg1);
}
export function __wbg_setVertexBuffer_6db3b60e99280744(arg0, arg1, arg2, arg3) {
    arg0.setVertexBuffer(arg1 >>> 0, arg2, arg3);
}
export function __wbg_setVertexBuffer_cbf4ca1627c02f4c(arg0, arg1, arg2, arg3, arg4) {
    arg0.setVertexBuffer(arg1 >>> 0, arg2, arg3, arg4);
}
export function __wbg_set_9cfc0f17d60ff0af(arg0, arg1, arg2) {
    arg0.set(arg1, arg2 >>> 0);
}
export function __wbg_set_a377297433dfea63() { return handleError(function (arg0, arg1, arg2) {
    const ret = Reflect.set(arg0, arg1, arg2);
    return ret;
}, arguments); }
export function __wbg_set_a_82818effc94f6256(arg0, arg1) {
    arg0.a = arg1;
}
export function __wbg_set_access_a099cfbbeec9b96f(arg0, arg1) {
    arg0.access = __wbindgen_enum_GpuStorageTextureAccess[arg1];
}
export function __wbg_set_alpha_106f21a936a85eba(arg0, arg1) {
    arg0.alpha = arg1;
}
export function __wbg_set_alpha_mode_5544568dbac50280(arg0, arg1) {
    arg0.alphaMode = __wbindgen_enum_GpuCanvasAlphaMode[arg1];
}
export function __wbg_set_alpha_to_coverage_enabled_3372ce329447b8f1(arg0, arg1) {
    arg0.alphaToCoverageEnabled = arg1 !== 0;
}
export function __wbg_set_array_layer_count_22afa0a979e4ad55(arg0, arg1) {
    arg0.arrayLayerCount = arg1 >>> 0;
}
export function __wbg_set_array_stride_f64_6816040e5e7598c3(arg0, arg1) {
    arg0.arrayStride = arg1;
}
export function __wbg_set_aspect_a48d046965270281(arg0, arg1) {
    arg0.aspect = __wbindgen_enum_GpuTextureAspect[arg1];
}
export function __wbg_set_attributes_9e38cb1dde387a5b(arg0, arg1, arg2) {
    arg0.attributes = getArrayJsValueViewFromWasm0(arg1, arg2);
}
export function __wbg_set_b_a3297ee7e7cac3a8(arg0, arg1) {
    arg0.b = arg1;
}
export function __wbg_set_base_array_layer_2435ba92c80346ae(arg0, arg1) {
    arg0.baseArrayLayer = arg1 >>> 0;
}
export function __wbg_set_base_mip_level_8b6093e875e7c65d(arg0, arg1) {
    arg0.baseMipLevel = arg1 >>> 0;
}
export function __wbg_set_beginning_of_pass_write_index_e552c5e8b8bbf52f(arg0, arg1) {
    arg0.beginningOfPassWriteIndex = arg1 >>> 0;
}
export function __wbg_set_bind_group_layouts_458c44ba55100b82(arg0, arg1, arg2) {
    arg0.bindGroupLayouts = getArrayJsValueViewFromWasm0(arg1, arg2);
}
export function __wbg_set_binding_81b3fac7f7acaf8d(arg0, arg1) {
    arg0.binding = arg1 >>> 0;
}
export function __wbg_set_binding_b6cee57f35ac5190(arg0, arg1) {
    arg0.binding = arg1 >>> 0;
}
export function __wbg_set_blend_1a801617945f7945(arg0, arg1) {
    arg0.blend = arg1;
}
export function __wbg_set_buffer_1548ae88a9188037(arg0, arg1) {
    arg0.buffer = arg1;
}
export function __wbg_set_buffer_8d0ac64ad20dfc84(arg0, arg1) {
    arg0.buffer = arg1;
}
export function __wbg_set_buffers_5d0e0c50791f710e(arg0, arg1, arg2) {
    arg0.buffers = getArrayJsValueViewFromWasm0(arg1, arg2);
}
export function __wbg_set_clear_value_gpu_color_dict_a9f763e8372ac1de(arg0, arg1) {
    arg0.clearValue = arg1;
}
export function __wbg_set_code_5d5b0b9e2fd0dca7(arg0, arg1, arg2) {
    arg0.code = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_color_8ecace4011f47d2e(arg0, arg1) {
    arg0.color = arg1;
}
export function __wbg_set_color_attachments_622fe2d5997fda7a(arg0, arg1, arg2) {
    arg0.colorAttachments = getArrayJsValueViewFromWasm0(arg1, arg2);
}
export function __wbg_set_compare_080c9e492ff36990(arg0, arg1) {
    arg0.compare = __wbindgen_enum_GpuCompareFunction[arg1];
}
export function __wbg_set_count_8ff0c9474e39a849(arg0, arg1) {
    arg0.count = arg1 >>> 0;
}
export function __wbg_set_cull_mode_85d2b4ab0ce3a564(arg0, arg1) {
    arg0.cullMode = __wbindgen_enum_GpuCullMode[arg1];
}
export function __wbg_set_depth_bias_95abf479cae3f3cd(arg0, arg1) {
    arg0.depthBias = arg1;
}
export function __wbg_set_depth_bias_clamp_ba3d0b8348151350(arg0, arg1) {
    arg0.depthBiasClamp = arg1;
}
export function __wbg_set_depth_bias_slope_scale_6b2584d93f5b9cd2(arg0, arg1) {
    arg0.depthBiasSlopeScale = arg1;
}
export function __wbg_set_depth_clear_value_e30a4c754c6b3b26(arg0, arg1) {
    arg0.depthClearValue = arg1;
}
export function __wbg_set_depth_compare_a90de4e3714397ab(arg0, arg1) {
    arg0.depthCompare = __wbindgen_enum_GpuCompareFunction[arg1];
}
export function __wbg_set_depth_fail_op_b5c64541d1b6b482(arg0, arg1) {
    arg0.depthFailOp = __wbindgen_enum_GpuStencilOperation[arg1];
}
export function __wbg_set_depth_load_op_932888016d762d3e(arg0, arg1) {
    arg0.depthLoadOp = __wbindgen_enum_GpuLoadOp[arg1];
}
export function __wbg_set_depth_or_array_layers_e2f074a0284e4806(arg0, arg1) {
    arg0.depthOrArrayLayers = arg1 >>> 0;
}
export function __wbg_set_depth_read_only_be790175a1c2db9a(arg0, arg1) {
    arg0.depthReadOnly = arg1 !== 0;
}
export function __wbg_set_depth_stencil_attachment_54a8922f5fbe08bf(arg0, arg1) {
    arg0.depthStencilAttachment = arg1;
}
export function __wbg_set_depth_stencil_b7cffc59ad4da529(arg0, arg1) {
    arg0.depthStencil = arg1;
}
export function __wbg_set_depth_store_op_9054814f164ab55d(arg0, arg1) {
    arg0.depthStoreOp = __wbindgen_enum_GpuStoreOp[arg1];
}
export function __wbg_set_depth_write_enabled_31a821ee1fb3b0b3(arg0, arg1) {
    arg0.depthWriteEnabled = arg1 !== 0;
}
export function __wbg_set_device_210484a77b675c9c(arg0, arg1) {
    arg0.device = arg1;
}
export function __wbg_set_dimension_3da9d03131a9f446(arg0, arg1) {
    arg0.dimension = __wbindgen_enum_GpuTextureDimension[arg1];
}
export function __wbg_set_dimension_56332450afa3e0c0(arg0, arg1) {
    arg0.dimension = __wbindgen_enum_GpuTextureViewDimension[arg1];
}
export function __wbg_set_dst_factor_865ba9aaf187890c(arg0, arg1) {
    arg0.dstFactor = __wbindgen_enum_GpuBlendFactor[arg1];
}
export function __wbg_set_end_of_pass_write_index_8f164f9e60d4ad16(arg0, arg1) {
    arg0.endOfPassWriteIndex = arg1 >>> 0;
}
export function __wbg_set_entries_6f866302103b81e9(arg0, arg1, arg2) {
    arg0.entries = getArrayJsValueViewFromWasm0(arg1, arg2);
}
export function __wbg_set_entries_f26b77ab9548e906(arg0, arg1, arg2) {
    arg0.entries = getArrayJsValueViewFromWasm0(arg1, arg2);
}
export function __wbg_set_entry_point_71cef95c137b5774(arg0, arg1, arg2) {
    arg0.entryPoint = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_entry_point_b70f98f5025a114d(arg0, arg1, arg2) {
    arg0.entryPoint = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_external_texture_7f966c604c4f8098(arg0, arg1) {
    arg0.externalTexture = arg1;
}
export function __wbg_set_fail_op_d59d0187e4111dfe(arg0, arg1) {
    arg0.failOp = __wbindgen_enum_GpuStencilOperation[arg1];
}
export function __wbg_set_format_23f7f32549751d43(arg0, arg1) {
    arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
}
export function __wbg_set_format_283dca56552f07a3(arg0, arg1) {
    arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
}
export function __wbg_set_format_5080a858117ad2c1(arg0, arg1) {
    arg0.format = __wbindgen_enum_GpuVertexFormat[arg1];
}
export function __wbg_set_format_66735b94bd868ba2(arg0, arg1) {
    arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
}
export function __wbg_set_format_7f2bdbfb101b1ae1(arg0, arg1) {
    arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
}
export function __wbg_set_format_92732ea75d3b79f5(arg0, arg1) {
    arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
}
export function __wbg_set_format_f009e603f7d4c28e(arg0, arg1) {
    arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
}
export function __wbg_set_fragment_d2b0ec97d7cf8d47(arg0, arg1) {
    arg0.fragment = arg1;
}
export function __wbg_set_front_face_d3f8a2e07e7b25dd(arg0, arg1) {
    arg0.frontFace = __wbindgen_enum_GpuFrontFace[arg1];
}
export function __wbg_set_g_b527ee8a9bed553d(arg0, arg1) {
    arg0.g = arg1;
}
export function __wbg_set_has_dynamic_offset_0c72ffa900c5a269(arg0, arg1) {
    arg0.hasDynamicOffset = arg1 !== 0;
}
export function __wbg_set_height_1202ad0eab43cbe0(arg0, arg1) {
    arg0.height = arg1 >>> 0;
}
export function __wbg_set_height_698fb3b255bc1348(arg0, arg1) {
    arg0.height = arg1 >>> 0;
}
export function __wbg_set_height_f6619158e5735877(arg0, arg1) {
    arg0.height = arg1 >>> 0;
}
export function __wbg_set_label_17202740051e9722(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_2fefb39c0e0dbbe8(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_3f2ccaafef5ff7c9(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_612add98a4398f92(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_70a09ee68d6b1b26(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_92cd3811e96b487c(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_9c2a186152427ee0(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_c3eaf136aa464cba(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_c7987704d29f284b(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_cfe64bca8945ee30(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_e02179cf97e95763(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_ee172cd5f6a96961(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_layout_454e3a091b390cd4(arg0, arg1) {
    arg0.layout = arg1;
}
export function __wbg_set_layout_75dc1ca3f2421cff(arg0, arg1) {
    arg0.layout = arg1;
}
export function __wbg_set_layout_gpu_auto_layout_mode_06a2b95af1043098(arg0, arg1) {
    arg0.layout = __wbindgen_enum_GpuAutoLayoutMode[arg1];
}
export function __wbg_set_load_op_c56b1269acc2d51f(arg0, arg1) {
    arg0.loadOp = __wbindgen_enum_GpuLoadOp[arg1];
}
export function __wbg_set_mapped_at_creation_3f320fef6761b02c(arg0, arg1) {
    arg0.mappedAtCreation = arg1 !== 0;
}
export function __wbg_set_mask_c1079e551ec360dc(arg0, arg1) {
    arg0.mask = arg1 >>> 0;
}
export function __wbg_set_min_binding_size_f64_897e3cd4496ddec9(arg0, arg1) {
    arg0.minBindingSize = arg1;
}
export function __wbg_set_mip_level_count_047936c630acee7b(arg0, arg1) {
    arg0.mipLevelCount = arg1 >>> 0;
}
export function __wbg_set_mip_level_count_44bc46a1ae6f6daa(arg0, arg1) {
    arg0.mipLevelCount = arg1 >>> 0;
}
export function __wbg_set_mode_7edfbc344ef9c650(arg0, arg1) {
    arg0.mode = __wbindgen_enum_GpuCanvasToneMappingMode[arg1];
}
export function __wbg_set_module_392eeaa269f203b0(arg0, arg1) {
    arg0.module = arg1;
}
export function __wbg_set_module_715d37652c4998ec(arg0, arg1) {
    arg0.module = arg1;
}
export function __wbg_set_multisample_ff72a7a5456cbeb7(arg0, arg1) {
    arg0.multisample = arg1;
}
export function __wbg_set_multisampled_039f032dc4b67367(arg0, arg1) {
    arg0.multisampled = arg1 !== 0;
}
export function __wbg_set_offset_f64_127e8a0aa5c5485a(arg0, arg1) {
    arg0.offset = arg1;
}
export function __wbg_set_offset_f64_457756429ede426d(arg0, arg1) {
    arg0.offset = arg1;
}
export function __wbg_set_operation_00a77386523b88f9(arg0, arg1) {
    arg0.operation = __wbindgen_enum_GpuBlendOperation[arg1];
}
export function __wbg_set_pass_op_3cf10feb3d76ab97(arg0, arg1) {
    arg0.passOp = __wbindgen_enum_GpuStencilOperation[arg1];
}
export function __wbg_set_power_preference_b42d00a8facfbade(arg0, arg1) {
    arg0.powerPreference = __wbindgen_enum_GpuPowerPreference[arg1];
}
export function __wbg_set_primitive_e796cf76f0ff89f3(arg0, arg1) {
    arg0.primitive = arg1;
}
export function __wbg_set_query_set_f030702f1b69199f(arg0, arg1) {
    arg0.querySet = arg1;
}
export function __wbg_set_r_6ece4d74af63364f(arg0, arg1) {
    arg0.r = arg1;
}
export function __wbg_set_required_features_bbab71414c45e621(arg0, arg1, arg2) {
    arg0.requiredFeatures = getArrayJsValueViewFromWasm0(arg1, arg2);
}
export function __wbg_set_required_limits_837f62d865e7cfac(arg0, arg1) {
    arg0.requiredLimits = arg1;
}
export function __wbg_set_resolve_target_gpu_texture_view_e4c1e3bbb8c27d87(arg0, arg1) {
    arg0.resolveTarget = arg1;
}
export function __wbg_set_resource_8fd8658b30d86ecf(arg0, arg1) {
    arg0.resource = arg1;
}
export function __wbg_set_resource_gpu_buffer_binding_33099b25da65b610(arg0, arg1) {
    arg0.resource = arg1;
}
export function __wbg_set_resource_gpu_texture_view_4cffe7bc7c8e5cbe(arg0, arg1) {
    arg0.resource = arg1;
}
export function __wbg_set_sample_count_481c255a12054e1d(arg0, arg1) {
    arg0.sampleCount = arg1 >>> 0;
}
export function __wbg_set_sample_type_ebc5fcd029513bda(arg0, arg1) {
    arg0.sampleType = __wbindgen_enum_GpuTextureSampleType[arg1];
}
export function __wbg_set_sampler_89cb4a7efcfc6005(arg0, arg1) {
    arg0.sampler = arg1;
}
export function __wbg_set_shader_location_3fb9f6a012eba494(arg0, arg1) {
    arg0.shaderLocation = arg1 >>> 0;
}
export function __wbg_set_size_f64_2f591b0654540477(arg0, arg1) {
    arg0.size = arg1;
}
export function __wbg_set_size_f64_e844c985b8f95261(arg0, arg1) {
    arg0.size = arg1;
}
export function __wbg_set_size_gpu_extent_3d_dict_adf57388ab1d4f18(arg0, arg1) {
    arg0.size = arg1;
}
export function __wbg_set_src_factor_6f2c9ec8e4d3d979(arg0, arg1) {
    arg0.srcFactor = __wbindgen_enum_GpuBlendFactor[arg1];
}
export function __wbg_set_stencil_back_c54d0443b8b6a957(arg0, arg1) {
    arg0.stencilBack = arg1;
}
export function __wbg_set_stencil_clear_value_a321b0e045bfd8c2(arg0, arg1) {
    arg0.stencilClearValue = arg1 >>> 0;
}
export function __wbg_set_stencil_front_3ff3f8385852efff(arg0, arg1) {
    arg0.stencilFront = arg1;
}
export function __wbg_set_stencil_load_op_37d20deccb26a0f1(arg0, arg1) {
    arg0.stencilLoadOp = __wbindgen_enum_GpuLoadOp[arg1];
}
export function __wbg_set_stencil_read_mask_021ef4271b24352c(arg0, arg1) {
    arg0.stencilReadMask = arg1 >>> 0;
}
export function __wbg_set_stencil_read_only_75fe66a2356d6e92(arg0, arg1) {
    arg0.stencilReadOnly = arg1 !== 0;
}
export function __wbg_set_stencil_store_op_501f91638dd386e6(arg0, arg1) {
    arg0.stencilStoreOp = __wbindgen_enum_GpuStoreOp[arg1];
}
export function __wbg_set_stencil_write_mask_ec1c12237e094bdd(arg0, arg1) {
    arg0.stencilWriteMask = arg1 >>> 0;
}
export function __wbg_set_step_mode_3cbbdeba1e5dfd62(arg0, arg1) {
    arg0.stepMode = __wbindgen_enum_GpuVertexStepMode[arg1];
}
export function __wbg_set_storage_texture_786aea7c5773b6c1(arg0, arg1) {
    arg0.storageTexture = arg1;
}
export function __wbg_set_store_op_678f33376d741711(arg0, arg1) {
    arg0.storeOp = __wbindgen_enum_GpuStoreOp[arg1];
}
export function __wbg_set_strip_index_format_70313df755145d5e(arg0, arg1) {
    arg0.stripIndexFormat = __wbindgen_enum_GpuIndexFormat[arg1];
}
export function __wbg_set_targets_674b33931e512fb1(arg0, arg1, arg2) {
    arg0.targets = getArrayJsValueViewFromWasm0(arg1, arg2);
}
export function __wbg_set_texture_a33be3fe02ac6264(arg0, arg1) {
    arg0.texture = arg1;
}
export function __wbg_set_timestamp_writes_de6a09f299b71b76(arg0, arg1) {
    arg0.timestampWrites = arg1;
}
export function __wbg_set_tone_mapping_320c1aad31db2e7f(arg0, arg1) {
    arg0.toneMapping = arg1;
}
export function __wbg_set_topology_b92cfe523bd9653b(arg0, arg1) {
    arg0.topology = __wbindgen_enum_GpuPrimitiveTopology[arg1];
}
export function __wbg_set_type_43e0092f16775979(arg0, arg1) {
    arg0.type = __wbindgen_enum_GpuSamplerBindingType[arg1];
}
export function __wbg_set_type_79cec55caf4cdb6d(arg0, arg1) {
    arg0.type = __wbindgen_enum_GpuBufferBindingType[arg1];
}
export function __wbg_set_unclipped_depth_32b7caf29fa5633d(arg0, arg1) {
    arg0.unclippedDepth = arg1 !== 0;
}
export function __wbg_set_usage_1ee33d98267e787d(arg0, arg1) {
    arg0.usage = arg1 >>> 0;
}
export function __wbg_set_usage_2365e2704b1fdb10(arg0, arg1) {
    arg0.usage = arg1 >>> 0;
}
export function __wbg_set_usage_d53ee6f0c7aedbfa(arg0, arg1) {
    arg0.usage = arg1 >>> 0;
}
export function __wbg_set_usage_f3e34822998d2147(arg0, arg1) {
    arg0.usage = arg1 >>> 0;
}
export function __wbg_set_vertex_77ed7a1229239b5a(arg0, arg1) {
    arg0.vertex = arg1;
}
export function __wbg_set_view_dimension_893e2d16561e56e8(arg0, arg1) {
    arg0.viewDimension = __wbindgen_enum_GpuTextureViewDimension[arg1];
}
export function __wbg_set_view_dimension_f2c5fe4bf927c3fe(arg0, arg1) {
    arg0.viewDimension = __wbindgen_enum_GpuTextureViewDimension[arg1];
}
export function __wbg_set_view_formats_427069064d8b7139(arg0, arg1, arg2) {
    arg0.viewFormats = getArrayJsValueViewFromWasm0(arg1, arg2);
}
export function __wbg_set_view_formats_9c2f01a6f3b365c7(arg0, arg1, arg2) {
    arg0.viewFormats = getArrayJsValueViewFromWasm0(arg1, arg2);
}
export function __wbg_set_view_gpu_texture_view_35f4655788535c4d(arg0, arg1) {
    arg0.view = arg1;
}
export function __wbg_set_view_gpu_texture_view_a532c825c52042c0(arg0, arg1) {
    arg0.view = arg1;
}
export function __wbg_set_visibility_d8a6821789538c25(arg0, arg1) {
    arg0.visibility = arg1 >>> 0;
}
export function __wbg_set_width_4c3a2252e0dea033(arg0, arg1) {
    arg0.width = arg1 >>> 0;
}
export function __wbg_set_width_b20525f5f4df4eb8(arg0, arg1) {
    arg0.width = arg1 >>> 0;
}
export function __wbg_set_width_f52a20e39808b138(arg0, arg1) {
    arg0.width = arg1 >>> 0;
}
export function __wbg_set_write_mask_42d89f182ade6b2d(arg0, arg1) {
    arg0.writeMask = arg1 >>> 0;
}
export function __wbg_static_accessor_GLOBAL_8eb4cd83130a11a0() {
    const ret = typeof global === 'undefined' ? null : global;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_GLOBAL_THIS_1e7044f654e934db() {
    const ret = typeof globalThis === 'undefined' ? null : globalThis;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_SELF_d8b50611246a6d92() {
    const ret = typeof self === 'undefined' ? null : self;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_WINDOW_fd0bc376bf0f8b42() {
    const ret = typeof window === 'undefined' ? null : window;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_submit_077c85cc28e36892(arg0, arg1, arg2) {
    arg0.submit(getArrayJsValueViewFromWasm0(arg1, arg2));
}
export function __wbg_then_7a850dae4493f353(arg0, arg1, arg2) {
    const ret = arg0.then(arg1, arg2);
    return ret;
}
export function __wbg_then_b830475380919203(arg0, arg1) {
    const ret = arg0.then(arg1);
    return ret;
}
export function __wbg_unconfigure_835307f58dc68d80(arg0) {
    arg0.unconfigure();
}
export function __wbg_unmap_6a96b14c9ef5f7f5(arg0) {
    arg0.unmap();
}
export function __wbg_writeBuffer_f4bb3f54adfe1330() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
    arg0.writeBuffer(arg1, arg2, getArrayU8FromWasm0(arg3, arg4), arg5, arg6);
}, arguments); }
export function __wbindgen_generic_0000000000000001(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 163, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true_);
    return ret;
}
export function __wbindgen_generic_0000000000000002(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("GPUDevice")], shim_idx: 112, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___sys__JsNullable_wgpu_5036807f9837e271___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true_);
    return ret;
}
export function __wbindgen_generic_0000000000000003(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("any")], shim_idx: 112, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___sys__JsNullable_wgpu_5036807f9837e271___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true__24);
    return ret;
}
export function __wbindgen_generic_0000000000000004(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("undefined")], shim_idx: 112, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___sys__JsNullable_wgpu_5036807f9837e271___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true__25);
    return ret;
}
export function __wbindgen_generic_0000000000000005(arg0) {
    // Cast intrinsic for `F64 -> Externref`.
    const ret = arg0;
    return ret;
}
export function __wbindgen_generic_0000000000000006(arg0, arg1) {
    // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
    const ret = getArrayU8FromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_generic_0000000000000007(arg0, arg1) {
    // Cast intrinsic for `Ref(String) -> Externref`.
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
}
function wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true_(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true_(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___sys__JsNullable_wgpu_5036807f9837e271___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true_(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___sys__JsNullable_wgpu_5036807f9837e271___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true_(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___sys__JsNullable_wgpu_5036807f9837e271___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true__24(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___sys__JsNullable_wgpu_5036807f9837e271___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true__24(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___sys__JsNullable_wgpu_5036807f9837e271___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true__25(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___wasm_bindgen_e91fa3817bc4b7fa___sys__JsNullable_wgpu_5036807f9837e271___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_e91fa3817bc4b7fa___JsError___true__25(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___js_sys_6fff18a125d5dcf7___Function_fn_wasm_bindgen_e91fa3817bc4b7fa___JsValue_____wasm_bindgen_e91fa3817bc4b7fa___sys__Undefined___js_sys_6fff18a125d5dcf7___Function_fn_wasm_bindgen_e91fa3817bc4b7fa___JsValue_____wasm_bindgen_e91fa3817bc4b7fa___sys__Undefined_______true_(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen_e91fa3817bc4b7fa___convert__closures_____invoke___js_sys_6fff18a125d5dcf7___Function_fn_wasm_bindgen_e91fa3817bc4b7fa___JsValue_____wasm_bindgen_e91fa3817bc4b7fa___sys__Undefined___js_sys_6fff18a125d5dcf7___Function_fn_wasm_bindgen_e91fa3817bc4b7fa___JsValue_____wasm_bindgen_e91fa3817bc4b7fa___sys__Undefined_______true_(arg0, arg1, arg2, arg3);
}


const __wbindgen_enum_GpuAutoLayoutMode = ["auto"];


const __wbindgen_enum_GpuBlendFactor = ["zero", "one", "src", "one-minus-src", "src-alpha", "one-minus-src-alpha", "dst", "one-minus-dst", "dst-alpha", "one-minus-dst-alpha", "src-alpha-saturated", "constant", "one-minus-constant", "src1", "one-minus-src1", "src1-alpha", "one-minus-src1-alpha"];


const __wbindgen_enum_GpuBlendOperation = ["add", "subtract", "reverse-subtract", "min", "max"];


const __wbindgen_enum_GpuBufferBindingType = ["uniform", "storage", "read-only-storage"];


const __wbindgen_enum_GpuCanvasAlphaMode = ["opaque", "premultiplied"];


const __wbindgen_enum_GpuCanvasToneMappingMode = ["standard", "extended"];


const __wbindgen_enum_GpuCompareFunction = ["never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"];


const __wbindgen_enum_GpuCullMode = ["none", "front", "back"];


const __wbindgen_enum_GpuFrontFace = ["ccw", "cw"];


const __wbindgen_enum_GpuIndexFormat = ["uint16", "uint32"];


const __wbindgen_enum_GpuLoadOp = ["load", "clear"];


const __wbindgen_enum_GpuPowerPreference = ["low-power", "high-performance"];


const __wbindgen_enum_GpuPrimitiveTopology = ["point-list", "line-list", "line-strip", "triangle-list", "triangle-strip"];


const __wbindgen_enum_GpuSamplerBindingType = ["filtering", "non-filtering", "comparison"];


const __wbindgen_enum_GpuStencilOperation = ["keep", "zero", "replace", "invert", "increment-clamp", "decrement-clamp", "increment-wrap", "decrement-wrap"];


const __wbindgen_enum_GpuStorageTextureAccess = ["write-only", "read-only", "read-write"];


const __wbindgen_enum_GpuStoreOp = ["store", "discard"];


const __wbindgen_enum_GpuTextureAspect = ["all", "stencil-only", "depth-only"];


const __wbindgen_enum_GpuTextureDimension = ["1d", "2d", "3d"];


const __wbindgen_enum_GpuTextureFormat = ["r8unorm", "r8snorm", "r8uint", "r8sint", "r16unorm", "r16snorm", "r16uint", "r16sint", "r16float", "rg8unorm", "rg8snorm", "rg8uint", "rg8sint", "r32uint", "r32sint", "r32float", "rg16unorm", "rg16snorm", "rg16uint", "rg16sint", "rg16float", "rgba8unorm", "rgba8unorm-srgb", "rgba8snorm", "rgba8uint", "rgba8sint", "bgra8unorm", "bgra8unorm-srgb", "rgb9e5ufloat", "rgb10a2uint", "rgb10a2unorm", "rg11b10ufloat", "rg32uint", "rg32sint", "rg32float", "rgba16unorm", "rgba16snorm", "rgba16uint", "rgba16sint", "rgba16float", "rgba32uint", "rgba32sint", "rgba32float", "stencil8", "depth16unorm", "depth24plus", "depth24plus-stencil8", "depth32float", "depth32float-stencil8", "bc1-rgba-unorm", "bc1-rgba-unorm-srgb", "bc2-rgba-unorm", "bc2-rgba-unorm-srgb", "bc3-rgba-unorm", "bc3-rgba-unorm-srgb", "bc4-r-unorm", "bc4-r-snorm", "bc5-rg-unorm", "bc5-rg-snorm", "bc6h-rgb-ufloat", "bc6h-rgb-float", "bc7-rgba-unorm", "bc7-rgba-unorm-srgb", "etc2-rgb8unorm", "etc2-rgb8unorm-srgb", "etc2-rgb8a1unorm", "etc2-rgb8a1unorm-srgb", "etc2-rgba8unorm", "etc2-rgba8unorm-srgb", "eac-r11unorm", "eac-r11snorm", "eac-rg11unorm", "eac-rg11snorm", "astc-4x4-unorm", "astc-4x4-unorm-srgb", "astc-5x4-unorm", "astc-5x4-unorm-srgb", "astc-5x5-unorm", "astc-5x5-unorm-srgb", "astc-6x5-unorm", "astc-6x5-unorm-srgb", "astc-6x6-unorm", "astc-6x6-unorm-srgb", "astc-8x5-unorm", "astc-8x5-unorm-srgb", "astc-8x6-unorm", "astc-8x6-unorm-srgb", "astc-8x8-unorm", "astc-8x8-unorm-srgb", "astc-10x5-unorm", "astc-10x5-unorm-srgb", "astc-10x6-unorm", "astc-10x6-unorm-srgb", "astc-10x8-unorm", "astc-10x8-unorm-srgb", "astc-10x10-unorm", "astc-10x10-unorm-srgb", "astc-12x10-unorm", "astc-12x10-unorm-srgb", "astc-12x12-unorm", "astc-12x12-unorm-srgb"];


const __wbindgen_enum_GpuTextureSampleType = ["float", "unfilterable-float", "depth", "sint", "uint"];


const __wbindgen_enum_GpuTextureViewDimension = ["1d", "2d", "2d-array", "cube", "cube-array", "3d"];


const __wbindgen_enum_GpuVertexFormat = ["uint8", "uint8x2", "uint8x4", "sint8", "sint8x2", "sint8x4", "unorm8", "unorm8x2", "unorm8x4", "snorm8", "snorm8x2", "snorm8x4", "uint16", "uint16x2", "uint16x4", "sint16", "sint16x2", "sint16x4", "unorm16", "unorm16x2", "unorm16x4", "snorm16", "snorm16x2", "snorm16x4", "float16", "float16x2", "float16x4", "float32", "float32x2", "float32x3", "float32x4", "uint32", "uint32x2", "uint32x3", "uint32x4", "sint32", "sint32x2", "sint32x3", "sint32x4", "unorm10-10-10-2", "unorm8x4-bgra"];


const __wbindgen_enum_GpuVertexStepMode = ["vertex", "instance"];
const PenCanvasFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pencanvas_free(ptr, 1));
const PenStrokeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_penstroke_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayJsValueViewFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    return result;
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
