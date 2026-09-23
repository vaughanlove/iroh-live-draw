# p2p whiteboard with iroh

*Experimental - there is no authentication. If someone knows your ticket, they can join as a peer. Does not work on Safari.*

Inspired by wanting to integrate my tablet more deeply into my workflows.

A vite webserver with a excalidraw canvas paired with iroh running over wasm. Iroh dials your peer(s) and establishes a bidirectional QUIC connection. 

![demo](./minidemo.gif)

Docs are topics. A topic owns board (the classic endless excalidraw whiteboard), letters (paginated board that has a set size), and dailies (which are a single page). For now, one peer owns the doc and holds the source of truth; everyone else goes view-only when the owner drops.

## Build 
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

## Keeper (always-on watch peer) + custom relay

Two Railway services, one repo:

- `relay/Dockerfile` — stock `n0computer/iroh-relay` plus a tiny entrypoint that renders config from `$PORT`. Railway terminates TLS, so the relay runs plain HTTP behind the proxy.
- `keeper/` — a Rust binary that joins docs as a dumb cache. Browsers POST tickets to `POST /watch` on boot and doc switch, so the keeper rejoins everything automatically. It merges what it sees (same CRDT rules) and answers `snap-req` when the owner is offline. It never answers `pull` and never edits. Newcomers can also fetch snapshots straight from it over QUIC (no gossip mesh needed) when gossip is being difficult.

Point a build at them with env (or `?relay=` / `?keeper=` query overrides, no rebuild needed):

```sh
VITE_RELAY_URL=https://<relay>.up.railway.app
VITE_KEEPER_URL=https://<keeper>.up.railway.app
VITE_KEEPER_TOKEN=...   # optional, must match keeper's KEEPER_TOKEN
```

Local dev defaults live in `web/.env.development` (keeper on :8081, n0 relays). Run the keeper locally with `cargo run -p keeper` (`LISTEN`, `KEEPER_DATA`, `KEEPER_SECRET`, `RELAY_URL`, `MAX_TOPICS` envs).

Env needed on Railway: keeper gets `RELAY_URL` pointing at the relay service; browsers get the two public URLs above. Railway has no UDP ingress so QUIC address discovery is off — relay-routed traffic (everything browsers need) works fine.

## Future work

- Automatic stroke to .typ file
- CRDT support
- Identity management for allowlisting certain peers, or future agent connections
- Experiment with DiffusionGemma or Jev generating AI-assisted strokes
