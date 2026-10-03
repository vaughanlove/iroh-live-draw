// Board: the scene store + camera that replaces Excalidraw's canvas.
//
// Everything above this layer (sync engine, CRDT, keeper, snapshots,
// tools UI) keeps talking to an Excalidraw-shaped API object; only the
// pixels changed owners. Scene state is a plain element array, the camera
// is explicit state, and updateScene fans out to the registered onChange
// exactly like Excalidraw did — including the remote-guard discipline
// (remote applies wrap in remote.current; see App).
//
// Not rendered in v1: images (files still sync, just invisible), text
// content (bounding outline only), selection UI, undo/redo.

export type El = any

export type CameraState = {
  scrollX: number
  scrollY: number
  zoom: number
  width: number
  height: number
}

export type ScenePatch = {
  elements?: El[]
  appState?: Partial<{ scrollX: number; scrollY: number; zoom: number | { value: number } }>
  collaborators?: unknown
}

export class Board {
  elements: El[] = []
  files = new Map<string, any>()
  /// EPHEMERAL peer presence (cursor dots). Render-only: never bumps rev,
  /// never fires onChange, never persists, never reaches the cell. Loss and
  /// staleness are fine — the next cursor message replaces them. This is the
  /// mesh path; the cell path owns everything durable.
  peers = new Map<string, { x: number; y: number; nick: string; at: number }>()
  /// Camera TARGET: where input wants to be (pan/zoom/pinch write here,
  /// clamp enforces here). The renderer draws this directly — no spring,
  /// no momentum: 1:1 tracking only.
  camera: CameraState = { scrollX: 0, scrollY: 0, zoom: 1, width: 1280, height: 800 }
  onChange: ((elements: readonly El[], appState: any, files: Record<string, any>) => void) | null = null
  /// Bumped on every scene replacement: render loops skip frames when
  /// neither rev nor camera moved (idle costs nothing).
  rev = 0

  // ---- Excalidraw-shaped surface (what App talks to) ----

  getSceneElements(): El[] {
    return this.elements
  }

  getSceneElementsIncludingDeleted(): El[] {
    return this.elements
  }

  getAppState(): any {
    const c = this.camera
    return {
      scrollX: c.scrollX,
      scrollY: c.scrollY,
      zoom: { value: c.zoom },
      width: c.width,
      height: c.height,
      selectedElementIds: {},
    }
  }

  getFiles(): Record<string, any> {
    return Object.fromEntries(this.files)
  }

  addFiles(files: any[]) {
    if (!Array.isArray(files)) return
    for (const f of files) if (f?.id) this.files.set(f.id, f)
  }

  updateScene(patch: ScenePatch) {
    let sceneChanged = false
    if (patch.appState) {
      const s = patch.appState
      if (typeof s.scrollX === 'number') this.camera.scrollX = s.scrollX
      if (typeof s.scrollY === 'number') this.camera.scrollY = s.scrollY
      if (typeof s.zoom === 'number') this.camera.zoom = s.zoom
      else if (s.zoom && typeof (s.zoom as any).value === 'number') {
        this.camera.zoom = (s.zoom as any).value
      }
    }
    if (Array.isArray(patch.elements)) {
      this.elements = patch.elements
      this.rev += 1
      sceneChanged = true
    }
    // collaborators intentionally ignored (roster lives in the tools panel)
    if (sceneChanged && this.onChange) {
      this.onChange(this.elements, this.getAppState(), this.getFiles())
    }
  }

  scrollToContent(els: El[]) {
    if (!Array.isArray(els) || !els.length) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const el of els) {
      const pts = Array.isArray(el?.points)
        ? el.points.map(([x, y]: [number, number]) => [x + (el.x ?? 0), y + (el.y ?? 0)])
        : [[el?.x ?? 0, el?.y ?? 0, (el?.x ?? 0) + (el?.width ?? 0), (el?.y ?? 0) + (el?.height ?? 0)]]
      const flat = pts.flat() as number[]
      for (let i = 0; i < flat.length; i += 2) {
        minX = Math.min(minX, flat[i]); minY = Math.min(minY, flat[i + 1])
        maxX = Math.max(maxX, flat[i]); maxY = Math.max(maxY, flat[i + 1])
      }
    }
    if (!isFinite(minX + minY + maxX + maxY)) return
    const c = this.camera
    this.camera.scrollX = (minX + maxX) / 2 - c.width / c.zoom / 2
    this.camera.scrollY = (minY + maxY) / 2 - c.height / c.zoom / 2
  }

  setViewportSize(w: number, h: number) {
    this.camera.width = w
    this.camera.height = h
  }

  /// Render-only peer update. Deliberately outside updateScene: no rev bump
  /// (that would force a full ink repaint per cursor move), no onChange
  /// (cursors must never enter sync, snapshots, or the cell).
  setPeers(peers: Record<string, { x: number; y: number; nick: string; at: number }>) {
    this.peers.clear()
    const now = Date.now()
    for (const [id, p] of Object.entries(peers)) {
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') continue
      if (now - (p.at ?? 0) > 3000) continue
      this.peers.set(id, p)
    }
  }
}
