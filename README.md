# p2p whiteboard with iroh

*Experimental - there is no authentication. If someone knows your ticket, they can join as a peer.*

Inspired by wanting to integrate my tablet more deeply into my workflows.

A vite webserver with a excalidraw canvas paired with iroh running over wasm. 

<video src="./tinydemo.mov" width="600" controls></video>

Docs are topics. A topic owns board (the classic endless excalidraw whiteboard), letters (paginated board that has a set size), and dailies (which are a single page). For now, one peer owns the doc and holds the source of truth; everyone else goes view-only when the owner drops.

## Build (MacBook, from clone)

1. Have the wasm32-unknown-unknown target installed: `rustup target add wasm32-unknown-unknown`. I'm running an intel macbook, so Apple clang can't build ring for wasm - (in my case) use zig instead:
```sh
cargo install cargo-zigbuild wasm-bindgen-cli
export PATH="$HOME/.local/zig/zig-x86_64-macos-0.16.0:$PATH"
```
Do not use wasm-pack or plain cargo build here, and do not set CC_wasm32_unknown_unknown. Both fail.

2. Build the bindings:
```sh
cargo zigbuild --release --target wasm32-unknown-unknown -p draw-browser-wasm
wasm-bindgen target/wasm32-unknown-unknown/release/draw_browser_wasm.wasm \
  --out-dir web/src/pkg --target bundler
```

3. Build the frontend:
```sh
cd web && npm i && npm run build
```

## Run
```sh
cargo run --  # serves web/dist (LISTEN=0.0.0.0:8080, WEB_DIR=web/dist)
# For local testing, open http://<device-lan-ip>:8080. Note that iroh will not let you tunnel between two localhost instances of this application. 
```
Dev alternative: `npm run dev` in web/. That turns on the debug drawer, save indicator, and clear-cache button (also available on any build with `?debug=1`).

## Connect
Hit **⧉ share** to copy a link for the current doc. Open it on the other device and you're in the same topic. Draw - changes sync realtime (batched deltas over gossip, last-writer-wins). Paste an image and the binary follows the elements.

State lives in the browser (localStorage per doc page). Refresh restores it. Clear-cache wipes it.

## Agent handoff
**agent JSON** / **SVG** buttons in the panel. Paste either into any agent. Future work: enable a agent to join as a peer.
