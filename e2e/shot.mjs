import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox', '--window-size=1280,800', '--user-data-dir=/tmp/shot-profile'] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 800 });
await p.goto('http://192.168.1.233:8080/?debug=1', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 9000));
await p.screenshot({ path: '/tmp/shot-canvas.png' });
await p.evaluate(() => {
  const btns = [...document.querySelectorAll('button')];
  if (!btns.some((b) => b.textContent.trim() === '← PROJECTS')) {
    btns.find((b) => b.textContent.trim() === '✦')?.click();
  }
});
await new Promise(r => setTimeout(r, 400));
await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '← PROJECTS').click());
await new Promise(r => setTimeout(r, 800));
await p.screenshot({ path: '/tmp/shot-topics.png' });
await b.close();
console.log('shots done');
