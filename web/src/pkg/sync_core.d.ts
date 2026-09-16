/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

export class Sync {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Full dial string: "<node-id> <home-relay-url>". Waits for home relay.
     */
    addr(): Promise<string>;
    /**
     * Create endpoint (connects to default relay). Pass a previously stored
     * secret key string for a stable device identity, or None to generate one.
     * Read it back via [`Sync::secret_key`] and store (e.g. localStorage).
     */
    static create(existing: string | null | undefined, on_remote: Function): Promise<Sync>;
    /**
     * Dial peer by addr string from [`Sync::addr`], then send current snapshot.
     */
    join(peer: string, snapshot: string): Promise<void>;
    node_id(): string;
    /**
     * Enqueue a message for every connected peer (never blocks).
     * Dead peers are pruned; per-peer pumps preserve send order.
     */
    push(snapshot: string): void;
    /**
     * Join a gossip room: seeds relay hints from `addrs` (JS array of
     * "<node-id> <relay-url>"), subscribes to the topic, and pumps received
     * messages into the JS callback. Live patches/cursors go over the room;
     * full snapshots stay on direct dials (see [`Sync::join`]).
     */
    room_join(topic_hex: string, addrs: any): Promise<void>;
    /**
     * Broadcast a message to the room (no-op if not joined).
     */
    room_push(s: string): void;
    /**
     * Push local snapshot to every connected peer (fire-and-forget).
     * Dead streams are pruned.
     * Fresh random room topic as hex (for share links).
     */
    static room_topic(): string;
    /**
     * Secret key string — persist it; passing it back to `create` restores
     * this device's identity (same node id / addr across reloads).
     */
    secret_key(): string;
    /**
     * Sign a message with this device's identity key (hex Ed25519 signature).
     * Used for presence: the worker verifies it against our node id, so no
     * password is ever needed or stored.
     */
    sign_presence(msg: string): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly __wbg_sync_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: any) => any;
    readonly intounderlyingbytesource_start: (a: number, b: any) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: any) => any;
    readonly intounderlyingsink_close: (a: number) => any;
    readonly intounderlyingsink_write: (a: number, b: any) => any;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: any) => any;
    readonly sync_addr: (a: number) => any;
    readonly sync_create: (a: number, b: number, c: any) => any;
    readonly sync_join: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly sync_node_id: (a: number) => [number, number];
    readonly sync_push: (a: number, b: number, c: number) => void;
    readonly sync_room_join: (a: number, b: number, c: number, d: any) => any;
    readonly sync_room_push: (a: number, b: number, c: number) => void;
    readonly sync_room_topic: () => [number, number, number, number];
    readonly sync_secret_key: (a: number) => [number, number];
    readonly sync_sign_presence: (a: number, b: number, c: number) => [number, number];
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h1be5897824ed5003: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h7c8754fb4fccc717: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h9288e816a40a14d3: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h9ca60cb6418926d7: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h9ca60cb6418926d7_24: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h9ca60cb6418926d7_25: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h9ca60cb6418926d7_26: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h5ab1ec89429495ee: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hc3b0e800b5c166fa: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hfff20b4885a17646: (a: number, b: number) => void;
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
