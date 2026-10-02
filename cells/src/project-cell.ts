// One cell per project: the honest version of keeper/.
// State: envelopes + cleartext CRDT claims (id, v, ts, author) + tombstones.
// The cell merges opaquely like the keeper does today — it never sees the
// data key, never decrypts. LWW compare is (v, ts, author), tombstone wins
// ties exactly as keeper PageState + App.tsx do.
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
    const [els, meta, tombs, files] = await Promise.all([
      this.state.storage.get(`els:${page}`) as any,
      this.state.storage.get(`meta:${page}`) as any,
      this.state.storage.get(`tombs:${page}`) as any,
      this.state.storage.get(`files:${page}`) as any,
    ]);
    return {
      elements: els ?? {},
      meta: meta ?? {},
      tombs: tombs ?? {},
      files: files ?? {},
    };
  }

  async save(page: string, s: any) {
    await Promise.all([
      this.state.storage.put(`els:${page}`, s.elements),
      this.state.storage.put(`meta:${page}`, s.meta),
      this.state.storage.put(`tombs:${page}`, s.tombs),
      this.state.storage.put(`files:${page}`, s.files),
    ]);
  }

  // Merge a push: envelopes in, merged snapshot out. Same rules as keeper
  // ingest_elements/ingest_tombs + evict: tomb-condemned elements stay dead.
  merge(s: any, push: any) {
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
