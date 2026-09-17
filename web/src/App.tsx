import { useEffect, useRef, useState } from 'react'
import { Excalidraw, reconcileElements, exportToSvg } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI, OrderedExcalidrawElement } from '@excalidraw/excalidraw/types'
import { ChatNode } from './pkg/draw_browser_wasm.js'
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

type PeerCursor = { x: number; y: number; at: number }

export default function App() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [id, setId] = useState('')
  const [peer, setPeer] = useState('')
  const [status, setStatus] = useState('starting…')
  const [showAdd, setShowAdd] = useState(false)
  const [showDbg, setShowDbg] = useState(false)
  const [dbg, setDbg] = useState('')
  const [online, setOnline] = useState<Record<string, string>>({})
  // event stats: per-type counters + rolling throughput
  const stats = useRef({ sent: {} as Record<string, number>, recv: {} as Record<string, number>, stale: 0 })
  const times = useRef<number[]>([])
  const bump = (dir: 'sent' | 'recv', t: string) => {
    const s = stats.current
    s[dir][t] = (s[dir][t] ?? 0) + 1
    times.current.push(Date.now())
  }
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const remote = useRef(false)
  const nodeRef = useRef<any>(null)
  const chanRef = useRef<any>(null)
  const roomGen = useRef(0)
  const me = useRef('')
  const nick = useRef('')
  const seq = useRef(0)
  const lastSeq = useRef<Record<string, number>>({})
  const cursors = useRef<Record<string, PeerCursor>>({})
  const lastPtr = useRef(0)
  const onlineRef = useRef<Record<string, string>>({})

  const sendMsg = (obj: any) => {
    const ch = chanRef.current
    if (!ch) return
    bump('sent', obj?.t ?? '?')
    const s = JSON.stringify({ from: me.current, seq: seq.current++, ...obj })
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

  const setPresence = (from: string, nickname: string) => {
    if (from === me.current) return
    onlineRef.current = { ...onlineRef.current, [from]: nickname || from.slice(0, 6) }
    setOnline(onlineRef.current)
  }

  // inbound gossip event from the room channel
  const onRoomEvent = (ev: any) => {
    if (!ev || typeof ev.type !== 'string') return
    if (ev.type === 'presence') {
      setPresence(String(ev.from), ev.nickname)
      return
    }
    if (ev.type === 'neighborUp') {
      setPresence(String(ev.endpoint_id ?? ev.endpointId ?? ''), '')
      return
    }
    if (ev.type === 'messageReceived') {
      let m: any
      try {
        m = JSON.parse(ev.text)
      } catch {
        return
      }
      bump('recv', m?.t ?? '?')
      const from = String(ev.from ?? m.from ?? '')
      if (from === me.current) return
      if (m?.t === 'cursor') {
        cursors.current[from] = { x: m.x, y: m.y, at: Date.now() }
        pushCollaborators()
        return
      }
      if (m?.t === 'p') {
        if (typeof m.seq === 'number') {
          if (m.seq <= (lastSeq.current[from] ?? -1)) { stats.current.stale++; return }
          lastSeq.current[from] = m.seq
        }
        if (Array.isArray(m.elements)) applyRemote(m.elements, false)
      } else if (m?.t === 'snap-req') {
        sendMsg({ t: 'snap', elements: apiRef.current?.getSceneElements() ?? [] })
      } else if (m?.t === 'snap') {
        if (Array.isArray(m.elements)) applyRemote(m.elements, true)
      }
    }
  }

  // join (or create) a room channel and pump its receiver stream.
  // Re-joining the same channel object is a no-op (its stream stays locked
  // to the original reader); a new channel abandons the old pump via gen.
  const pumpingFor = useRef<any>(null)
  const joinChannel = async (ch: any) => {
    const gen = ++roomGen.current
    chanRef.current = ch
    if (pumpingFor.current === ch) return
    pumpingFor.current = ch
    const reader = (ch.receiver as ReadableStream).getReader()
    setStatus('connected — draw!')
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || gen !== roomGen.current) break
        onRoomEvent(value)
      }
    } catch {
      /* stream closed */
    } finally {
      if (pumpingFor.current === ch) pumpingFor.current = null
      try { reader.releaseLock() } catch {}
    }
  }

  const pushCollaborators = () => {
    const a = apiRef.current
    if (!a) return
    const map = new Map()
    for (const [from, c] of Object.entries(cursors.current)) {
      map.set(from, {
        pointer: { x: c.x, y: c.y, tool: 'pointer' },
        button: 'up',
        username: (onlineRef.current[from] ?? from.slice(0, 6)),
      })
    }
    a.updateScene({ collaborators: map as any })
  }

  // boot: node identity (ephemeral), then room from share link if present
  useEffect(() => {
    let dead = false
    ;(async () => {
      try {
        const node = await ChatNode.spawn()
        if (dead) return
        nodeRef.current = node
        const myId = node.endpoint_id() as string
        me.current = myId
        nick.current = 'peer-' + myId.slice(0, 6)
        setId(myId)
        setStatus('ready')
        const ticket = new URLSearchParams(location.hash.slice(1)).get('t')
        if (ticket) {
          setStatus('joining…')
          const ch = await node.join(ticket, nick.current)
          if (dead) return
          await joinChannel(ch)
          sendMsg({ t: 'snap-req' })
        }
      } catch (e) {
        if (!dead) setStatus(`init failed: ${e}`)
      }
    })()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // debug drawer data (rendered only when open)
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now()
      times.current = times.current.filter((ts) => now - ts < 2000)
      const s = stats.current
      const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ') || '—'
      setDbg(
        `eps=${(times.current.length / 2).toFixed(1)} (2s window)\nsent: ${fmt(s.sent)}\nrecv: ${fmt(s.recv)}\nstale dropped: ${s.stale}\nonline: ${Object.keys(onlineRef.current).length} me: ${me.current.slice(0, 8)}`,
      )
    }, 500)
    return () => clearInterval(t)
  }, [])

  // local edits -> broadcast only version-bumped elements (~60/s)
  const sentVersions = useRef<Record<string, number>>({})
  const onChange = (elements: readonly OrderedExcalidrawElement[]) => {
    if (remote.current || !me.current || !chanRef.current) return
    const changed = elements.filter((el: any) => sentVersions.current[el.id] !== el.version)
    if (!changed.length) return
    for (const el of changed as any[]) sentVersions.current[el.id] = el.version
    sendMsg({ t: 'p', elements: changed })
  }

  const onPointerUpdate = (payload: { pointer: { x: number; y: number } }) => {
    const now = Date.now()
    if (now - lastPtr.current < 80 || !me.current || !chanRef.current) return
    lastPtr.current = now
    sendMsg({ t: 'cursor', x: payload.pointer.x, y: payload.pointer.y })
  }

  const share = async () => {
    const node = nodeRef.current
    if (!node) return
    try {
      const ch = chanRef.current ?? (await node.create(nick.current))
      await joinChannel(ch)
      const ticket = ch.ticket({ includeMyself: true, includeBootstrap: true, includeNeighbors: true })
      await copyText(`${location.origin}${location.pathname}#t=${encodeURIComponent(ticket)}`)
      setStatus('share link copied — send it')
    } catch (e) {
      setStatus(`share failed: ${e}`)
    }
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
  const names = Object.values(online)
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
        {names.length > 0 && (
          <div style={{ opacity: 0.75, marginBottom: 4 }}>online: {names.join(', ')}</div>
        )}
        <button style={btn} onClick={() => setShowAdd((s) => !s)}>+</button>
        {showAdd && (
          <div>
            <input placeholder="paste ticket…" value={peer} onChange={(e) => setPeer(e.target.value)} style={input} />
            <button style={btn} onClick={async () => {
              setShowAdd(false)
              setStatus('joining…')
              try {
                const ch = await nodeRef.current.join(peer.trim(), nick.current)
                await joinChannel(ch)
                sendMsg({ t: 'snap-req' })
              } catch (e) { setStatus(`join failed: ${e}`) }
            }}>join</button>
          </div>
        )}
        <div style={{ marginTop: 6 }}>
          <button disabled={!id} style={btn} onClick={share}>⧉ share</button>
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
        <button style={btn} onClick={() => setShowDbg((s) => !s)}>debug</button>
        {showDbg && (
          <pre style={{ fontSize: 10, fontFamily: 'monospace', background: '#0d0f16', color: '#9fe', borderRadius: 8, padding: 8, marginTop: 4, whiteSpace: 'pre-wrap' }}>{dbg}</pre>
        )}
      </div>
    </div>
  )
}
