// Loads the compiled sync-core WASM pkg (built with wasm-pack) and
// exposes a minimal sync handle. iPad runs this — no cargo, just browser.
import init, { Sync } from './pkg/sync_core.js'

let sync: Sync | null = null

const KEY = 'iroh-live-draw-secret'

export async function irohInit(onRemote: (snap: string) => void): Promise<string> {
  await init()
  // Tab-scoped identity: two tabs on one origin must be two different peers.
  // (localStorage is shared per origin — it gave every tab the same node ID,
  // so dials self-routed and relays couldn't tell tabs apart.)
  let secret = sessionStorage.getItem(KEY)
  sync = await Sync.create(secret)
  try { sessionStorage.setItem(KEY, sync.secret_key()) } catch {}
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

export function signPresence(msg: string): string {
  if (!sync) throw new Error('init first')
  return sync.sign_presence(msg)
}

export function peerCount(): number {
  if (!sync) return -1
  try { return sync.peer_count() } catch { return -2 }
}
