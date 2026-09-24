// Sandbox: spawn headless Chromium peers against the live-draw app and
// observe the gossip layer. Same-browser tabs share one profile (like two
// tabs on the MacBook); separate launches get separate profiles (like
// MacBook + iPad).
//
//   node spawn.mjs liveness   # owner creates, guest joins, owner dies, owner returns
//
// Env: APP_URL (default http://192.168.1.233:8080), CHROME_BIN, OUT_DIR.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const APP_URL = process.env.APP_URL ?? 'http://192.168.1.233:8080';
const KEEPER_QS = `keeper=${encodeURIComponent(APP_URL.replace(/:\d+$/, ':8081'))}`;
const CHROME_BIN = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = process.env.OUT_DIR ?? path.resolve('logs');
fs.mkdirSync(OUT_DIR, { recursive: true });

const ts = () => new Date().toISOString().slice(11, 23);
const logFile = path.join(OUT_DIR, `run-${Date.now()}.log`);
const log = (tab, ...args) => {
  const line = `[${ts()}] [${tab}] ${args.map(String).join(' ')}`;
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
};

async function launch(profile) {
  // Fresh profile per run: stale tickets/identities from prior runs point
  // at dead endpoint ids and poison the scenario.
  const dir = path.join(OUT_DIR, 'profiles', `${profile}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return { browser: await puppeteer.launch({
    executablePath: CHROME_BIN,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${dir}`],
  }), dir };
}

async function openTab(browser, name, url) {
  // Every tab gets the keeper address (query override beats build env).
  const u = new URL(url);
  const k = new URLSearchParams(KEEPER_QS);
  for (const [kk, vv] of k) u.searchParams.set(kk, vv);
  url = u.toString();
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/draw_shared|draw_browser|endpoint|gossip|joining|firewall|presence|stage-vanish|mint-tomb|onchange#|\[flow\]|merge-drop/i.test(t)) log(name, 'CONSOLE:', t.slice(0, 400));
  });
  page.on('pageerror', (e) => log(name, 'PAGEERROR:', String(e).slice(0, 300)));
  page.on('dialog', async (d) => { log(name, 'DIALOG:', d.message().slice(0, 80)); await d.accept('e2e-topic'); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
  return page;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// DOM helpers (no app code changes needed: drive the real UI).
async function pillText(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const pill = btns.find((b) => b.textContent?.includes('live draw') && b.textContent.length < 120);
    return pill ? pill.textContent.trim().slice(0, 160) : '(no pill)';
  });
}
async function pillButton(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    return btns.findIndex((b) => b.textContent?.includes('live draw') && b.textContent.length < 160);
  });
}
async function openPanel(page) {
  // Pill opens the topics overlay; Peers tab holds the roster.
  const idx = await pillButton(page);
  if (idx >= 0) await page.evaluate((i) => [...document.querySelectorAll('button')][i].click(), idx);
  await sleep(500);
}
async function openPeers(page) {
  await openPanel(page);
  const done = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Peers');
    if (b) { b.click(); return true; }
    return false;
  });
  await sleep(500);
  return done;
}
async function panelText(page) {
  // Scope to the overlay sheet when open (body text is Excalidraw chrome).
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('div')];
    const sheet = els.find((d) => d.textContent?.includes('Shared with me') || d.textContent?.includes('No peers seen yet') || d.textContent?.includes('My topics'));
    if (sheet) return sheet.innerText.slice(0, 1500);
    const panel = els.find((d) => d.textContent?.includes('✦ tools'));
    return (panel ? panel.innerText : document.body.innerText).slice(0, 1500);
  });
}
async function ls(page) {
  return page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith('draw.')) out[k] = localStorage.getItem(k).slice(0, k === 'draw.docs' ? 10000 : 400);
    }
    return out;
  });
}
async function clickBtn(page, label) {
  const found = await page.evaluate((label) => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === label);
    if (b) { b.click(); return true; }
    return false;
  }, label);
  return found;
}

async function scenarioLiveness() {
  log('harness', 'APP_URL=', APP_URL);
  const { browser } = await launch('same-browser');
  try {
    // Owner tab: fresh load, create topic.
    const A = await openTab(browser, 'owner', `${APP_URL}/?debug=1`);
    await sleep(8000);
    log('owner', 'pill:', await pillText(A));
    await openPanel(A);
    if (!(await clickBtn(A, '+ new topic'))) throw new Error('no + new topic button');
    await sleep(6000);
    const aLs = await ls(A);
    const docs = JSON.parse(aLs['draw.docs'] ?? '[]');
    docs.sort((a, b) => b.updatedAt - a.updatedAt);
    if (!docs.length || !docs[0].ticket) throw new Error('owner has no ticket: ' + JSON.stringify(Object.keys(aLs)));
    const ticket = docs[0].ticket;
    const docId = docs[0].id;
    log('owner', 'doc:', docId.slice(0, 8), 'ticket bytes:', ticket.length);

    // Guest tab, same browser profile (shared localStorage, distinct tab id).
    // Guest tab: ?fresh=1 gives it an ephemeral id (same-browser tabs
    // share the base identity, so testing needs the explicit hatch).
    const B = await openTab(browser, 'guest', `${APP_URL}/?fresh=1&debug=1#t=${encodeURIComponent(ticket)}`);
    await sleep(10000);
    log('guest', 'pill:', await pillText(B));
    await openPeers(B);
    log('guest', 'panel:', (await panelText(B)).replace(/\n/g, ' | ').slice(0, 800));

    // Steady state: both should see each other.
    await sleep(8000);
    await openPeers(A);
    log('owner', 'panel:', (await panelText(A)).replace(/\n/g, ' | ').slice(0, 800));

    // Kill the owner. Watch the guest judge liveness.
    log('harness', 'closing owner tab');
    await A.close();
    for (let i = 0; i < 5; i++) {
      await sleep(5000);
      log('guest', `t+${(i + 1) * 5}s pill:`, await pillText(B));
    }
    await openPeers(B);
    log('guest', 'panel after owner death:', (await panelText(B)).replace(/\n/g, ' | ').slice(0, 800));

    // Owner returns (fresh tab, same profile).
    log('harness', 'reopening owner tab');
    const A2 = await openTab(browser, 'owner2', `${APP_URL}/?debug=1`);
    await sleep(10000);
    log('owner2', 'pill:', await pillText(A2));
    await openPeers(A2);
    log('owner2', 'panel:', (await panelText(A2)).replace(/\n/g, ' | ').slice(0, 800));
    await sleep(15000);
    await openPeers(B);
    log('guest', 'panel after owner return:', (await panelText(B)).replace(/\n/g, ' | ').slice(0, 800));
    // Same-id reconnect may leave the mesh half-built (stale gossip state
    // for the rebooted id). Reload the guest for a clean handshake.
    log('harness', 'reloading guest for clean handshake');
    await B.reload({ waitUntil: 'domcontentloaded' }); await sleep(2000);
    await sleep(15000);
    await openPeers(B);
    log('guest', 'panel after guest reload:', (await panelText(B)).replace(/\n/g, ' | ').slice(0, 800));
    await A2.close();
    await B.close();
  } finally {
    await browser.close();
  }
  log('harness', 'done. log at', logFile);
}

async function drawApi(page, fn, arg) {
  return page.evaluate((fn, arg) => window.__draw && window.__draw[fn](arg), fn, arg);
}
async function sceneIds(page) {
  const s = await drawApi(page, 'scene');
  return (s ?? []).filter((e) => !e.del).map((e) => e.id);
}

async function scenarioCrdt() {
  log('harness', 'APP_URL=', APP_URL);
  const { browser } = await launch('crdt');
  try {
    const A = await openTab(browser, 'owner', `${APP_URL}/?debug=1`);
    await sleep(8000);
    await openPanel(A);
    if (!(await clickBtn(A, '+ new topic'))) throw new Error('no + new topic button');
    await sleep(6000);
    const docs = JSON.parse((await ls(A))['draw.docs'] ?? '[]').sort((a, b) => b.updatedAt - a.updatedAt);
    if (!docs.length || !docs[0].ticket) throw new Error('no ticket');
    const B = await openTab(browser, 'guest', `${APP_URL}/?fresh=1&debug=1#t=${encodeURIComponent(docs[0].ticket)}`);
    await sleep(10000);

    // 1. create on owner -> converges to guest
    const id1 = await drawApi(A, 'addRect');
    log('crdt', 'owner drew', id1);
    await sleep(8000);
    const g1 = await sceneIds(B);
    log('crdt', 'guest sees rect:', g1.includes(id1), `(guest has ${g1.length})`);

    // 2. delete on owner -> disappears on guest, tombstone minted.
    // Deletion needs a foreground tab (renders must commit): like a user.
    await A.bringToFront();
    await drawApi(A, 'del', id1);
    await sleep(8000);
    const g2 = await sceneIds(B);
    const tombs = await drawApi(A, 'tombs');
    log('crdt', 'guest rect gone:', !g2.includes(id1), '| owner tombs:', JSON.stringify(tombs));

    // 3. guest reload -> no resurrection from snapshot merge.
    // Re-navigate (not reload) so ?fresh=1&debug=1 and the ticket survive;
    // the app strips the hash after joining.
    const guestUrl = `${APP_URL}/?fresh=1&debug=1#t=${encodeURIComponent(docs[0].ticket)}`;
    await B.goto(guestUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(2000);
    await sleep(12000);
    const g3 = await sceneIds(B);
    log('crdt', 'no resurrection after reload:', !g3.includes(id1), `(guest has ${g3.length})`);

    // 4. concurrent draw on both -> both converge on both
    const idA = await drawApi(A, 'addRect');
    await sleep(500);
    const idB = await drawApi(B, 'addRect');
    log('crdt', 'drew A:', idA, 'B:', idB);
    await sleep(1500);
    log('crdt', 'B scene now:', JSON.stringify(await drawApi(B, 'scene')));
    log('crdt', 'B meta now:', JSON.stringify(await drawApi(B, 'meta')));
    log('crdt', 'B tombs now:', JSON.stringify(await drawApi(B, 'tombs')));
    await sleep(10000);
    const sA = await sceneIds(A);
    const sB = await sceneIds(B);
    log('crdt', 'A ids:', JSON.stringify(sA), 'B ids:', JSON.stringify(sB));
    log('crdt', 'A stats:', JSON.stringify(await drawApi(A, 'stats')));
    log('crdt', 'B stats:', JSON.stringify(await drawApi(B, 'stats')));
    log('crdt', 'A tombs:', JSON.stringify(await drawApi(A, 'tombs')));
    log('crdt', 'B tombs:', JSON.stringify(await drawApi(B, 'tombs')));
    const conv = sA.includes(idA) && sA.includes(idB) && sB.includes(idA) && sB.includes(idB);
    log('crdt', 'concurrent converge:', conv, `A:[${sA.length}] B:[${sB.length}]`);

    // 5. overwrite-pull: guest diverges, pulls, gets written over by owner.
    // Owner parks on another format first: the answer must come from the
    // owner's stored board state, not silence.
    await A.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '⋯').click();
    });
    await sleep(500);
    await A.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent.includes('letters')).click();
    });
    await sleep(2000);
    const idD = await drawApi(B, 'addRect');
    await sleep(3000);
    const preDiv = await sceneIds(B);
    log('crdt', 'guest diverged:', preDiv.includes(idD));
    await B.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '⋯').click();
    });
    await sleep(500);
    await B.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent.includes('sync')).click();
    });
    await sleep(2000);
    log('crdt', 'B lastPush:', await drawApi(B, 'lastPush'));
    await sleep(8000);
    const sB2 = (await sceneIds(B)).sort();
    // Owner is parked on another format: B must equal the owner's STORED
    // board state, not the owner's live (letters) scene.
    const ownerDocs = JSON.parse((await drawApi(A, 'lsGet', 'draw.docs')) ?? '[]');
    const odoc = ownerDocs.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const boardPage = odoc.pages.find((p) => p.kind === 'board') ?? odoc.pages[0];
    const stored = JSON.parse((await drawApi(A, 'lsGet', `draw.snap.${odoc.id}.${boardPage.id}`)) ?? '[]').map((e) => e.id).sort();
    log('crdt', 'pull overwrote:', JSON.stringify(sB2) === JSON.stringify(stored), `owner-board:${JSON.stringify(stored)} B:${JSON.stringify(sB2)}`);
    // 6. keeper serves while owner is offline: close everything, fresh
    //    join with a FRESH ticket (refreshed tickets carry keeper + relays;
    //    the scenario-start ticket predates them). Keeper answers.
    const freshDocs = JSON.parse((await drawApi(B, 'lsGet', 'draw.docs')) ?? '[]').sort((a, b) => b.updatedAt - a.updatedAt);
    const ticket = freshDocs[0].ticket;
    await A.close();
    await B.close();
    await sleep(2000);
    const C = await openTab(browser, 'newcomer', `${APP_URL}/?fresh=1&debug=1#t=${encodeURIComponent(ticket)}`);
    await sleep(15000);
    const sC = await sceneIds(C);
    log('crdt', 'keeper served newcomer:', sC.length >= 2, JSON.stringify(sC));
    log('crdt', 'fetchErr:', await drawApi(C, 'fetchErr'));
    await C.close();
  } finally {
    await browser.close();
  }
  log('harness', 'done. log at', logFile);
}

async function scenarioKeeper() {
  log('harness', 'APP_URL=', APP_URL);
  // Separate browser profile for the newcomer — like MacBook vs iPad in
  // reality. Same-profile tabs share localStorage, which cross-contaminates
  // snapshots and rosters and lies to every assertion.
  const { browser } = await launch('keeper-owner');
  const { browser: other } = await launch('keeper-guest');
  try {
    const A = await openTab(browser, 'owner', `${APP_URL}/?debug=1`);
    await sleep(8000);
    await openPanel(A);
    if (!(await clickBtn(A, '+ new topic'))) throw new Error('no + new topic button');
    await sleep(6000);
    const id1 = await drawApi(A, 'addRect');
    const id2 = await drawApi(A, 'addRect');
    await sleep(6000);
    const docs = JSON.parse((await ls(A))['draw.docs'] ?? '[]').sort((a, b) => b.updatedAt - a.updatedAt);
    const ticket = docs[0].ticket;
    log('keeper-test', 'ticket bytes:', ticket.length);
    await sleep(10000); // let keeper merge
    await A.close();
    await sleep(2000);
    const C = await openTab(other, 'newcomer', `${APP_URL}/?fresh=1&debug=1#t=${encodeURIComponent(ticket)}`);
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      const d = await drawApi(C, 'diag');
      const c = await drawApi(C, 'counts');
      log('keeper-test', `t+${(i + 1) * 2}s scene=${d.scene} meta=${d.meta} tombs=${d.tombs} known=${d.known} counts=${JSON.stringify(c)}`);
      if (d.scene > 0) break;
    }
    const sC = await sceneIds(C);
    log('keeper-test', 'served with owner offline:', sC.includes(id1) && sC.includes(id2), JSON.stringify(sC));
    log('keeper-test', 'fetchErr:', await drawApi(C, 'fetchErr'));
    log('keeper-test', 'lastFetch:', await drawApi(C, 'lastFetch'));
    log('keeper-test', 'flushCount:', await drawApi(C, 'flushCount'));
    log('keeper-test', 'diag:', JSON.stringify(await drawApi(C, 'diag')));
    log('keeper-test', 'meta:', JSON.stringify(await drawApi(C, 'meta')));
    log('keeper-test', 'tombs:', JSON.stringify(await drawApi(C, 'tombs')));
    log('keeper-test', 'usLog:', JSON.stringify(await drawApi(C, 'usLog')));
    log('keeper-test', 'apiCalls:', JSON.stringify(await drawApi(C, 'apiCalls')));
    await C.close();
  } finally {
    await browser.close();
    await other.close();
  }
  log('harness', 'done. log at', logFile);
}

async function scenarioRejoin() {
  log('harness', 'APP_URL=', APP_URL);
  const { browser } = await launch('rejoin-owner');
  const other = (await launch('rejoin-guest')).browser;
  try {
    const A = await openTab(browser, 'owner', `${APP_URL}/?debug=1`);
    await sleep(8000);
    await openPanel(A);
    if (!(await clickBtn(A, '+ new topic'))) throw new Error('no + new topic button');
    await sleep(6000);
    const idA = await drawApi(A, 'addRect');
    const docs = JSON.parse((await ls(A))['draw.docs'] ?? '[]').sort((a, b) => b.updatedAt - a.updatedAt);
    const ticket = docs[0].ticket;
    const B = await openTab(other, 'guest', `${APP_URL}/?fresh=1&debug=1#t=${encodeURIComponent(ticket)}`);
    await sleep(10000);
    log('rejoin', 'both converged:', JSON.stringify(await sceneIds(A)), JSON.stringify(await sceneIds(B)));
    log('rejoin', 'A apiCalls:', JSON.stringify(await drawApi(A, 'apiCalls')));
    for (let i = 0; i < 3; i++) {
      await sleep(2500);
      log('rejoin', `A t+${(i + 1) * 2.5}s:`, JSON.stringify(await sceneIds(A)));
    }
    log('rejoin', 'A pre-close meta:', JSON.stringify(await drawApi(A, 'meta')));
    log('rejoin', 'A pre-close tombs:', JSON.stringify(await drawApi(A, 'tombs')));
    log('rejoin', 'A pre-close usLog:', JSON.stringify(await drawApi(A, 'usLog')));
    log('rejoin', 'A pre-close diag:', JSON.stringify(await drawApi(A, 'diag')));
    log('rejoin', 'A pre-close diag:', JSON.stringify(await drawApi(A, 'diag')));
    // Owner leaves; guest draws alone.
    await A.close();
    await sleep(2000);
    log('rejoin', 'pages after A.close:', (await browser.pages()).length);
    const idB = await drawApi(B, 'addRect');
    await sleep(8000);
    log('rejoin', 'guest drew alone:', idB, JSON.stringify(await sceneIds(B)));
    // Owner rejoins (same profile = same identity). The keeper watchdog
    // needs a silence window first, so give the mesh time to heal.
    const A2 = await openTab(browser, 'owner2', `${APP_URL}/?debug=1`);
    await sleep(45000);
    const sA2 = await sceneIds(A2);
    const sB = await sceneIds(B);
    log('rejoin', 'owner2 scene:', JSON.stringify(sA2), 'guest scene:', JSON.stringify(sB));
    log('rejoin', 'edits survived:', sA2.includes(idA) && sA2.includes(idB));
    log('rejoin', 'A2 meta:', JSON.stringify(await drawApi(A2, 'meta')));
    log('rejoin', 'A2 tombs:', JSON.stringify(await drawApi(A2, 'tombs')));
    log('rejoin', 'A2 usLog:', JSON.stringify(await drawApi(A2, 'usLog')));
    log('rejoin', 'A2 lastFetch:', await drawApi(A2, 'lastFetch'));
    log('rejoin', 'A2 fetchErr:', await drawApi(A2, 'fetchErr'));
    log('rejoin', 'A2 stats:', JSON.stringify(await drawApi(A2, 'stats')));
    log('rejoin', 'A2 apiCalls:', JSON.stringify(await drawApi(A2, 'apiCalls')));
    log('rejoin', 'A2 sceneAll:', JSON.stringify(await drawApi(A2, 'sceneAll')));
    log('rejoin', 'A2 counts:', JSON.stringify(await drawApi(A2, 'counts')));
    log('rejoin', 'B meta:', JSON.stringify(await drawApi(B, 'meta')));
    log('rejoin', 'B tombs:', JSON.stringify(await drawApi(B, 'tombs')));
    await A2.close();
    await B.close();
  } finally {
    await browser.close();
    await other.close();
  }
  log('harness', 'done. log at', logFile);
}
const scenario = process.argv[2] ?? 'liveness';
if (scenario === 'liveness') await scenarioLiveness();
else if (scenario === 'crdt') await scenarioCrdt();
else if (scenario === 'keeper') await scenarioKeeper();
else if (scenario === 'rejoin') await scenarioRejoin();
else throw new Error(`unknown scenario: ${scenario}`);
