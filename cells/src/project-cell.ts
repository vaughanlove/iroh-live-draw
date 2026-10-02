// One cell per project: the honest version of keeper/.
// State: envelopes + cleartext CRDT claims (id, v, ts, author) + tombstones.
// The cell merges opaquely like the keeper does today — it never sees the
// data key, never decrypts. Merge runs in the draw-crdt Rust wasm build
// (same source as native keeper/tests); the JS mirror below is fallback
// only, for a wasm that fails to instantiate.
import crdtModule from './crdt.wasm';

let crdt: {
  memory: WebAssembly.Memory;
  crdt_alloc: (len: number) => number;
  crdt_free: (ptr: number, len: number) => void;
  crdt_merge: (ptr: number, len: number) => bigint;
} | null = null;
try {
  const inst = new WebAssembly.Instance(crdtModule, {});
  crdt = inst.exports as any;
} catch (e) {
  console.warn('[cell] crdt wasm unavailable, JS fallback:', e);
}

const TE = new TextEncoder();
const TD = new TextDecoder();

const wasmMerge = (s: any, push: any): any | null => {
  if (!crdt) return null;
  try {
    const input = TE.encode(JSON.stringify({ state: toWasmState(s), push }));
    const inPtr = crdt.crdt_alloc(input.length);
    new Uint8Array(crdt.memory.buffer).set(input, inPtr);
    const packed = crdt.crdt_merge(inPtr, input.length);
    crdt.crdt_free(inPtr, input.length);
    // packed = out_ptr | (out_len << 32); BigInt when i64 is involved.
    const p = typeof packed === 'bigint' ? packed : BigInt(packed as any);
    const outPtr = Number(p & 0xffffffffn);
    const outLen = Number(p >> 32n);
    const out = TD.decode(new Uint8Array(crdt.memory.buffer).slice(outPtr, outPtr + outLen));
    crdt.crdt_free(outPtr, outLen);
    const snap = JSON.parse(out);
    if (snap?.error) throw new Error(snap.error);
    return fromWasmSnapshot(snap);
  } catch (e) {
    console.warn('[cell] wasm merge failed, JS fallback:', e);
    return null;
  }
};

// Rust PageState shape: meta/tombs as {id: {v, ts, author}},
// files as {id: value}. JS cell keeps meta as {id: [ts, author]} alongside.
const toWasmState = (s: any) => {
  const meta: Record<string, any> = {};
  for (const [id, m] of Object.entries(s.meta ?? {})) {
    const a = m as any;
    if (Array.isArray(a)) {
      // Stored JS claim is [ts, author]; version rides on the element.
      const v = (s.elements as any)?.[id]?.version ?? 0;
      meta[id] = { v, ts: a[0] ?? 0, author: a[1] ?? '' };
    } else meta[id] = a;
  }
  return { elements: s.elements ?? {}, meta, tombs: s.tombs ?? {}, files: s.files ?? {} };
};

const fromWasmSnapshot = (snap: any) => ({
  elements: Object.fromEntries((snap.elements ?? []).map((el: any) => [el?.id, el])),
  meta: Object.fromEntries(
    Object.entries(snap.meta ?? {}).map(([id, v]: any) => [id, Array.isArray(v) ? v : [v.ts ?? 0, v.author ?? '']]),
  ),
  tombs: Object.fromEntries((snap.tombs ?? []).map((t: any) => [t.id, { v: t.v ?? 0, ts: t.ts ?? 0, author: t.author ?? '' }])),
  files: Object.fromEntries((snap.files ?? []).map((f: any) => [f?.id ?? Math.random(), f])),
});
export class ProjectCell {
  state: any;
  constructor(state: any) {
    this.state = state;
  }

  // Claim compare: max(v, ts, author) wins.
  best(meta: any, tombs: any, id: string) {
    const m = meta[id];
    const t = tombs[id];
    if (m && t) {
      if (m.v !== t.v) return m.v > t.v ? [m, false] : [t, true];
      if (m.ts !== t.ts) return m.ts > t.ts ? [m, false] : [t, true];
      return m.author >= t.author ? [m, false] : [t, true];
    }
    if (m) return [m, false];
    if (t) return [t, true];
    return null;
  }

  async load(page: string) {
    const [els, meta, tombs, files, pages] = await Promise.all([
      this.state.storage.get(`els:${page}`) as any,
      this.state.storage.get(`meta:${page}`) as any,
      this.state.storage.get(`tombs:${page}`) as any,
      this.state.storage.get(`files:${page}`) as any,
      this.state.storage.get('pages') as any,
    ]);
    return {
      elements: els ?? {},
      meta: meta ?? {},
      tombs: tombs ?? {},
      files: files ?? {},
      pages: pages ?? {},
    };
  }

  async save(page: string, s: any) {
    await Promise.all([
      this.state.storage.put(`els:${page}`, s.elements),
      this.state.storage.put(`meta:${page}`, s.meta),
      this.state.storage.put(`tombs:${page}`, s.tombs),
      this.state.storage.put(`files:${page}`, s.files),
      this.state.storage.put('pages', s.pages),
    ]);
  }

  // Merge a push: envelopes in, merged snapshot out. Same rules as keeper
  // ingest_elements/ingest_tombs + evict: tomb-condemned elements stay dead.
  // Rust wasm first (single source of truth), JS mirror as fallback.
  // Page roster union lives here (path-independent): the wasm core only
  // judges element claims.
  merge(s: any, push: any) {
    const files = Array.isArray(push.files)
      ? Object.fromEntries(push.files.filter((f: any) => f?.id).map((f: any) => [f.id, f]))
      : (push.files ?? {});
    const norm = { ...push, files };
    const w = wasmMerge(s, norm);
    const merged = w
      // wasm returns map-shaped state; convert files back to cell shape.
      ? { elements: w.elements, meta: w.meta, tombs: w.tombs, files: w.files, pages: s.pages ?? {} }
      : this.mergeJs(s, norm);
    this.touchPages(merged, norm);
    return merged;
  }

  touchPages(s: any, push: any) {
    s.pages = s.pages ?? {};
    for (const p of push.pages ?? []) {
      if (!p?.id) continue;
      const prev = s.pages[p.id] ?? {};
      s.pages[p.id] = {
        id: p.id,
        name: typeof p.name === 'string' ? p.name : (prev.name ?? p.id),
        createdAt: p.createdAt ?? prev.createdAt ?? Date.now(),
        updatedAt: Math.max(p.updatedAt ?? 0, prev.updatedAt ?? 0, Date.now()),
      };
    }
    if (push.pageId) {
      const prev = s.pages[push.pageId] ?? {};
      s.pages[push.pageId] = {
        id: push.pageId,
        name: push.pageName ?? prev.name ?? push.pageId,
        createdAt: prev.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
    }
  }

  mergeJs(s: any, push: any) {
    for (const t of push.tombs ?? []) {
      if (!t?.id) continue;
      const cand = { v: t.v ?? 0, ts: t.ts ?? 0, author: t.author ?? '' };
      const cur = this.best(s.meta, s.tombs, t.id);
      if (!cur || this.cmp(cand, cur[0]) > 0) {
        s.tombs[t.id] = cand;
        delete s.meta[t.id];
      }
    }
    const m = push.meta ?? {};
    for (const el of push.elements ?? []) {
      if (!el?.id) continue;
      const a = m[el.id];
      const cand = { v: el.version ?? 0, ts: a?.[0] ?? 0, author: a?.[1] ?? '' };
      const cur = this.best(s.meta, s.tombs, el.id);
      if (!cur || this.cmp(cand, cur[0]) > 0) {
        s.meta[el.id] = cand;
        delete s.tombs[el.id];
        s.elements[el.id] = el;
      }
    }
    for (const id of Object.keys(s.elements)) {
      const cur = this.best(s.meta, s.tombs, id);
      if (cur?.[1]) delete s.elements[id];
    }
    for (const [id, f] of Object.entries(push.files ?? {})) s.files[id as string] = f;
    return s;
  }

  cmp(a: any, b: any) {
    return a.v !== b.v
      ? a.v - b.v
      : a.ts !== b.ts
        ? a.ts - b.ts
        : a.author < b.author
          ? -1
          : a.author > b.author
            ? 1
            : 0;
  }

  snapshot(s: any) {
    return {
      elements: Object.values(s.elements),
      meta: s.meta,
      tombs: Object.entries(s.tombs).map(([id, c]: any) => ({ id, ...c })),
      files: Object.values(s.files),
      // Project page roster: lets late joiners discover boards without
      // gossip history (the 'pages' broadcast has no replay).
      pages: Object.values(s.pages ?? {}),
    };
  }

  broadcast(msg: any) {
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {}
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] } as any);
    }
    const page = url.searchParams.get('page') ?? 'main';
    if (url.pathname === '/snapshot' && req.method === 'GET') {
      return Response.json(this.snapshot(await this.load(page)));
    }
    if (url.pathname === '/push' && req.method === 'POST') {
      const push = await req.json();
      push.pageId = page;
      const s = this.merge(await this.load(page), push);
      await this.save(page, s);
      const snap = this.snapshot(s);
      this.broadcast({ type: 'merge', page, ...snap });
      return Response.json(snap);
    }
    return new Response('snapshot|push|ws', { status: 404 });
  }

  async webSocketMessage(ws: any, msg: any) {
    // Live stroke relay: client pushes envelope batch, cell merges +
    // fans out. Keeps today's fire-and-forget broadcast semantics.
    try {
      const m = JSON.parse(typeof msg === 'string' ? msg : '{}');
      if (m.type === 'push' && m.page) {
        const s = this.merge(await this.load(m.page), m);
        await this.save(m.page, s);
        this.broadcast({ type: 'merge', page: m.page, ...this.snapshot(s) });
      }
    } catch {}
  }
}
