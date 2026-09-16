import { useEffect, useRef, useState } from 'react'
import { Excalidraw, reconcileElements, exportToSvg } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI, OrderedExcalidrawElement } from '@excalidraw/excalidraw/types'
import { irohInit, irohJoin, irohPush, roomTopic, roomJoin, roomPush, signPresence } from './iroh'
import '@excalidraw/excalidraw/index.css'

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

type PeerCursor = { x: number; y: number; at: number }

export default function App() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [id, setId] = useState('')
  const [peer, setPeer] = useState('')
  const [status, setStatus] = useState('starting…')
  const [showAdd, setShowAdd] = useState(false)
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const remote = useRef(false)
  const timers = useRef<number[]>([])
  const me = useRef('')
  const seq = useRef(0)
  const inRoom = useRef(false)
  const dialed = useRef<Set<string>>(new Set()) // presence auto-dial dedup
  // fixed dev room: presence-discovered peers converge here without links
  const DEV_TOPIC = 'fc0e92f0414e9f0cc1445177fec17336a2ca07396ae16334d1029f31540663e4'
  const lastSeq = useRef<Record<string, number>>({})
  const latestScene = useRef<any[] | null>(null)
  const cursors = useRef<Record<string, PeerCursor>>({})
  const lastFlush = useRef(0)
  const lastPtr = useRef(0)

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

  // inbound: patches merge via reconcile, snaps load as-is, cursors tracked.
  // Single irohInit (see init effect); this ref always points at fresh logic.
  const handleRef = useRef((_raw: string) => {})
  handleRef.current = (msg: string) => {
    try {
      const m = JSON.parse(msg)
      if (m?.t === 'cursor' && m.from && m.from !== me.current) {
        cursors.current[m.from] = { x: m.x, y: m.y, at: Date.now() }
        pushCollaborators()
        return
      }
      if (m?.t === 'p') {
        if (typeof m.seq === 'number' && m.from) {
          if (m.seq <= (lastSeq.current[m.from] ?? -1)) return
          lastSeq.current[m.from] = m.seq
        }
        latestScene.current = m.elements
      } else if (m?.t === 'snap-req') {
        sendMsg({ t: 'snap', elements: apiRef.current?.getSceneElements() ?? [] })
      } else if (m?.t === 'snap' || m?.t === 'snap-back') {
        if (Array.isArray(m.elements)) applyRemote(m.elements)
      } else if (Array.isArray(m)) {
        applyRemote(m) // legacy untagged
      }
    } catch {}
  }

  const applyRemote = (elements: any[]) => {
    const a = apiRef.current
    if (!a) return
    remote.current = true
    try {
      a.updateScene({ elements: reconcileElements(a.getSceneElements(), elements, a.getAppState()) as OrderedExcalidrawElement[] })
    } finally {
      remote.current = false
    }
  }

  // apply newest queued scene at most once per frame (bounded work)
  useEffect(() => {
    let raf = 0
    const step = () => {
      raf = requestAnimationFrame(step)
      const el = latestScene.current
      latestScene.current = null
      if (el) applyRemote(el)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  // prune stale cursors
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now()
      let changed = false
      for (const [k, c] of Object.entries(cursors.current)) {
        if (now - c.at > 3000) { delete cursors.current[k]; changed = true }
      }
      if (changed) pushCollaborators()
    }, 1000)
    return () => clearInterval(t)
  }, [])

  const pushCollaborators = () => {
    const a = apiRef.current
    if (!a) return
    const map = new Map()
    for (const [from, c] of Object.entries(cursors.current)) {
      map.set(from, {
        pointer: { x: c.x, y: c.y, tool: 'pointer' },
        button: 'up',
        username: from.slice(0, 6),
        color: { Background: `hsl(${hue(from)} 85% 55%)`, Stroke: `hsl(${hue(from)} 85% 55%)` },
      })
    }
    a.updateScene({ collaborators: map as any })
  }

  // init: identity, share-link autojoin (room + direct dial for snapshot)
  useEffect(() => {
    irohInit((msg) => handleRef.current(msg)).then(async (a) => {
      setId(a)
      me.current = a.split(/\s/)[0]
      setStatus('ready')
      const q = new URLSearchParams(location.hash.slice(1))
      const viaTopic = q.get('t'), viaLink = q.get('p')
      if (viaTopic) {
        try {
          await roomJoin(viaTopic, viaLink && viaLink !== a ? [viaLink] : [])
          inRoom.current = true
        } catch (e) { setStatus(`room failed: ${e}`) }
      }
      if (viaLink && viaLink !== a) connect(viaLink)
      // dev presence: signed register, then auto-dial every new peer seen.
      // No-op where /api/presence doesn't exist (local static server).
      const presence = async () => {
        try {
          const ts = Date.now()
          const msg = `${me.current}.${a}.${ts}`
          await fetch('/api/presence', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ nodeId: me.current, addr: a, ts, sig: signPresence(msg) }),
          })
          const peers: { nodeId: string; addr: string }[] = await (await fetch('/api/presence')).json()
          const fresh = peers.filter((p) => p?.nodeId && p.nodeId !== me.current && p.addr && !dialed.current.has(p.nodeId))
          if (fresh.length) {
            if (!inRoom.current) {
              await roomJoin(DEV_TOPIC, fresh.map((p) => p.addr))
              inRoom.current = true
            }
            for (const p of fresh) {
              dialed.current.add(p.nodeId)
              connect(p.addr)
            }
          }
        } catch {}
      }
      presence()
      timers.current.push(window.setInterval(presence, 20000))
    }).catch((e) => setStatus(`init failed: ${e}`))
    return () => timers.current.forEach(clearInterval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // local edits -> broadcast (~30/s, latest scene only)
  const onChange = (elements: readonly OrderedExcalidrawElement[]) => {
    if (remote.current || !me.current) return
    const now = Date.now()
    if (now - lastFlush.current < 33) return
    lastFlush.current = now
    sendMsg({ t: 'p', elements })
  }

  const onPointerUpdate = (payload: { pointer: { x: number; y: number } }) => {
    const now = Date.now()
    if (now - lastPtr.current < 80 || !me.current) return
    lastPtr.current = now
    sendMsg({ t: 'cursor', x: payload.pointer.x, y: payload.pointer.y })
  }

  const panel: React.CSSProperties = {
    position: 'absolute', top: 12, left: 12, zIndex: 999, maxWidth: 280,
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
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Excalidraw
        excalidrawAPI={(a) => { setApi(a); apiRef.current = a }}
        onChange={onChange}
        onPointerUpdate={onPointerUpdate}
        isCollaborating
      />
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
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 12 }}>{status}</div>
      </div>
    </div>
  )
}
