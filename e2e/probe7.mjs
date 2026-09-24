import { webkit } from 'playwright';
const b = await webkit.launch();
const p = await (await b.newContext()).newPage();
const urls = [
  'https://euc1-1.relay.n0.iroh.link/ping',
  'https://euc1-1.relay.n0.iroh.link./ping',
  'https://relay-production-61c3.up.railway.app/healthz',
];
for (let round = 0; round < 3; round++) {
  for (const u of urls) {
    const r = await p.evaluate(async (u) => {
      try { const r = await fetch(u); return r.status; }
      catch (e) { return 'FAIL:' + String(e).slice(0, 60); }
    }, u);
    console.log(`round${round}`, u.includes('iroh.link/') ? 'n0-bare' : u.includes('iroh.link.') ? 'n0-dot' : 'custom', '=>', r);
  }
}
await b.close();
