// Cell sync client: plain fetch + WebSocket against the celld fleet.
// No iroh, no tickets-as-network — docId + page address the cell, and the
// envelope/meta/tombs wire format is identical to the gossip path so the
// CRDT merge (JS today, draw-crdt wasm next) behaves the same.
//
// KEEPER_URL env now points at the cell fleet (e.g. https://cell-a.exe.xyz,
// ?keeper= override still works). Paths: GET /p/:doc/snapshot?page=,
// POST /p/:doc/push?page=, WS /p/:doc/ws
const base = (): string | undefined => {
  try {
    const qs = new URLSearchParams(location.search);
    const q = (qs.get('keeper') ?? '').trim().replace(/\/$/, '');
    if (q) return q;
    const env = (import.meta as any).env?.VITE_KEEPER_URL ?? '';
    const e = String(env).trim().replace(/\/$/, '');
    return e || undefined;
  } catch {
    return undefined;
  }
};

export const cellBase = base;

export type CellPage = { id: string; name: string; createdAt: number; updatedAt: number };

export type CellPush = {
  elements: any[];
  meta: Record<string, [number, string]>;
  tombs: { id: string; v: number; ts: number; author: string }[];
  files: Record<string, any>;
  pages: CellPage[];
  pageName: string;
};

export type CellSnapshot = {
  elements: any[];
  meta: Record<string, [number, string]>;
  tombs: { id: string; v: number; ts: number; author: string }[];
  files: any[];
  pages: CellPage[];
};

const url = (docId: string, path: string, page: string): string | null => {
  const b = base();
  if (!b) return null;
  return `${b}/p/${encodeURIComponent(docId)}/${path}?page=${encodeURIComponent(page)}`;
};

export const cellSnapshot = async (docId: string, page: string): Promise<CellSnapshot | null> => {
  const u = url(docId, 'snapshot', page);
  if (!u) return null;
  const r = await fetch(u);
  if (!r.ok) return null;
  const j = await r.json();
  return {
    elements: Array.isArray(j.elements) ? j.elements : [],
    meta: j.meta ?? {},
    tombs: Array.isArray(j.tombs) ? j.tombs : [],
    files: Array.isArray(j.files) ? j.files : [],
    pages: Array.isArray(j.pages) ? j.pages : [],
  };
};

// Fire-and-forget push; failures are silent by design (gossip/localStorage
// remain the safety net until the cell path is proven).
export const cellPush = (docId: string, page: string, push: CellPush): void => {
  try {
    const u = url(docId, 'push', page);
    if (!u) return;
    fetch(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...push, files: Object.values(push.files ?? {}) }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
};

// Subscribe to live merges fanned out by the cell. Returns an unsubscribe.
// Auto-reconnects with backoff; messages are full snapshots ({type:'merge'}).
export const cellSubscribe = (
  docId: string,
  onMerge: (page: string, snap: CellSnapshot) => void,
): (() => void) => {
  const b = base();
  if (!b) return () => {};
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  const connect = () => {
    if (closed) return;
    try {
      ws = new WebSocket(`${b.replace(/^http/, 'ws')}/p/${encodeURIComponent(docId)}/ws`);
    } catch {
      retry();
      return;
    }
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data));
        if (m?.type === 'merge' && typeof m.page === 'string') {
          onMerge(m.page, {
            elements: Array.isArray(m.elements) ? m.elements : [],
            meta: m.meta ?? {},
            tombs: Array.isArray(m.tombs) ? m.tombs : [],
            files: Array.isArray(m.files) ? m.files : [],
            pages: Array.isArray(m.pages) ? m.pages : [],
          });
        }
      } catch {}
    };
    ws.onclose = () => retry();
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {}
    };
  };
  const retry = () => {
    if (closed) return;
    attempt += 1;
    window.setTimeout(connect, Math.min(15000, 500 * 2 ** Math.min(attempt, 5)));
  };
  connect();
  return () => {
    closed = true;
    try {
      ws?.close();
    } catch {}
  };
};
