import { useCallback, useEffect, useRef, useState } from 'react'
import { Excalidraw, reconcileElements, exportToSvg } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI, OrderedExcalidrawElement } from '@excalidraw/excalidraw/types'
import { DrawNode } from './pkg/draw_browser_wasm.js'
import '@excalidraw/excalidraw/index.css'

async function copyText(t: string) {
  try {
    await navigator.clipboard.writeText(t)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = t
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

type PeerCursor = { x: number; y: number; at: number }
// A doc is an overarching topic. It owns pages in three formats:
// board (freeform), letter (formal, fixed geometry), daily (dated letters).
type PageKind = 'board' | 'letter' | 'daily'
type FormatTab = 'board' | 'letters' | 'daily'
type PageMeta = { id: string; name: string; kind: PageKind; createdAt: number; updatedAt: number }
type DocMeta = { id: string; owner: string | null; name: string; ticket?: string; updatedAt: number; pages: PageMeta[] }
type PeerInfo = { nick: string; lastSeen: number; doc?: string | null; hasAccess?: boolean }

const LS_SECRET = 'draw.secret'
const LS_DOCS = 'draw.docs'
const LS_PEERS = 'draw.peers'
const LS_PAGE = 'draw.activepage'
const LS_ALIASES = 'draw.aliases'
const SS_TAB = 'draw.tab'

// US Letter at 96dpi — the writing surface for letter pages.
const LETTER_W = 816
const LETTER_H = 1056

const newPageId = () => 'pg' + Math.random().toString(36).slice(2, 10)
const mainPage = (): PageMeta => ({ id: 'main', name: 'Board', kind: 'board', createdAt: 0, updatedAt: 0 })
const todayName = () => new Date().toISOString().slice(0, 10)
// Format tabs group pages: board | letters (formal pieces) | daily (dated).
const formatOf = (p: PageMeta): FormatTab =>
  p.kind === 'board' ? 'board' : p.kind === 'daily' ? 'daily' : 'letters'
const isLetterKind = (k: PageKind) => k !== 'board'
const snapKey = (doc: string, page: string) => `draw.snap.${doc}.${page}`
const filesKey = (doc: string, page: string) => `draw.files.${doc}.${page}`
const legacySnapKey = (doc: string) => `draw.snap.${doc}`

// Identity is per browser (localStorage base secret): closing tabs,
// refreshing, or opening new tabs never changes who you are — ownership
// survives all of it. Same-browser testing needs distinct ids, so
// `?fresh=1` opts one tab into an ephemeral key (never stored).
const bytesToHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const randomHex = (n: number): string => {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return bytesToHex(b)
}
const browserSecretHex = (): string => {
  try {
    if (new URLSearchParams(location.search).has('fresh')) return randomHex(32)
  } catch {}
  let base = localStorage.getItem(LS_SECRET)
  if (!base || !/^[0-9a-fA-F]{64}$/.test(base.trim())) {
    base = randomHex(32)
    try { localStorage.setItem(LS_SECRET, base) } catch {}
  }
  return base.trim()
}

const loadDocs = (): DocMeta[] => {
  let docs: DocMeta[] = []
  try { docs = JSON.parse(localStorage.getItem(LS_DOCS) ?? '[]') } catch { return [] }
  // Migrate: docs predate pages; give each a default board page and move
  // its snapshot under the new per-page key. Docs predate kinds too.
  let migrated = false
  for (const d of docs) {
    if (!d.pages || !d.pages.length) {
      d.pages = [mainPage()]
      try {
        const raw = localStorage.getItem(legacySnapKey(d.id))
        if (raw) {
          localStorage.setItem(snapKey(d.id, 'main'), raw)
          localStorage.removeItem(legacySnapKey(d.id))
          const fraw = localStorage.getItem(`draw.files.${d.id}`)
          if (fraw) {
            localStorage.setItem(filesKey(d.id, 'main'), fraw)
            localStorage.removeItem(`draw.files.${d.id}`)
          }
        }
      } catch {}
      migrated = true
    }
  }
  if (migrated) { try { localStorage.setItem(LS_DOCS, JSON.stringify(docs)) } catch {} }
  return docs
}
const saveDocs = (d: DocMeta[]) => localStorage.setItem(LS_DOCS, JSON.stringify(d))
const loadPeers = (): Record<string, PeerInfo> => {
  try { return JSON.parse(localStorage.getItem(LS_PEERS) ?? '{}') } catch { return {} }
}
const savePeers = (p: Record<string, PeerInfo>) => localStorage.setItem(LS_PEERS, JSON.stringify(p))

// Developer UI (debug drawer, save indicator, cache reset) is only shown
// with `npm run dev` (VITE_DEBUG via .env.development) or `?debug=1`.
// Production builds served to the iPad stay clean.
const DEBUG =
  (import.meta as any).env?.VITE_DEBUG === '1' ||
  new URLSearchParams(location.search).has('debug')
// Custom relay (all mesh traffic) + keeper (always-on watch peer).
// Empty = n0 defaults / no keeper. Both also accept `?relay=` / `?keeper=`
// query overrides (handy for tests and for pointing a build at private infra
// without rebuilding).
const qs = new URLSearchParams(location.search)
const RELAY_URL = (qs.get('relay') ?? (import.meta as any).env?.VITE_RELAY_URL ?? '').trim() || undefined
const KEEPER_URL = (qs.get('keeper') ?? (import.meta as any).env?.VITE_KEEPER_URL ?? '').trim().replace(/\/$/, '') || undefined
const KEEPER_TOKEN = ((import.meta as any).env?.VITE_KEEPER_TOKEN as string | undefined)?.trim() || undefined

// Register a doc's ticket with the keeper so it joins as a watch peer.
// Fire-and-forget: keeper down just means no cache until it's back.
// The keeper's endpoint id comes back in the response and is stored for
// direct snapshot fetches (no gossip mesh needed for those).
const LS_KEEPER = 'draw.keeper'
const registerWithKeeper = (ticket: string) => {
  if (!KEEPER_URL || !ticket) return
  try {
    fetch(`${KEEPER_URL}/watch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(KEEPER_TOKEN ? { 'x-keeper-token': KEEPER_TOKEN } : {}),
      },
      body: JSON.stringify({ ticket }),
    }).then((r) => r.json()).then((j) => {
      if (j?.keeper) { try { localStorage.setItem(LS_KEEPER, String(j.keeper)) } catch {} }
    }).catch(() => {})
  } catch {}
}

export default function App() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [id, setId] = useState('')
  const [peer, setPeer] = useState('')
  const [status, setStatus] = useState('starting…')
  const [showAdd, setShowAdd] = useState(false)
  const [showDbg, setShowDbg] = useState(false)
  const [dbg, setDbg] = useState('')
  const [online, setOnline] = useState<Record<string, string>>({})
  const [peers, setPeers] = useState<Record<string, PeerInfo>>(() => loadPeers())
  const [docs, setDocs] = useState<DocMeta[]>(() => loadDocs())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activePage, setActivePage] = useState<string | null>(null)
  const [activeFormat, setActiveFormat] = useState<FormatTab>('board')
  // Overlay views: null = canvas, 'tools' = slim canvas panel,
  // 'topics' = topic cards, 'peers' = peer management.
  const [view, setView] = useState<null | 'tools' | 'topics' | 'peers'>(null)
  const [aliases, setAliases] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(LS_ALIASES) ?? '{}') } catch { return {} }
  })
  const dispNick = (pid: string, fallback: string) => aliases[pid] ?? fallback
  const setAlias = (pid: string, alias: string) => {
    const next = { ...aliases }
    if (alias.trim()) next[pid] = alias.trim()
    else delete next[pid]
    setAliases(next)
    try { localStorage.setItem(LS_ALIASES, JSON.stringify(next)) } catch {}
  }
  const [ownerLive, setOwnerLive] = useState(true)
  const [saveInfo, setSaveInfo] = useState('not saved yet')

  const stats = useRef({ sent: {} as Record<string, number>, recv: {} as Record<string, number>, stale: 0, maxOut: 0, poison: 0, lastErr: '' })
  const times = useRef<number[]>([])
  const bump = (dir: 'sent' | 'recv', t: string) => {
    const s = stats.current
    s[dir][t] = (s[dir][t] ?? 0) + 1
    times.current.push(Date.now())
  }
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const usLog = useRef<string[]>([])
  const US = (tag: string, scene: any) => {
    const a = apiRef.current
    if (!a) return
    const before = (a.getSceneElements() as any[]).length
    a.updateScene(scene)
    const after = (a.getSceneElements() as any[]).length
    usLog.current.push(`${tag}:${before}->${after}`)
    if (usLog.current.length > 20) usLog.current.shift()
  }
  // (onApi stable callback is defined below, after its dependencies.)
  const restored = useRef<Set<string>>(new Set())
  const lastPush = useRef('none')
  const fetchErr = useRef('none')
  const lastFetch = useRef('none')
  const vanishCount = useRef(0)
  const persistCount = useRef(0)
  const changeCount = useRef(0)
  const lastSeenCount = useRef(-1)
  const seenHist = useRef<number[]>([])
  const remote = useRef(false)
  const nodeRef = useRef<any>(null)
  const me = useRef('')
  const nick = useRef('')
  const seq = useRef(0)
  const epoch = useRef(Math.random().toString(36).slice(2))
  const lastSeq = useRef<Record<string, number>>({})
  const cursors = useRef<Record<string, PeerCursor>>({})
  const lastPtr = useRef(0)
  const onlineRef = useRef<Record<string, string>>({})
  const peersRef = useRef<Record<string, PeerInfo>>(loadPeers())
  // docId -> { ch, owner, live:Set<peerId>, fwVersion }
  const rooms = useRef(new Map<string, { ch: any; owner: string | null; live: Map<string, number>; fwVersion: number }>())
  const activeRef = useRef<string | null>(null)
  const activePageRef = useRef<string | null>(null)
  const activeFormatRef = useRef<FormatTab>('board')
  const docsRef = useRef<DocMeta[]>(loadDocs())
  const sentVersions = useRef<Record<string, number>>({})

  // ---- CRDT: LWW-element-map -------------------------------------------
  // Per element id, the winner is max(version, ts, author). Deletes are
  // tombstones (first-class entries), so a late snapshot can never resurrect
  // a deleted element. Snapshots merge; they never replace.
  // Working state is for the active page only; it is loaded/stored with the
  // snapshot on page switches (draw.meta.<doc>.<page>, draw.tombs.<doc>.<page>).
  type Entry = { v: number; ts: number; author: string }
  const metaActive = useRef(new Map<string, Entry>())
  const tombsActive = useRef(new Map<string, Entry>())
  const knownIds = useRef(new Set<string>())
  const dirtyTombs = useRef(new Map<string, Entry>())
  const metaKey = (doc: string, page: string) => `draw.meta.${doc}.${page}`
  const tombsKey = (doc: string, page: string) => `draw.tombs.${doc}.${page}`
  // Vanished ids are deletes — but a single onChange reading is not
  // trustworthy (a stale delivery racing an in-flight remote apply would
  // murder fresh elements with our own authorship). So disappearance only
  // stages a tombstone; a delayed re-scan of the LIVE scene confirms it.
  // Real deletes are still missing then; stale readings self-heal.
  const pendingVanish = useRef(new Map<string, { v: number }>())
  const confirmVanish = () => {
    const a = apiRef.current
    if (!a) return
    const now = Date.now()
    const seen = new Set((a.getSceneElements() as any[]).map((el) => el.id))
    for (const [id, { v }] of pendingVanish.current) {
      if (seen.has(id)) { pendingVanish.current.delete(id); continue }
      const tomb: Entry = { v, ts: now, author: me.current }
      const best = bestFor(id)
      if (!best || cmpEntry(tomb, best.entry) > 0) {
        tombsActive.current.set(id, tomb)
        if (metaActive.current.has(id)) metaActive.current.delete(id)
        dirtyTombs.current.set(id, tomb)
      }
      pendingVanish.current.delete(id)
    }
  }
  const cmpEntry = (a: Entry, b: Entry): number =>
    a.v !== b.v ? a.v - b.v : a.ts !== b.ts ? a.ts - b.ts : a.author < b.author ? -1 : a.author > b.author ? 1 : 0
  // Best known claim for id: max(live meta, tombstone), or null if unknown.
  const bestFor = (id: string): { entry: Entry; deleted: boolean } | null => {
    const m = metaActive.current.get(id)
    const t = tombsActive.current.get(id)
    if (m && t) return cmpEntry(m, t) >= 0 ? { entry: m, deleted: false } : { entry: t, deleted: true }
    if (m) return { entry: m, deleted: false }
    if (t) return { entry: t, deleted: true }
    return null
  }

  const activeDocPages = (): PageMeta[] =>
    docsRef.current.find((d) => d.id === activeRef.current)?.pages ?? []
  const setActivePageBoth = (docId: string, pageId: string) => {
    activePageRef.current = pageId
    setActivePage(pageId)
    try { localStorage.setItem(`${LS_PAGE}.${docId}`, pageId) } catch {}
    const pg = docsRef.current.find((d) => d.id === docId)?.pages.find((p) => p.id === pageId)
    if (pg) {
      const f = formatOf(pg)
      activeFormatRef.current = f
      setActiveFormat(f)
    }
  }
  const storedActivePage = (docId: string): string | null => {
    try { return localStorage.getItem(`${LS_PAGE}.${docId}`) } catch { return null }
  }
  // Presence announces "docId#pageId" in the shared doc string (no wire
  // change: the Rust side carries it opaquely).
  const presenceDoc = () => `${activeRef.current ?? ''}#${activePageRef.current ?? 'main'}`
  const parsePresenceDoc = (s: string | null | undefined): { doc: string; page: string | null } => {
    if (!s) return { doc: '', page: null }
    const i = s.indexOf('#')
    if (i < 0) return { doc: s, page: null }
    return { doc: s.slice(0, i), page: s.slice(i + 1) || null }
  }

  const setDocsBoth = (d: DocMeta[]) => {
    docsRef.current = d
    setDocs(d)
    saveDocs(d)
  }
  const setPeersBoth = (p: Record<string, PeerInfo>) => {
    peersRef.current = p
    setPeers(p)
    savePeers(p)
  }
  const touchPeer = (from: string, nickname: string, doc?: string | null) => {
    if (!from || from === me.current) return
    const prev = peersRef.current[from] ?? { nick: '', lastSeen: 0 }
    const entry: PeerInfo = { nick: nickname || prev.nick || from.slice(0, 6), lastSeen: Date.now(), doc: doc ?? prev.doc ?? null }
    // Derive has_access from the firewall replica for the announced doc.
    const pd = parsePresenceDoc(entry.doc)
    if (pd.doc && rooms.current.has(pd.doc)) entry.hasAccess = queryAccess(pd.doc, from)
    else entry.hasAccess = prev.hasAccess
    const next = { ...peersRef.current, [from]: entry }
    setPeersBoth(next)
  }

  const activeCh = () => (activeRef.current ? rooms.current.get(activeRef.current)?.ch ?? null : null)

  // Snapshots can vanish into a half-built mesh (late-joiner broadcast
  // stall): if our scene is still empty seconds after requesting, ask
  // again. Last resort is a direct QUIC fetch from the keeper, which needs
  // no gossip mesh at all. All bounded — each step fires only if we're
  // still on the same doc+page with an empty canvas.
  const fetchFromKeeper = async (roomId: string, page: string) => {
    try {
      if (roomId !== activeRef.current || page !== (activePageRef.current ?? 'main')) return
      if ((apiRef.current?.getSceneElements() ?? []).length > 0) return
      const node = nodeRef.current
      const keeperId = localStorage.getItem(LS_KEEPER)
      const ticket = docsRef.current.find((d) => d.id === roomId)?.ticket
      // Keeper shares our relay setup in every deployment that matters, so
      // our own home relay is a sound fallback when none is configured.
      const relay = RELAY_URL ?? node?.relay_url?.()
      if (!node?.fetch_snapshot || !keeperId || !relay || !ticket) return
      const json = await node.fetch_snapshot(keeperId, relay, ticket, page)
      if (roomId !== activeRef.current || page !== (activePageRef.current ?? 'main')) return
      const res = JSON.parse(json)
      lastFetch.current = `els=${res.elements?.length ?? '?'} tombs=${res.tombs?.length ?? '?'}`
      if (Array.isArray(res.files)) ingestFiles(res.files)
      const els = Array.isArray(res.elements) ? res.elements : []
      const tombs = Array.isArray(res.tombs) ? res.tombs : []
      if (!els.length && !tombs.length) return
      remote.current = true
      try {
        if (ingestTombs(tombs)) { /* enforced below */ }
        if (els.length) queueRemote(els, res.meta, false)
        enforceTombs()
      } finally {
        remote.current = false
      }
      setStatus('restored from keeper')
    } catch (e) {
      fetchErr.current = String(e).slice(0, 160)
    }
  }
  const requestSnap = (roomId: string, page: string, attempt = 0) => {
    if (roomId !== activeRef.current || page !== (activePageRef.current ?? 'main')) return
    if ((apiRef.current?.getSceneElements() ?? []).length > 0) return
    if (attempt >= 1) {
      // Gossip retries didn't fill us: go direct to the keeper, which
      // needs no mesh at all.
      fetchFromKeeper(roomId, page)
      return
    }
    sendMsg({ t: 'snap-req' })
    window.setTimeout(() => requestSnap(roomId, page, attempt + 1), 6000)
  }

  // has_access is derived from the local firewall replica — never stored
  // as authority, only as a personal cached view (the PeerList rule).
  const queryAccess = (roomId: string, peer: string): boolean | undefined => {
    try {
      const room = rooms.current.get(roomId)
      if (!room) return undefined
      return room.ch.has_access(peer) ?? undefined
    } catch { return undefined }
  }
  const recomputeAccess = (roomId: string) => {
    const next = { ...peersRef.current }
    let changed = false
    for (const [pid, p] of Object.entries(next)) {
      const pd = parsePresenceDoc(p.doc)
      if (pd.doc !== roomId) continue
      const ha = queryAccess(roomId, pid)
      if (ha !== undefined && ha !== p.hasAccess) { next[pid] = { ...p, hasAccess: ha }; changed = true }
    }
    if (changed) setPeersBoth(next)
  }
  // Owner broadcasts rule changes; receivers apply them wholesale. Only
  // messages from the topic owner are honored (sender == owner), versioned
  // by wall clock (prototype-grade ordering — see note below).
  const broadcastFw = (roomId: string) => {
    const room = rooms.current.get(roomId)
    if (!room || room.owner !== me.current) return
    try {
      const snap = room.ch.firewall_snapshot()
      room.fwVersion = Date.now()
      bump('sent', 'fw')
      room.ch.sender.broadcast(JSON.stringify({ from: me.current, epoch: epoch.current, seq: seq.current++, page: activePageRef.current ?? 'main', t: 'fw', v: room.fwVersion, snap })).catch(() => bump('sent', 'drop'))
      recomputeAccess(roomId)
    } catch {}
  }
  const setFwRule = (roomId: string, peer: string, allow: boolean) => {
    const room = rooms.current.get(roomId)
    if (!room || room.owner !== me.current) return
    try {
      if (allow) room.ch.allow_peer(peer)
      else room.ch.revoke_peer(peer)
      broadcastFw(roomId)
    } catch (e) { setStatus(`firewall failed: ${e}`) }
  }

  const sendMsg = (obj: any) => {
    const ch = activeCh()
    if (!ch) return
    bump('sent', obj?.t ?? '?')
    const s = JSON.stringify({ from: me.current, epoch: epoch.current, seq: seq.current++, page: activePageRef.current ?? 'main', ...obj })
    if (s.length > stats.current.maxOut) stats.current.maxOut = s.length
    ch.sender.broadcast(s).catch(() => bump('sent', 'drop'))
  }

  // Merge elements into a background page's stored snapshot by CRDT claim
  // (version, ts, author) — never blind replace — so pages you're not
  // viewing still converge without resurrection.
  const mergePageSnapshot = (docId: string, page: string, elements: any[], meta: Record<string, [number, string]> | undefined, tombs: any[], files: any[]) => {
    try {
      if (Array.isArray(files) && files.length) {
        const fraw = localStorage.getItem(filesKey(docId, page))
        const fmap = fraw ? JSON.parse(fraw) : {}
        for (const f of files) if (f?.id) fmap[f.id] = f
        try { localStorage.setItem(filesKey(docId, page), JSON.stringify(fmap)) } catch {}
      }
      const mraw = localStorage.getItem(metaKey(docId, page))
      const smeta: Record<string, Entry> = mraw ? JSON.parse(mraw) : {}
      const traw = localStorage.getItem(tombsKey(docId, page))
      const stombs: Record<string, Entry> = traw ? JSON.parse(traw) : {}
      const bestStored = (id: string): { e: Entry; del: boolean } | null => {
        const m = smeta[id]
        const t = stombs[id]
        if (m && t) return cmpEntry(m, t) >= 0 ? { e: m, del: false } : { e: t, del: true }
        if (m) return { e: m, del: false }
        if (t) return { e: t, del: true }
        return null
      }
      if (Array.isArray(tombs)) for (const t of tombs) {
        if (!t || typeof t.id !== 'string') continue
        const cand: Entry = { v: t.v ?? 0, ts: t.ts ?? 0, author: t.author ?? '' }
        const b = bestStored(t.id)
        if (!b || cmpEntry(cand, b.e) > 0) {
          stombs[t.id] = cand
          delete smeta[t.id]
        }
      }
      const raw = localStorage.getItem(snapKey(docId, page))
      const cur = raw ? JSON.parse(raw) : []
      const map = new Map<string, any>()
      if (Array.isArray(cur)) for (const el of cur) map.set(el.id, el)
      if (Array.isArray(elements)) for (const el of elements) {
        const [ts, author] = meta?.[el.id] ?? [0, '']
        const cand: Entry = { v: el.version ?? 0, ts, author }
        const b = bestStored(el.id)
        if (b && cmpEntry(b.e, cand) >= 0) continue
        smeta[el.id] = cand
        delete stombs[el.id]
        map.set(el.id, el)
      }
      // Evict anything the tombstones condemn.
      for (const [id, t] of Object.entries(stombs)) {
        const el = map.get(id)
        if (!el) continue
        const m = smeta[id]
        if (!m || cmpEntry(t, m) > 0) map.delete(id)
      }
      localStorage.setItem(snapKey(docId, page), JSON.stringify([...map.values()]))
      try { localStorage.setItem(metaKey(docId, page), JSON.stringify(smeta)) } catch {}
      try { localStorage.setItem(tombsKey(docId, page), JSON.stringify(stombs)) } catch {}
    } catch {}
  }

  const applyRemote = (elements: any[], asIs: boolean) => {
    const a = apiRef.current
    if (!a || !Array.isArray(elements)) return
    remote.current = true
    try {
      // Snapshots merge, never replace (CRDT rule — see header above).
      US('apply', { elements: reconcileElements(a.getSceneElements(), elements as OrderedExcalidrawElement[], a.getAppState()) })
      for (const el of a.getSceneElements()) sentVersions.current[el.id] = el.version
      // Only ids confirmed in our scene count as known: an onChange that
      // runs between queueing and this apply must never tombstone
      // not-yet-applied remote elements.
      for (const el of a.getSceneElements() as any[]) knownIds.current.add(el.id)
      enforceTombs()
    } finally {
      remote.current = false
    }
  }

  // Remove anything the tombstones condemn (runs inside the remote guard).
  const enforceTombs = () => {
    const a = apiRef.current
    if (!a || !tombsActive.current.size) return
    const condemned: string[] = []
    for (const el of a.getSceneElements() as any[]) {
      const t = tombsActive.current.get(el.id)
      const m = metaActive.current.get(el.id)
      if (t && (!m || cmpEntry(t, m) > 0)) condemned.push(el.id)
    }
    if (!condemned.length) return
    const dead = new Set(condemned)
    US('tombs', {
      elements: (a.getSceneElements() as any[]).map((el) =>
        dead.has(el.id) ? { ...el, isDeleted: true } : el,
      ),
    })
  }

  // Inbound coalescing: drawing messages can arrive at pointer-move rate.
  // Merge them and reconcile at most once per animation frame instead of
  // once per message (each reconcile is O(scene) — this is what lags after
  // ~10s of continuous strokes on a grown canvas).
  // CRDT gate: an incoming element/tombstone only enters the pending set if
  // it beats the best known claim for its id.
  const pendingRef = useRef<{ map: Map<string, { el: any; ts: number; author: string }>; asIs: boolean } | null>(null)
  const rafRef = useRef(0)
  const timerRef = useRef(0)
  const flushCount = useRef(0)
  const flushPending = () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = 0 }
    const p = pendingRef.current
    pendingRef.current = null
    if (!p) return
    flushCount.current += 1
    applyRemote([...p.map.values()].map((e) => e.el), p.asIs)
  }
  const queueRemote = (elements: any[], meta: Record<string, [number, string]> | undefined, asIs: boolean) => {
    const p = asIs || !pendingRef.current
      ? { map: new Map<string, { el: any; ts: number; author: string }>(), asIs }
      : pendingRef.current!
    if (asIs) p.asIs = true
    for (const el of elements) {
      const [ts, author] = meta?.[el.id] ?? [0, '']
      const cand: Entry = { v: el.version ?? 0, ts, author }
      const best = bestFor(el.id)
      if (best && cmpEntry(best.entry, cand) >= 0) continue
      metaActive.current.set(el.id, cand)
      // A live element beating its tombstone buries it.
      if (tombsActive.current.has(el.id)) tombsActive.current.delete(el.id)
      const prev = p.map.get(el.id)
      if (!prev || (el.version ?? 0) >= (prev.el.version ?? 0)) p.map.set(el.id, { el, ts, author })
    }
    pendingRef.current = p
    if (!rafRef.current && !timerRef.current) {
      rafRef.current = requestAnimationFrame(flushPending)
      timerRef.current = window.setTimeout(flushPending, 50)
    }
  }
  const ingestTombs = (tombs: any[]): boolean => {
    if (!Array.isArray(tombs) || !tombs.length) return false
    let changed = false
    for (const t of tombs) {
      if (!t || typeof t.id !== 'string') continue
      const cand: Entry = { v: t.v ?? 0, ts: t.ts ?? 0, author: t.author ?? '' }
      const best = bestFor(t.id)
      if (best && cmpEntry(best.entry, cand) >= 0) continue
      tombsActive.current.set(t.id, cand)
      if (metaActive.current.has(t.id)) metaActive.current.delete(t.id)
      dirtyTombs.current.delete(t.id)
      changed = true
    }
    return changed
  }

  const refreshOwnerLive = () => {
    setOwnerLive(ownerIsLive())
  }

  const ownerIsLive = () => {
    const aid = activeRef.current
    if (!aid) return true
    const room = rooms.current.get(aid)
    if (!room) return true
    if (!room.owner || room.owner === me.current) return true
    const last = room.live.get(room.owner) ?? 0
    return Date.now() - last < 12000
  }

  const setPresence = (roomId: string, from: string, nickname: string, doc?: string | null) => {
    if (from === me.current) return
    touchPeer(from, nickname, doc)
    const room = rooms.current.get(roomId)
    if (room) room.live.set(from, Date.now())
    // Only surface presence for the active room's roster.
    // A peer counts as "in this doc" if their announced doc matches,
    // or if we heard them on this room's gossip channel (fallback).
    if (roomId === activeRef.current) {
      onlineRef.current = { ...onlineRef.current, [from]: nickname || from.slice(0, 6) }
      setOnline(onlineRef.current)
    }
    refreshOwnerLive()
  }

  // Re-mint the stored ticket when mesh membership changes so it always
  // carries current neighbors + their relays. Without this, a rejoin after
  // churn dials a stale bootstrap (possibly only dead peers) and the mesh
  // never reforms — browsers have no discovery to fall back on.
  // Fire-and-forget: failures just leave the previous ticket in place.
  // A delayed retry follows each change because relay addresses may not be
  // in the endpoint map yet at the instant the neighbor event fires.
  const refreshTicket = (roomId: string, delayed = false) => {
    const run = async () => {
      try {
        const room = rooms.current.get(roomId)
        if (!room) return
        const ticket = await room.ch.ticket({ includeMyself: true, includeBootstrap: true, includeNeighbors: true })
        const docs = docsRef.current.map((d) => (d.id === roomId ? { ...d, ticket, updatedAt: Date.now() } : d))
        setDocsBoth(docs)
      } catch {}
    }
    run()
    if (!delayed) window.setTimeout(run, 10000)
  }

  const onRoomEvent = (roomId: string, ev: any) => {
    if (!ev || typeof ev.type !== 'string') return
    if (ev.type === 'presence') {
      setPresence(roomId, String(ev.from), ev.nickname, ev.doc ?? null)
      return
    }
    if (ev.type === 'neighborUp') {
      setPresence(roomId, String(ev.endpoint_id ?? ev.endpointId ?? ''), '', null)
      refreshTicket(roomId)
      return
    }
    if (ev.type === 'neighborDown') {
      const from = String(ev.endpoint_id ?? ev.endpointId ?? '')
      rooms.current.get(roomId)?.live.delete(from)
      if (roomId === activeRef.current) {
        const { [from]: _drop, ...rest } = onlineRef.current
        onlineRef.current = rest
        setOnline(rest)
      }
      refreshOwnerLive()
      refreshTicket(roomId)
      return
    }
    if (ev.type === 'messageReceived') {
      let m: any
      try { m = JSON.parse(ev.text) } catch { return }
      bump('recv', m?.t ?? '?')
      const from = String(ev.from ?? m.from ?? '')
      if (from === me.current) return
      // Firewall rules replicate to every joined room, background or not:
      // only the topic owner is honored, newest version wins.
      if (m?.t === 'fw') {
        const room = rooms.current.get(roomId)
        const v = typeof m.v === 'number' ? m.v : 0
        if (room && room.owner && from === room.owner && v > room.fwVersion && typeof m.snap === 'string') {
          try {
            room.ch.apply_firewall(m.snap)
            room.fwVersion = v
            recomputeAccess(roomId)
          } catch {}
        }
        return
      }
      // Ignore drawing traffic for background rooms (still track presence)
      if (roomId !== activeRef.current && (m?.t === 'p' || m?.t === 'f' || m?.t === 'snap' || m?.t === 'snap-req' || m?.t === 'pull' || m?.t === 'push' || m?.t === 'cursor' || m?.t === 'pages')) return
      // Page tag (absent = legacy client on the default page).
      const msgPage = typeof m.page === 'string' ? m.page : 'main'
      const isActivePage = msgPage === (activePageRef.current ?? 'main')
      if (m?.t === 'cursor') {
        if (!isActivePage) return
        cursors.current[from] = { x: m.x, y: m.y, at: Date.now() }
        pushCollaborators()
        return
      }
      if (m?.t === 'pages') {
        mergePages(roomId, m.pages)
        return
      }
      if (m?.t === 'f') {
        if (isActivePage) ingestFiles(m.files)
        else mergePageSnapshot(roomId, msgPage, [], undefined, [], m.files ?? [])
        return
      }
      // CRDT ingest helper: tombstones first (they condemn), then elements.
      // After ingesting, enforce against the live scene under the remote guard.
      const ingestCrdt = (elements: any[] | undefined, meta: any, tombs: any[]) => {
        let touched = false
        if (ingestTombs(tombs)) touched = true
        if (Array.isArray(elements) && elements.length) {
          const before = pendingRef.current?.map.size ?? -1
          queueRemote(elements, meta, false)
          touched = touched || (pendingRef.current?.map.size ?? -1) !== before
        }
        if (touched) {
          remote.current = true
          try { enforceTombs() } finally { remote.current = false }
        }
      }
      if (m?.t === 'p') {
        if (typeof m.seq === 'number' && m.from) {
          const key = `${m.from}:${m.epoch ?? 0}`
          if (m.seq <= (lastSeq.current[key] ?? -1)) { stats.current.stale++; return }
          lastSeq.current[key] = m.seq
        }
        if (isActivePage) {
          if (Array.isArray(m.files)) ingestFiles(m.files)
          ingestCrdt(m.elements, m.meta, m.tombs ?? [])
        } else if (Array.isArray(m.elements)) {
          mergePageSnapshot(roomId, msgPage, m.elements, m.meta, m.tombs ?? [], m.files ?? [])
        } else if (Array.isArray(m.tombs)) {
          mergePageSnapshot(roomId, msgPage, [], undefined, m.tombs, m.files ?? [])
        }
      } else if (m?.t === 'snap-req') {
        // Answer with elements + their binaries (forced: the requester is
        // usually a newcomer who missed the original file broadcasts).
        // Honors the requested page, live or stored; falls back to our own
        // active page only when the message carries no usable tag.
        // Snapshots carry CRDT claims (meta + tombstones) so the joiner
        // merges instead of replacing — no resurrection, no clobber.
        const pg = typeof m.page === 'string' ? m.page : (activePageRef.current ?? 'main')
        const { els, files, meta, tombs } = gatherPage(roomId, pg)
        if (JSON.stringify(files).length + JSON.stringify(els).length < MAX_MSG) {
          sendMsg({ t: 'snap', elements: els, meta, tombs, files, page: pg })
        } else {
          sendMsg({ t: 'snap', elements: els, meta, tombs, page: pg })
          for (const f of files) {
            if (JSON.stringify(f).length > MAX_MSG) continue
            sendMsg({ t: 'f', files: [f], page: pg })
          }
        }
      } else if (m?.t === 'pull') {
        // Manual sync: only the owner answers, with full state for the
        // requested page (live or stored — the owner may be viewing
        // elsewhere). The requester overwrites itself (see 'push').
        const room = rooms.current.get(roomId)
        if (!room || (room.owner && room.owner !== me.current)) return
        const pg = typeof m.page === 'string' ? m.page : (activePageRef.current ?? 'main')
        const { els, files, meta, tombs } = gatherPage(roomId, pg)
        if (JSON.stringify(files).length + JSON.stringify(els).length < MAX_MSG) {
          sendMsg({ t: 'push', elements: els, meta, tombs, files, page: pg })
        } else {
          sendMsg({ t: 'push', elements: els, meta, tombs, page: pg })
          for (const f of files) {
            if (JSON.stringify(f).length > MAX_MSG) continue
            sendMsg({ t: 'f', files: [f], page: pg })
          }
        }
      } else if (m?.t === 'push') {
        // Manual sync answer: only honored from the owner (or when no
        // owner is recorded). Our scene is REPLACED wholesale — local
        // unflushed edits are discarded, claims adopt the owner's.
        const room = rooms.current.get(roomId)
        if (!room) { lastPush.current = 'ignored: no room'; return }
        if (room.owner && from !== room.owner) { lastPush.current = `ignored: not owner (from ${String(from).slice(0, 6)} owner ${(room.owner ?? '').slice(0, 6)})`; return }
        if (!isActivePage || !apiRef.current || !Array.isArray(m.elements)) { lastPush.current = 'ignored: wrong page/no api/bad elements'; return }
        lastPush.current = `applied ${m.elements.length} els`
        if (Array.isArray(m.files)) ingestFiles(m.files)
        remote.current = true
        try {
          metaActive.current = new Map()
          tombsActive.current = new Map()
          if (Array.isArray(m.tombs)) for (const t of m.tombs) {
            if (t?.id) tombsActive.current.set(t.id, { v: t.v ?? 0, ts: t.ts ?? 0, author: t.author ?? '' })
          }
          // Claims adopt the owner's; element versions seed from the pushed
          // scene so future merges compare against real versions.
          for (const el of m.elements as any[]) {
            const c = (m.meta as any)?.[el.id]
            metaActive.current.set(el.id, { v: el.version ?? 0, ts: c?.[0] ?? 0, author: c?.[1] ?? '' })
          }
          US('push', { elements: m.elements as OrderedExcalidrawElement[], commitToHistory: false })
          for (const el of apiRef.current.getSceneElements()) sentVersions.current[el.id] = el.version
          knownIds.current = new Set((apiRef.current.getSceneElements() as any[]).map((el: any) => el.id))
          enforceTombs()
          dirtyRef.current.clear()
          dirtyFilesRef.current.clear()
          dirtyTombs.current.clear()
          pendingRef.current = null
        } finally {
          remote.current = false
        }
        persistSnapshot(roomId, msgPage)
        setStatus('synced from owner')
      } else if (m?.t === 'snap') {
        if (isActivePage) {
          if (Array.isArray(m.files)) ingestFiles(m.files)
          ingestCrdt(m.elements, m.meta, m.tombs ?? [])
        } else if (Array.isArray(m.elements)) {
          mergePageSnapshot(roomId, msgPage, m.elements, m.meta, m.tombs ?? [], m.files ?? [])
        } else if (Array.isArray(m.tombs)) {
          mergePageSnapshot(roomId, msgPage, [], undefined, m.tombs, m.files ?? [])
        }
      }
    }
  }

  // Gather a page's full state for snapshot/pull answers: the live scene
  // when it's our active page, stored state otherwise.
  const gatherPage = (roomId: string, page: string) => {
    let els: any[]
    let files: any[]
    let meta: Record<string, [number, string]> = {}
    let tombs: any[] = []
    if (page === (activePageRef.current ?? 'main') && roomId === activeRef.current) {
      els = apiRef.current?.getSceneElements() ?? []
      files = collectFilesFor(els, true)
      for (const [id, e] of metaActive.current) meta[id] = [e.ts, e.author]
      tombs = [...tombsActive.current.entries()].map(([id, e]) => ({ id, v: e.v, ts: e.ts, author: e.author }))
    } else {
      try {
        const raw = localStorage.getItem(snapKey(roomId, page))
        els = raw ? JSON.parse(raw) : []
      } catch { els = [] }
      try {
        const fraw = localStorage.getItem(filesKey(roomId, page))
        files = Object.values(fraw ? JSON.parse(fraw) : {})
      } catch { files = [] }
      try {
        const mraw = localStorage.getItem(metaKey(roomId, page))
        meta = mraw ? JSON.parse(mraw) : {}
      } catch {}
      try {
        const traw = localStorage.getItem(tombsKey(roomId, page))
        const tm = traw ? JSON.parse(traw) : {}
        tombs = Object.entries(tm).map(([id, e]: any) => ({ id, v: e.v, ts: e.ts, author: e.author }))
      } catch {}
    }
    return { els, files, meta, tombs }
  }

  const pumpRoom = (roomId: string, ch: any) => {
    ;(async () => {
      const reader = (ch.receiver as ReadableStream).getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!rooms.current.has(roomId)) break
          try {
            onRoomEvent(roomId, typeof value === 'string' ? JSON.parse(value) : value)
          } catch (e) {
            stats.current.poison++
            stats.current.lastErr = String(e).slice(0, 120)
          }
        }
      } catch { /* closed */ }
      finally { try { reader.releaseLock() } catch {} }
    })()
  }

  const persistSnapshot = (roomId: string, page?: string) => {
    const pg = page ?? activePageRef.current ?? 'main'
    try {
      const els = apiRef.current?.getSceneElements() ?? []
      const key = snapKey(roomId, pg)
      // Never let a blank canvas destroy a non-empty snapshot. Tabs share
      // one localStorage, so an idle/empty tab would otherwise wipe the
      // drawing tab's snapshot within 3s. (Trade-off: wiping the canvas
      // empty on purpose won't persist until something is drawn again —
      // use "clear cache" for a full reset.)
      if (els.length === 0) {
        const raw = localStorage.getItem(key)
        if (raw && raw !== '[]') { setSaveInfo(`held snapshot ${new Date().toLocaleTimeString()} (canvas empty)`); return }
      }
      localStorage.setItem(key, JSON.stringify(els))
      persistCount.current += 1
      // Persist CRDT claims alongside (best-effort like the rest here).
      try {
        const m: Record<string, Entry> = {}
        for (const [id, e] of metaActive.current) m[id] = e
        localStorage.setItem(metaKey(roomId, pg), JSON.stringify(m))
      } catch {}
      try {
        const t: Record<string, Entry> = {}
        for (const [id, e] of tombsActive.current) t[id] = e
        localStorage.setItem(tombsKey(roomId, pg), JSON.stringify(t))
      } catch {}
      // Persist image binaries alongside (best-effort: quota may refuse).
      try {
        const files = apiRef.current?.getFiles() ?? {}
        const needed: Record<string, any> = {}
        for (const el of els as any[]) {
          const fid = el?.fileId
          if (fid && files[fid]) needed[fid] = files[fid]
        }
        localStorage.setItem(filesKey(roomId, pg), JSON.stringify(needed))
      } catch {}
      const verify = localStorage.getItem(key)
      setSaveInfo(`saved ${els.length} els ${new Date().toLocaleTimeString()} (${(verify ?? '').length}B)`)
    } catch (e) {
      setSaveInfo(`save FAILED: ${String(e).slice(0, 80)}`)
    }
  }

  // Restore a doc's snapshot into the canvas. Safe to call before the
  // Excalidraw api is ready — it no-ops and the api setter retries.
  const applyStoredSnapshot = (roomId: string, page?: string) => {
    const pg = page ?? activePageRef.current ?? 'main'
    if (!apiRef.current) { setSaveInfo('restore deferred (no api yet)'); return }
    try {
      // Binaries first, so image elements resolve instead of placeholdering.
      try {
        const fraw = localStorage.getItem(filesKey(roomId, pg))
        const fmap = fraw ? JSON.parse(fraw) : {}
        const arr = Object.values(fmap)
        if (arr.length) {
          apiRef.current.addFiles(arr as any)
          for (const f of arr as any[]) if (f?.id) sentFiles.current.add(f.id)
        }
      } catch {}
      // CRDT working state for this page.
      metaActive.current = new Map()
      tombsActive.current = new Map()
      dirtyTombs.current.clear()
      try {
        const mraw = localStorage.getItem(metaKey(roomId, pg))
        const m = mraw ? JSON.parse(mraw) : {}
        for (const [id, e] of Object.entries(m)) metaActive.current.set(id, e as Entry)
      } catch {}
      try {
        const traw = localStorage.getItem(tombsKey(roomId, pg))
        const t = traw ? JSON.parse(traw) : {}
        for (const [id, e] of Object.entries(t)) tombsActive.current.set(id, e as Entry)
      } catch {}
      const raw = localStorage.getItem(snapKey(roomId, pg))
      const els = raw ? JSON.parse(raw) : []
      if (Array.isArray(els)) {
        remote.current = true
        try { US('restore', { elements: els, commitToHistory: false }) } finally { remote.current = false }
        for (const el of apiRef.current.getSceneElements()) sentVersions.current[el.id] = el.version
        knownIds.current = new Set((apiRef.current.getSceneElements() as any[]).map((el) => el.id))
        // Seed live claims for restored elements lacking stored meta
        // (legacy snapshots): our load counts as an observation, not an edit.
        for (const el of apiRef.current.getSceneElements() as any[]) {
          if (!metaActive.current.has(el.id) && !tombsActive.current.has(el.id)) {
            metaActive.current.set(el.id, { v: el.version ?? 0, ts: 0, author: '' })
          }
        }
        remote.current = true
        try { enforceTombs() } finally { remote.current = false }
        restored.current.add(`${roomId}/${pg}`)
        setSaveInfo(`restored ${els.length} els ${new Date().toLocaleTimeString()}`)
      }
    } catch (e) {
      setSaveInfo(`restore FAILED: ${String(e).slice(0, 80)}`)
    }
  }

  // Merge a remote page list: adopt unknown pages (LWW on updatedAt),
  // then pull any adopted page's content from the owner.
  const mergePages = (roomId: string, remotePages: PageMeta[]) => {
    if (!Array.isArray(remotePages) || !remotePages.length) return
    const docs = [...docsRef.current]
    const doc = docs.find((d) => d.id === roomId)
    if (!doc) return
    let changed = false
    for (const rp of remotePages) {
      if (!rp || typeof rp.id !== 'string') continue
      const local = doc.pages.find((p) => p.id === rp.id)
      const rkind: PageKind = rp.kind === 'letter' || rp.kind === 'daily' ? rp.kind : 'board'
      if (!local) {
        doc.pages.push({
          id: rp.id,
          name: typeof rp.name === 'string' ? rp.name : rp.id,
          kind: rkind,
          createdAt: rp.createdAt ?? Date.now(),
          updatedAt: rp.updatedAt ?? Date.now(),
        })
        changed = true
        // pull the adopted page's content (goes to stored snapshot if
        // we're not viewing it)
        if (roomId === activeRef.current && rp.id === activePageRef.current) sendMsg({ t: 'snap-req' })
      } else if ((rp.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
        local.name = typeof rp.name === 'string' ? rp.name : local.name
        local.kind = rkind
        local.updatedAt = rp.updatedAt
        changed = true
      }
    }
    if (changed) {
      doc.pages.sort((a, b) => a.createdAt - b.createdAt)
      setDocsBoth(docs)
    }
  }

  const broadcastPages = () => {
    const doc = docsRef.current.find((d) => d.id === activeRef.current)
    if (doc) sendMsg({ t: 'pages', pages: doc.pages })
  }

  const switchDoc = (roomId: string) => {
    // flush outgoing edits + persist outgoing canvas
    flushDirty()
    if (activeRef.current) persistSnapshot(activeRef.current)
    activeRef.current = roomId
    setActiveId(roomId)
    onlineRef.current = {}
    setOnline({})
    cursors.current = {}
    sentVersions.current = {}
    sentFiles.current = new Set()
    dirtyFilesRef.current.clear()
    // CRDT working state is per page; the incoming page reloads its own.
    metaActive.current = new Map()
    tombsActive.current = new Map()
    dirtyTombs.current.clear()
    knownIds.current = new Set()
    pendingRef.current = null
    // restore this doc's last-viewed page (or its first page)
    const doc = docsRef.current.find((d) => d.id === roomId)
    const pages = doc?.pages?.length ? doc.pages : [mainPage()]
    const want = storedActivePage(roomId)
    const pg = pages.some((p) => p.id === want) ? want! : pages[0].id
    setActivePageBoth(roomId, pg)
    // load incoming snapshot (deferred until api ready if needed)
    applyStoredSnapshot(roomId, pg)
    ensureLetterSurface(roomId, pg)
    epoch.current = Math.random().toString(36).slice(2)
    seq.current = 0
    // announce which doc+page we have open on every live room sender
    for (const [, r] of rooms.current) {
      try { r.ch.sender.set_current_doc?.(presenceDoc()) } catch {}
    }
    setStatus('connected — draw!')
    refreshOwnerLive()
    requestSnap(roomId, activePageRef.current ?? 'main')
    // The selected document wakes the keeper.
    const sel = docsRef.current.find((d) => d.id === roomId)
    if (sel?.ticket) registerWithKeeper(sel.ticket)
  }

  const switchPage = (pageId: string) => {
    const roomId = activeRef.current
    if (!roomId || pageId === activePageRef.current) return
    flushDirty()
    const outgoing = activePageRef.current ?? 'main'
    persistSnapshot(roomId, outgoing)
    activePageRef.current = null // park: announce uses explicit ids below
    cursors.current = {}
    sentVersions.current = {}
    sentFiles.current = new Set()
    dirtyFilesRef.current.clear()
    metaActive.current = new Map()
    tombsActive.current = new Map()
    dirtyTombs.current.clear()
    knownIds.current = new Set()
    pendingRef.current = null
    setActivePageBoth(roomId, pageId)
    applyStoredSnapshot(roomId, pageId)
    ensureLetterSurface(roomId, pageId)
    for (const [, r] of rooms.current) {
      try { r.ch.sender.set_current_doc?.(presenceDoc()) } catch {}
    }
    requestSnap(roomId, pageId)
    setStatus('connected — draw!')
  }

  // Letter pages get a fixed US-Letter frame as the writing surface
  // (visual boundary + export unit). Created once per page as an ordinary
  // element, so it syncs to peers like anything else.
  const ensureLetterSurface = (roomId: string, pageId: string) => {
    const a = apiRef.current
    if (!a) return
    const doc = docsRef.current.find((d) => d.id === roomId)
    const page = doc?.pages.find((p) => p.id === pageId)
    if (!page || !isLetterKind(page.kind)) return
    let raw: string | null = null
    try { raw = localStorage.getItem(snapKey(roomId, pageId)) } catch {}
    if (raw && raw !== '[]') return // page already has content
    if (a.getSceneElements().length > 0) return
    const frame = {
      id: `frame-${pageId}`,
      type: 'frame',
      x: 0, y: 0, width: LETTER_W, height: LETTER_H,
      angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
      fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
      roughness: 0, opacity: 100, strokeSharpness: 'sharp',
      roundness: null, boundElements: [], link: null, locked: false,
      name: page.name, index: null, version: 1, versionNonce: Math.floor(Math.random() * 2 ** 31),
      isDeleted: false, groupIds: [], frameId: null,
    } as any
    remote.current = true
    try { US('frame', { elements: [...a.getSceneElements(), frame] }) } finally { remote.current = false }
    try { a.scrollToContent([frame] as any, { animate: true } as any) } catch {}
  }

  // Stable Excalidraw API callback (see note at apiRef): mount-only restore.
  const apiCalls = useRef<string[]>([])
  const onApi = useCallback((a: ExcalidrawImperativeAPI | null) => {
    const first = apiRef.current !== a
    apiCalls.current.push(`${Date.now() % 100000}:${first ? 'first' : 'repeat'}`)
    if (apiCalls.current.length > 12) apiCalls.current.shift()
    setApi(a)
    apiRef.current = a
    if (first && a && activeRef.current) {
      applyStoredSnapshot(activeRef.current, activePageRef.current ?? 'main')
      ensureLetterSurface(activeRef.current, activePageRef.current ?? 'main')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const createPage = (kind: PageKind, name?: string) => {
    const roomId = activeRef.current
    if (!roomId) return
    const docs = [...docsRef.current]
    const doc = docs.find((d) => d.id === roomId)
    if (!doc) return
    const count = doc.pages.length + 1
    const date = todayName()
    const pg: PageMeta = {
      id: newPageId(),
      name: name ?? (kind === 'daily' ? (doc.pages.some((p) => p.name === date) ? `${date} · ${count}` : date) : kind === 'letter' ? `Letter ${count}` : `Board ${count}`),
      kind,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    doc.pages.push(pg)
    setDocsBoth(docs)
    broadcastPages()
    switchPage(pg.id)
  }

  // Visiting the Daily tab lands on today's page, creating it if missing.
  const switchFormat = (f: FormatTab) => {
    const roomId = activeRef.current
    if (!roomId) return
    const doc = docsRef.current.find((d) => d.id === roomId)
    if (!doc) return
    activeFormatRef.current = f
    setActiveFormat(f)
    const inFormat = doc.pages.filter((p) => formatOf(p) === f)
    if (inFormat.length) {
      switchPage(inFormat[inFormat.length - 1].id)
      return
    }
    if (f === 'daily') {
      createPage('daily')
    } else {
      createPage(f === 'letters' ? 'letter' : 'board')
    }
  }

  const ensureRoom = async (ticketStr: string, nickname: string, meta?: DocMeta): Promise<string> => {
    const node = nodeRef.current
    const ch = await node.join(ticketStr, nickname)
    const roomId: string = ch.id()
    const owner: string | null = (() => { try { return ch.owner?.() ?? null } catch { return null } })()
    if (!rooms.current.has(roomId)) {
      rooms.current.set(roomId, { ch, owner, live: new Map(), fwVersion: 0 })
      pumpRoom(roomId, ch)
    }
    // upsert doc meta (never clobber the local page list with an older one)
    const docs = [...docsRef.current]
    const i = docs.findIndex((d) => d.id === roomId)
    const entry: DocMeta = {
      id: roomId,
      owner: meta?.owner ?? owner ?? meta?.owner ?? null,
      name: meta?.name ?? docs[i]?.name ?? `doc-${roomId.slice(0, 6)}`,
      ticket: ticketStr,
      updatedAt: Date.now(),
      pages: meta?.pages?.length ? meta.pages : (docs[i]?.pages?.length ? docs[i].pages : [mainPage()]),
    }
    if (i >= 0) docs[i] = entry
    else docs.push(entry)
    setDocsBoth(docs)
    try { ch.sender.set_current_doc?.(presenceDoc()) } catch {}
    registerWithKeeper(ticketStr)
    return roomId
  }

  // A doc is an overarching topic. It starts with one board page;
  // letter and daily pages are added from the format tabs inside.
  const createDoc = async () => {
    const node = nodeRef.current
    if (!node) return
    if (activeRef.current) persistSnapshot(activeRef.current)
    const name = prompt('Topic name', `Topic ${docsRef.current.length + 1}`)
    if (name === null) return
    const ch = await node.create(nick.current)
    const roomId: string = ch.id()
    const owner: string = me.current
    rooms.current.set(roomId, { ch, owner, live: new Map() })
    pumpRoom(roomId, ch)
    const ticket = await ch.ticket({ includeMyself: true, includeBootstrap: true, includeNeighbors: true })
    setDocsBoth([...docsRef.current, { id: roomId, owner, name: name.trim() || `Topic ${docsRef.current.length + 1}`, ticket, updatedAt: Date.now(), pages: [mainPage()] }])
    try { ch.sender.set_current_doc?.(presenceDoc()) } catch {}
    switchDoc(roomId)
    await copyText(`${location.origin}${location.pathname}#t=${encodeURIComponent(ticket)}`)
    setStatus('new topic created — share link copied')
  }

  const pushCollaborators = () => {
    const a = apiRef.current
    if (!a) return
    const map = new Map()
    for (const [from, c] of Object.entries(cursors.current)) {
      map.set(from, {
        pointer: { x: c.x, y: c.y, tool: 'pointer' },
        button: 'up',
        username: dispNick(from, onlineRef.current[from] ?? peersRef.current[from]?.nick ?? from.slice(0, 6)),
      })
    }
    a.updateScene({ collaborators: map as any })
  }

  // boot: stable identity, then room from share link if present
  useEffect(() => {
    let dead = false
    ;(async () => {
      try {
        const DN: any = DrawNode
        const node = DN.spawn_with_key
          ? await DN.spawn_with_key(browserSecretHex(), RELAY_URL)
          : await DN.spawn()
        if (dead) return
        nodeRef.current = node
        const myId = node.endpoint_id() as string
        me.current = myId
        nick.current = 'peer-' + myId.slice(0, 6)
        setId(myId)
        setStatus('ready — create or join a doc')
        const ticket = new URLSearchParams(location.hash.slice(1)).get('t')
        if (ticket) {
          setStatus('joining…')
          const roomId = await ensureRoom(ticket, nick.current)
          if (dead) return
          switchDoc(roomId)
          sendMsg({ t: 'snap-req' })
          // Clear the ticket hash so refresh doesn't rejoin, but preserve
          // the query string (?debug=1, ?fresh=1 live there).
          history.replaceState(null, '', location.pathname + location.search)
        } else if (docsRef.current.length > 0 && docsRef.current[0].ticket) {
          // rejoin last doc(s) live: keep other documents live as well
          for (const d of docsRef.current) {
            if (!d.ticket) continue
            try {
              const rid = await ensureRoom(d.ticket, nick.current, d)
              if (dead) return
              if (!activeRef.current) switchDoc(rid)
            } catch {}
          }
          if (activeRef.current) sendMsg({ t: 'snap-req' })
        }
      } catch (e) {
        if (!dead) setStatus(`init failed: ${e}`)
      }
    })()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // persist canvas debounced per active doc
  useEffect(() => {
    const t = window.setInterval(() => { if (activeRef.current) persistSnapshot(activeRef.current) }, 3000)
    return () => clearInterval(t)
  }, [])

  // DEBUG-only console hook for the e2e sandbox (draw/add/delete/verify).
  useEffect(() => {
    if (!DEBUG) return
    ;(window as any).__draw = {
      scene: () => (apiRef.current?.getSceneElements() ?? []).map((el: any) => ({ id: el.id, type: el.type, v: el.version, del: !!el.isDeleted })),
      addRect: () => {
        const a = apiRef.current
        if (!a) return null
        const id = 'e2e-' + Math.random().toString(36).slice(2, 10)
        const el = { id, type: 'rectangle', x: 100, y: 100, width: 200, height: 100, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, roundness: { type: 3 }, boundElements: [], link: null, locked: false, index: null, version: 1, versionNonce: Math.floor(Math.random() * 2 ** 31), isDeleted: false, groupIds: [], frameId: null } as any
        a.updateScene({ elements: [...a.getSceneElements(), el] })
        return id
      },
      del: (id: string) => {
        const a = apiRef.current
        if (!a) return
        a.updateScene({ elements: (a.getSceneElements() as any[]).filter((el) => el.id !== id) })
      },
      collabPing: () => {
        cursors.current['probe'] = { x: 1, y: 1, at: Date.now() }
        pushCollaborators()
      },
      meta: () => [...metaActive.current.entries()].map(([id, e]) => ({ id, ...e })),
      tombs: () => [...tombsActive.current.entries()].map(([id, e]) => ({ id, ...e })),
      stats: () => JSON.parse(JSON.stringify(stats.current)),
      lastPush: () => lastPush.current,
      fetchErr: () => fetchErr.current,
      lastFetch: () => lastFetch.current,
      flushCount: () => flushCount.current,
      apiCalls: () => apiCalls.current,
      usLog: () => usLog.current,
      counts: () => ({ vanish: vanishCount.current, persist: persistCount.current, flush: flushCount.current, changes: changeCount.current, lastSeen: lastSeenCount.current, seenHist: seenHist.current }),
      diag: () => ({
        meta: metaActive.current.size,
        tombs: tombsActive.current.size,
        known: knownIds.current.size,
        pending: pendingRef.current ? pendingRef.current.map.size : -1,
        scene: (apiRef.current?.getSceneElements() ?? []).length,
      }),
      lsGet: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
    }
    return () => { try { delete (window as any).__draw } catch {} }
  }, [])

  // flush outbound drawing batches ~16/s
  useEffect(() => {
    const t = window.setInterval(flushDirty, 60)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // prune stale cursors + owner liveness
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now()
      let changed = false
      for (const [k, c] of Object.entries(cursors.current)) {
        if (now - c.at > 3000) { delete cursors.current[k]; changed = true }
      }
      if (changed) pushCollaborators()
      refreshOwnerLive()
      // Expire the visible roster from the same liveness timestamps —
      // gossip NeighborDown can lag death by ~30s, so without this the
      // "live here" list lies long after a peer is gone.
      const room = activeRef.current ? rooms.current.get(activeRef.current) : undefined
      if (room) {
        let rosterChanged = false
        for (const k of Object.keys(onlineRef.current)) {
          if (now - (room.live.get(k) ?? 0) > 12000) { delete onlineRef.current[k]; rosterChanged = true }
        }
        if (rosterChanged) setOnline({ ...onlineRef.current })
      }
    }, 1000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // debug drawer data (rendered only when open; skipped entirely in prod)
  useEffect(() => {
    if (!DEBUG) return
    const t = window.setInterval(() => {
      const now = Date.now()
      times.current = times.current.filter((ts) => now - ts < 2000)
      const s = stats.current
      const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ') || '—'
      setDbg(
        `eps=${(times.current.length / 2).toFixed(1)} (2s window)\nsent: ${fmt(s.sent)}\nrecv: ${fmt(s.recv)}\nstale: ${s.stale} poison: ${s.poison} maxOut: ${s.maxOut}B\nerr: ${s.lastErr}\nonline: ${Object.keys(onlineRef.current).length} me: ${me.current.slice(0, 8)}\nrooms: ${rooms.current.size} active: ${(activeRef.current ?? '—').slice(0, 8)} owner: ${(rooms.current.get(activeRef.current ?? '')?.owner ?? '—').slice(0, 8)}`,
      )
    }, 500)
    return () => clearInterval(t)
  }, [])

  // Outbound batching: freedraw fires onChange at pointer-move rate with
  // ever-growing element payloads. Accumulate latest-version-per-id and
  // flush ~16/s instead of broadcasting every event (60ms keeps remote
  // strokes looking smooth; inbound rAF coalescing handles the rest).
  const dirtyRef = useRef(new Map<string, any>())
  const dirtyFilesRef = useRef(new Map<string, any>())
  const sentFiles = useRef<Set<string>>(new Set())
  // Gossip cap is 256KB and oversize sends fail silently — stay well under.
  const MAX_MSG = 180 * 1024

  // Files for image elements, from the local files map. Only ones we
  // haven't already broadcast (unless force, e.g. answering a snap-req
  // from a newcomer who missed them).
  const collectFilesFor = (elements: any[], force = false): any[] => {
    const a = apiRef.current
    if (!a) return []
    let all: Record<string, any> = {}
    try { all = a.getFiles() ?? {} } catch { return [] }
    const out: any[] = []
    for (const el of elements) {
      const fid = el?.fileId
      if (!fid || (!force && sentFiles.current.has(fid))) continue
      const f = all[fid]
      if (f) { out.push(f); sentFiles.current.add(fid) }
    }
    return out
  }
  const ingestFiles = (files: any[]) => {
    const a = apiRef.current
    if (!a || !Array.isArray(files) || !files.length) return
    try {
      a.addFiles(files)
      for (const f of files) if (f?.id) sentFiles.current.add(f.id)
    } catch {}
  }
  const flushDirty = () => {
    if (!dirtyRef.current.size && !dirtyFilesRef.current.size && !dirtyTombs.current.size) return
    if (!me.current || !activeCh()) return
    const els = [...dirtyRef.current.values()]
    dirtyRef.current.clear()
    const files = [...dirtyFilesRef.current.values()]
    dirtyFilesRef.current.clear()
    const tombs = [...dirtyTombs.current.entries()].map(([id, e]) => ({ id, v: e.v, ts: e.ts, author: e.author }))
    dirtyTombs.current.clear()
    // Claim metadata rides alongside (compact): receivers merge by
    // (version, ts, author) instead of trusting arrival order.
    const meta: Record<string, [number, string]> = {}
    for (const el of els) {
      const m = metaActive.current.get(el.id)
      if (m) meta[el.id] = [m.ts, m.author]
    }
    if (!files.length && !tombs.length) {
      if (els.length) sendMsg({ t: 'p', elements: els, meta })
      return
    }
    const body = { t: 'p', elements: els, meta, tombs }
    if (!files.length) {
      sendMsg(body)
      return
    }
    const inline = JSON.stringify(files).length + JSON.stringify(body).length < MAX_MSG
    if (inline) {
      sendMsg({ ...body, files })
    } else {
      if (els.length || tombs.length) sendMsg(body)
      for (const f of files) {
        if (JSON.stringify(f).length > MAX_MSG) {
          setStatus('image too large to sync (>180KB)')
          continue
        }
        sendMsg({ t: 'f', files: [f] })
      }
    }
  }

  const onChange = (elements: readonly OrderedExcalidrawElement[], _appState: any, files: Record<string, any>) => {
    changeCount.current += 1
    lastSeenCount.current = (elements as any[]).length
    seenHist.current.push((elements as any[]).length)
    if (seenHist.current.length > 12) seenHist.current.shift()
    if (remote.current || !me.current || !activeCh()) return
    const now = Date.now()
    let touched = false
    const seen = new Set<string>()
    for (const el of elements as any[]) {
      seen.add(el.id)
      if (sentVersions.current[el.id] === el.version) continue
      sentVersions.current[el.id] = el.version
      metaActive.current.set(el.id, { v: el.version, ts: now, author: me.current })
      if (tombsActive.current.has(el.id)) tombsActive.current.delete(el.id)
      if (dirtyTombs.current.has(el.id)) dirtyTombs.current.delete(el.id)
      const prev = dirtyRef.current.get(el.id)
      if (!prev || el.version >= prev.version) dirtyRef.current.set(el.id, el)
      touched = true
      // Image element changed version (pasted, moved, resized): make sure
      // its binary rides along at flush time.
      const fid = (el as any)?.fileId
      if (fid && !sentFiles.current.has(fid) && files?.[fid]) {
        dirtyFilesRef.current.set(fid, files[fid])
      }
    }
    // Vanished ids stage (never mint inline — see confirmVanish). A genuine
    // local delete is still missing at the delayed re-scan of the live scene.
    for (const id of knownIds.current) {
      if (seen.has(id)) {
        if (pendingVanish.current.has(id)) pendingVanish.current.delete(id)
        continue
      }
      if (!pendingVanish.current.has(id)) {
        const lastV = sentVersions.current[id] ?? metaActive.current.get(id)?.v ?? 0
        pendingVanish.current.set(id, { v: lastV + 1 })
        window.setTimeout(confirmVanish, 500)
      }
    }
    knownIds.current = seen
    if (touched && dirtyRef.current.size > 200) flushDirty() // backpressure: huge burst flushes early
  }

  const onPointerUpdate = (payload: { pointer: { x: number; y: number } }) => {
    const now = Date.now()
    if (now - lastPtr.current < 80 || !me.current || !activeCh()) return
    lastPtr.current = now
    sendMsg({ t: 'cursor', x: payload.pointer.x, y: payload.pointer.y })
  }

  // Tickets without relay hints are undialable (the exact
  // "No addressing information available" failure). The home relay takes
  // a few seconds to settle after boot, so wait for it before minting.
  const awaitRelay = async (tries = 16) => {
    for (let i = 0; i < tries; i++) {
      try {
        if (nodeRef.current?.relay_url?.()) return true
      } catch {}
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  const share = async () => {
    const room = activeRef.current ? rooms.current.get(activeRef.current) : null
    if (!room) return
    try {
      setStatus('waiting for relay…')
      await awaitRelay()
      const ticket = await room.ch.ticket({ includeMyself: true, includeBootstrap: true, includeNeighbors: true })
      await copyText(`${location.origin}${location.pathname}#t=${encodeURIComponent(ticket)}`)
      // refresh stored ticket
      const docs = docsRef.current.map((d) => (d.id === activeRef.current ? { ...d, ticket, updatedAt: Date.now() } : d))
      setDocsBoth(docs)
      setStatus('share link copied — send it')
    } catch (e) {
      setStatus(`share failed: ${e}`)
    }
  }

  const panel: React.CSSProperties = {
    position: 'absolute', right: 12, bottom: 64, zIndex: 999, width: 300, maxHeight: '70vh', overflowY: 'auto',
    background: 'rgba(255,255,255,.94)', color: '#1a1d26', padding: 12, borderRadius: 14,
    boxShadow: '0 8px 32px #0003', backdropFilter: 'blur(8px)',
    border: '1px solid #00000014', fontSize: 13, fontFamily: 'system-ui',
  }
  // Connection state for the status pill: red = offline, yellow = working,
  // green = in a room.
  const conn: 'off' | 'busy' | 'on' =
    !id || /failed/i.test(status) ? 'off'
    : !activeId || /starting|joining|ready/i.test(status) ? 'busy'
    : 'on'
  const connColor = conn === 'on' ? '#30a46c' : conn === 'busy' ? '#f5a524' : '#e5484d'
  const pill: React.CSSProperties = {
    position: 'absolute', right: 12, bottom: 12, zIndex: 1000,
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'rgba(255,255,255,.94)', color: '#1a1d26', padding: '8px 14px', borderRadius: 999,
    boxShadow: '0 8px 32px #0003', backdropFilter: 'blur(8px)',
    border: '1px solid #00000014', fontSize: 13, fontFamily: 'system-ui', fontWeight: 700,
    cursor: 'pointer',
  }
  const btn: React.CSSProperties = {
    background: '#eef0f6', color: '#1a1d26', border: '1px solid #00000014',
    borderRadius: 999, padding: '5px 12px', margin: '2px 4px 2px 0', cursor: 'pointer', fontSize: 13,
  }
  const input: React.CSSProperties = {
    width: '100%', margin: '6px 0', background: '#fff', color: '#1a1d26',
    border: '1px solid #00000022', borderRadius: 8, padding: '5px 8px', fontSize: 12,
  }
  const names = Object.entries(online)
  const activeDoc = docs.find((d) => d.id === activeId)
  const knownPeers = Object.entries(peers).sort((a, b) => b[1].lastSeen - a[1].lastSeen).slice(0, 30)
  const timeAgo = (ts: number) => {
    const s = Math.floor((Date.now() - ts) / 1000)
    if (s < 5) return 'now'
    if (s < 60) return `${s}s ago`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    return `${Math.floor(m / 60)}h ago`
  }
  const peersOnDoc = (docId: string) =>
    Object.entries(peers).filter(([, p]) => parsePresenceDoc(p.doc).doc === docId)
  const myDocs = docs.filter((d) => d.owner === id)
  const sharedDocs = docs.filter((d) => d.owner !== id)

  const overlayBack: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(18,20,28,.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    fontFamily: 'system-ui',
  }
  const sheet: React.CSSProperties = {
    background: '#fff', color: '#1a1d26', borderRadius: 20, padding: 20,
    width: 'min(760px, 94vw)', maxHeight: '86vh', overflowY: 'auto',
    boxShadow: '0 24px 80px #0008',
  }
  const cardGrid: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12,
  }
  const card: React.CSSProperties = {
    border: '1px solid #00000014', borderRadius: 16, padding: 14, cursor: 'pointer',
    background: '#f7f8fc',
  }
  const cardActive: React.CSSProperties = { ...card, border: '2px solid #1a1d26', background: '#fff' }
  const tabBtn = (active: boolean): React.CSSProperties => ({
    ...btn, background: active ? '#1a1d26' : '#eef0f6', color: active ? '#fff' : '#1a1d26',
    fontWeight: 700,
  })

  const openDoc = (roomId: string) => {
    switchDoc(roomId)
    setView(null)
  }
  const joinTicket = async () => {
    setShowAdd(false)
    setStatus('joining…')
    try {
      const roomId = await ensureRoom(peer.trim(), nick.current)
      switchDoc(roomId)
      sendMsg({ t: 'snap-req' })
      setPeer('')
      setView(null)
    } catch (e) { setStatus(`join failed: ${e}`) }
  }

  const renderTopicCards = (list: DocMeta[]) => (
    <div style={cardGrid}>
      {list.map((d) => {
        const access = peersOnDoc(d.id)
        const live = rooms.current.get(d.id)?.live.size ?? 0
        const counts = (['board', 'letters', 'daily'] as FormatTab[]).map(
          (f) => d.pages.filter((p) => formatOf(p) === f).length,
        )
        return (
          <div key={d.id} style={d.id === activeId ? cardActive : card} onClick={() => openDoc(d.id)}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{d.name}{d.owner === id ? ' ★' : ''}</div>
            <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 6 }}>
              {counts[0]} board · {counts[1]} letters · {counts[2]} daily
              {live > 0 && ` · ${live} live`}
            </div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {d.owner === id ? 'owned by you' : `owner ${d.owner?.slice(0, 6) ?? '?'}`}
              {access.length > 0 && (
                <span> · {access.slice(0, 4).map(([pid, p]) => dispNick(pid, p.nick)).join(', ')}{access.length > 4 ? ` +${access.length - 4}` : ''}</span>
              )}
            </div>
          </div>
        )
      })}
      <div style={{ ...card, borderStyle: 'dashed', display: 'flex', flexDirection: 'column', gap: 8, cursor: 'default' }}>
        <button style={btn} onClick={createDoc}>+ new topic</button>
        {!showAdd
          ? <button style={btn} onClick={() => setShowAdd(true)}>⤵ join with ticket</button>
          : (
            <div>
              <input placeholder="paste ticket…" value={peer} onChange={(e) => setPeer(e.target.value)} style={input} />
              <button style={btn} onClick={joinTicket}>join</button>
            </div>
          )}
      </div>
    </div>
  )

  const renderPeers = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {knownPeers.length === 0 && <div style={{ opacity: 0.6 }}>No peers seen yet — share a ticket to connect.</div>}
      {knownPeers.map(([pid, p]) => {
        const pd = parsePresenceDoc(p.doc)
        const pgName = pd.page ? (activeDocPages().find((x) => x.id === pd.page)?.name ?? pd.page.slice(0, 6)) : null
        const onActiveDoc = pd.doc === activeId
        const iOwn = !!activeDoc && activeDoc.owner === id
        return (
          <div key={pid} style={{ ...card, cursor: 'default', display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              key={pid + ':' + (aliases[pid] ?? '')}
              defaultValue={aliases[pid] ?? ''}
              placeholder={p.nick}
              title="nickname (stored locally, only you see it)"
              style={{ ...input, margin: 0, width: 130 }}
              onBlur={(e) => setAlias(pid, e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            />
            <div style={{ fontSize: 12, opacity: 0.75, flex: 1 }}>
              {p.nick} · {timeAgo(p.lastSeen)}
              {pd.doc ? ` · ${pd.doc.slice(0, 6)}` : ''}{pgName ? `/${pgName}` : ''}
              {p.hasAccess === false && <span style={{ color: '#e5484d' }}> · revoked</span>}
            </div>
            {iOwn && onActiveDoc && (
              <button
                style={{ ...btn, padding: '1px 8px', fontSize: 11 }}
                title={p.hasAccess === false ? 'allow back onto this doc' : 'revoke access to this doc'}
                onClick={() => activeId && setFwRule(activeId, pid, p.hasAccess === false)}
              >{p.hasAccess === false ? 'allow' : 'revoke'}</button>
            )}
          </div>
        )
      })}
    </div>
  )
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Excalidraw
        excalidrawAPI={onApi}
        onChange={onChange}
        onPointerUpdate={onPointerUpdate}
        isCollaborating
        renderTopRightUI={() => null}
      />
      <button style={pill} onClick={() => setView('topics')} title={status}>
        <span style={{ width: 10, height: 10, borderRadius: 999, background: connColor, display: 'inline-block' }} />
        ✦ live draw
        <span style={{ fontWeight: 400, opacity: 0.65, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {activeDoc ? `${activeDoc.name}` : status}
        </span>
      </button>
      <button
        style={{ ...pill, right: undefined, left: 12, padding: '8px 12px' }}
        onClick={() => setView((v) => (v === 'tools' ? null : 'tools'))}
        title="canvas tools"
      >⋯</button>
      {view === 'tools' && (
      <div style={{ ...panel, left: 12, right: undefined }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>✦ tools</div>
        {activeDoc && (
          <div style={{ marginBottom: 6 }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              {(['board', 'letters', 'daily'] as FormatTab[]).map((f) => (
                <button
                  key={f}
                  style={{ ...btn, background: activeFormat === f ? '#1a1d26' : '#eef0f6', color: activeFormat === f ? '#fff' : '#1a1d26' }}
                  onClick={() => switchFormat(f)}
                >
                  {f === 'board' ? '◻ board' : f === 'letters' ? '▤ letters' : '📅 daily'}
                </button>
              ))}
              <button
                style={btn}
                title={activeFormat === 'daily' ? 'new dated page' : activeFormat === 'letters' ? 'new letter' : 'new board page'}
                onClick={() => createPage(activeFormat === 'letters' ? 'letter' : activeFormat === 'daily' ? 'daily' : 'board')}
              >+</button>
            </div>
            {activeDoc.pages.filter((p) => formatOf(p) === activeFormat).length > 1 && (
              <select
                value={activePage ?? ''}
                onChange={(e) => switchPage(e.target.value)}
                style={{ ...input, margin: 0 }}
              >
                {activeDoc.pages.filter((p) => formatOf(p) === activeFormat).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
          </div>
        )}
        {names.length > 0 && (
          <div style={{ opacity: 0.75, marginBottom: 4 }}>
            live here: {names.map(([pid, n]) => dispNick(pid, n)).join(', ')}
          </div>
        )}
        <div style={{ marginTop: 6 }}>
          <button disabled={!id || !activeId} style={btn} onClick={share}>⧉ share</button>
          <button style={btn} onClick={() => {
            sendMsg({ t: 'pull' })
            setStatus('pulling from owner…')
          }}>⟳ sync</button>
          <button style={btn} onClick={async () => {
            await copyText(JSON.stringify(apiRef.current?.getSceneElements() ?? []))
            alert('Copied JSON — paste into any agent')
          }}>agent JSON</button>
          <button style={btn} onClick={async () => {
            const a = apiRef.current
            if (!a) return
            const svg = await exportToSvg({ elements: a.getSceneElements(), appState: a.getAppState(), files: a.getFiles() })
            await copyText(svg.outerHTML)
            alert('Copied SVG')
          }}>SVG</button>
        </div>
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 12 }}>{status}{activeDoc ? ` · ${activeDoc.name}` : ''}{activePage ? ` / ${activeDoc?.pages.find((p) => p.id === activePage)?.name ?? ''}` : ''}</div>
        {DEBUG && <div style={{ opacity: 0.6, marginTop: 2, fontSize: 12 }}>💾 {saveInfo}</div>}
        {DEBUG && <button style={btn} onClick={() => setShowDbg((s) => !s)}>debug</button>}
        {DEBUG && <button style={btn} onClick={() => {
          try {
            Object.keys(localStorage).filter((k) => k.startsWith('draw.')).forEach((k) => localStorage.removeItem(k))
            sessionStorage.removeItem('draw.tab')
          } catch {}
          location.hash = ''
          location.reload()
        }}>clear cache</button>}
        {DEBUG && showDbg && (
          <pre style={{ fontSize: 10, fontFamily: 'monospace', background: '#0d0f16', color: '#9fe', borderRadius: 8, padding: 8, marginTop: 4, whiteSpace: 'pre-wrap' }}>{dbg}</pre>
        )}
      </div>
      )}
      {(view === 'topics' || view === 'peers') && (
        <div style={overlayBack} onClick={() => setView(null)}>
          <div style={sheet} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
              <button style={tabBtn(view === 'topics')} onClick={() => setView('topics')}>Topics</button>
              <button style={tabBtn(view === 'peers')} onClick={() => setView('peers')}>Peers</button>
              <span style={{ flex: 1 }} />
              <button style={btn} onClick={() => setView(null)}>✕</button>
            </div>
            {view === 'topics' && (
              <div>
                {myDocs.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontWeight: 700, marginBottom: 8 }}>My topics</div>
                    {renderTopicCards(myDocs)}
                  </div>
                )}
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>Shared with me</div>
                  {sharedDocs.length > 0
                    ? renderTopicCards(sharedDocs)
                    : (myDocs.length === 0 ? renderTopicCards([]) : (
                      <div style={{ opacity: 0.6, fontSize: 13 }}>Nothing shared yet.</div>
                    ))}
                </div>
              </div>
            )}
            {view === 'peers' && renderPeers()}
          </div>
        </div>
      )}
    </div>
  )
}
