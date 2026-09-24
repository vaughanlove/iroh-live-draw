import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox', '--user-data-dir=/tmp/probe3-profile'] });
const p1 = await b.newPage();
await p1.goto('http://192.168.1.233:8080/?debug=1', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 5000));
const p2 = await b.newPage();
await p2.goto('http://192.168.1.233:8080/?debug=1', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));
for (const [n, p] of [['p1', p1], ['p2', p2]]) {
  const s = await p.evaluate(() => ({ vis: document.visibilityState, focus: document.hasFocus(), hidden: document.hidden }));
  console.log(n, JSON.stringify(s));
}
await b.close();
