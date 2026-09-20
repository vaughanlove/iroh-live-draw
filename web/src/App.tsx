import { useEffect, useRef, useState } from 'react'
import { Excalidraw, reconcileElements, exportToSvg } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI, OrderedExcalidrawElement } from '@excalidraw/excalidraw/types'
import nacl from 'tweetnacl'
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
type PeerInfo = { nick: string; lastSeen: number; doc?: string | null }

const LS_SECRET = 'draw.secret'
const LS_DOCS = 'draw.docs'
const LS_PEERS = 'draw.peers'
const LS_PAGE = 'draw.activepage'
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

// Identity: stable per browser (localStorage) but derived per tab
// (sessionStorage), so two tabs in the same browser get distinct endpoint
// IDs and can gossip with each other. Same-tab reloads keep their ID
// (sessionStorage survives reload); cross-device stays distinct.
const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.trim().toLowerCase().replace(/^0x/, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}
const bytesToHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const randomHex = (n: number): string => {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return bytesToHex(b)
}
const tabSecretHex = (): string => {
  let base = localStorage.getItem(LS_SECRET)
  if (!base || !/^[0-9a-fA-F]{64}$/.test(base.trim())) {
    base = randomHex(32)
    try { localStorage.setItem(LS_SECRET, base) } catch {}
  }
  let tab = sessionStorage.getItem(SS_TAB)
  if (!tab) {
    tab = randomHex(8)
    try { sessionStorage.setItem(SS_TAB, tab) } catch {}
  }
  const enc = new TextEncoder()
  const input = new Uint8Array([...hexToBytes(base), ...enc.encode(tab)])
  return bytesToHex(nacl.hash(input).slice(0, 32))
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
  const restored = useRef<Set<string>>(new Set())
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
  // docId -> { ch, owner, live:Set<peerId> }
  const rooms = useRef(new Map<string, { ch: any; owner: string | null; live: Map<string, number> }>())
  const activeRef = useRef<string | null>(null)
  const activePageRef = useRef<string | null>(null)
  const activeFormatRef = useRef<FormatTab>('board')
  const docsRef = useRef<DocMeta[]>(loadDocs())
  const sentVersions = useRef<Record<string, number>>({})

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
    const next = { ...peersRef.current, [from]: { nick: nickname || prev.nick || from.slice(0, 6), lastSeen: Date.now(), doc: doc ?? prev.doc ?? null } }
    setPeersBoth(next)
  }

  const activeCh = () => (activeRef.current ? rooms.current.get(activeRef.current)?.ch ?? null : null)

  const sendMsg = (obj: any) => {
    const ch = activeCh()
    if (!ch) return
    bump('sent', obj?.t ?? '?')
    const s = JSON.stringify({ from: me.current, epoch: epoch.current, seq: seq.current++, page: activePageRef.current ?? 'main', ...obj })
    if (s.length > stats.current.maxOut) stats.current.maxOut = s.length
    ch.sender.broadcast(s).catch(() => bump('sent', 'drop'))
  }

  // Merge elements into a background page's stored snapshot (id-merge,
  // version wins) so pages you're not viewing still converge.
  const mergePageSnapshot = (docId: string, page: string, elements: any[], files: any[]) => {
    try {
      if (Array.isArray(files) && files.length) {
        const fraw = localStorage.getItem(filesKey(docId, page))
        const fmap = fraw ? JSON.parse(fraw) : {}
        for (const f of files) if (f?.id) fmap[f.id] = f
        try { localStorage.setItem(filesKey(docId, page), JSON.stringify(fmap)) } catch {}
      }
      const raw = localStorage.getItem(snapKey(docId, page))
      const cur = raw ? JSON.parse(raw) : []
      const map = new Map<string, any>()
      if (Array.isArray(cur)) for (const el of cur) map.set(el.id, el)
      for (const el of elements) {
        const prev = map.get(el.id)
        if (!prev || (el.version ?? 0) >= (prev.version ?? 0)) map.set(el.id, el)
      }
      localStorage.setItem(snapKey(docId, page), JSON.stringify([...map.values()]))
    } catch {}
  }

  const applyRemote = (elements: any[], asIs: boolean) => {
    const a = apiRef.current
    if (!a || !Array.isArray(elements)) return
    remote.current = true
    try {
      if (asIs) {
        a.updateScene({ elements: elements as OrderedExcalidrawElement[], commitToHistory: false })
      } else {
        a.updateScene({ elements: reconcileElements(a.getSceneElements(), elements, a.getAppState()) })
      }
      for (const el of a.getSceneElements()) sentVersions.current[el.id] = el.version
    } finally {
      remote.current = false
    }
  }

  // Inbound coalescing: drawing messages can arrive at pointer-move rate.
  // Merge them and reconcile at most once per animation frame instead of
  // once per message (each reconcile is O(scene) — this is what lags after
  // ~10s of continuous strokes on a grown canvas).
  const pendingRef = useRef<{ map: Map<string, any>; asIs: boolean } | null>(null)
  const rafRef = useRef(0)
  const flushPending = () => {
    rafRef.current = 0
    const p = pendingRef.current
    pendingRef.current = null
    if (!p) return
    applyRemote([...p.map.values()], p.asIs)
  }
  const queueRemote = (elements: any[], asIs: boolean) => {
    const p = asIs || !pendingRef.current
      ? { map: new Map<string, any>(), asIs }
      : pendingRef.current!
    if (asIs) p.asIs = true
    for (const el of elements) {
      const prev = p.map.get(el.id)
      if (!prev || (el.version ?? 0) >= (prev.version ?? 0)) p.map.set(el.id, el)
    }
    pendingRef.current = p
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushPending)
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

  const onRoomEvent = (roomId: string, ev: any) => {
    if (!ev || typeof ev.type !== 'string') return
    if (ev.type === 'presence') {
      setPresence(roomId, String(ev.from), ev.nickname, ev.doc ?? null)
      return
    }
    if (ev.type === 'neighborUp') {
      setPresence(roomId, String(ev.endpoint_id ?? ev.endpointId ?? ''), '', null)
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
      return
    }
    if (ev.type === 'messageReceived') {
      let m: any
      try { m = JSON.parse(ev.text) } catch { return }
      bump('recv', m?.t ?? '?')
      const from = String(ev.from ?? m.from ?? '')
      if (from === me.current) return
      // Ignore drawing traffic for background rooms (still track presence)
      if (roomId !== activeRef.current && (m?.t === 'p' || m?.t === 'f' || m?.t === 'snap' || m?.t === 'snap-req' || m?.t === 'cursor' || m?.t === 'pages')) return
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
        else mergePageSnapshot(roomId, msgPage, [], m.files ?? [])
        return
      }
      if (m?.t === 'p') {
        if (typeof m.seq === 'number' && m.from) {
          const key = `${m.from}:${m.epoch ?? 0}`
          if (m.seq <= (lastSeq.current[key] ?? -1)) { stats.current.stale++; return }
          lastSeq.current[key] = m.seq
        }
        if (isActivePage) {
          if (Array.isArray(m.files)) ingestFiles(m.files)
          if (Array.isArray(m.elements)) queueRemote(m.elements, false)
        } else if (Array.isArray(m.elements)) {
          mergePageSnapshot(roomId, msgPage, m.elements, m.files ?? [])
        }
      } else if (m?.t === 'snap-req') {
        // Answer with elements + their binaries (forced: the requester is
        // usually a newcomer who missed the original file broadcasts).
        // Honors the requested page; falls back to our active page.
        const want = typeof m.page === 'string' && m.page !== (activePageRef.current ?? 'main') ? m.page : null
        let els: any[]
        let files: any[]
        if (want) {
          try {
            const raw = localStorage.getItem(snapKey(roomId, want))
            els = raw ? JSON.parse(raw) : []
          } catch { els = [] }
          try {
            const fraw = localStorage.getItem(filesKey(roomId, want))
            files = Object.values(fraw ? JSON.parse(fraw) : {})
          } catch { files = [] }
        } else {
          els = apiRef.current?.getSceneElements() ?? []
          files = collectFilesFor(els, true)
        }
        if (JSON.stringify(files).length + JSON.stringify(els).length < MAX_MSG) {
          sendMsg({ t: 'snap', elements: els, files, page: want ?? activePageRef.current ?? 'main' })
        } else {
          sendMsg({ t: 'snap', elements: els, page: want ?? activePageRef.current ?? 'main' })
          for (const f of files) {
            if (JSON.stringify(f).length > MAX_MSG) continue
            sendMsg({ t: 'f', files: [f], page: want ?? activePageRef.current ?? 'main' })
          }
        }
      } else if (m?.t === 'snap') {
        if (isActivePage) {
          if (Array.isArray(m.files)) ingestFiles(m.files)
          if (Array.isArray(m.elements)) queueRemote(m.elements, true)
        } else if (Array.isArray(m.elements)) {
          mergePageSnapshot(roomId, msgPage, m.elements, m.files ?? [])
        }
      }
    }
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
      const raw = localStorage.getItem(snapKey(roomId, pg))
      const els = raw ? JSON.parse(raw) : []
      if (Array.isArray(els)) {
        remote.current = true
        try { apiRef.current.updateScene({ elements: els, commitToHistory: false }) } finally { remote.current = false }
        for (const el of apiRef.current.getSceneElements()) sentVersions.current[el.id] = el.version
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
    sendMsg({ t: 'snap-req' })
  }

  const switchPage = (pageId: string) => {
    const roomId = activeRef.current
    if (!roomId || pageId === activePageRef.current) return
    flushDirty()
    persistSnapshot(roomId)
    activePageRef.current = null // park: outgoing persist/announce use explicit ids below
    cursors.current = {}
    sentVersions.current = {}
    sentFiles.current = new Set()
    dirtyFilesRef.current.clear()
    pendingRef.current = null
    setActivePageBoth(roomId, pageId)
    applyStoredSnapshot(roomId, pageId)
    ensureLetterSurface(roomId, pageId)
    for (const [, r] of rooms.current) {
      try { r.ch.sender.set_current_doc?.(presenceDoc()) } catch {}
    }
    sendMsg({ t: 'snap-req' })
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
    try { a.updateScene({ elements: [...a.getSceneElements(), frame] }) } finally { remote.current = false }
    try { a.scrollToContent([frame] as any, { animate: true } as any) } catch {}
  }

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
      rooms.current.set(roomId, { ch, owner, live: new Map() })
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
    const ticket = ch.ticket({ includeMyself: true, includeBootstrap: true, includeNeighbors: true })
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
        username: (onlineRef.current[from] ?? peersRef.current[from]?.nick ?? from.slice(0, 6)),
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
          ? await DN.spawn_with_key(tabSecretHex())
          : await DN.spawn()
        if (dead) return
        nodeRef.current = node
        // NOTE: do NOT persist node.secret_key() — it is the per-tab
        // derived key; the base secret is managed by tabSecretHex().
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
          history.replaceState(null, '', location.pathname)
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
    if (!dirtyRef.current.size && !dirtyFilesRef.current.size) return
    if (!me.current || !activeCh()) return
    if (!ownerIsLive()) return // owner offline → edits stop
    const els = [...dirtyRef.current.values()]
    dirtyRef.current.clear()
    const files = [...dirtyFilesRef.current.values()]
    dirtyFilesRef.current.clear()
    if (!files.length) {
      if (els.length) sendMsg({ t: 'p', elements: els })
      return
    }
    // Attach files inline when small; otherwise send elements first and
    // follow with one 'f' message per file so nothing exceeds the cap.
    const inline = JSON.stringify(files).length + JSON.stringify(els).length < MAX_MSG
    if (inline) {
      sendMsg({ t: 'p', elements: els, files })
    } else {
      if (els.length) sendMsg({ t: 'p', elements: els })
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
    if (remote.current || !me.current || !activeCh()) return
    if (!ownerLive) return // owner offline → edits stop (flush rechecks live)
    let touched = false
    for (const el of elements as any[]) {
      if (sentVersions.current[el.id] === el.version) continue
      sentVersions.current[el.id] = el.version
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
    if (touched && dirtyRef.current.size > 200) flushDirty() // backpressure: huge burst flushes early
  }

  const onPointerUpdate = (payload: { pointer: { x: number; y: number } }) => {
    const now = Date.now()
    if (now - lastPtr.current < 80 || !me.current || !activeCh()) return
    lastPtr.current = now
    sendMsg({ t: 'cursor', x: payload.pointer.x, y: payload.pointer.y })
  }

  const share = async () => {
    const room = activeRef.current ? rooms.current.get(activeRef.current) : null
    if (!room) return
    try {
      const ticket = room.ch.ticket({ includeMyself: true, includeBootstrap: true, includeNeighbors: true })
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
    position: 'absolute', top: 12, left: 12, zIndex: 999, maxWidth: 300,
    background: 'rgba(255,255,255,.92)', color: '#1a1d26', padding: 12, borderRadius: 14,
    boxShadow: '0 8px 32px #0003', backdropFilter: 'blur(8px)',
    border: '1px solid #00000014', fontSize: 13, fontFamily: 'system-ui',
  }
  const btn: React.CSSProperties = {
    background: '#eef0f6', color: '#1a1d26', border: '1px solid #00000014',
    borderRadius: 999, padding: '5px 12px', margin: '2px 4px 2px 0', cursor: 'pointer', fontSize: 13,
  }
  const input: React.CSSProperties = {
    width: '100%', margin: '6px 0', background: '#fff', color: '#1a1d26',
    border: '1px solid #00000022', borderRadius: 8, padding: '5px 8px', fontSize: 12,
  }
  const names = Object.values(online)
  const activeDoc = docs.find((d) => d.id === activeId)
  const knownPeers = Object.entries(peers).sort((a, b) => b[1].lastSeen - a[1].lastSeen).slice(0, 12)
  const timeAgo = (ts: number) => {
    const s = Math.floor((Date.now() - ts) / 1000)
    if (s < 5) return 'now'
    if (s < 60) return `${s}s ago`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    return `${Math.floor(m / 60)}h ago`
  }
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Excalidraw
        excalidrawAPI={(a) => { setApi(a); apiRef.current = a; if (activeRef.current) { applyStoredSnapshot(activeRef.current, activePageRef.current ?? 'main'); ensureLetterSurface(activeRef.current, activePageRef.current ?? 'main') } }}
        onChange={onChange}
        onPointerUpdate={onPointerUpdate}
        isCollaborating
      />
      <div style={panel}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>✦ live draw</div>
        {!ownerLive && (
          <div style={{ background: '#fff3cd', border: '1px solid #ffe08a', borderRadius: 8, padding: '4px 8px', marginBottom: 6 }}>
            owner offline — view only
          </div>
        )}
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          <button style={btn} onClick={createDoc}>+ topic</button>
          <button style={btn} onClick={() => setShowAdd((s) => !s)}>⤵ join</button>
        </div>
        {docs.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            {docs.map((d) => (
              <button
                key={d.id}
                style={{ ...btn, background: d.id === activeId ? '#1a1d26' : '#eef0f6', color: d.id === activeId ? '#fff' : '#1a1d26' }}
                onClick={() => switchDoc(d.id)}
                title={`owner: ${d.owner?.slice(0, 8) ?? '?'}`}
              >
                {d.name}{d.owner === id ? ' ★' : ''}
              </button>
            ))}
          </div>
        )}
        {names.length > 0 && (
          <div style={{ opacity: 0.75, marginBottom: 4 }}>live here: {names.join(', ')}</div>
        )}
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
        {knownPeers.length > 0 && (
          <div style={{ opacity: 0.75, marginBottom: 4, fontSize: 12 }}>
            <div style={{ fontWeight: 600 }}>peers seen</div>
            {knownPeers.map(([pid, p]) => {
              const pd = parsePresenceDoc(p.doc)
              const pgName = pd.page ? (activeDocPages().find((x) => x.id === pd.page)?.name ?? pd.page.slice(0, 6)) : null
              return (
                <div key={pid}>{p.nick} · {timeAgo(p.lastSeen)}{pd.doc ? ` · ${pd.doc.slice(0, 6)}` : ''}{pgName ? `/${pgName}` : ''}</div>
              )
            })}
          </div>
        )}
        {showAdd && (
          <div>
            <input placeholder="paste ticket…" value={peer} onChange={(e) => setPeer(e.target.value)} style={input} />
            <button style={btn} onClick={async () => {
              setShowAdd(false)
              setStatus('joining…')
              try {
                const roomId = await ensureRoom(peer.trim(), nick.current)
                switchDoc(roomId)
                sendMsg({ t: 'snap-req' })
                setPeer('')
              } catch (e) { setStatus(`join failed: ${e}`) }
            }}>join</button>
          </div>
        )}
        <div style={{ marginTop: 6 }}>
          <button disabled={!id || !activeId} style={btn} onClick={share}>⧉ share</button>
          <button style={btn} onClick={() => {
            sendMsg({ t: 'snap-req' })
            setStatus('reloading board…')
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
    </div>
  )
}
