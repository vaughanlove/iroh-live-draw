// E2E harness v2: device profiles + assertion DSL.
//
// Form-factor emulation (viewport, dpr, touch, UA) across one shared
// Chromium — honest emulation, not real devices. Real-device proof still
// needs the physical hardware; this catches layout, dpr, touch-routing,
// and renderer-ladder bugs (note which renderer each peer lands on).
//
// Usage:
//   node harness.mjs live [--app-url http://192.168.1.233:8080]
// Scenarios exit non-zero on the first failed expectation (no log
// eyeballing). Shared helpers live here; scenarios are small files.
import { chromium } from 'playwright';

export const APP_URL = process.env.APP_URL ?? 'http://192.168.1.233:8080';

// ---- devices -----------------------------------------------------------
// name -> { viewport, dpr, touch, mobile, ua }. Keep the set small and
// meaningful: the dpr axis (1 vs 2 vs 3) is what broke rendering before,
// touch is what broke input routing.
export const DEVICES = {
  'desktop-1x': {
    viewport: { width: 1280, height: 800 },
    dpr: 1,
    touch: false,
    mobile: false,
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Safari/537.36',
  },
  'desktop-hidpi': {
    viewport: { width: 1512, height: 982 },
    dpr: 2,
    touch: false,
    mobile: false,
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Safari/537.36',
  },
  'android-tablet': {
    viewport: { width: 1600, height: 2560 },
    dpr: 2,
    touch: true,
    mobile: true,
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Safari/537.36',
  },
  'iphone': {
    viewport: { width: 390, height: 844 },
    dpr: 3,
    touch: true,
    mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  },
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- world -------------------------------------------------------------
// One browser, isolated contexts per peer (separate profiles: storage,
// identity, and keys never cross-contaminate).
export async function launchWorld() {
  const browser = await chromium.launch();
  const peers = [];
  return {
    browser,
    async spawn(deviceName, url, peerName) {
      const dev = DEVICES[deviceName];
      if (!dev) throw new Error(`unknown device: ${deviceName}`);
      const ctx = await browser.newContext({
        viewport: dev.viewport,
        deviceScaleFactor: dev.dpr,
        hasTouch: dev.touch,
        isMobile: dev.mobile,
        userAgent: dev.ua,
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push('PAGE: ' + String(e).slice(0, 200)));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 200));
      });
      page.on('dialog', async (d) => {
        await d.accept(`${peerName}-project`);
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2000);
      const peer = { page, ctx, name: peerName ?? deviceName, device: deviceName, errors };
      peers.push(peer);
      return peer;
    },
    async close() {
      await browser.close();
    },
  };
}

// ---- app driver (real UI where cheap, debug hooks where precise) --------
export async function appUrl(qs = '', hash = '') {
  return `${APP_URL}/${qs}${hash}`;
}

export async function openProjects(peer) {
  // Summon the hidden title block, open the projects home.
  await peer.page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    if (!btns.some((b) => b.textContent.trim() === '← PROJECTS')) {
      btns.find((b) => b.textContent.trim() === '✦')?.click();
    }
  });
  await sleep(400);
  await peer.page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '← PROJECTS')?.click();
  });
  await sleep(600);
}

export async function createProject(peer) {
  await openProjects(peer);
  const ok = await peer.page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '+ new project');
    if (b) b.click();
    return !!b;
  });
  if (!ok) throw new Error(`[${peer.name}] no + new project button`);
  await sleep(5000);
  const docs = JSON.parse(
    (await peer.page.evaluate(() => localStorage.getItem('draw.docs') ?? '[]')),
  ).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!docs.length || !docs[0].ticket) throw new Error(`[${peer.name}] no ticket after create`);
  const key = await peer.page.evaluate((k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }, `draw.key.${docs[0].id}`);
  return { docId: docs[0].id, ticket: docs[0].ticket, key };
}

export function shareUrl(ticket, key, fresh = true) {
  const frag = `t=${encodeURIComponent(ticket)}${key ? `&k=${encodeURIComponent(key)}` : ''}`;
  return `${APP_URL}/?${fresh ? 'fresh=1&' : ''}debug=1#${frag}`;
}

export async function drawRect(peer) {
  return peer.page.evaluate(() => window.__draw && window.__draw.addRect());
}

export async function sceneIds(peer) {
  const s = await peer.page.evaluate(() => window.__draw && window.__draw.scene());
  return (s ?? []).filter((e) => !e.del).map((e) => e.id);
}

export async function rendererOf(peer) {
  // Which rung of the renderer ladder this peer landed on.
  return peer.page.evaluate(() => (window.__draw && window.__draw.gpu ? window.__draw.gpu() : 'n/a'));
}

// ---- expect DSL (polling assertions; throw on timeout) -----------------
export function expect(peer) {
  const label = peer?.name ?? '?';
  async function poll(fn, timeout, what) {
    const t0 = Date.now();
    let last;
    for (;;) {
      try {
        last = await fn();
        if (last.ok) return last.value;
      } catch (e) {
        last = { error: String(e).slice(0, 120) };
      }
      if (Date.now() - t0 > timeout) {
        throw new Error(`[${label}] EXPECT FAILED (${what}): ${JSON.stringify(last)}`);
      }
      await sleep(500);
    }
  }
  return {
    async sceneIds(want, { timeout = 20000 } = {}) {
      const ids = want.slice().sort();
      return poll(
        async () => {
          const got = (await sceneIds(peer)).slice().sort();
          return JSON.stringify(got) === JSON.stringify(ids)
            ? { ok: true, value: got }
            : { ok: false, value: got };
        },
        timeout,
        `scene == [${ids}]`,
      );
    },
    async sceneContains(id, { timeout = 20000 } = {}) {
      return poll(
        async () => {
          const got = await sceneIds(peer);
          return got.includes(id) ? { ok: true, value: got } : { ok: false, value: got };
        },
        timeout,
        `scene contains ${id}`,
      );
    },
    async sceneLacks(id, { timeout = 20000 } = {}) {
      // Absence must HOLD for the window (tombstone convergence, not luck).
      await sleep(Math.min(timeout, 3000));
      const got = await sceneIds(peer);
      if (got.includes(id)) throw new Error(`[${label}] EXPECT FAILED (scene lacks ${id}): still present`);
      return got;
    },
    async noErrors() {
      if (peer.errors.length) {
        throw new Error(`[${label}] EXPECT FAILED (no errors):\n  ` + peer.errors.slice(0, 5).join('\n  '));
      }
    },
  };
}

export async function expectConverged(peers, { timeout = 25000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const scenes = await Promise.all(peers.map((p) => sceneIds(p)));
    const first = JSON.stringify(scenes[0].slice().sort());
    if (scenes.every((s) => JSON.stringify(s.slice().sort()) === first) && scenes[0].length > 0) {
      return scenes[0];
    }
    if (Date.now() - t0 > timeout) {
      throw new Error(`EXPECT FAILED (converged): ${scenes.map((s, i) => `${peers[i].name}=[${s}]`).join(' ')}`);
    }
    await sleep(500);
  }
}
