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
type DocMeta = { id: string; owner: string | null; name: string; ticket?: string; updatedAt: number }
type PeerInfo = { nick: string; lastSeen: number; doc?: string | null }

const LS_SECRET = 'draw.secret'
const LS_DOCS = 'draw.docs'
const LS_PEERS = 'draw.peers'
const SS_TAB = 'draw.tab'

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
  try { return JSON.parse(localStorage.getItem(LS_DOCS) ?? '[]') } catch { return [] }
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
  const docsRef = useRef<DocMeta[]>(loadDocs())
  const sentVersions = useRef<Record<string, number>>({})

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
    const s = JSON.stringify({ from: me.current, epoch: epoch.current, seq: seq.current++, ...obj })
    if (s.length > stats.current.maxOut) stats.current.maxOut = s.length
    ch.sender.broadcast(s).catch(() => bump('sent', 'drop'))
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
      if (roomId !== activeRef.current && (m?.t === 'p' || m?.t === 'snap' || m?.t === 'snap-req' || m?.t === 'cursor')) return
      if (m?.t === 'cursor') {
        cursors.current[from] = { x: m.x, y: m.y, at: Date.now() }
        pushCollaborators()
        return
      }
      if (m?.t === 'p') {
        if (typeof m.seq === 'number' && m.from) {
          const key = `${m.from}:${m.epoch ?? 0}`
          if (m.seq <= (lastSeq.current[key] ?? -1)) { stats.current.stale++; return }
          lastSeq.current[key] = m.seq
        }
        if (Array.isArray(m.elements)) queueRemote(m.elements, false)
      } else if (m?.t === 'snap-req') {
        sendMsg({ t: 'snap', elements: apiRef.current?.getSceneElements() ?? [] })
      } else if (m?.t === 'snap') {
        if (Array.isArray(m.elements)) queueRemote(m.elements, true)
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

  const persistSnapshot = (roomId: string) => {
    try {
      const els = apiRef.current?.getSceneElements() ?? []
      const key = `draw.snap.${roomId}`
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
      const verify = localStorage.getItem(key)
      setSaveInfo(`saved ${els.length} els ${new Date().toLocaleTimeString()} (${(verify ?? '').length}B)`)
    } catch (e) {
      setSaveInfo(`save FAILED: ${String(e).slice(0, 80)}`)
    }
  }

  // Restore a doc's snapshot into the canvas. Safe to call before the
  // Excalidraw api is ready — it no-ops and the api setter retries.
  const applyStoredSnapshot = (roomId: string) => {
    if (!apiRef.current) { setSaveInfo('restore deferred (no api yet)'); return }
    try {
      const raw = localStorage.getItem(`draw.snap.${roomId}`)
      const els = raw ? JSON.parse(raw) : []
      if (Array.isArray(els)) {
        remote.current = true
        try { apiRef.current.updateScene({ elements: els, commitToHistory: false }) } finally { remote.current = false }
        for (const el of apiRef.current.getSceneElements()) sentVersions.current[el.id] = el.version
        restored.current.add(roomId)
        setSaveInfo(`restored ${els.length} els ${new Date().toLocaleTimeString()}`)
      }
    } catch (e) {
      setSaveInfo(`restore FAILED: ${String(e).slice(0, 80)}`)
    }
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
    // load incoming snapshot (deferred until api ready if needed)
    applyStoredSnapshot(roomId)
    epoch.current = Math.random().toString(36).slice(2)
    seq.current = 0
    // announce which doc we have open on every live room sender
    for (const [, r] of rooms.current) {
      try { r.ch.sender.set_current_doc?.(roomId) } catch {}
    }
    setStatus('connected — draw!')
    refreshOwnerLive()
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
    // upsert doc meta
    const docs = [...docsRef.current]
    const i = docs.findIndex((d) => d.id === roomId)
    const entry: DocMeta = {
      id: roomId,
      owner: meta?.owner ?? owner ?? meta?.owner ?? null,
      name: meta?.name ?? docs[i]?.name ?? `doc-${roomId.slice(0, 6)}`,
      ticket: ticketStr,
      updatedAt: Date.now(),
    }
    if (i >= 0) docs[i] = entry
    else docs.push(entry)
    setDocsBoth(docs)
    try { ch.sender.set_current_doc?.(roomId) } catch {}
    return roomId
  }

  const createDoc = async () => {
    const node = nodeRef.current
    if (!node) return
    if (activeRef.current) persistSnapshot(activeRef.current)
    const ch = await node.create(nick.current)
    const roomId: string = ch.id()
    const owner: string = me.current
    rooms.current.set(roomId, { ch, owner, live: new Map() })
    pumpRoom(roomId, ch)
    const ticket = ch.ticket({ includeMyself: true, includeBootstrap: true, includeNeighbors: true })
    const name = `doc-${docsRef.current.length + 1}`
    setDocsBoth([...docsRef.current, { id: roomId, owner, name, ticket, updatedAt: Date.now() }])
    try { ch.sender.set_current_doc?.(roomId) } catch {}
    switchDoc(roomId)
    await copyText(`${location.origin}${location.pathname}#t=${encodeURIComponent(ticket)}`)
    setStatus('new doc created — share link copied')
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
  const flushDirty = () => {
    if (!dirtyRef.current.size) return
    if (!me.current || !activeCh()) return
    if (!ownerIsLive()) return // owner offline → edits stop
    const els = [...dirtyRef.current.values()]
    dirtyRef.current.clear()
    sendMsg({ t: 'p', elements: els })
  }

  const onChange = (elements: readonly OrderedExcalidrawElement[]) => {
    if (remote.current || !me.current || !activeCh()) return
    if (!ownerLive) return // owner offline → edits stop (flush rechecks live)
    let touched = false
    for (const el of elements as any[]) {
      if (sentVersions.current[el.id] === el.version) continue
      sentVersions.current[el.id] = el.version
      const prev = dirtyRef.current.get(el.id)
      if (!prev || el.version >= prev.version) dirtyRef.current.set(el.id, el)
      touched = true
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
        excalidrawAPI={(a) => { setApi(a); apiRef.current = a; if (activeRef.current) applyStoredSnapshot(activeRef.current) }}
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
          <button style={btn} onClick={createDoc}>+ new doc</button>
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
        {knownPeers.length > 0 && (
          <div style={{ opacity: 0.75, marginBottom: 4, fontSize: 12 }}>
            <div style={{ fontWeight: 600 }}>peers seen</div>
            {knownPeers.map(([pid, p]) => (
              <div key={pid}>{p.nick} · {timeAgo(p.lastSeen)}{p.doc ? ` · ${p.doc.slice(0, 6)}` : ''}</div>
            ))}
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
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 12 }}>{status}{activeDoc ? ` · ${activeDoc.name}` : ''}</div>
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
