// WebKit pass (closest to iPad Safari testable on this Mac): owner creates,
// guest joins via ticket, owner draws late, guest must converge — then back.
import { webkit } from 'playwright';

const APP_URL = process.env.APP_URL ?? 'http://192.168.1.233:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const browser = await webkit.launch();
const clog = (who) => (m) => {
  const t = m.text();
  if (/certificate|Failed to load/i.test(t)) {
    console.log(new Date().toISOString().slice(11, 23), `[${who}] CERTFAIL:`, t.slice(0, 500), '| loc:', m.location()?.url?.slice(0, 120));
  }
  if (/draw_shared|draw_browser|endpoint bound|endpoint id|home is now|joining|Joined|Neighbor|presence|firewall|dial|error|Error|failed|warn|WARN/i.test(t)) {
    console.log(new Date().toISOString().slice(11, 23), `[${who}]`, t.slice(0, 220));
  }
};
try {
  const ctxA = await browser.newContext();
  const A = await ctxA.newPage();
  A.on('console', clog('A'));
  const errors = [];
  A.on('pageerror', (e) => errors.push('A pageerror: ' + String(e).slice(0, 200)));
  A.on('dialog', async (d) => { await d.accept('e2e-topic'); });
  await A.goto(`${APP_URL}/?debug=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(8000);
  // open topics overlay via pill, create topic
  await A.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('live draw')).click());
  await sleep(500);
  await A.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '+ new topic').click());
  await sleep(6000);
  const docs = await A.evaluate(() => JSON.parse(localStorage.getItem('draw.docs') ?? '[]').sort((a, b) => b.updatedAt - a.updatedAt));
  if (!docs.length || !docs[0].ticket) throw new Error('no ticket, keys: ' + Object.keys(await A.evaluate(() => ({ ...localStorage }))).join(','));
  const ticket = docs[0].ticket;
  log('webkit owner doc, ticket bytes:', ticket.length);

  const ctxB = await browser.newContext();
  const B = await ctxB.newPage();
  B.on('console', clog('B'));
  B.on('pageerror', (e) => errors.push('B pageerror: ' + String(e).slice(0, 200)));
  await B.goto(`${APP_URL}/?fresh=1&debug=1#t=${encodeURIComponent(ticket)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(12000);

  const idA = await A.evaluate(() => window.__draw.addRect());
  await sleep(10000);
  const bScene = await B.evaluate(() => window.__draw.scene().map((e) => e.id));
  log('webkit late edit reached guest:', bScene.includes(idA), JSON.stringify(bScene));

  const idB = await B.evaluate(() => window.__draw.addRect());
  await sleep(10000);
  const aScene = await A.evaluate(() => window.__draw.scene().map((e) => e.id));
  log('webkit late edit reached owner:', aScene.includes(idB), JSON.stringify(aScene));
  log('webkit errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}
log('done');
