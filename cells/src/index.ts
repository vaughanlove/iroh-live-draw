// Worker: routes /p/:projectId/* to that project's cell.
// Live strokes go over the cell's hibernatable WebSocket (same path as
// today's gossip broadcast, minus iroh). Snapshots are plain fetch —
// this replaces keeper POST /watch + QUIC snap-req for web clients.
import { ProjectCell } from './project-cell.js';

export { ProjectCell };

export default {
  async fetch(req: Request, env: any): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/p\/([^/]+)(\/.*)?$/);
    if (!m) {
      if (url.pathname === '/healthz') return new Response('ok');
      return new Response('use /p/:projectId/snapshot|push|ws', { status: 404 });
    }
    const id = env.PROJECT.idFromName(m[1]);
    const stub = env.PROJECT.get(id);
    // Forward path + method + body unchanged; cell owns auth + merge.
    const fwd = new URL(req.url);
    fwd.pathname = m[2] || '/snapshot';
    return stub.fetch(new Request(fwd, req));
  },
};
