// Loads the compiled sync-core WASM pkg (built with wasm-pack) and
// exposes a minimal sync handle. iPad runs this — no cargo, just browser.
import init, { Sync } from './pkg/sync_core.js'

let sync: Sync | null = null

const KEY = 'iroh-live-draw-secret'

export async function irohInit(onRemote: (snap: string) => void): Promise<string> {
  await init()
  sync = await Sync.create(localStorage.getItem(KEY), onRemote)
  // persist identity: same node id / addr on every load per device
  try { localStorage.setItem(KEY, sync.secret_key()) } catch {}
  // Full dial string (node id + home relay) — needed: no discovery in browser.
  return sync.addr()
}

export async function irohJoin(peerId: string, snapshot: string) {
  if (!sync) throw new Error('init first')
  await sync.join(peerId, snapshot)
}

export function irohPush(snapshot: string) {
  if (!sync) return
  try { sync.push(snapshot) } catch {}
}

// --- gossip room (live patches + cursors). Snapshots stay direct. ---

export function roomTopic(): string {
  if (!sync) throw new Error('init first')
  return sync.room_topic()
}

export async function roomJoin(topicHex: string, addrs: string[]): Promise<void> {
  if (!sync) throw new Error('init first')
  await sync.room_join(topicHex, addrs)
}

export function roomPush(s: string) {
  if (!sync) return
  try { sync.room_push(s) } catch {}
}
