import { useCallback, useEffect, useRef, useState } from 'react'
import { DrawNode } from './pkg/draw_browser_wasm.js'
import PenOverlay from './PenOverlay.js'
import { Board } from './board.js'
import { createBoardView, makeMeshProvider } from './boardView.js'
import { erase_hit } from './pkg-pen/pen.js'
import {
  generateKey,
  isEnvelope,
  isFileEnvelope,
  keyFromB64,
  keyToB64,
  loadKey,
  openElement,
  openFile,
  saveKey,
  sealElement,
  sealFile,
  selfTest,
} from './crypto.js'
import { cellPush, cellSnapshot, cellSubscribe } from './cell.js'
import { attachPeerOverlay } from './peers.js'

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

// ---- TOPS engineering-pad theme --------------------------------------
// Pale green paper #D8E8D0, dark-green #7BAE7B grid at 20px intervals
// (lines slightly translucent), monospace type, title-block header.
const PAPER = '#d8e8d0'
const GRID_LINE = 'rgba(123,174,123,0.4)'
const INK = '#1e4620'
const INK_SOFT = 'rgba(30,70,32,0.62)'
const CARD_BG = '#eef4e4'
const MONO =
  "ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace"
const paperGrid: React.CSSProperties = {
  backgroundColor: PAPER,
  backgroundImage:
    `linear-gradient(${GRID_LINE} 1px, transparent 1px),` +
    `linear-gradient(90deg, ${GRID_LINE} 1px, transparent 1px)`,
  backgroundSize: '20px 20px',
}
// RolodexDeck lives outside App (stable identity preserves drum position),
// so its button style lives at module scope too.
const deckBtn: React.CSSProperties = {
  background: CARD_BG, color: INK, border: `1.5px solid ${INK}`,
  borderRadius: 4, padding: '5px 12px', cursor: 'pointer', fontSize: 13,
  fontFamily: MONO,
}
// A project is the highest conceptual unit. Sharing links a peer to a
// project (capabilities formalized in a future pass — basic logic only).
// Inside a project live boards (freeform canvases) + highlights (dated
// selections of board elements; a future project map just assembles these).
type BoardMeta = { id: string; name: string; createdAt: number; updatedAt: number }
// DocMeta/ProjectMeta share the same localStorage shape (draw.docs) so
// existing data migrates forward; PageMeta is the legacy board shape.
type PageKind = 'board'
type FormatTab = 'board'
type PageMeta = BoardMeta & { kind?: PageKind }
type DocMeta = { id: string; owner: string | null; name: string; ticket?: string; updatedAt: number; pages: PageMeta[] }
type Highlight = { id: string; boardId: string; elementIds: string[]; date: string; createdAt: number; note?: string }
type PeerInfo = { nick: string; lastSeen: number; doc?: string | null; hasAccess?: boolean }

const LS_SECRET = 'draw.secret'
const LS_DOCS = 'draw.docs'
const LS_PEERS = 'draw.peers'
const LS_PAGE = 'draw.activepage'
const LS_ALIASES = 'draw.aliases'
const SS_TAB = 'draw.tab'

// US Letter width at 96dpi — boards are fixed-width engineering paper:
// finite horizontally, infinite downward. (The old synced frame element
// is gone; the "edge" is just where the clamp stops you.)
const LETTER_W = 816
const LETTER_H = 1056
const SHEET_W = LETTER_W
// Page-break interval down the infinite roll (scene units).
const SHEET_H = LETTER_H
// Grid unit drawn on the paper (scene units). Painted by us, under the
// ink — Excalidraw's own grid rendering stays off (its zoom-dependent
// step coarsening is what read "wrong").
const GRID_UNIT = 10
// Overscroll allowance so the sheet edge stays reachable.
const SHEET_MARGIN = 80
const highlightsKey = (doc: string) => `draw.highlights.${doc}`

const newPageId = () => 'pg' + Math.random().toString(36).slice(2, 10)
const newHighlightId = () => 'hl' + Math.random().toString(36).slice(2, 10)
const mainPage = (): PageMeta => ({ id: 'main', name: 'Board', createdAt: 0, updatedAt: 0 })
const todayName = () => new Date().toISOString().slice(0, 10)
// Deprecated: letter/daily formats removed. All pages are boards now;
// format helpers stay as no-op shims so old snapshots migrate cleanly.
const formatOf = (_p: PageMeta): FormatTab => 'board'
const isLetterKind = (_k: PageKind | string | undefined) => false
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
  // its snapshot under the new per-page key. Legacy letter/daily pages are
  // folded into plain boards (kind dropped, content preserved).
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
    // Strip legacy kinds so every page is a board.
    for (const p of d.pages) {
      if ((p as any).kind && (p as any).kind !== 'board') {
        delete (p as any).kind
        migrated = true
      }
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
const loadHighlights = (docId: string): Highlight[] => {
  try {
    const v = JSON.parse(localStorage.getItem(highlightsKey(docId)) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch { return [] }
}
const saveHighlights = (docId: string, h: Highlight[]) => {
  try { localStorage.setItem(highlightsKey(docId), JSON.stringify(h)) } catch {}
}

// Developer UI (debug drawer, save indicator, cache reset) is only shown
// with `npm run dev` (VITE_DEBUG via .env.development) or `?debug=1`.
// Production builds served to the iPad stay clean.
const DEBUG =
  (import.meta as any).env?.VITE_DEBUG === '1' ||
  new URLSearchParams(location.search).has('debug')
// Mesh relay (ephemeral gossip: strokes-in-flight, cursors, presence).
// Client-side iroh through the Railway relay; the mesh never touches
// Cloudflare and holds nothing durable. `?relay=` overrides per-boot.
const qs = new URLSearchParams(location.search)
const RELAY_URL = (qs.get('relay') ?? (import.meta as any).env?.VITE_RELAY_URL ?? '').trim() || undefined
// NOTE: VITE_KEEPER_URL / ?keeper= now address the celld fleet (durable
// truth); see cell.ts. The keeper watch peer is retired.

import { useState as useRolodexState, useRef as useRolodexRef } from 'react'

// Rolodex drum: a vertical wheel of project cards you roll through with the
// mouse wheel, trackpad, touch drag, or ↑/↓ buttons. The focused card sits
// front-and-center; neighbors tilt back around the drum.
function RolodexDeck({ cards, renderCard, newCard, onSelect }: {
  cards: string[]
  renderCard: (key: string, offset: number, front: boolean) => React.ReactNode
  newCard: React.ReactNode
  onSelect?: (key: string) => void
}) {
  const total = cards.length + 1 // trailing new/join card rides the drum too
  const [idx, setIdx] = useRolodexState(0)
  const touchY = useRolodexRef<number | null>(null)
  const acc = useRolodexRef(0)
  const roll = (dir: 1 | -1) =>
    setIdx((i) => Math.min(total - 1, Math.max(0, i + dir)))
  const onWheel = (e: React.WheelEvent) => {
    acc.current += e.deltaY
    if (Math.abs(acc.current) < 24) return
    roll(acc.current > 0 ? 1 : -1)
    acc.current = 0
  }
  const R = 260 // drum radius px
  const SPREAD = 0.42 // radians between cards
  const clickCard = (i: number) => {
    if (i === idx && onSelect && i < cards.length) onSelect(cards[i])
    else setIdx(i)
  }
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'center' }}>
        <button style={deckBtn} onClick={() => roll(-1)} title="roll up" disabled={idx <= 0}>↑</button>
        <button style={deckBtn} onClick={() => roll(1)} title="roll down" disabled={idx >= total - 1}>↓</button>
      </div>
      <div
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') { e.preventDefault(); roll(-1) }
          else if (e.key === 'ArrowDown') { e.preventDefault(); roll(1) }
          else if (e.key === 'Enter' && onSelect && idx < cards.length) { e.preventDefault(); onSelect(cards[idx]) }
        }}
        onWheel={onWheel}
        onTouchStart={(e) => { touchY.current = e.touches[0].clientY }}
        onTouchMove={(e) => {
          if (touchY.current === null) return
          const dy = e.touches[0].clientY - touchY.current
          if (Math.abs(dy) > 32) { roll(dy < 0 ? 1 : -1); touchY.current = e.touches[0].clientY }
        }}
        onTouchEnd={() => { touchY.current = null }}
        style={{ perspective: 1200, flex: 1, height: 360, position: 'relative', overflow: 'hidden', outline: 'none' }}
      >
        <div style={{ position: 'absolute', inset: 0, transformStyle: 'preserve-3d' }}>
          {cards.map((key, i) => {
            const off = i - idx
            if (Math.abs(off) > 3) return null
            const ang = off * SPREAD
            return (
              <div
                key={key}
                onClick={() => clickCard(i)}
                style={{
                  position: 'absolute', left: '4%', right: '4%', top: 65, height: 210,
                  transform: `translateY(${Math.sin(ang) * R}px) translateZ(${(Math.cos(ang) - 1) * R + (off === 0 ? 40 : 0)}px) rotateX(${-ang}rad)`,
                  opacity: Math.abs(off) > 2 ? 0.25 : 1 - Math.abs(off) * 0.22,
                  zIndex: 100 - Math.abs(off),
                  transition: 'transform 0.28s ease, opacity 0.28s ease',
                  cursor: 'pointer',
                }}
              >
                {renderCard(key, off, off === 0)}
              </div>
            )
          })}
          {(() => {
            const off = cards.length - idx
            if (Math.abs(off) > 3) return null
            const ang = off * SPREAD
            return (
              <div
                onClick={() => clickCard(cards.length)}
                style={{
                  position: 'absolute', left: '4%', right: '4%', top: 65, height: 210,
                  transform: `translateY(${Math.sin(ang) * R}px) translateZ(${(Math.cos(ang) - 1) * R + (off === 0 ? 40 : 0)}px) rotateX(${-ang}rad)`,
                  opacity: Math.abs(off) > 2 ? 0.25 : 1 - Math.abs(off) * 0.22,
                  zIndex: 100 - Math.abs(off),
                  transition: 'transform 0.28s ease, opacity 0.28s ease',
                  cursor: 'pointer',
                }}
              >
                {newCard}
              </div>
            )
          })()}
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const boardRef = useRef<Board | null>(null)
  if (!boardRef.current) boardRef.current = new Board()
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [activeFormat, setActiveFormat] = useState<FormatTab>('board')
  void activeFormat
  void setActiveFormat
  void formatOf
  void isLetterKind
  void switchFormat
  const [highlights, setHighlights] = useState<Highlight[]>([])
  // Overlay views: null = canvas, 'tools' = slim canvas panel,
  // 'topics' = topic cards, 'peers' = peer management.
  const [view, setView] = useState<null | 'tools' | 'topics' | 'peers'>(null)
  // Canvas tool: pen draws (PenOverlay), eraser deletes (hit-test),
  // pan moves. No selection UI in v1.
  const [tool, setTool] = useState<'pen' | 'eraser' | 'pan'>('pen')
  const toolRef = useRef<'pen' | 'eraser' | 'pan'>('pen')
  toolRef.current = tool
  const spaceRef = useRef(false)
  // Title-block header starts hidden; the ✦ stamp summons it.
  const [showHeader, setShowHeader] = useState(false)
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
  const apiRef = useRef<Board | null>(null)
  // The board store is ready synchronously (no canvas-mount race like the
  // old Excalidraw api): point apiRef at it on first render.
  if (!apiRef.current) apiRef.current = boardRef.current
  const usLog = useRef<string[]>([])
  const US = (tag: string, scene: any) => {
    const a = apiRef.current
    if (!a) return
    const before = (a.getSceneElements() as any[]).length
    lastWriteAt.current = Date.now()
    a.updateScene(scene)
    const after = (a.getSceneElements() as any[]).length
    usLog.current.push(`${Date.now() % 100000}:${tag}:${before}->${after}`)
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
  // Delete detection that no stale onChange can corrupt: ids ever observed
  // (add-only) that are missing from the LIVE scene get tombstoned — but
  // only when the last programmatic write is old (rules out races with our
  // own in-flight updates) and the tab is visible (background tabs get
  // stale deliveries and starved renders). Runs on flush + persist ticks,
  // so real deletes converge in seconds.
  const lastWriteAt = useRef(0)
  const mintScan = () => {
    const a = apiRef.current
    if (!a) return
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    if (Date.now() - lastWriteAt.current < 1000) return
    const now = Date.now()
    const seen = new Set((a.getSceneElements() as any[]).map((el) => el.id))
    let minted = false
    for (const id of knownIds.current) {
      if (seen.has(id)) continue
      if (tombsActive.current.has(id)) continue
      const lastV = sentVersions.current[id] ?? metaActive.current.get(id)?.v ?? 0
      const tomb: Entry = { v: lastV + 1, ts: now, author: me.current }
      const best = bestFor(id)
      if (!best || cmpEntry(tomb, best.entry) > 0) {
        tombsActive.current.set(id, tomb)
        if (metaActive.current.has(id)) metaActive.current.delete(id)
        dirtyTombs.current.set(id, tomb)
        minted = true
      }
    }
    void minted
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
    const f: FormatTab = 'board'
    activeFormatRef.current = f
    setActiveFormat(f)
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

  // ---- Highlights (dated board selections) ------------------------------
  // A highlight pins a set of element ids on a board + auto-assigned date.
  // Compiling a project map later = assembling highlights. Synced as a
  // full-list LWW union (by id) over gossip; transport untouched.
  const highlightsRef = useRef<Highlight[]>([])
  const setHighlightsBoth = (docId: string, h: Highlight[]) => {
    highlightsRef.current = h
    setHighlights(h)
    saveHighlights(docId, h)
  }
  const mergeHighlights = (roomId: string, remoteH: Highlight[]) => {
    if (!Array.isArray(remoteH)) return
    const map = new Map(highlightsRef.current.map((h) => [h.id, h]))
    let changed = false
    for (const rh of remoteH) {
      if (!rh || typeof rh.id !== 'string') continue
      const local = map.get(rh.id)
      if (!local || (rh.createdAt ?? 0) >= (local.createdAt ?? 0)) {
        map.set(rh.id, rh)
        changed = true
      }
    }
    if (changed) {
      const next = [...map.values()].sort((a, b) => a.createdAt - b.createdAt)
      if (roomId === activeRef.current) setHighlightsBoth(roomId, next)
      else saveHighlights(roomId, next)
    }
  }
  const broadcastHighlights = (roomId?: string) => {
    const rid = roomId ?? activeRef.current
    if (!rid) return
    sendMsg({ t: 'highlights', highlights: highlightsRef.current })
  }
  const createHighlightFromSelection = () => {
    const roomId = activeRef.current
    const boardId = activePageRef.current ?? 'main'
    const a = apiRef.current
    if (!roomId || !a) return
    let sel: any[] = []
    try { sel = (a.getAppState() as any)?.selectedElementIds ? Object.keys((a.getAppState() as any).selectedElementIds).filter((k) => (a.getAppState() as any).selectedElementIds[k]) : [] } catch {}
    if (!sel.length) {
      // Fall back to all non-deleted elements currently visible.
      sel = (a.getSceneElements() as any[]).filter((el) => !el.isDeleted).map((el) => el.id)
    }
    if (!sel.length) { setStatus('nothing to highlight — draw first, then select'); return }
    const h: Highlight = { id: newHighlightId(), boardId, elementIds: sel, date: todayName(), createdAt: Date.now() }
    setHighlightsBoth(roomId, [...highlightsRef.current, h])
    broadcastHighlights(roomId)
    setStatus(`highlighted ${sel.length} elements · ${h.date}`)
  }
  const deleteHighlight = (hid: string) => {
    const roomId = activeRef.current
    if (!roomId) return
    setHighlightsBoth(roomId, highlightsRef.current.filter((h) => h.id !== hid))
    broadcastHighlights(roomId)
  }
  const jumpToHighlight = (h: Highlight) => {
    if (h.boardId !== (activePageRef.current ?? 'main')) switchPage(h.boardId)
    window.setTimeout(() => {
      try {
        const a = apiRef.current
        if (!a) return
        const els = (a.getSceneElements() as any[]).filter((el) => h.elementIds.includes(el.id))
        if (els.length) a.scrollToContent(els as any, { animate: true } as any)
      } catch {}
    }, 300)
  }

  // ---- Fixed-width paper (infinite downward) --------------------------
  // The viewport is clamped horizontally to the sheet (plus a small
  // overscroll margin); vertically it runs free. Screen transform (per
  // Excalidraw's renderer) is screen = (scene + scroll) * zoom, so the
  // visible scene rect starts at (-scrollX, -scrollY).
  // The grid is painted by us on the app container, UNDER the transparent
  // canvas: exact color, exact GRID_UNIT spacing at every zoom, aligned to
  // scene coords via background-position. Scroll-only writes never touch
  // elements, so this can't disturb sync.
  const paperRef = useRef<HTMLDivElement | null>(null)
  const sheetPageRef = useRef<HTMLSpanElement | null>(null)
  const lastSheetPage = useRef(1)
  // Grid repaint is rAF-throttled: pointer moves fire far faster than
  // frames, and every paint rebuilds 3 background strings + forces style
  // recalc. Clamp math stays synchronous; only the DOM write coalesces.
  const paintQueued = useRef(false)
  const paintArgs = useRef<[number, number, number]>([0, 0, 1])
  const paintPaperGrid = (scrollX: number, scrollY: number, zoom: number) => {
    paintArgs.current = [scrollX, scrollY, zoom]
    if (paintQueued.current) return
    paintQueued.current = true
    requestAnimationFrame(() => {
      paintQueued.current = false
      const [x, y, z] = paintArgs.current
      paintPaperGridNow(x, y, z)
    })
  }
  const paintPaperGridNow = (scrollX: number, scrollY: number, zoom: number) => {
    const el = paperRef.current
    if (!el) return
    const step = GRID_UNIT * zoom
    const pageH = SHEET_H * zoom
    if (!isFinite(step) || step <= 0 || !isFinite(pageH) || pageH <= 0) return
    const mod = (n: number, s: number) => ((n % s) + s) % s
    el.style.backgroundColor = PAPER
    // Page-break rules on top, grid beneath: one ruled sheet per SHEET_H.
    el.style.backgroundImage =
      `linear-gradient(${INK}99 2px, transparent 2px),` +
      `linear-gradient(${GRID_LINE} 1px, transparent 1px),` +
      `linear-gradient(90deg, ${GRID_LINE} 1px, transparent 1px)`
    el.style.backgroundSize = `100% ${pageH}px, ${step}px ${step}px, ${step}px ${step}px`
    el.style.backgroundPosition =
      `0px ${mod(scrollY * zoom, pageH)}px,` +
      `${mod(scrollX * zoom, step)}px ${mod(scrollY * zoom, step)}px,` +
      `${mod(scrollX * zoom, step)}px ${mod(scrollY * zoom, step)}px`
    // Live sheet indicator (imperative: no re-render on scroll).
    const sheet = Math.max(1, Math.floor(-scrollY / SHEET_H) + 1)
    if (sheet !== lastSheetPage.current) {
      lastSheetPage.current = sheet
      if (sheetPageRef.current) sheetPageRef.current.textContent = `SHEET-PG ${sheet}`
    }
  }
  const clampViewport = (): boolean => {
    const a = apiRef.current
    if (!a) return false
    let st: any
    try { st = a.getAppState() } catch { return false }
    const W = st.width ?? 0
    const H = st.height ?? 0
    if (!W || !H) return false
    let zoom = typeof st.zoom?.value === 'number' ? st.zoom.value : 1
    if (!isFinite(zoom) || zoom <= 0) return false
    // Min zoom fits the sheet WIDTH (height runs infinite, so it plays no
    // part). Max zoom stops runaway pinch. Below min there is no "beyond"
    // to see or draw in.
    const MAX_ZOOM = 8
    const minZoom = W / (SHEET_W + 2 * SHEET_MARGIN)
    let zoomOut = false
    if (zoom < minZoom) { zoom = minZoom; zoomOut = true }
    let zoomIn = false
    if (zoom > MAX_ZOOM) { zoom = MAX_ZOOM; zoomIn = true }
    const vw = W / zoom
    if (!isFinite(vw)) return false
    const lo = vw - SHEET_W - SHEET_MARGIN
    const hi = SHEET_MARGIN
    const nx = lo > hi ? (vw - SHEET_W) / 2 : Math.min(hi, Math.max(lo, st.scrollX ?? 0))
    const ny = st.scrollY ?? 0 // vertical: free
    paintPaperGrid(nx, ny, zoom)
    if (!zoomOut && !zoomIn && Math.abs(nx - (st.scrollX ?? 0)) < 0.5) return false
    try {
      remote.current = true
      a.updateScene({
        appState: {
          scrollX: nx,
          ...((zoomOut || zoomIn) ? { zoom: { value: zoom } as any } : {}),
        },
      })
    } catch {} finally {
      remote.current = false
    }
    return true
  }
  const centerSheet = (fromTop = false) => {
    const a = apiRef.current
    if (!a) return
    let st: any
    try { st = a.getAppState() } catch { return }
    const zoom = typeof st.zoom?.value === 'number' ? st.zoom.value : 1
    const nx = ((st.width ?? 0) / zoom - SHEET_W) / 2
    if (!isFinite(nx)) return
    lastSheetPage.current = -1 // force the sheet indicator to repaint
    try {
      remote.current = true
      a.updateScene({ appState: { scrollX: nx, ...(fromTop ? { scrollY: 0 } : {}) } })
    } catch {} finally {
      remote.current = false
    }
    paintPaperGrid(nx, fromTop ? 0 : (st.scrollY ?? 0), zoom)
  }

  // ---- Project data keys (peers only — never sent to the keeper) ----
  // Share links carry `#t=<ticket>&k=<key>`; the ticket routes + auths,
  // the key decrypts. Tickets (re)minted from the mesh never contain it.
  const docKey = (docId: string): Uint8Array | null => loadKey(docId)
  const shareLink = (ticket: string, docId: string): string => {
    const k = loadKey(docId)
    const frag = `t=${encodeURIComponent(ticket)}${k ? `&k=${encodeURIComponent(keyToB64(k))}` : ''}`
    return `${location.origin}${location.pathname}#${frag}`
  }
  // Paste box accepts a bare ticket or a full share link.
  const splitTicketInput = (input: string): { ticket: string; key: Uint8Array | null } => {
    const t = input.trim()
    const hi = t.indexOf('#')
    const qs = hi >= 0 ? t.slice(hi + 1) : t.includes('&') || t.includes('=') ? t : ''
    if (qs) {
      try {
        const ps = new URLSearchParams(qs)
        const ticket = ps.get('t')
        if (ticket) return { ticket, key: ps.get('k') ? keyFromB64(ps.get('k')!) : null }
      } catch {}
    }
    return { ticket: t, key: null }
  }

  // ---- Wire crypto (envelopes) ----------------------------------------
  // Outbound: plaintext scene → sealed envelopes (keyed project) or raw
  // (legacy keyless project). Inbound: envelopes → plaintext; envelopes
  // without a key are dropped (never throw into sync). Claims (meta) and
  // tombstones ride cleartext in both directions — the keeper merges them
  // without ever seeing content.
  const openEls = async (roomId: string, elements: any[] | undefined): Promise<any[]> => {
    if (!Array.isArray(elements)) return []
    const key = docKey(roomId)
    const out: any[] = []
    for (const el of elements) {
      if (isEnvelope(el)) {
        if (!key) continue
        const pt = await openElement(key, el)
        if (pt) out.push(pt)
      } else out.push(el)
    }
    return out
  }
  const openIncomingFiles = async (roomId: string, files: any[] | undefined): Promise<any[]> => {
    if (!Array.isArray(files)) return []
    const key = docKey(roomId)
    const out: any[] = []
    for (const f of files) {
      if (isFileEnvelope(f)) {
        if (!key) continue
        const pt = await openFile(key, f)
        if (pt) out.push(pt)
      } else out.push(f)
    }
    return out
  }
  const sealEls = async (roomId: string, elements: any[]): Promise<any[]> => {
    const key = docKey(roomId)
    if (!key) return elements
    const out: any[] = []
    for (const el of elements) {
      try {
        const env = await sealElement(key, el)
        if (env) out.push(env)
      } catch (e) {
        // Sealing must never fail silently again (insecure-origin Subtle
        // once ate every outbound message with zero trace): loud + keep raw
        // would leak; loud + drop preserves blindness. So: loud.
        console.warn('[crypto] seal failed, dropping element:', e)
        setStatus('encrypt failed — check console')
      }
    }
    return out
  }
  const sealOutgoingFiles = async (roomId: string, files: any[]): Promise<any[]> => {
    const key = docKey(roomId)
    if (!key || !files.length) return files
    const out: any[] = []
    for (const f of files) {
      try {
        if (!f?.id) continue
        const env = await sealFile(key, f.id, f)
        if (env) out.push(env)
      } catch {}
    }
    return out
  }

  const activeCh = () => (activeRef.current ? rooms.current.get(activeRef.current)?.ch ?? null : null)

  // Self-heal against silent drops: union the live scene with the stored
  // pre-close snapshot. Anything the store knows that the canvas lost
  // (without a winning tombstone) is re-merged — never removed. Runs once
  // per doc+page per session (boot/rejoin) and on owner return. Deliberately
  // NOT run after manual pull, which is an intentional replace.
  const healedRef = useRef<Set<string>>(new Set())
  const lastEditAt = useRef(0)
  const healFromSnapshot = (roomId: string, page: string) => {
    try {
      const key = `${roomId}/${page}`
      if (healedRef.current.has(key)) return
      healedRef.current.add(key)
      if (roomId !== activeRef.current || page !== (activePageRef.current ?? 'main')) return
      // Don't second-guess a canvas the user just touched: their live
      // edits (including fresh deletes still minting tombs) win.
      if (Date.now() - lastEditAt.current < 10000) return
      const a = apiRef.current
      if (!a) return
      const raw = localStorage.getItem(snapKey(roomId, page))
      const els = raw ? JSON.parse(raw) : []
      if (!Array.isArray(els) || !els.length) return
      let mraw: Record<string, [number, string]> = {}
      try { mraw = JSON.parse(localStorage.getItem(metaKey(roomId, page)) ?? '{}') } catch {}
      const live = new Set((a.getSceneElements() as any[]).map((el) => el.id))
      const meta: Record<string, [number, string]> = {}
      const healEls: any[] = []
      for (const el of els) {
        if (!el?.id || live.has(el.id)) continue
        // Skip anything our live tombstones condemn (real deletes stay dead).
        const t = tombsActive.current.get(el.id)
        const m = mraw[el.id]
        const cand = { v: el.version ?? 0, ts: m?.[0] ?? 0, author: m?.[1] ?? '' }
        if (t && cmpEntry(t, cand) > 0) continue
        if (m) meta[el.id] = m
        healEls.push(el)
      }
      if (!healEls.length) return
      queueRemote(healEls, meta, false)
      setStatus('healed from snapshot')
    } catch {}
  }

  // Snapshots can vanish into a half-built mesh (late-joiner broadcast
  // stall): if our scene is still empty seconds after requesting, ask
  // again. The cell snapshot needs no mesh at all. All bounded — each step
  // fires only if we're still on the same doc+page with an empty canvas.
  const fetchFromKeeper = async (roomId: string, page: string, force = false): Promise<boolean> => {
    try {
      if (roomId !== activeRef.current || page !== (activePageRef.current ?? 'main')) return false
      if (!force && (apiRef.current?.getSceneElements() ?? []).length > 0) return false
      // Cell (no iroh needed): plain HTTPS snapshot from the celld fleet.
      // Same envelope/claims wire format as gossip, so the ingest below is
      // shared. Falls through to gossip snap-req retries on failure.
      try {
        const snap = await cellSnapshot(roomId, page)
        if (snap && (snap.elements.length || snap.tombs.length)) {
          if (roomId !== activeRef.current || page !== (activePageRef.current ?? 'main')) return false
          lastFetch.current = `cell els=${snap.elements.length} tombs=${snap.tombs.length}`
          const files = await openIncomingFiles(roomId, snap.files)
          if (files.length) ingestFiles(files)
          const els = await openEls(roomId, snap.elements)
          if (!els.length && !snap.tombs.length) return false
          remote.current = true
          try {
            if (ingestTombs(snap.tombs)) { /* enforced below */ }
            if (els.length) queueRemote(els, snap.meta, false)
            enforceTombs()
          } finally {
            remote.current = false
          }
          setStatus('restored from cell')
          return true
        }
      } catch {}
      // Cell missed (or no cell configured): fall through to gossip
      // snap-req retries. The keeper QUIC path is retired — the mesh holds
      // nothing durable, the cell holds everything.
      return false
    } catch (e) {
      fetchErr.current = String(e).slice(0, 160)
      return false
    }
  }
  const requestSnap = (roomId: string, page: string, attempt = 0) => {
    if (roomId !== activeRef.current || page !== (activePageRef.current ?? 'main')) return
    if ((apiRef.current?.getSceneElements() ?? []).length > 0) return
    if (attempt === 0) {
      sendMsg({ t: 'snap-req' })
      window.setTimeout(() => requestSnap(roomId, page, 1), 6000)
      return
    }
    // Gossip retries didn't fill us: go to the cell, which needs no mesh
    // at all. Keep trying a few times — cell deploy, api mount all race boot.
    fetchFromKeeper(roomId, page, true).then((ok) => {
      if (!ok && attempt < 4) window.setTimeout(() => requestSnap(roomId, page, attempt + 1), 8000)
    })
  }

  // Cell pull independent of scene emptiness: merge-only, so it can run
  // on every join even with a stale-but-nonempty canvas. Retries until it
  // goes through.
  const requestKeeper = (roomId: string, page: string, attempt = 0) => {
    if (roomId !== activeRef.current || page !== (activePageRef.current ?? 'main')) return
    if (attempt > 4) return
    fetchFromKeeper(roomId, page, true).then((ok) => {
      if (!ok) window.setTimeout(() => requestKeeper(roomId, page, attempt + 1), 8000)
    })
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

  // ---- Sync split: DURABLE vs EPHEMERAL ---------------------------------
  // DURABLE (must survive a dead node): elements + claims + tombstones +
  // files. Two writers: gossip 'p'/'snap' (live peers, merge-only) and the
  // cell (debounced push, snapshot fetch, WS fan-out). Both carry the same
  // sealed envelopes + cleartext claims; the Rust draw-crdt merge is the
  // single judge of what wins.
  // EPHEMERAL (latest-wins, loss is fine): cursor positions, presence.
  // Mesh-only ('cursor' gossip, set_current_doc presence), rendered from
  // board.peers on a separate overlay canvas. These MUST NOT enter rev,
  // onChange, localStorage snapshots, or cell pushes — durability gating
  // on throwaway data is pure latency tax.
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
      // Our own deterministic union — NOT Excalidraw's reconcileElements.
      // Rationale, earned the hard way: reconcile's index-sync side effects
      // intermittently drop merged elements at commit time (observed as
      // 1+1 merges landing 1 element with zero errors). Our CRDT claims
      // already resolved every conflict upstream (queueRemote only holds
      // winners), so all that's left is replace-or-append, with fresh
      // objects so no shared/mutated references leak back into Excalidraw.
      // New ids append at the end (incoming strokes land on top, as users
      // expect); local order is otherwise untouched. `asIs` is vestigial
      // (snapshots merge like everything else) and kept for signature shape.
      void asIs
      const local = a.getSceneElements() as any[]
      const at = new Map(local.map((el, i) => [el.id, i]))
      const out = local.map((el) => ({ ...el }))
      for (const el of elements) {
        if (!el || typeof el.id !== 'string') continue
        const i = at.get(el.id)
        if (i !== undefined) out[i] = { ...el }
        else { at.set(el.id, out.length); out.push({ ...el }) }
      }
      const before = (a.getSceneElements() as any[]).length
      US('apply', { elements: out as any[] })
      if (DEBUG && (a.getSceneElements() as any[]).length !== out.length) {
        console.log(`[apply-drop] want=${out.length} got=${(a.getSceneElements() as any[]).length}`)
      }
      void before
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
    // No canvas yet (pre-mount): keep the queue and retry. Dropping here
    // loses rejoins whose data arrives before Excalidraw mounts.
    if (!apiRef.current) {
      if (p) timerRef.current = window.setTimeout(flushPending, 1000)
      return
    }
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
    // Owner returning after absence: pull the keeper for a fresh merge.
    // This is the same join-a-stream event as reconnect/switch/refresh.
    const wasOwnerAbsent = !!room?.owner && from === room.owner &&
      Date.now() - (room.live.get(from) ?? 0) > 30000
    if (room) room.live.set(from, Date.now())
    if (wasOwnerAbsent && roomId === activeRef.current) {
      const pg = activePageRef.current ?? 'main'
      requestKeeper(roomId, pg, 0)
      window.setTimeout(() => healFromSnapshot(roomId, pg), 4000)
    }
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
      if (roomId !== activeRef.current && (m?.t === 'p' || m?.t === 'f' || m?.t === 'snap' || m?.t === 'snap-req' || m?.t === 'pull' || m?.t === 'push' || m?.t === 'cursor' || m?.t === 'pages' || m?.t === 'highlights')) return
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
      if (m?.t === 'highlights') {
        mergeHighlights(roomId, m.highlights)
        return
      }
      if (m?.t === 'f') {
        if (isActivePage) void openIncomingFiles(roomId, m.files).then(ingestFiles)
        else void (async () => mergePageSnapshot(roomId, msgPage, [], undefined, [], await openIncomingFiles(roomId, m.files)))()
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
        // Decrypt-then-ingest (fire-and-forget; merge-only, order-free).
        void (async () => {
          const els = await openEls(roomId, m.elements)
          const files = await openIncomingFiles(roomId, m.files)
          if (isActivePage && roomId === activeRef.current && msgPage === (activePageRef.current ?? 'main')) {
            if (files.length) ingestFiles(files)
            ingestCrdt(els, m.meta, m.tombs ?? [])
          } else if (els.length || Array.isArray(m.tombs)) {
            mergePageSnapshot(roomId, msgPage, els, m.meta, m.tombs ?? [], files)
          } else if (files.length) {
            mergePageSnapshot(roomId, msgPage, [], undefined, [], files)
          }
        })()
      } else if (m?.t === 'snap-req') {
        // Answer with elements + their binaries (forced: the requester is
        // usually a newcomer who missed the original file broadcasts).
        // Honors the requested page, live or stored; falls back to our own
        // active page only when the message carries no usable tag.
        // Snapshots carry CRDT claims (meta + tombstones) so the joiner
        // merges instead of replacing — no resurrection, no clobber.
        const pg = typeof m.page === 'string' ? m.page : (activePageRef.current ?? 'main')
        const { els, files, meta, tombs } = gatherPage(roomId, pg)
        void answerWith(roomId, pg, els, files, meta, tombs, 'snap')
        // Newcomers also need highlights for the project map future.
        if (roomId === activeRef.current && highlightsRef.current.length) {
          sendMsg({ t: 'highlights', highlights: highlightsRef.current })
        }
      } else if (m?.t === 'pull') {
        // Manual sync: only the owner answers, with full state for the
        // requested page (live or stored — the owner may be viewing
        // elsewhere). The requester overwrites itself (see 'push').
        const room = rooms.current.get(roomId)
        if (!room || (room.owner && room.owner !== me.current)) return
        const pg = typeof m.page === 'string' ? m.page : (activePageRef.current ?? 'main')
        const { els, files, meta, tombs } = gatherPage(roomId, pg)
        void answerWith(roomId, pg, els, files, meta, tombs, 'push')
      } else if (m?.t === 'push') {
        // Manual sync answer: only honored from the owner (or when no
        // owner is recorded). Our scene is REPLACED wholesale — local
        // unflushed edits are discarded, claims adopt the owner's.
        // Envelopes decrypt first; a replace that can't decrypt aborts
        // rather than wiping the canvas.
        const room = rooms.current.get(roomId)
        if (!room) { lastPush.current = 'ignored: no room'; return }
        if (room.owner && from !== room.owner) { lastPush.current = `ignored: not owner (from ${String(from).slice(0, 6)} owner ${(room.owner ?? '').slice(0, 6)})`; return }
        if (!isActivePage || !apiRef.current || !Array.isArray(m.elements)) { lastPush.current = 'ignored: wrong page/no api/bad elements'; return }
        void (async () => {
          const els = await openEls(roomId, m.elements)
          const files = await openIncomingFiles(roomId, m.files)
          const hadEnvelopes = (m.elements as any[]).some(isEnvelope)
          if (hadEnvelopes && els.length < (m.elements as any[]).length) {
            lastPush.current = 'ignored: undecryptable push (missing key?)'
            return
          }
          if (roomId !== activeRef.current || msgPage !== (activePageRef.current ?? 'main') || !apiRef.current) {
            lastPush.current = 'ignored: switched away'
            return
          }
          lastPush.current = `applied ${els.length} els`
          if (files.length) ingestFiles(files)
          remote.current = true
        try {
          metaActive.current = new Map()
          tombsActive.current = new Map()
          if (Array.isArray(m.tombs)) for (const t of m.tombs) {
            if (t?.id) tombsActive.current.set(t.id, { v: t.v ?? 0, ts: t.ts ?? 0, author: t.author ?? '' })
          }
          // Claims adopt the owner's; element versions seed from the pushed
          // scene so future merges compare against real versions.
          for (const el of els as any[]) {
            const c = (m.meta as any)?.[el.id]
            metaActive.current.set(el.id, { v: el.version ?? 0, ts: c?.[0] ?? 0, author: c?.[1] ?? '' })
          }
          US('push', { elements: els as any[], commitToHistory: false })
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
        })()
      } else if (m?.t === 'snap') {
        // Decrypt-then-ingest, like 'p' above.
        void (async () => {
          const els = await openEls(roomId, m.elements)
          const files = await openIncomingFiles(roomId, m.files)
          if (isActivePage && roomId === activeRef.current && msgPage === (activePageRef.current ?? 'main')) {
            if (files.length) ingestFiles(files)
            ingestCrdt(els, m.meta, m.tombs ?? [])
          } else if (els.length || Array.isArray(m.tombs)) {
            mergePageSnapshot(roomId, msgPage, els, m.meta, m.tombs ?? [], files)
          } else if (files.length) {
            mergePageSnapshot(roomId, msgPage, [], undefined, [], files)
          }
        })()
      }
    }
  }

  // Answer a snapshot/pull request: seal the gathered state (when keyed)
  // and send, splitting binaries out when oversize. `kind` is snap|push.
  const answerWith = async (
    roomId: string, pg: string,
    els: any[], files: any[], meta: Record<string, [number, string]>, tombs: any[],
    kind: 'snap' | 'push',
  ) => {
    try {
      const sels = await sealEls(roomId, els)
      const sfiles = await sealOutgoingFiles(roomId, files)
      if (JSON.stringify(sfiles).length + JSON.stringify(sels).length < MAX_MSG) {
        sendMsg({ t: kind, elements: sels, meta, tombs, files: sfiles, page: pg })
      } else {
        sendMsg({ t: kind, elements: sels, meta, tombs, page: pg })
        for (const f of sfiles) {
          if (JSON.stringify(f).length > MAX_MSG) continue
          sendMsg({ t: 'f', files: [f], page: pg })
        }
      }
    } catch {}
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
    if (DEBUG) { try { console.log(`[flow] persist ${(apiRef.current?.getSceneElements() ?? []).length}els`) } catch {} }
    const pg = page ?? activePageRef.current ?? 'main'
    // Mint scan before saving so deletes persist even on quiet tabs.
    if (pg === (activePageRef.current ?? 'main') && roomId === activeRef.current) mintScan()
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
    scheduleCellPush(roomId, pg)
  }

  // Cell push (debounced trailing 2.5s): sealed live scene + claims to the
  // celld fleet. Fire-and-forget — gossip + localStorage stay the safety net
  // until this path is proven. No iroh involved.
  const cellPushTimers = useRef(new Map<string, number>())
  const pushCellNow = async (roomId: string, pg: string) => {
    try {
      const g = gatherPage(roomId, pg)
      const sels = await sealEls(roomId, g.els)
      const sfiles = await sealOutgoingFiles(roomId, g.files)
      const fmap: Record<string, any> = {}
      for (const f of sfiles) if (f?.id) fmap[f.id] = f
      cellPush(roomId, pg, { elements: sels, meta: g.meta, tombs: g.tombs, files: fmap })
    } catch {}
  }
  const scheduleCellPush = (roomId: string, pg: string) => {
    try {
      const k = `${roomId}/${pg}`
      const prev = cellPushTimers.current.get(k)
      if (prev) window.clearTimeout(prev)
      cellPushTimers.current.set(
        k,
        window.setTimeout(() => {
          cellPushTimers.current.delete(k)
          void pushCellNow(roomId, pg)
        }, 2500),
      )
    } catch {}
  }

  // Restore a doc's snapshot into the canvas. Safe to call before the
  // Excalidraw api is ready — it no-ops and the api setter retries.
  const applyStoredSnapshot = (roomId: string, page?: string) => {
    if (DEBUG) console.log(`[flow] restore-in ${roomId.slice(0,6)}/${page ?? '?'} t=${Date.now() % 100000}`)
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
      if (!local) {
        doc.pages.push({
          id: rp.id,
          name: typeof rp.name === 'string' ? rp.name : rp.id,
          createdAt: rp.createdAt ?? Date.now(),
          updatedAt: rp.updatedAt ?? Date.now(),
        })
        changed = true
        // pull the adopted page's content (goes to stored snapshot if
        // we're not viewing it)
        if (roomId === activeRef.current && rp.id === activePageRef.current) sendMsg({ t: 'snap-req' })
      } else if ((rp.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
        local.name = typeof rp.name === 'string' ? rp.name : local.name
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
    if (DEBUG) console.log(`[flow] switchDoc ${roomId.slice(0,6)} t=${Date.now() % 100000}`)
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
    setHighlightsBoth(roomId, loadHighlights(roomId))
    setActivePageBoth(roomId, pg)
    // load incoming snapshot (deferred until api ready if needed)
    applyStoredSnapshot(roomId, pg)
    centerSheet(!localStorage.getItem(snapKey(roomId, pg)))
    ensureLetterSurface(roomId, pg)
    ensureLetterSurface(roomId, pg)
    epoch.current = Math.random().toString(36).slice(2)
    seq.current = 0
    // announce which doc+page we have open on every live room sender
    for (const [, r] of rooms.current) {
      try { r.ch.sender.set_current_doc?.(presenceDoc()) } catch {}
    }
    setStatus('connected — draw!')
    refreshOwnerLive()
    requestSnap(roomId, pg)
    // Every join pulls the cell's latest for this page and merges it —
    // reconnect, room switch, and refresh are all the same event: someone
    // joining a stream. Merge (never replace) so unsynced local edits
    // survive alongside the cell's truth. Cell pull runs regardless of
    // scene emptiness (unlike the gossip snap path above).
    requestKeeper(roomId, pg, 0)
    window.setTimeout(() => healFromSnapshot(roomId, pg), 4000)
  }

  const switchPage = (pageId: string) => {
    if (DEBUG) console.log(`[flow] switchPage ${pageId} t=${Date.now() % 100000}`)
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
    restorePending.current = null
    setActivePageBoth(roomId, pageId)
    applyStoredSnapshot(roomId, pageId)
    centerSheet(!localStorage.getItem(snapKey(roomId, pageId)))
    ensureLetterSurface(roomId, pageId)
    for (const [, r] of rooms.current) {
      try { r.ch.sender.set_current_doc?.(presenceDoc()) } catch {}
    }
    requestSnap(roomId, pageId)
    requestKeeper(roomId, pageId, 0)
    setStatus('connected — draw!')
  }

  // Letter surface deprecated with letter pages: boards need no frame.
  const ensureLetterSurface = (_roomId: string, _pageId: string) => {}

  // No mount race anymore: the board store is synchronous, so restores
  // run directly in switchDoc/switchPage. Kept as stubs for the debug hooks.
  const apiCalls = useRef<string[]>([])
  const restorePending = useRef<{ room: string; page: string } | null>(null)
  void restorePending

  const createPage = (name?: string) => {
    const roomId = activeRef.current
    if (!roomId) return
    const docs = [...docsRef.current]
    const doc = docs.find((d) => d.id === roomId)
    if (!doc) return
    const count = doc.pages.length + 1
    const pg: PageMeta = {
      id: newPageId(),
      name: name ?? `Board ${count}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    doc.pages.push(pg)
    setDocsBoth(docs)
    broadcastPages()
    switchPage(pg.id)
  }

  // Visiting a board = switching to it. (Daily auto-create deprecated.)
  const switchFormat = (_f: FormatTab) => {}

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
    return roomId
  }

  // A project is the highest unit. It starts with one board; more boards
  // are added from the tools panel. Sharing links a peer to the project.
  const createDoc = async () => {
    const node = nodeRef.current
    if (!node) return
    if (activeRef.current) persistSnapshot(activeRef.current)
    const name = prompt('Project name', `Project ${docsRef.current.length + 1}`)
    if (name === null) return
    const ch = await node.create(nick.current)
    const roomId: string = ch.id()
    const owner: string = me.current
    rooms.current.set(roomId, { ch, owner, live: new Map() })
    pumpRoom(roomId, ch)
    // Wait for the home relay before minting: tickets without relay hints
    // are undialable, and the keeper (which joins from the stored ticket)
    // would sit in the topic alone, merging nothing. Same wait as share().
    setStatus('waiting for relay…')
    await awaitRelay()
    const ticket = await ch.ticket({ includeMyself: true, includeBootstrap: true, includeNeighbors: true })
    setDocsBoth([...docsRef.current, { id: roomId, owner, name: name.trim() || `Project ${docsRef.current.length + 1}`, ticket, updatedAt: Date.now(), pages: [mainPage()] }])
    try { ch.sender.set_current_doc?.(presenceDoc()) } catch {}
    switchDoc(roomId)
    // Fresh data key, stored locally, shared only via the link fragment.
    saveKey(roomId, generateKey())
    await copyText(shareLink(ticket, roomId))
    setStatus('new project created — share link copied')
  }

  // EPHEMERAL presence → render-only peers. Cursor dots ride the mesh and
  // land in board.peers (overlay canvas); they never enter rev, onChange,
  // snapshots, or the cell. Stale entries (>3s) are pruned at write + paint.
  const pushCollaborators = () => {
    const board = boardRef.current
    if (!board) return
    const peers: Record<string, { x: number; y: number; nick: string; at: number }> = {}
    for (const [from, c] of Object.entries(cursors.current)) {
      peers[from] = {
        x: c.x,
        y: c.y,
        nick: dispNick(from, onlineRef.current[from] ?? peersRef.current[from]?.nick ?? from.slice(0, 6)),
        at: c.at,
      }
    }
    board.setPeers(peers)
  }

  // boot: stable identity, then room from share link if present
  useEffect(() => {
    let dead = false
    void selfTest().then((ok) => {
      if (!ok && !dead) setStatus('encryption self-test FAILED — see console')
    })
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
          // Data key rides the fragment, never the ticket: store it.
          const k = new URLSearchParams(location.hash.slice(1)).get('k')
          const raw = k ? keyFromB64(k) : null
          if (raw) saveKey(roomId, raw)
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
  const gpuWarned = useRef(false)
  useEffect(() => {
    const t = window.setInterval(() => {
      if (activeRef.current) persistSnapshot(activeRef.current)
      // Surface GPU death visibly (once): silent frame-loop failure looks
      // exactly like "commits vanish, grid stays".
      // stats shape: "begun dropped drawn last_error | ferr=N msg".
      if (!gpuWarned.current && viewRef.current) {
        try {
          const s = viewRef.current.stats()
          const begun = parseInt(s.split(' ')[0] ?? 'NaN', 10)
          const sceneLen = apiRef.current?.getSceneElements?.().length ?? 0
          if (/ferr=(?!0(\s|$))/.test(s) || (/acquire:/.test(s) && begun === 0)) {
            gpuWarned.current = true
            setStatus(`canvas trouble: ${s.slice(0, 120)}`)
          } else if (Number.isFinite(begun) && begun === 0 && sceneLen > 0) {
            // Frames never presented while ink exists: surface dead.
            gpuWarned.current = true
            setStatus(`canvas trouble: gpu never presented (${s.slice(0, 100)})`)
          }
        } catch {}
      }
    }, 3000)
    return () => clearInterval(t)
  }, [])

  // Cell live merges: WS fan-out from the celld fleet, ingested through the
  // same decrypt-then-merge path as gossip 'p'. No iroh involved.
  useEffect(() => {
    if (!activeId) return
    const roomId = activeId
    return cellSubscribe(roomId, (pg, snap) => {
      if (roomId !== activeRef.current) return
      void (async () => {
        try {
          const els = await openEls(roomId, snap.elements)
          const files = await openIncomingFiles(roomId, snap.files)
          if (pg === (activePageRef.current ?? 'main')) {
            if (files.length) ingestFiles(files)
            if (ingestTombs(snap.tombs ?? [])) { /* enforced below */ }
            if (els.length) queueRemote(els, snap.meta, false)
            remote.current = true
            try { enforceTombs() } finally { remote.current = false }
          } else if (els.length || Array.isArray(snap.tombs)) {
            mergePageSnapshot(roomId, pg, els, snap.meta, snap.tombs ?? [], files)
          } else if (files.length) {
            mergePageSnapshot(roomId, pg, [], undefined, [], files)
          }
        } catch {}
      })()
    })
  }, [activeId])

  // DEBUG-only console hook for the e2e sandbox (draw/add/delete/verify).
  useEffect(() => {
    if (!DEBUG) return
    ;(window as any).__draw = {
      scene: () => (apiRef.current?.getSceneElements() ?? []).map((el: any) => ({ id: el.id, type: el.type, v: el.version, del: !!el.isDeleted, w: el.strokeWidth, n: el.points?.length })),
      sceneAll: () => {
        const a: any = apiRef.current
        const els = a?.getSceneElementsIncludingDeleted ? a.getSceneElementsIncludingDeleted() : (a?.getSceneElements() ?? [])
        return els.map((el: any) => ({ id: el.id, v: el.version, del: !!el.isDeleted }))
      },
      addRect: () => {
        const a = apiRef.current
        if (!a) return null
        const id = 'e2e-' + Math.random().toString(36).slice(2, 10)
        // Unique fractional index: elements sharing index:null collide in
        // Excalidraw's index sync and one gets dropped on merge.
        const idx = 'a' + Date.now().toString(36).slice(-4) + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')
        const el = { id, type: 'rectangle', x: 100, y: 100, width: 200, height: 100, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, roundness: { type: 3 }, boundElements: [], link: null, locked: false, index: idx, version: 1, versionNonce: Math.floor(Math.random() * 2 ** 31), isDeleted: false, groupIds: [], frameId: null } as any
        a.updateScene({ elements: [...a.getSceneElements(), el] })
        return id
      },
      del: (id: string) => {
        const a = apiRef.current
        if (!a) return
        a.updateScene({ elements: (a.getSceneElements() as any[]).filter((el) => el.id !== id) })
      },
      // Stroke-width probe: rewrite all live widths (render-only, versions
      // untouched so nothing broadcasts).
      setWidths: (w: number) => {
        const a = apiRef.current
        if (!a) return null
        remote.current = true
        try {
          US('thin-test', {
            elements: (a.getSceneElements() as any[]).map((el) => ({ ...el, strokeWidth: w })),
          })
        } finally {
          remote.current = false
        }
        return true
      },
      reconcileTest: (_els: any[]) => null, // retired with Excalidraw
      collabPing: () => {
        cursors.current['probe'] = { x: 1, y: 1, at: Date.now() }
        pushCollaborators()
      },
      meta: () => [...metaActive.current.entries()].map(([id, e]) => ({ id, ...e })),
      mesh: () => {
        const els = apiRef.current?.getSceneElements() ?? []
        return (els as any[]).map((el) => {
          try {
            const m = meshProviderRef.current(el)
            return m ? { id: el.id, verts: m.verts.length, idx: m.idx.length, v0: Array.from(m.verts.slice(0, 6)), i0: Array.from(m.idx.slice(0, 6)) } : { id: el.id, skipped: true }
          } catch (e) { return { id: el?.id, err: String(e).slice(0, 120) } }
        })
      },
      tombs: () => [...tombsActive.current.entries()].map(([id, e]) => ({ id, ...e })),
      stats: () => JSON.parse(JSON.stringify(stats.current)),
      lastPush: () => lastPush.current,
      gpu: () => {
        try { return viewRef.current?.stats() ?? 'no-view' } catch (e) { return `err ${String(e).slice(0, 80)}` }
      },
      fetchErr: () => fetchErr.current,
      lastFetch: () => lastFetch.current,
      flushCount: () => flushCount.current,
      apiCalls: () => apiCalls.current,
      usLog: () => usLog.current,
      counts: () => ({ vanish: vanishCount.current, persist: persistCount.current, flush: flushCount.current, changes: changeCount.current, lastSeen: lastSeenCount.current, seenHist: seenHist.current }),
      scroll: () => {
        try {
          const s: any = apiRef.current?.getAppState()
          return s ? { x: s.scrollX, y: s.scrollY, z: s.zoom?.value ?? 1, w: s.width, h: s.height } : null
        } catch { return null }
      },
      diag: () => ({
        meta: metaActive.current.size,
        tombs: tombsActive.current.size,
        known: knownIds.current.size,
        pending: pendingRef.current ? pendingRef.current.map.size : -1,
        scene: (apiRef.current?.getSceneElements() ?? []).length,
      }),
      lsGet: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
      lsDel: (k: string) => { try { localStorage.removeItem(k); return true } catch { return false } },
    }
    return () => { try { delete (window as any).__draw } catch {} }
  }, [])

  // flush outbound drawing batches ~16/s
  useEffect(() => {
    const t = window.setInterval(flushDirty, 60)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sheet clamp backstop (covers pans that don't fire onChange).
  useEffect(() => {
    const t = window.setInterval(clampViewport, 150)
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
  const flushDirty = async () => {
    if (!dirtyRef.current.size && !dirtyFilesRef.current.size && !dirtyTombs.current.size) return
    if (!me.current || !activeCh()) return
    // Capture room+page: sealing is async, and a switch mid-seal must not
    // send this room's ink on another room's channel (persist-on-switch
    // already saved it; dropping here loses nothing).
    const roomId = activeRef.current
    const pg = activePageRef.current ?? 'main'
    if (!roomId) return
    const els = [...dirtyRef.current.values()]
    dirtyRef.current.clear()
    const files = [...dirtyFilesRef.current.values()]
    dirtyFilesRef.current.clear()
    const tombs = [...dirtyTombs.current.entries()].map(([id, e]) => ({ id, v: e.v, ts: e.ts, author: e.author }))
    dirtyTombs.current.clear()
    // Delete scan rides the flush: genuine local deletes mint within ~60ms
    // while drawing (persist tick covers quiet tabs).
    mintScan()
    // Claim metadata rides alongside (compact): receivers merge by
    // (version, ts, author) instead of trusting arrival order.
    const meta: Record<string, [number, string]> = {}
    for (const el of els) {
      const m = metaActive.current.get(el.id)
      if (m) meta[el.id] = [m.ts, m.author]
    }
    const sels = await sealEls(roomId, els)
    const sfiles = await sealOutgoingFiles(roomId, files)
    if (roomId !== activeRef.current) return // switched mid-seal: drop
    if (!sfiles.length && !tombs.length) {
      if (sels.length) sendMsg({ t: 'p', elements: sels, meta, page: pg })
      return
    }
    const body = { t: 'p', elements: sels, meta, tombs, page: pg }
    if (!sfiles.length) {
      sendMsg(body)
      return
    }
    const inline = JSON.stringify(sfiles).length + JSON.stringify(body).length < MAX_MSG
    if (inline) {
      sendMsg({ ...body, files: sfiles })
    } else {
      if (sels.length || tombs.length) sendMsg(body)
      for (const f of sfiles) {
        if (JSON.stringify(f).length > MAX_MSG) {
          setStatus('image too large to sync (>180KB)')
          continue
        }
        sendMsg({ t: 'f', files: [f], page: pg })
      }
    }
  }

  const onChange = (elements: readonly any[], _appState: any, files: Record<string, any>) => {
    clampViewport()
    changeCount.current += 1
    lastSeenCount.current = (elements as any[]).length
    seenHist.current.push((elements as any[]).length)
    if (seenHist.current.length > 12) seenHist.current.shift()
    if (changeCount.current <= 6 && DEBUG) console.log(`[onchange#${changeCount.current}] t=${Date.now() % 100000} seen=${(elements as any[]).length} remote=${remote.current}`)
    if (remote.current || !me.current || !activeCh()) return
    lastEditAt.current = Date.now()
    const now = Date.now()
    let touched = false
    const seen = new Set<string>()
    // NOTE: no width rewriting here. The pen overlay commits final widths
    // directly (fractional allowed); Excalidraw shapes keep native 1/2/3.
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
    // knownIds is add-only: ids ever observed in our scene. Stale onChange
    // deliveries must neither add nor remove here beyond union — the mint
    // scan decides deletes from live truth.
    for (const id of seen) knownIds.current.add(id)
    if (touched && dirtyRef.current.size > 200) flushDirty() // backpressure: huge burst flushes early
  }

  // Stable onChange identity for the board store fan-out.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const stableOnChange = useCallback(
    (elements: readonly any[], appState: any, files: Record<string, any>) =>
      onChangeRef.current(elements, appState, files),
    [],
  )

  // ---- Canvas input: pan + eraser (pen lives in PenOverlay) ------------
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const meshProviderRef = useRef(makeMeshProvider())
  const panRef = useRef<{ x: number; y: number; btn: number } | null>(null)

  const sceneOf = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    const board = boardRef.current
    if (!canvas || !board) return null
    const r = canvas.getBoundingClientRect()
    const c = board.camera
    return {
      x: (clientX - r.left) / c.zoom - c.scrollX,
      y: (clientY - r.top) / c.zoom - c.scrollY,
    }
  }

  const eraseAt = (clientX: number, clientY: number) => {
    const board = boardRef.current
    if (!board) return
    const s = sceneOf(clientX, clientY)
    if (!s) return
    const radius = 12 / board.camera.zoom
    const targets = board.elements
      .filter((el: any) => el?.type === 'freedraw' && !el.isDeleted && Array.isArray(el.points))
      .map((el: any) => ({
        id: el.id,
        points: (el.points as [number, number][]).map(([px, py]) => [px + (el.x ?? 0), py + (el.y ?? 0)]),
        width: +el.strokeWidth || 1,
      }))
    if (!targets.length) return
    let hits: string[] = []
    try {
      hits = JSON.parse(erase_hit(JSON.stringify(targets), s.x, s.y, radius))
    } catch { return }
    if (!hits.length) return
    const dead = new Set(hits)
    // Removal mint-tombs via the usual scan: ids were known, now missing.
    apiRef.current?.updateScene({ elements: board.elements.filter((el: any) => !dead.has(el.id)) })
  }

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointersRef.current.size === 2) {
      // Second finger lands: pinch takes over, whatever was happening ends.
      panRef.current = null
      pinchRef.current = pinchState()
      return
    }
    const panning = toolRef.current === 'pan' || spaceRef.current || e.button === 1
    if (panning) {
      panRef.current = { x: e.clientX, y: e.clientY, btn: e.button }
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      return
    }
    if (toolRef.current === 'eraser') {
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      panRef.current = { x: e.clientX, y: e.clientY, btn: -2 } // erase stroke
      eraseAt(e.clientX, e.clientY)
    }
  }

  // EPHEMERAL cursor broadcast: throttled pointer position over the mesh.
  // Best-effort datagram semantics — drops are fine, the next move replaces
  // them. Never persisted, never merged, never sent to the cell.
  const cursorLastRef = useRef(0)
  const sendCursor = (clientX: number, clientY: number) => {
    try {
      const now = Date.now()
      if (now - cursorLastRef.current < 100) return
      cursorLastRef.current = now
      const board = boardRef.current
      const canvas = canvasRef.current
      if (!board || !canvas || !activeCh()) return
      const r = canvas.getBoundingClientRect()
      const c = board.camera
      sendMsg({
        t: 'cursor',
        x: (clientX - r.left) / c.zoom - c.scrollX,
        y: (clientY - r.top) / c.zoom - c.scrollY,
        page: activePageRef.current ?? 'main',
      })
    } catch {}
  }

  const onCanvasPointerMove = (e: React.PointerEvent) => {
    sendCursor(e.clientX, e.clientY)
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }
    const pinch = pinchRef.current
    const board = boardRef.current
    if (pinch && pointersRef.current.size >= 2 && board) {
      // Two fingers: zoom around the midpoint + pan with it.
      const cur = pinchState()
      if (cur && pinch.dist > 0 && cur.dist > 0) {
        const c = board.camera
        const factor = cur.dist / pinch.dist
        const zx = Math.min(8, Math.max(0.1, c.zoom * factor))
        // Scene point under the old midpoint stays under the new one.
        const r = canvasRef.current?.getBoundingClientRect()
        const mx = (cur.midX - (r?.left ?? 0))
        const my = (cur.midY - (r?.top ?? 0))
        const sx = mx / c.zoom - c.scrollX
        const sy = my / c.zoom - c.scrollY
        c.zoom = zx
        c.scrollX = mx / zx - sx + (cur.midX - pinch.midX) / zx
        c.scrollY = my / zx - sy + (cur.midY - pinch.midY) / zx
        pinchRef.current = cur
        clampViewport()
      }
      return
    }
    const pan = panRef.current
    if (!pan || !e.buttons) return
    if (!board) return
    if (pan.btn === -2) {
      eraseAt(e.clientX, e.clientY)
      return
    }
    const dx = (e.clientX - pan.x) / board.camera.zoom
    const dy = (e.clientY - pan.y) / board.camera.zoom
    pan.x = e.clientX
    pan.y = e.clientY
    board.camera.scrollX += dx
    board.camera.scrollY += dy
    clampViewport()
  }

  const onCanvasPointerUp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
    if (pointersRef.current.size === 0) panRef.current = null
  }

  const onCanvasWheel = (e: React.WheelEvent) => {
    const board = boardRef.current
    const canvas = canvasRef.current
    if (!board || !canvas) return
    const r = canvas.getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    if (e.ctrlKey || e.metaKey) {
      // Pinch/keyboard zoom around the cursor.
      const factor = Math.exp(-e.deltaY * 0.01)
      const c = board.camera
      const zx = Math.min(8, Math.max(0.1, c.zoom * factor))
      const sx = (mx / c.zoom - c.scrollX) // scene under cursor, before
      const sy = (my / c.zoom - c.scrollY)
      c.zoom = zx
      c.scrollX = mx / zx - sx
      c.scrollY = my / zx - sy
    } else {
      // The roll scrolls: wheel runs down the sheet.
      board.camera.scrollY -= e.deltaY / board.camera.zoom
      board.camera.scrollX -= e.deltaX / board.camera.zoom
    }
    clampViewport()
  }

  // wgpu render loop: store → meshes → canvas. Sync engine untouched.
  const viewRef = useRef<{ destroy(): void; stats(): string; renderer: string } | null>(null)
  const [rendererKind, setRendererKind] = useState('…')
  // Live pointers for pinch tracking (pointerId → client coords).
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ dist: number; midX: number; midY: number } | null>(null)
  const pinchState = () => {
    const pts = [...pointersRef.current.values()]
    if (pts.length < 2) return null
    const [a, b] = pts
    return {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    }
  }
  useEffect(() => {
    let dead = false
    let view: { destroy(): void; stats(): string; renderer: string } | null = null
    let peers: { destroy(): void } | null = null
    ;(async () => {
      const canvas = canvasRef.current
      const board = boardRef.current
      if (!canvas || !board) return
      board.onChange = stableOnChange
      board.setViewportSize(canvas.clientWidth, canvas.clientHeight)
      // Ephemeral overlay first: own canvas + loop, zero coupling to ink.
      try {
        if (canvas.parentElement) peers = attachPeerOverlay(canvas.parentElement, canvas, board)
      } catch {}
      try {
        view = await createBoardView(canvas, board, meshProviderRef.current)
      } catch (err) {
        setStatus(`canvas init failed: ${err}`)
        return
      }
      if (dead) { view.destroy(); return }
      viewRef.current = view
      setRendererKind(view.renderer)
    })()
    return () => {
      dead = true
      view?.destroy()
      peers?.destroy()
      if (viewRef.current === view) viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Space held = temporary pan (mirrors the overlay's own tracking).
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space') spaceRef.current = true }
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') spaceRef.current = false }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

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
      await copyText(shareLink(ticket, activeRef.current!))
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
    background: PAPER, color: INK, padding: 12, borderRadius: 4,
    boxShadow: `3px 3px 0 ${INK}`,
    border: `1.5px solid ${INK}`, fontSize: 13, fontFamily: MONO,
  }
  // Connection state for the status stamp: red = offline, yellow = working,
  // green = in a room.
  const conn: 'off' | 'busy' | 'on' =
    !id || /failed/i.test(status) ? 'off'
    : !activeId || /starting|joining|ready/i.test(status) ? 'busy'
    : 'on'
  const connColor = conn === 'on' ? '#2e7d32' : conn === 'busy' ? '#b7791f' : '#c62828'
  const pill: React.CSSProperties = {
    position: 'absolute', right: 12, bottom: 12, zIndex: 1000,
    display: 'flex', alignItems: 'center', gap: 8,
    background: PAPER, color: INK, padding: '8px 14px', borderRadius: 4,
    boxShadow: `3px 3px 0 ${INK}`,
    border: `1.5px solid ${INK}`, fontSize: 13, fontFamily: MONO, fontWeight: 700,
    cursor: 'pointer',
  }
  const btn: React.CSSProperties = {
    background: CARD_BG, color: INK, border: `1.5px solid ${INK}`,
    borderRadius: 4, padding: '5px 12px', margin: '2px 4px 2px 0', cursor: 'pointer', fontSize: 13,
    fontFamily: MONO,
  }
  const input: React.CSSProperties = {
    width: '100%', margin: '6px 0', background: PAPER, color: INK,
    border: `1.5px solid ${INK}`, borderRadius: 4, padding: '5px 8px', fontSize: 12,
    fontFamily: MONO, boxSizing: 'border-box',
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

  // Full zoom-out: opaque engineering-pad home screen, no whiteboard
  // behind. Projects are a rolodex drum you roll through vertically.
  const overlayBack: React.CSSProperties = {
    ...paperGrid,
    position: 'fixed', inset: 0, zIndex: 2000,
    display: 'flex', alignItems: 'stretch', justifyContent: 'center',
    fontFamily: MONO, color: INK,
  }
  const sheet: React.CSSProperties = {
    ...paperGrid, color: INK, padding: 24,
    width: '100%', maxWidth: 1100, height: '100%', overflowY: 'auto',
  }
  const deckCard: React.CSSProperties = {
    height: '100%', boxSizing: 'border-box',
    border: `1.5px solid ${INK}`, borderRadius: 4, padding: 18, cursor: 'pointer',
    background: CARD_BG, boxShadow: `3px 3px 0 ${INK}`,
    display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    fontFamily: MONO, color: INK,
  }
  const deckCardActive: React.CSSProperties = { ...deckCard, border: `3px solid ${INK}` }
  const cardGrid: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12,
  }
  const card: React.CSSProperties = {
    border: `1.5px solid ${INK}`, borderRadius: 4, padding: 14, cursor: 'pointer',
    background: CARD_BG, fontFamily: MONO, color: INK,
  }
  const cardActive: React.CSSProperties = { ...card, border: `3px solid ${INK}` }
  const tabBtn = (active: boolean): React.CSSProperties => ({
    ...btn, background: active ? INK : CARD_BG, color: active ? PAPER : INK,
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
      const { ticket, key } = splitTicketInput(peer)
      const roomId = await ensureRoom(ticket.trim(), nick.current)
      if (key) saveKey(roomId, key)
      switchDoc(roomId)
      sendMsg({ t: 'snap-req' })
      setPeer('')
      setView(null)
    } catch (e) { setStatus(`join failed: ${e}`) }
  }

  const renderTopicCards = (list: DocMeta[]) => (
    <RolodexDeck
      cards={list.map((d) => d.id)}
      onSelect={(key) => openDoc(key)}
      renderCard={(key, _offset, front) => {
        const d = list.find((x) => x.id === key)
        if (!d) return null
        const access = peersOnDoc(d.id)
        const live = rooms.current.get(d.id)?.live.size ?? 0
        return (
          <div
            style={d.id === activeId ? deckCardActive : deckCard}
            title={front ? 'Click to open' : 'Click to bring to front'}
          >
            <div>
              <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 4 }}>{d.name}{d.owner === id ? ' ★' : ''}</div>
              <div style={{ fontSize: 13, opacity: 0.65, marginBottom: 6 }}>
                {d.pages.length} board{d.pages.length === 1 ? '' : 's'}
                {live > 0 && ` · ${live} live`}
              </div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {d.owner === id ? 'owned by you' : `owner ${d.owner?.slice(0, 6) ?? '?'}`}
                {access.length > 0 && (
                  <span> · {access.slice(0, 4).map(([pid, p]) => dispNick(pid, p.nick)).join(', ')}{access.length > 4 ? ` +${access.length - 4}` : ''}</span>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={btn} onClick={(e) => { e.stopPropagation(); openDoc(d.id) }}>Open →</button>
            </div>
          </div>
        )
      }}
      newCard={
        <div style={{ ...deckCard, borderStyle: 'dashed', cursor: 'default', justifyContent: 'flex-start' }}>
          <button style={btn} onClick={createDoc}>+ new project</button>
          {!showAdd
            ? <button style={btn} onClick={() => setShowAdd(true)}>⤵ join with ticket</button>
            : (
              <div>
                <input placeholder="paste ticket or share link…" value={peer} onChange={(e) => setPeer(e.target.value)} style={input} />
                <button style={btn} onClick={joinTicket}>join</button>
              </div>
            )}
          <div style={{ fontSize: 12, opacity: 0.55, marginTop: 8 }}>roll ↑ ↓ to flip through projects</div>
        </div>
      }
    />
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
    <div ref={paperRef} style={{ position: 'fixed', inset: 0, ...paperGrid }}>
      {/* Rust canvas: wgpu surface, transparent over the CSS grid. */}
      <canvas
        id="board"
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none' }}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerUp}
        onWheel={onCanvasWheel}
      />
      {/* Tool cluster: pen draws, eraser deletes, pan moves. */}
      <div
        style={{
          position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 1000,
          display: 'flex', gap: 6, alignItems: 'center',
          background: PAPER, color: INK,
          border: `2px solid ${INK}`, borderRadius: 4,
          boxShadow: `3px 3px 0 ${INK}`,
          padding: '4px 6px', fontFamily: MONO, fontSize: 12, fontWeight: 700,
        }}
      >
        {([
          ['pen', '✏ PEN', 'tool-pen'],
          ['eraser', '⌫ ERASE', 'tool-eraser'],
          ['pan', '✥ PAN', 'tool-pan'],
        ] as const).map(([t, label, testid]) => (
          <button
            key={t}
            data-testid={testid}
            style={{
              ...btn, margin: 0,
              background: tool === t ? INK : CARD_BG,
              color: tool === t ? PAPER : INK,
              fontWeight: 700,
            }}
            onClick={() => setTool(t)}
          >{label}</button>
        ))}
      </div>
      {/* Pen capture: pencil input owned by the pen crate. Commits land
          as ordinary freedraw elements through onChange (sync untouched). */}
      <PenOverlay
        apiRef={apiRef}
        armed={tool === 'pen'}
        onError={(msg) => setStatus(msg)}
        onStroke={(el) => {
          const a = apiRef.current
          if (!a) return
          a.updateScene({ elements: [...a.getSceneElements(), el] as any[] })
        }}
      />
      {/* TOPS title block: hidden until summoned. Small stamp button
          toggles the full header (project/board/page/date + back-out). */}
      {!showHeader ? (
        <button
          style={{
            position: 'absolute', top: 12, left: 12, zIndex: 1000,
            background: PAPER, color: INK,
            border: `2px solid ${INK}`, borderRadius: 4,
            boxShadow: `3px 3px 0 ${INK}`,
            fontFamily: MONO, fontSize: 14, fontWeight: 800,
            padding: '4px 10px', cursor: 'pointer',
          }}
          onClick={() => setShowHeader(true)}
          title="Show header"
        >✦</button>
      ) : (
      <div
        style={{
          position: 'absolute', top: 12, left: 12, zIndex: 1000,
          background: PAPER, color: INK,
          border: `2px solid ${INK}`, borderRadius: 4,
          boxShadow: `3px 3px 0 ${INK}`,
          fontSize: 12, fontFamily: MONO,
          maxWidth: 'min(480px, 70vw)', overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          borderBottom: `1.5px solid ${INK}`, padding: '4px 8px',
          fontWeight: 800, letterSpacing: 1,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: connColor, display: 'inline-block', flexShrink: 0 }} />
          LIVE DRAW · ENG. PAD
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px' }}>
          <button
            style={{ ...btn, margin: 0, fontWeight: 700 }}
            onClick={() => setView('topics')}
            title="Back out to projects"
          >← PROJECTS</button>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
            {activeDoc ? `${activeDoc.name}` : 'No project open'}
            {activePage && activeDoc ? ` / SHT ${activeDoc.pages.find((p) => p.id === activePage)?.name ?? ''}` : ''}
          </span>
        </div>
        {activeDoc && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
            borderTop: `1.5px solid ${INK}`, opacity: 0.85,
          }}>
            <span>PG {Math.max(0, activeDoc.pages.findIndex((p) => p.id === activePage)) + 1} OF {activeDoc.pages.length}</span>
            <span style={{ flex: 1 }} />
            <span ref={sheetPageRef}>SHEET-PG 1</span>
            <span>{todayName()}</span>
          </div>
        )}
        <button
          style={{ ...btn, margin: 0, width: '100%', borderLeft: 'none', borderRight: 'none', borderBottom: 'none', borderRadius: 0 }}
          onClick={() => setShowHeader(false)}
          title="Hide header"
        >✕ HIDE</button>
      </div>
      )}
      <button style={{ ...pill, cursor: 'default' }} title={status}>
        <span style={{ width: 10, height: 10, borderRadius: 999, background: connColor, display: 'inline-block' }} />
        ENG.PAD
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
            <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4 }}>Boards in this project</div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
              <select
                value={activePage ?? ''}
                onChange={(e) => switchPage(e.target.value)}
                style={{ ...input, margin: 0, flex: 1 }}
              >
                {activeDoc.pages.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button style={btn} title="new board" onClick={() => createPage()}>+</button>
            </div>
            <button style={{ ...btn, width: '100%' }} title="Highlight the current selection (auto-dated)" onClick={createHighlightFromSelection}>
              ✦ highlight selection · auto-dates today
            </button>
            {highlights.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4 }}>Highlights ({highlights.length}) — future project map source</div>
                {[...highlights].sort((a, b) => b.createdAt - a.createdAt).map((h) => {
                  const bname = activeDoc.pages.find((p) => p.id === h.boardId)?.name ?? h.boardId.slice(0, 6)
                  return (
                    <div key={h.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, padding: '3px 0' }}>
                      <span style={{ background: PAPER, border: `1.5px solid ${INK}`, borderRadius: 4, padding: '0 6px', fontWeight: 700 }}>{h.date}</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bname} · {h.elementIds.length} els</span>
                      <button style={{ ...btn, padding: '1px 8px', fontSize: 11 }} onClick={() => jumpToHighlight(h)}>go</button>
                      <button style={{ ...btn, padding: '1px 8px', fontSize: 11 }} onClick={() => deleteHighlight(h.id)}>✕</button>
                    </div>
                  )
                })}
              </div>
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
        </div>
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 12 }}>{status}{activeDoc ? ` · ${activeDoc.name}` : ''}{activePage ? ` / ${activeDoc?.pages.find((p) => p.id === activePage)?.name ?? ''}` : ''}</div>
        <div style={{ opacity: 0.6, marginTop: 2, fontSize: 12 }}>renderer: {rendererKind}</div>
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
      {(view === 'topics' || view === 'peers' || !activeId) && (
        <div style={overlayBack} onClick={() => { if (activeId) setView(null) }}>
          <div style={sheet} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
              <span style={{
                fontWeight: 800, fontSize: 20, letterSpacing: 1,
                border: `2px solid ${INK}`, borderRadius: 4, padding: '2px 12px',
                background: PAPER, boxShadow: `3px 3px 0 ${INK}`,
              }}>✦ LIVE DRAW</span>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: connColor, display: 'inline-block' }} />
              <span style={{ flex: 1 }} />
              {activeId && view !== null && (
                <button style={btn} onClick={() => setView(null)}>← Back to board</button>
              )}
            </div>
            <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 16 }}>
              roll to flip through projects · click the front card to open it
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
              <button style={tabBtn(view === 'topics' || !activeId)} onClick={() => setView('topics')}>Projects</button>
              <button style={tabBtn(view === 'peers')} onClick={() => setView('peers')}>Peers</button>
            </div>
            {(view === 'topics' || !activeId) && (
              <div>
                {myDocs.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontWeight: 700, marginBottom: 8 }}>My projects</div>
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
