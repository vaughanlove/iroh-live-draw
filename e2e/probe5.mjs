import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox', '--user-data-dir=/tmp/probe5-profile'] });
const p1 = await b.newPage();
await p1.goto('http://192.168.1.233:8080/?debug=1', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 8000));
const id = await p1.evaluate(() => window.__draw.addRect());
await new Promise(r => setTimeout(r, 1000));
const before = await p1.evaluate(() => window.__draw.scene().length);
// background p1 by opening + focusing p2
const p2 = await b.newPage();
await p2.goto('http://192.168.1.233:8080/?debug=1', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));
const vis1 = await p1.evaluate(() => document.visibilityState);
await p1.evaluate(() => window.__draw.collabPing());
await new Promise(r => setTimeout(r, 1500));
const after = await p1.evaluate(() => window.__draw.scene().length);
console.log(JSON.stringify({ id, before, vis1, after }));
await b.close();
