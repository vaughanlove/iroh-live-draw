/* @ts-self-types="./pen.d.ts" */
import * as wasm from "./pen_bg.wasm";
import { __wbg_set_wasm } from "./pen_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    PenCanvas, PenStroke, erase_hit, project
} from "./pen_bg.js";
