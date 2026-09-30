// Pen capture overlay: the pencil, owned by the pen crate.
//
// A transparent canvas sits above the board and swallows pointer input
// ONLY while the pen tool is armed. Samples stream into Rust PenStroke
// (pressure + smoothing + taper); the live preview paints the centerline;
// on lift the smoothed stroke commits as an ordinary freedraw element,
// which flows through onChange → gossip → keeper untouched. Wheel events
// forward to the board canvas so zoom keeps working underneath; holding
// Space (or a second finger) drops pencil input for navigation.
import { useEffect, useRef, useState } from 'react'
import { PenStroke } from './pkg-pen/pen.js'

// Pen defaults: sharpie, technical-pen weight, app ink.
// PEN_WIDTH is calibrated: Excalidraw renders roughness-0 freedraw at
// ~6.1 scene units per strokeWidth unit at uniform 0.5 pressure (measured
// headless, linear 1..6), so the commit matches the live preview.
export const PEN_SIZE = 1
export const PEN_WIDTH = 0.66
export const PEN_INK = '#1e1e1e'

type LiveStroke = {
  push(x: number, y: number, p: number, t: number): void
  centerline(): number[]
  to_json(): string
  free(): void
}

const newStrokeId = () => 'pen' + Math.random().toString(36).slice(2, 10)
const newIndex = () =>
  'a' + Date.now().toString(36).slice(-4) + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')

export default function PenOverlay({
  apiRef,
  armed,
  onStroke,
  onError,
}: {
  apiRef: React.RefObject<{ getAppState(): any } | null>
  armed: boolean
  onStroke: (el: unknown) => void
  onError: (msg: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const liveRef = useRef<LiveStroke | null>(null)
  // Touch routing: every pointer on the overlay is tracked. One pointer =
  // a stroke; two = a pinch, and the pinch wins — the partial stroke is
  // dropped (never committed) and all pointers route to the board canvas
  // until fingers lift. Non-primary mouse buttons route straight through.
  const touchesRef = useRef(new Map<number, { x: number; y: number }>())
  const strokePointerRef = useRef<number | null>(null)

  const boardCanvas = () => document.getElementById('board')

  const forwardToBoard = (
    type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
    e: { pointerId: number; pointerType: string; isPrimary: boolean; clientX: number; clientY: number; buttons: number; button: number; pressure: number },
  ) => {
    const target = boardCanvas()
    if (!target) return
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        isPrimary: e.isPrimary,
        clientX: e.clientX,
        clientY: e.clientY,
        buttons: e.buttons,
        button: e.button,
        pressure: e.pressure,
      }),
    )
  }

  const dropStroke = () => {
    if (strokePointerRef.current === null) return
    strokePointerRef.current = null
    try { liveRef.current?.free() } catch {}
    liveRef.current = null
    clearPreview()
  }

  // Arm/disarm: the parent owns the tool; Space drops the overlay
  // momentarily so it never eats a pan.
  const [space, setSpace] = useState(false)
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space') setSpace(true) }
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpace(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // Size the canvas (fullscreen overlay; CSS px == scene transform base).
  // Re-sized on every window resize: a stale backing store stretches the
  // preview (renders smaller + offset) while commits stay correct — the
  // classic "disconnect between pen and render" on rotate/resize/URL-bar.
  useEffect(() => {
    const fit = () => {
      const c = canvasRef.current
      if (!c) return
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      c.width = Math.floor(innerWidth * dpr)
      c.height = Math.floor(innerHeight * dpr)
      c.style.width = innerWidth + 'px'
      c.style.height = innerHeight + 'px'
      clearPreview()
    }
    fit()
    window.addEventListener('resize', fit)
    window.addEventListener('orientationchange', fit)
    return () => {
      window.removeEventListener('resize', fit)
      window.removeEventListener('orientationchange', fit)
    }
  }, [])

  const sceneOf = (clientX: number, clientY: number) => {
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    const st = apiRef.current?.getAppState() as any
    const zoom = st?.zoom?.value ?? 1
    return {
      x: (clientX - r.left) / zoom - (st?.scrollX ?? 0),
      y: (clientY - r.top) / zoom - (st?.scrollY ?? 0),
    }
  }

  const preview = () => {
    const c = canvasRef.current
    const live = liveRef.current
    if (!c || !live) return
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const g = c.getContext('2d')!
    const st = apiRef.current?.getAppState() as any
    const zoom = st?.zoom?.value ?? 1
    const sx = st?.scrollX ?? 0
    const sy = st?.scrollY ?? 0
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, c.width, c.height)
    const line: number[] = live.centerline()
    if (line.length < 4) return
    g.strokeStyle = PEN_INK
    g.lineWidth = PEN_SIZE * zoom * dpr
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.beginPath()
    g.moveTo((line[0] + sx) * zoom * dpr, (line[1] + sy) * zoom * dpr)
    for (let i = 2; i < line.length; i += 2) {
      g.lineTo((line[i] + sx) * zoom * dpr, (line[i + 1] + sy) * zoom * dpr)
    }
    g.stroke()
  }

  const clearPreview = () => {
    const c = canvasRef.current
    if (!c) return
    const g = c.getContext('2d')!
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, c.width, c.height)
  }

  const pressureOf = (e: React.PointerEvent) =>
    e.pointerType === 'mouse' ? -1 : e.pressure > 0 ? e.pressure : -1

  const onPointerDown = (e: React.PointerEvent) => {
    touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (touchesRef.current.size >= 2) {
      // Pinch takes over: drop any partial stroke, route everything down.
      dropStroke()
      for (const [id, pt] of touchesRef.current) {
        forwardToBoard('pointerdown', {
          pointerId: id, pointerType: e.pointerType, isPrimary: id === e.pointerId,
          clientX: id === e.pointerId ? e.clientX : pt.x,
          clientY: id === e.pointerId ? e.clientY : pt.y,
          buttons: 1, button: 0, pressure: 0,
        })
      }
      return
    }
    if (e.pointerType === 'mouse' && e.button !== 0) {
      // Middle/right: pan gestures belong to the board, not the pencil.
      touchesRef.current.delete(e.pointerId)
      forwardToBoard('pointerdown', e)
      return
    }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    const s = sceneOf(e.clientX, e.clientY)
    const live: LiveStroke = new PenStroke(PEN_SIZE, 0.12, 0.12, 0.12, 1, true)
    live.push(s.x, s.y, pressureOf(e), e.timeStamp)
    liveRef.current = live
    strokePointerRef.current = e.pointerId
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (touchesRef.current.has(e.pointerId)) {
      touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }
    if (e.pointerId !== strokePointerRef.current) {
      // Pinch/forwarded pointer: mirror it down for gesture continuity.
      if (touchesRef.current.size >= 2) forwardToBoard('pointermove', e)
      return
    }
    const live = liveRef.current
    if (!live || !e.buttons) return
    const evts = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [e.nativeEvent]
    for (const c of evts as PointerEvent[]) {
      const s = sceneOf(c.clientX, c.clientY)
      const p = c.pointerType === 'mouse' ? -1 : c.pressure > 0 ? c.pressure : -1
      live.push(s.x, s.y, p, c.timeStamp)
    }
    preview()
  }

  const commit = (e: React.PointerEvent) => {
    touchesRef.current.delete(e.pointerId)
    if (touchesRef.current.size > 0) {
      // Still pinching: route the lift down, never commit partial ink.
      forwardToBoard('pointerup', e)
      return
    }
    if (e.pointerId !== strokePointerRef.current) {
      // A forwarded pointer's lift (e.g. middle-button pan): not ours.
      forwardToBoard('pointerup', e)
      return
    }
    strokePointerRef.current = null
    const live = liveRef.current
    liveRef.current = null
    clearPreview()
    if (!live) return
    try {
      const body = JSON.parse(live.to_json()) as { points: [number, number][]; pressures: number[] }
      live.free()
      if (body.points.length < 2) return // taps: no single-point freedraw
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const [x, y] of body.points) {
        minX = Math.min(minX, x); minY = Math.min(minY, y)
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      }
      // Sharpie: uniform pressure along the whole stroke. The renderer
      // modulates width by pressure, so varying pressures would
      // reintroduce the unpredictability sharpie mode exists to kill.
      const el = {
        id: newStrokeId(),
        type: 'freedraw',
        x: minX, y: minY,
        width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY),
        angle: 0,
        strokeColor: PEN_INK,
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: PEN_WIDTH,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: 100,
        roundness: null,
        boundElements: [],
        link: null,
        locked: false,
        seed: Math.floor(Math.random() * 2 ** 31),
        version: 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        isDeleted: false,
        groupIds: [],
        frameId: null,
        index: newIndex(),
        points: body.points.map(([x, y]) => [x - minX, y - minY]),
        pressures: body.points.map(() => 0.5),
        simulatePressure: false,
      }
      onStroke(el)
      // Landing check: the store takes synchronously. If it didn't, say so
      // loudly — a silent drop looks exactly like "ink vanishes on lift".
      try {
        const scene = (apiRef.current as any)?.getSceneElements?.() as any[] | undefined
        if (Array.isArray(scene) && !scene.some((s) => s?.id === (el as any).id)) {
          onError(`stroke ${(el as any).id} committed but not in scene`)
        }
      } catch (err) {
        onError(`landing check failed: ${String(err).slice(0, 80)}`)
      }
    } catch (err) {
      try { live.free() } catch {}
      onError(`stroke commit failed: ${String(err).slice(0, 120)}`)
    }
  }

  // Forward wheel so zoom keeps working under the overlay.
  const onWheel = (e: React.WheelEvent) => {
    const target = document.getElementById('board')
    if (!target) return
    target.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaZ: e.deltaZ,
        deltaMode: e.deltaMode,
        clientX: e.clientX,
        clientY: e.clientY,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
      }),
    )
  }

  const live = armed && !space
  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute', inset: 0, zIndex: 3,
        pointerEvents: live ? 'auto' : 'none',
        cursor: live ? 'crosshair' : 'default',
        touchAction: 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={commit}
      onPointerCancel={(e) => {
        touchesRef.current.delete(e.pointerId)
        if (touchesRef.current.size > 0) {
          forwardToBoard('pointercancel', e)
          return
        }
        if (e.pointerId !== strokePointerRef.current) return
        strokePointerRef.current = null
        try { liveRef.current?.free() } catch {}
        liveRef.current = null
        clearPreview()
      }}
      onWheel={onWheel}
    />
  )
}
