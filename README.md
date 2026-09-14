# iroh-live-draw (WASM edition)

Both devices run the **same Vite page**. Sync core is Rust → WASM (`crates/sync-core`, `wasm-bindgen`):
browser iroh endpoints gossip tldraw snapshots over QUIC streams via relay
(browsers can't do UDP hole-punching; traffic stays E2E encrypted).

No cargo on the iPad. Only the MacBook builds + serves.

## Build (MacBook, once)
```sh
cargo install wasm-pack
wasm-pack build crates/sync-core --target web --out-dir ../../web/src/pkg
cd web && npm i && npm run build
```

## Run (MacBook)
```sh
export SPARK_API_KEY=...            # never ships to the iPad
# optional: SPARK_BASE_URL, SPARK_MODEL
cargo run --  # serves web/dist + /api/* (LISTEN=0.0.0.0:8080, WEB_DIR=web/dist)
# open http://<macbook-lan-ip>:8080 on the iPad AND on the MacBook
```
Dev alternative: `npm run preview` in web/ (static only, no /api/*).

## AI sidecar (all compute on MacBook)
- `POST /api/transcribe` `{prompt, system?}` → Muse Spark chat completion JSON
- `POST /api/diagram` same shape (client in `web/src/ai.ts` pre-prompts for typst)
- `POST /api/typst` `{source}` → PDF bytes (`brew install typst`)
- Client: `web/src/ai.ts` — `transcribe`, `diagramToTypst`, `typstToPdf`. No keys in browser.

## Connect
Each page shows `my id`. Paste the other device's id → **Connect**. Draw — snapshots sync realtime (debounced full-snapshot gossip, last-writer-wins).

## Agent handoff
**Copy JSON (agents)** / **Copy SVG** buttons in the canvas corner.
