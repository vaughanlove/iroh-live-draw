// Micro-benchmark: Canvas2D pan strategies at realistic board density.
//
// Reproduces the CPU-2D path (boardView.ts paintAll) against the offscreen
// blit cache, on synthetic strokes. Answers one question: on a pan, does
// re-stroking every stroke dominate, and does blitting beat it?
//
//   node bench-paint.mjs [strokes] [pointsPerStroke]
import puppeteer from 'puppeteer-core';

const STROKES = Number(process.argv[2] || 500);
const PTS = Number(process.argv[3] || 100);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1600;
const H = 900;
const DPR = 2;
const ZOOM = 1;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', `--user-data-dir=/tmp/bench-paint-${Date.now()}`],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: DPR });

const r = await page.evaluate(async (STROKES, PTS, W, H, DPR, ZOOM) => {
  const cv = document.createElement('canvas');
  cv.width = W * DPR;
  cv.height = H * DPR;
  document.body.appendChild(cv);
  const g = cv.getContext('2d');

  // Synthetic strokes: random walk, scene coords, spread over the viewport.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const strokes = [];
  for (let s = 0; s < STROKES; s++) {
    const pts = new Float64Array(PTS * 2);
    let x = rnd() * W;
    let y = rnd() * H;
    for (let i = 0; i < PTS; i++) {
      pts[i * 2] = x;
      pts[i * 2 + 1] = y;
      x += (rnd() - 0.5) * 24;
      y += (rnd() - 0.5) * 24;
    }
    strokes.push(pts);
  }
  const SIZE = 3;

  // --- A: current path — re-record + re-stroke every stroke, per frame.
  const paintPath = (scrollX) => {
    g.setTransform(DPR * ZOOM, 0, 0, DPR * ZOOM, DPR * scrollX * ZOOM, 0);
    g.clearRect(-scrollX, 0, cv.width / DPR / ZOOM, cv.height / DPR / ZOOM);
    g.strokeStyle = 'rgb(30,70,32)';
    g.lineWidth = SIZE;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const line of strokes) {
      g.beginPath();
      g.moveTo(line[0], line[1]);
      for (let i = 2; i < line.length; i += 2) g.lineTo(line[i], line[i + 1]);
      g.stroke();
    }
  };

  // --- B: blit cache — rasterize once per stroke, then translate.
  // Offscreen canvases hold the stroke at scene origin; pan moves them.
  const tiles = strokes.map((line) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < line.length; i += 2) {
      if (line[i] < minX) minX = line[i];
      if (line[i] > maxX) maxX = line[i];
      if (line[i + 1] < minY) minY = line[i + 1];
      if (line[i + 1] > maxY) maxY = line[i + 1];
    }
    const pad = SIZE * 2;
    const w = Math.ceil((maxX - minX + pad * 2) * DPR * ZOOM);
    const h = Math.ceil((maxY - minY + pad * 2) * DPR * ZOOM);
    const t = document.createElement('canvas');
    t.width = Math.max(1, w);
    t.height = Math.max(1, h);
    const tg = t.getContext('2d');
    tg.setTransform(DPR * ZOOM, 0, 0, DPR * ZOOM, -minX * DPR * ZOOM + pad * DPR * ZOOM, -minY * DPR * ZOOM + pad * DPR * ZOOM);
    tg.strokeStyle = 'rgb(30,70,32)';
    tg.lineWidth = SIZE;
    tg.lineCap = 'round';
    tg.lineJoin = 'round';
    tg.beginPath();
    tg.moveTo(line[0], line[1]);
    for (let i = 2; i < line.length; i += 2) tg.lineTo(line[i], line[i + 1]);
    tg.stroke();
    return { t, minX: minX - pad, minY: minY - pad };
  });

  const tileBytes = tiles.reduce((a, x) => a + x.t.width * x.t.height * 4, 0);

  const paintBlit = (scrollX) => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    const s = DPR * ZOOM;
    const ox = DPR * scrollX * ZOOM;
    for (const { t, minX, minY } of tiles) {
      g.drawImage(t, Math.round(minX * s + ox), Math.round(minY * s));
    }
  };

  // Warm both, then time N pans. A pan = one scroll step, same shape.
  const time = (fn, frames) => {
    for (let i = 0; i < 3; i++) fn(i * 4);
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) fn(i * 4);
    return (performance.now() - t0) / frames;
  };

  const FRAMES = 60;
  const pathMs = time(paintPath, FRAMES);
  const blitMs = time(paintBlit, FRAMES);

  // Zoom = cache invalidation for B, full re-record for A.
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) paintPath(i * 4);
  const pathMs10 = (performance.now() - t0) / 10;

  return {
    pathMs,
    blitMs,
    pathMs10,
    tileMB: tileBytes / 1e6,
    perTileKB: tileBytes / tiles.length / 1024,
    totalTiles: tiles.length,
  };
}, STROKES, PTS, W, H, DPR, ZOOM);

console.log(`strokes=${STROKES} pts=${PTS} canvas=${W}x${H}@${DPR}x zoom=${ZOOM}`);
console.log(`  re-stroke path : ${r.pathMs.toFixed(2)} ms/frame`);
console.log(`  blit cache     : ${r.blitMs.toFixed(2)} ms/frame`);
console.log(`  speedup        : ${(r.pathMs / r.blitMs).toFixed(2)}x`);
console.log(`  tile memory    : ${r.tileMB.toFixed(1)} MB total (${r.perTileKB.toFixed(1)} KB/stroke x ${r.totalTiles})`);
console.log(`  60fps budget   : 16.7 ms`);

await browser.close();
