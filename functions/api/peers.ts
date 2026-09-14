// Cloudflare Pages Function: keyless lobby for peer discovery.
// Backed by a KV namespace bound as PEERS. Entries expire after 60s;
// clients re-register every ~20s, so dead tabs vanish on their own.
interface Env {
  PEERS: KVNamespace;
}

const key = (addr: string) => {
  let h = 0;
  for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0;
  return 'peer:' + h.toString(36);
};

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const kv = ctx.env.PEERS;
  if (ctx.request.method === 'POST') {
    let addr = '';
    try {
      addr = ((await ctx.request.json()) as any)?.addr ?? '';
    } catch {}
    if (typeof addr === 'string' && addr) {
      await kv.put(key(addr), addr, { expirationTtl: 60 });
    }
    return new Response('ok');
  }
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'peer:', cursor });
    for (const k of page.keys) {
      const v = await kv.get(k.name);
      if (v) out.push(v);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return Response.json(out);
};
