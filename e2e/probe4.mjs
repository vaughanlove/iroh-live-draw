import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox', '--user-data-dir=/tmp/probe4-profile'] });
const p = await b.newPage();
await p.goto('http://192.168.1.233:8080/?debug=1', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 8000));
const out = await p.evaluate(async () => {
  const api = window.__draw;
  const idA = api.addRect();
  await new Promise(r => setTimeout(r, 800));
  const idB = api.addRect();
  await new Promise(r => setTimeout(r, 800));
  const scene = api.scene();
  const remote = [{ ...scene.find((e) => e.id === idB), version: 2 }];
  const t = api.reconcileTest(remote);
  return { idA, idB, scene: scene.map((e) => e.id), test: t };
});
console.log(JSON.stringify(out, null, 1));
await b.close();
