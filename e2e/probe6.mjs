import { webkit } from 'playwright';
const b = await webkit.launch();
const p = await (await b.newContext()).newPage();
const r = await p.evaluate(async () => {
  const out = {};
  for (const u of ['https://euc1-1.relay.n0.iroh.link/ping', 'https://relay-production-61c3.up.railway.app/healthz', 'https://example.com/']) {
    try { const r = await fetch(u); out[u] = r.status; }
    catch (e) { out[u] = 'FAIL: ' + String(e).slice(0, 100); }
  }
  return out;
});
console.log(JSON.stringify(r, null, 1));
await b.close();
