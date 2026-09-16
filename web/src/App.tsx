import { useEffect, useRef, useState } from 'react'
import { Tldraw, useEditor, getSnapshot } from 'tldraw'
import { irohInit, irohJoin, irohPush, roomTopic, roomJoin, roomPush } from './iroh'

// Packet pipeline: encode (compact) -> transport -> decode (expand) ->
// order (seq) -> apply (coalesce). Every message stays self-contained, so
// any loss/reorder degrades to a dropped frame, never corruption.
const r2 = (v: any) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)
// draw/highlight points [{x,y,z}...] -> flat [x,y,z...]: ~3x smaller JSON
const compactRec = (r: any) => {
  const segs = r?.props?.segments
  if (!Array.isArray(segs)) return r
  return {
    ...r,
    props: {
      ...r.props,
      segments: segs.map((s: any) => ({
        ...s,
        points:
          Array.isArray(s.points) && s.points.length && typeof s.points[0] === 'object'
            ? s.points.flatMap((p: any) => [r2(p.x), r2(p.y), r2(p.z)])
            : s.points,
      })),
    },
  }
}
const expandRec = (r: any) => {
  const segs = r?.props?.segments
  if (!Array.isArray(segs)) return r
  const out = []
  for (const s of segs) {
    let points = s.points
    if (Array.isArray(points) && typeof points[0] === 'number') {
      const pts = []
      for (let i = 0; i + 2 < points.length; i += 3)
        pts.push({ x: points[i], y: points[i + 1], z: points[i + 2] })
      points = pts
    }
    out.push({ ...s, points })
  }
  return { ...r, props: { ...r.props, segments: out } }
}

// navigator.clipboard needs HTTPS; plain-HTTP LAN (Android especially)
// throws, so fall back to the legacy execCommand path.
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

const hue = (s: string) => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

type Cursor = { tx: number; ty: number; x: number; y: number; at: number }

function Net() {
  const editor = useEditor()
  const [id, setId] = useState('')
  const [peer, setPeer] = useState('')
  const [status, setStatus] = useState('starting…')
  const curs = useRef<Record<string, Cursor>>({})
  const [, setTick] = useState(0)
  const [showAdd, setShowAdd] = useState(false)
  const pending = useRef<{ added: any[]; updated: Map<string, any>; removed: string[] } | null>(null)
  const raf = useRef(0)
  const timers = useRef<number[]>([])

  // Direct broadcast: every message travels exactly one path (producer to
  // each direct peer). Per-sender sequence numbers drop the odd stale frame.
  const me = useRef('')
  const seq = useRef(0)
  const inRoom = useRef(false) // live traffic rides gossip once joined
  const lastSeq = useRef<Record<string, number>>({})
  // receive coalescing: keep only the newest patch per sender; the render
  // loop applies at most one per frame, so a burst can never backlog the UI
  const latestPatch = useRef<Record<string, any>>({})
  const sendMsg = (obj: any) => {
    const s = JSON.stringify({ from: me.current, seq: seq.current++, ...obj })
    if (inRoom.current) roomPush(s)
    else irohPush(s)
  }
  const connect = async (addr: string) => {
    setStatus('connecting…')
    try {
      await irohJoin(addr, JSON.stringify({ from: me.current, seq: seq.current++, t: 'snap-req' }))
      setStatus('connected — draw!')
    } catch (e) { setStatus(`connect failed: ${e}`) }
  }

  useEffect(() => {
    // Board-as-is: newcomer takes the board exactly. No merges, no replies
    // except answering a state request with the current snapshot.
    irohInit((msg) => {
      try {
        const m = JSON.parse(msg)
        if (m?.t === 'cursor' && m.from && m.from !== me.current) {
          const prev = curs.current[m.from]
          curs.current[m.from] = {
            tx: m.x, ty: m.y,
            x: prev?.x ?? m.x, y: prev?.y ?? m.y,
            at: Date.now(),
          }
          return
        }
        if (m?.t === 'p') {
          // drop stale frames (older copy via slower path) — only patches reorder
          if (typeof m.seq === 'number' && m.from) {
            if (m.seq <= (lastSeq.current[m.from] ?? -1)) return // stale copy
            lastSeq.current[m.from] = m.seq
          }
          latestPatch.current[m.from ?? '?'] = m
        } else if (m?.t === 'snap-req') {
          sendMsg({ t: 'snap', snapshot: getSnapshot(editor.store) })
        } else if (m?.t === 'snap' || m?.t === 'snap-back') {
          const doc = m.snapshot?.document ?? m.snapshot
          if (doc) {
            try { editor.store.loadStoreSnapshot(doc) } catch {}
            setStatus('board loaded')
            setTimeout(() => setStatus('ready'), 2000)
          }
        } else if (m && !m.t) {
          const doc = m?.document ?? m
          try { editor.store.loadStoreSnapshot(doc) } catch {}
        }
      } catch {}
    }).then(async (a) => {
      setId(a)
      me.current = a.split(/\s/)[0] // node id portion of addr
      setStatus('ready')
      // share-link autojoin: #t=<topic>&p=<addr> — gossip room for live
      // traffic, direct dial for the initial snapshot
      const q = new URLSearchParams(location.hash.slice(1))
      const viaTopic = q.get('t'), viaLink = q.get('p')
      if (viaTopic) {
        try {
          await roomJoin(viaTopic, viaLink && viaLink !== a ? [viaLink] : [])
          inRoom.current = true
        } catch (e) { setStatus(`room failed: ${e}`) }
      }
      if (viaLink && viaLink !== a) connect(viaLink)
    }).catch((e) => setStatus(`init failed: ${e}`))
    // realtime: forward every local document change, coalesced per frame,
    // compacted, paced to ~30/s
    let lastFlush = 0
    const flush = () => {
      raf.current = 0
      if (Date.now() - lastFlush < 33) {
        if (pending.current) raf.current = requestAnimationFrame(flush)
        return
      }
      lastFlush = Date.now()
      const d = pending.current; pending.current = null
      if (d && (d.added.length || d.updated.size || d.removed.length)) {
        sendMsg({
          t: 'p',
          added: d.added.map(compactRec),
          updated: [...d.updated.values()].map(compactRec),
          removed: d.removed,
        })
      }
    }
    const off = editor.store.listen((entry) => {
      if (entry.source !== 'user') return
      const p = (pending.current ??= { added: [], updated: new Map(), removed: [] })
      for (const r of Object.values(entry.changes.added)) p.added.push(r)
      for (const [id, change] of Object.entries(entry.changes.updated)) p.updated.set(id, (change as any)[1])
      for (const id of Object.keys(entry.changes.removed)) p.removed.push(id as string)
      if (!raf.current) raf.current = requestAnimationFrame(flush)
    }, { scope: 'document' })
    timers.current.push(window.setInterval(() => setTick((t) => t + 1), 500)) // prune stale lasers
    // smoothing loop: laser dots ease toward targets; at most one queued
    // patch per sender is applied per frame (~60fps, bounded work)
    let raf2 = 0
    const step = () => {
      raf2 = requestAnimationFrame(step)
      let moved = false
      for (const [from, c] of Object.entries(curs.current)) {
        if (Date.now() - c.at > 3000) { delete curs.current[from]; moved = true; continue }
        const nx = c.x + (c.tx - c.x) * 0.25, ny = c.y + (c.ty - c.y) * 0.25
        if (Math.abs(nx - c.x) + Math.abs(ny - c.y) > 0.05) { c.x = nx; c.y = ny; moved = true }
      }
      const pend = latestPatch.current; latestPatch.current = {}
      for (const m of Object.values(pend)) {
        moved = true
        editor.store.mergeRemoteChanges(() => {
          if (m.removed?.length) editor.store.remove(m.removed)
          if (m.added?.length) editor.store.put(m.added.map(expandRec))
          if (m.updated?.length) editor.store.put(m.updated.map(expandRec))
        })
      }
      if (moved) setTick((t) => t + 1)
    }
    raf2 = requestAnimationFrame(step)
    return () => { off(); cancelAnimationFrame(raf.current); cancelAnimationFrame(raf2); timers.current.forEach(clearInterval) }
  }, [editor])

  // laser pointer: broadcast page-space position, ~12/s while moving.
  // Listens on tldraw's own container (an overlay div would eat canvas clicks).
  useEffect(() => {
    const el = editor.getContainer()
    let last = 0
    const h = (e: PointerEvent) => {
      const now = Date.now()
      if (now - last < 80 || !me.current) return
      last = now
      const rect = el.getBoundingClientRect()
      const pt = editor.screenToPage({ x: e.clientX - rect.left, y: e.clientY - rect.top })
      sendMsg({ t: 'cursor', x: pt.x, y: pt.y })
    }
    el.addEventListener('pointermove', h)
    return () => el.removeEventListener('pointermove', h)
  }, [editor])

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
  const now = Date.now()
  return (
    <>
      {/* remote laser pointers (smoothed) */}
      {Object.entries(curs.current).map(([from, c]) => {
        if (now - c.at > 3000) return null
        const s = editor.pageToScreen({ x: c.x, y: c.y })
        const col = `hsl(${hue(from)} 85% 60%)`
        return (
          <div key={from} style={{ position: 'absolute', left: s.x, top: s.y, zIndex: 998, pointerEvents: 'none' }}>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: col, boxShadow: `0 0 12px 3px ${col}`, transform: 'translate(-50%,-50%)' }} />
            <div style={{ fontSize: 10, color: col, marginTop: 8, textShadow: '0 1px 4px #fff' }}>{from.slice(0, 6)}</div>
          </div>
        )
      })}
      <div style={panel}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>✦ live draw</div>
        <button style={btn} onClick={() => setShowAdd((s) => !s)}>+</button>
        {showAdd && (
          <div>
            <input placeholder="paste peer addr…" value={peer} onChange={(e) => setPeer(e.target.value)} style={input} />
            <button style={btn} onClick={() => { connect(peer); setShowAdd(false) }}>connect</button>
          </div>
        )}
        <div style={{ marginTop: 6 }}>
          <button disabled={!id} style={btn} onClick={async () => {
            try {
              const t = roomTopic()
              await roomJoin(t, [])
              inRoom.current = true
              await copyText(`${location.origin}${location.pathname}#t=${t}&p=${encodeURIComponent(id)}`)
              setStatus('share link copied — send it')
            } catch (e) { setStatus(`share failed: ${e}`) }
          }}>⧉ share</button>
          <button style={btn} onClick={() => {
            sendMsg({ t: 'snap-req' })
            setStatus('reloading board…')
          }}>⟳ sync</button>
          <button style={btn} onClick={() => copyText(JSON.stringify(getSnapshot(editor.store))).then(() => alert('Copied JSON — paste into any agent'))}>agent JSON</button>
          <button style={btn} onClick={async () => {
            const svg = await editor.getSvgString(editor.getCurrentPageShapeIds())
            await copyText(svg?.svg ?? '')
            alert('Copied SVG')
          }}>SVG</button>
        </div>
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 12 }}>{status}</div>
      </div>
    </>
  )
}

export default function App() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw persistenceKey="iroh-live-draw">
        <Net />
      </Tldraw>
    </div>
  )
}
