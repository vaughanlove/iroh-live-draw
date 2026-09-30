# live draw · engineering pad

A peer-to-peer whiteboard styled as a TOPS engineering pad: pale-green graph
paper, monospace title blocks, fixed-width boards that scroll infinitely
downward with ruled sheet breaks. Peers draw together over iroh; an
always-on keeper holds snapshots so newcomers converge while the owner is
offline.

*Experimental — no encryption yet. A share ticket is a bearer credential:
anyone holding it can join as a peer. See Security.*

## Concepts

- **Project** — the highest unit. Sharing links a peer to a project
  (capabilities are basic on purpose; formalize later).
- **Board** — a fixed-width (816-unit letter) sheet inside a project that
  runs infinitely downward. Boards start at the top; the header reads
  `PG x OF n · SHEET-PG k · date`.
- **Highlight** — a dated selection of board elements; the future project
  map assembles highlights. (Replaces the old daily-note / project-map
  pages, which are deprecated.)
- **Home** — a full-screen rolodex drum of projects (roll with wheel,
  touch, ↑/↓, or click a card to bring it front, click again to open).
  No whiteboard behind it.

## Architecture

```
web/            Vite + React shell (panels, rolodex, peers, header)
  src/App.tsx       sync engine: CRDT claims, gossip I/O, snapshots, firewall
  src/board.ts      scene store + camera (replaced Excalidraw's canvas)
  src/boardView.ts  rAF renderer: hardware wgpu → software wgpu → CPU 2D
  src/PenOverlay.tsx pencil capture (arms on the pen tool only)
shared/         protocol core: tickets, signed messages, firewall, gossip join
                  compiled to native AND wasm (single source of truth)
browser-wasm/   wasm peer: join/create rooms, keeper snapshot fetch
pen/            hand-drawn stroke pipeline + renderer
                  model → smooth → outline → render / wasm
                  pressure-aware variable width + monoline sharpie mode,
                  wgpu renderer (transparent over the CSS grid),
                  Excalidraw-freedraw interop both directions
keeper/         always-on watch peer: merges gossip into RAM, persists
                  state.json every 30s, answers snap-req + direct QUIC fetch
relay/          stock iroh-relay behind TLS-terminating proxy (Railway)
e2e/            headless-Chromium harness (puppeteer): liveness, CRDT,
                  keeper-offline, rejoin, live scenarios + WebKit probe
```

The transport is element-JSON-agnostic: gossip carries versioned freedraw
blobs, the keeper merges them opaquely, and LWW-element-map (version, ts,
author) with tombstones converges everything. The firewall is
authorization (who may affect state), not confidentiality.

Rendering: every stroke draws sharpie-style — one uniform centerline, no
triangle seams, pixel-identical overlaps. Tools are pen / eraser / pan
(two-finger pinch zooms on touch). Deliberately absent: selection,
undo/redo, text editing, embeds, image rendering (binaries still sync).

## Build

Prereqs (pinned via mise — `mise install`): node 24, rust stable.

```sh
# 1. browser peer bindings (Intel Mac: zig toolchain for ring, see below)
cargo zigbuild --release --target wasm32-unknown-unknown -p draw-browser-wasm
wasm-bindgen target/wasm32-unknown-unknown/release/draw_browser_wasm.wasm \
  --out-dir web/src/pkg --target bundler

# 2. pen bindings (bench bundle + app bundle)
mise run pen-wasm

# 3. frontend
cd web && npm i && npm run build
```

Apple-Clang can't build `ring` for wasm on Intel Macs — use zig instead:

```sh
cargo install cargo-zigbuild wasm-bindgen-cli
export PATH="$HOME/.local/zig/zig-x86_64-macos-0.16.0:$PATH"
```

`mise run` tasks: `keeper`, `web` (dev server), `serve` (:8080 static),
`wasm`, `pen-wasm`, `build`, `e2e --scenario live|crdt|keeper|rejoin|liveness`.

## Run

```sh
mise run keeper   # :8081 (LISTEN, KEEPER_DATA, KEEPER_TOKEN, RELAY_URL, MAX_TOPICS)
mise run serve    # :8080 serves web/dist
# dev alternative: `npm run dev` in web/ (debug drawer via .env.development)
```

Local testing note: iroh won't tunnel between two localhost instances —
use the LAN IP (`http://<lan-ip>:8080`) for device-to-device, or the e2e
harness for same-machine peers.

**Pen test bench:** `/pen/` — pointer samples → Rust `PenStroke` → mesh →
Canvas2D. Size slider, sharpie toggle, square/iso grid toggle, frame-time
readout. The feel-tuning surface.

## Connect

**⧉ share** copies a link for the current project. Open it on the other
device to join. State lives in browser localStorage per board (elements,
CRDT claims, tombstones, files); refresh restores it.

Query overrides (no rebuild): `?relay=`, `?keeper=`, `?debug=1`, `?fresh=1`
(ephemeral identity for same-browser testing).

## Keeper + relay (Railway, defined in `.railway/railway.ts`)

Two services, one repo: `relay` (stock image + entrypoint rendering config
from `$PORT`) and `keeper` (root Dockerfile). Browsers need relay-routed
traffic (wasm can't hole-punch); Railway has no UDP ingress, which is fine
for exactly that reason.

| env | where | meaning |
|---|---|---|
| `RELAY_URL` | keeper, `VITE_RELAY_URL` web | own relay (compiled default is ours; n0 is gone) |
| `VITE_KEEPER_URL` | web | keeper public URL |
| `VITE_KEEPER_TOKEN` / keeper `KEEPER_TOKEN` | both | optional bearer for `POST /watch` |
| `KEEPER_DATA`, `MAX_TOPICS`, `LISTEN` | keeper | storage, caps, bind |

## E2E

```sh
mise run serve & mise run keeper &   # terminals 1+2
APP_URL=http://<lan-ip>:8080 RELAY_URL=<relay> mise run e2e --scenario live
```

Scenarios drive the real UI (`+ new project`, `← PROJECTS`, tools `⋯`,
`sync`) with `?debug=1` + the `window.__draw` hook (scene, tombs, meta,
stats, diag, mesh, scroll, gpu). Logs land in `e2e/logs/`.

## Security (honest)

- Transport is **signed** (Ed25519, unspoofable senders) and every project
  now carries a **data key**: share links are `#t=<ticket>&k=<key>`, where
  the ticket routes + authorizes (keeper sees it) and the key decrypts
  (peers only — never POSTed anywhere, never in tickets).
- Board content + image binaries travel as **AES-GCM-256 envelopes**;
  CRDT claims (id, version, ts, author) and tombstones ride cleartext so
  the keeper merges without reading. Keeper disk holds ciphertext.
- The firewall is authorization (who may *affect* state), not
  confidentiality. Tickets stay bearer credentials; a bare ticket joins
  keyless and sees nothing (by design — the e2e asserts this implicitly).
- Local browser storage stays plaintext (device trust boundary).
- Lost key = lost access: no recovery except a fresh share link from a
  member. Rotation without resharing is future work (Noise re-keying).
- Firewall snapshots, presence, highlights (ids only) stay cleartext.

## Future

- Blind keeper (per-project AEAD envelopes, cleartext CRDT claims).
- Native app (full iroh: direct QUIC, discovery; the mesh replaces keeper).
- Pen render parity gaps: image/text rendering, selection, undo.
- Tombstone GC via version vectors; extract CRDT + identity into crates.
