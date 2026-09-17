/* @ts-self-types="./draw_browser_wasm.d.ts" */
import * as wasm from "./draw_browser_wasm_bg.wasm";
import { __wbg_set_wasm } from "./draw_browser_wasm_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    Channel, ChannelSender, DrawNode, IntoUnderlyingByteSource, IntoUnderlyingSink, IntoUnderlyingSource, start
} from "./draw_browser_wasm_bg.js";
