// Temporary dev presence: devices prove identity with an Ed25519 signature
// from their iroh key (no passwords). Worker returns known peer addrs so a
// new device can dial everyone it has ever seen.
//   POST {nodeId, addr, ts, sig} — sig = sign("<nodeId>.<addr>.<ts>")
//   GET -> [{nodeId, addr, lastSeen}]
// KV namespace bound as PEERS. Dev-only: reads are unauthenticated.
interface Env {
  PEERS: KVNamespace;
}

const hex = (s: string) => {
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return b;
};

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const kv = ctx.env.PEERS;
  if (ctx.request.method === 'POST') {
    let b: any = {};
    try {
      b = await ctx.request.json();
    } catch {}
    const { nodeId, addr, ts, sig } = b;
    if (typeof nodeId !== 'string' || typeof addr !== 'string' || typeof ts !== 'number' || typeof sig !== 'string') {
      return new Response('bad shape', { status: 400 });
    }
    if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
      return new Response('stale', { status: 400 });
    }
    try {
      const key = await crypto.subtle.importKey('raw', hex(nodeId).buffer as ArrayBuffer, { name: 'Ed25519' }, false, ['verify']);
      const msg = new TextEncoder().encode(`${nodeId}.${addr}.${ts}`);
      const ok = await crypto.subtle.verify('Ed25519', key, hex(sig), msg);
      if (!ok) return new Response('bad sig', { status: 401 });
    } catch {
      return new Response('verify error', { status: 401 });
    }
    await kv.put('p:' + nodeId, JSON.stringify({ nodeId, addr, lastSeen: Date.now() }), { expirationTtl: 3600 });
    return new Response('ok');
  }
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'p:', cursor });
    for (const k of page.keys) {
      const v = await kv.get(k.name);
      if (v) out.push(JSON.parse(v));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return Response.json(out);
};
