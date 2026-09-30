// BoardView: rAF renderer — board store to pixels.
//
// Renderer ladder, best first: hardware wgpu → software wgpu (SwiftShader:
// identical pixels, slower) → Canvas2D (no GPU at all: blocklisted
// drivers, headless, Safari). Each step logs loudly; a silent fallback
// would look exactly like "ink disappears".
//
// Per frame: begin_frame(camera) → freedraw strokes as pen meshes (cached
// by id:version, rebuilt only on change) → legacy shapes as bbox outlines
// → end_frame. Transparent clear: the CSS engineering grid underneath is
// the paper. Nothing here touches sync; it only reads the store.
import { PenCanvas, PenStroke } from './pkg-pen/pen.js'
import { PEN_SIZE } from './PenOverlay.js'
import type { Board } from './board.js'

type Cached = { v: number; verts: Float32Array; idx: Uint32Array; line: number[] | null; size: number; bounds: [number, number, number, number] }

const INK: [number, number, number, number] = [30 / 255, 70 / 255, 32 / 255, 1]

function hexToRgb(hex: string): [number, number, number, number] {  const h = (hex ?? '').trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(h)) {
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255,
      1,
    ]
  }
  return INK
}

function css(el: any): string {
  const [r, g, b] = hexToRgb(el?.strokeColor)
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},1)`
}

export type BoardView = {
  destroy(): void
  frame(): void
  stats(): string
  renderer: string
}

export type MeshFor = (el: any) => {
  verts: Float32Array
  idx: Uint32Array
  line: number[] | null
  size: number
  bounds: [number, number, number, number]
} | null

// Frustum cull: skip meshes fully outside the viewport (+margin for width).
const CULL_MARGIN = 60
function visible(
  bounds: [number, number, number, number],
  c: { scrollX: number; scrollY: number; zoom: number; width: number; height: number },
): boolean {
  const x0 = -c.scrollX - CULL_MARGIN
  const y0 = -c.scrollY - CULL_MARGIN
  const x1 = -c.scrollX + c.width / c.zoom + CULL_MARGIN
  const y1 = -c.scrollY + c.height / c.zoom + CULL_MARGIN
  return bounds[0] <= x1 && bounds[2] >= x0 && bounds[1] <= y1 && bounds[3] >= y0
}

export async function createBoardView(
  canvas: HTMLCanvasElement,
  board: Board,
  meshFor: MeshFor,
): Promise<BoardView> {
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2)
  const size = () => {
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr()))
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr()))
  }
  size()
  board.setViewportSize(canvas.clientWidth, canvas.clientHeight)
  const timed = <T>(label: string, p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_, reject) =>
        window.setTimeout(() => reject(new Error(`${label} timed out after 10s`)), 10000),
      ),
    ])
  // Probe BEFORE touching the canvas: the first getContext (webgpu vs 2d)
  // wins permanently, and a failed GPU attempt poisons the canvas for the
  // 2D fallback (getContext('2d') returns null → a silent, inkless loop).
  const probeGpu = async (fallback: boolean): Promise<boolean> => {
    try {
      const gpu = (globalThis as any).navigator?.gpu
      if (!gpu) return false
      const ad = await gpu.requestAdapter(fallback ? { forceFallbackAdapter: true } : undefined)
      return !!ad
    } catch {
      return false
    }
  }
  if (await probeGpu(false)) {
  try {
    const gpu = await timed('hardware wgpu', PenCanvas.new(canvas))
    console.info('[board] renderer: hardware wgpu')
    return { ...startGpuLoop(canvas, board, meshFor, gpu), renderer: 'hardware wgpu' }
    } catch (err) {
      console.warn('[board] hardware wgpu failed after probe:', err)
    }
  } else {
    console.warn('[board] no hardware WebGPU adapter')
  }
  if (await probeGpu(true)) {
  try {
    const gpu = await timed('software wgpu', PenCanvas.new_with_fallback(canvas, true))
    console.info('[board] renderer: software wgpu')
    return { ...startGpuLoop(canvas, board, meshFor, gpu), renderer: 'software wgpu' }
    } catch (err) {
      console.warn('[board] software wgpu failed after probe:', err)
    }
  } else {
    console.warn('[board] no software WebGPU adapter')
  }
  console.info('[board] renderer: CPU 2D fallback')
  return { ...startCpuLoop(canvas, board, meshFor), renderer: 'CPU 2D' }
}

function trackLoop(
  onResize: () => void,
  frame: () => void,
): { destroy(): void; frame(): void } {
  let dead = false
  const wrapped = () => {
    if (dead) return
    frame()
  }
  const loop = () => {
    if (dead) return
    wrapped()
    requestAnimationFrame(loop)
  }
  window.addEventListener('resize', onResize)
  requestAnimationFrame(loop)
  return {
    destroy() {
      dead = true
      window.removeEventListener('resize', onResize)
    },
    frame: wrapped,
  }
}

function startGpuLoop(
  canvas: HTMLCanvasElement,
  board: Board,
  meshFor: MeshFor,
  gpu: PenCanvas,
): BoardView {
  gpu.resize(canvas.width, canvas.height)
  let frameErrors = 0
  let lastFrameError = ''
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2)
  // GPU-side upload ledger: keys this loop has retained.
  const uploaded = new Set<string>()
  const uploadedById = new Map<string, string>()
  const retain = (key: string, id: string, m: { verts: Float32Array; idx: Uint32Array }) => {
    const prev = uploadedById.get(id)
    if (prev && prev !== key) {
      try { gpu.evict(prev) } catch {}
      uploaded.delete(prev)
    }
    if (!uploaded.has(key)) {
      try { gpu.retain_mesh(key, m.verts as any, m.idx as any) } catch (e) {
        frameErrors += 1
        lastFrameError = `retain:${id}:${String(e).slice(0, 80)}`
        return false
      }
      uploaded.add(key)
      uploadedById.set(id, key)
      if (uploaded.size > 400) {
        const first = uploaded.values().next().value as string | undefined
        if (first) {
          try { gpu.evict(first) } catch {}
          uploaded.delete(first)
        }
      }
    }
    return true
  }
  // Idle skip: camera + rev unchanged → presenting again is pure cost.
  let lastFrameKey = ''
  // Device-zoom handshake: the shader's view dims are device px (backing
  // store), so zoom must arrive in device px too. Passing CSS zoom with
  // device dims halves all rendering whenever dpr != 1 (smaller + offset
  // ink on hidpi) — the CPU path never had this bug because setTransform
  // takes dpr explicitly.
  const view = trackLoop(
    () => {
      board.setViewportSize(canvas.clientWidth, canvas.clientHeight)
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr()))
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr()))
      try {
        gpu.resize(canvas.width, canvas.height)
      } catch (e) {
        frameErrors += 1
        lastFrameError = `resize:${String(e).slice(0, 80)}`
      }
      lastFrameKey = '' // resize dirties everything
    },
    () => {
      // A throw here must never kill the rAF loop: a dead loop looks exactly
      // like "commits vanish, grid stays" (the preview is a separate canvas).
      try {
        const c = board.camera
        const key = `${c.scrollX}|${c.scrollY}|${c.zoom}|${board.rev}`
        if (key === lastFrameKey) return
        lastFrameKey = key
        gpu.begin_frame(c.scrollX, c.scrollY, c.zoom * dpr())
        const seen = new Set<string>()
        for (const el of board.elements) {
          if (!el || el.isDeleted) continue
          seen.add(el.id)
          try {
            const m = meshFor(el)
            if (!m || !visible(m.bounds, c)) continue
            const mkey = `${el.id}:${el.version}`
            if (retain(mkey, el.id, m)) gpu.draw_keyed(mkey)
          } catch (e) {
            frameErrors += 1
            lastFrameError = `mesh:${el?.id}:${String(e).slice(0, 100)}`
          }
        }
        // Deleted elements leave no tombstone in the GPU cache: sweep ids
        // that vanished from the store.
        for (const [id, key] of uploadedById) {
          if (!seen.has(id)) {
            try { gpu.evict(key) } catch {}
            uploaded.delete(key)
            uploadedById.delete(id)
          }
        }
        gpu.end_frame()
      } catch (e) {
        frameErrors += 1
        lastFrameError = `frame:${String(e).slice(0, 100)}`
      }
    },
  )
  return {
    ...view,
    stats() {
      let g = '? ? ? n/a'
      try {
        g = gpu.stats()
      } catch {
        /* ignore */
      }
      return `${g} | ferr=${frameErrors} ${lastFrameError}`.trim()
    },
  }
}

// CPU 2D fallback: same meshes, Canvas2D fills. Serves when no WebGPU
// adapter exists at all; doubles as the headless-verifiable path.
function startCpuLoop(
  canvas: HTMLCanvasElement,
  board: Board,
  meshFor: MeshFor,
): BoardView {
  const g = canvas.getContext('2d')
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2)
  let frames = 0
  let draws = 0
  let lastKey = ''

  const paintAll = (c: { scrollX: number; scrollY: number; zoom: number }) => {
    if (!g) return
    // Scene → device px through the sheet transform.
    g.setTransform(
      dpr() * c.zoom, 0, 0, dpr() * c.zoom,
      dpr() * c.scrollX * c.zoom, dpr() * c.scrollY * c.zoom,
    )
    g.clearRect(-c.scrollX, -c.scrollY, canvas.width / dpr() / c.zoom, canvas.height / dpr() / c.zoom)
    for (const el of board.elements) {
      if (!el || el.isDeleted) continue
      let m: { verts: Float32Array; idx: Uint32Array; line: number[] | null; size: number; bounds: [number, number, number, number] } | null = null
      try {
        m = meshFor(el)
      } catch {
        continue
      }
      if (!m || !visible(m.bounds, c)) continue
      // Prefer the centerline: one stroked path, zero triangle seams.
      if (m.line && m.line.length >= 4) {
        draws += 1
        g.strokeStyle = css(el)
        g.lineWidth = m.size
        g.lineCap = 'round'
        g.lineJoin = 'round'
        g.beginPath()
        g.moveTo(m.line[0], m.line[1])
        for (let i = 2; i < m.line.length; i += 2) g.lineTo(m.line[i], m.line[i + 1])
        g.stroke()
        continue
      }
      if (m.line && m.line.length === 2) {
        draws += 1
        g.fillStyle = css(el)
        g.beginPath()
        g.arc(m.line[0], m.line[1], m.size / 2, 0, Math.PI * 2)
        g.fill()
        continue
      }
      if (m.idx.length < 3) continue
      draws += 1
      g.beginPath()
      const v = m.verts,
        ix = m.idx
      for (let i = 0; i < ix.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const o = ix[i + k] * 6
          if (k === 0) g.moveTo(v[o], v[o + 1])
          else g.lineTo(v[o], v[o + 1])
        }
        g.closePath()
      }
      const r = Math.round(v[2] * 255),
        gg = Math.round(v[3] * 255),
        b = Math.round(v[4] * 255)
      g.fillStyle = `rgba(${r},${gg},${b},1)`
      g.fill()
    }
  }

  const view = trackLoop(
    () => {
      board.setViewportSize(canvas.clientWidth, canvas.clientHeight)
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr()))
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr()))
      lastKey = ''
    },
    () => {
      if (!g) return
      const c = board.camera
      const key = `${c.scrollX}|${c.scrollY}|${c.zoom}|${board.rev}|${canvas.width}x${canvas.height}`
      if (key === lastKey) return
      lastKey = key
      frames += 1
      paintAll(c)
    },
  )
  return {
    ...view,
    stats() {
      return `cpu frames=${frames} drawn=${draws} | ferr=0`
    },
  }
}

// Mesh provider: freedraw only, sharpie everywhere. Non-freedraw legacy
// elements don't render (rapid iteration: no legacy support).
// Every stroke draws as one uniform centerline (monoline PEN_SIZE) in the
// element's own color — GPU and CPU paths agree exactly, and triangle
// seams can never appear at overlaps.
export function makeMeshProvider() {
  const cache = new Map<string, Cached>()
  const meshFor: MeshFor = (el: any) => {
    if (!el || el.isDeleted || el.type !== 'freedraw' || !Array.isArray(el.points)) return null
    const key = `${el.id}:${el.version}`
    const hit = cache.get(key)
    if (hit) return hit
    // Evict stale versions of the same element (bounded: latest only).
    for (const k of cache.keys()) {
      if (k.startsWith(el.id + ':') && k !== key) cache.delete(k)
    }
    try {
      const [r, g, b, a] = hexToRgb(el?.strokeColor)
      const s = new PenStroke(PEN_SIZE, r, g, b, a, true)
      const pts = el.points as [number, number][]
      const prs = Array.isArray(el.pressures) ? el.pressures : []
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (let i = 0; i < pts.length; i++) {
        const x = pts[i][0] + (el.x ?? 0), y = pts[i][1] + (el.y ?? 0)
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
        s.push(x, y, prs[i] ?? -1, i * 8)
      }
      const pad = PEN_SIZE
      const out: Cached = {
        v: el.version,
        verts: new Float32Array(s.vertices()),
        idx: new Uint32Array(s.indices()),
        line: s.centerline(),
        size: PEN_SIZE,
        bounds: [minX - pad, minY - pad, maxX + pad, maxY + pad],
      }
      s.free()
      cache.set(key, out)
      if (cache.size > 400) {
        const first = cache.keys().next().value
        if (first) cache.delete(first)
      }
      return out
    } catch {
      return null
    }
  }
  return meshFor
}
