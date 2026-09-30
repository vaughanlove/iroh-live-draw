// Pen test bench: pointer samples → Rust (PenStroke) → triangle mesh →
// Canvas2D. Stylus pressure passes through; mouse synthesizes from velocity
// (pressure -1). Coalesced events keep fast strokes dense.
import init, { PenStroke } from './pkg/pen.js';

const INK = [30 / 255, 70 / 255, 32 / 255, 1.0];
const canvas = document.getElementById('pad');
const ctx = canvas.getContext('2d');
const sizeEl = document.getElementById('size');
const readout = document.getElementById('readout');

let strokes = []; // finished: {mono, line+size} | {mono:false, verts, idx}
let live = null;  // active PenStroke
let dpr = 1;
// Committed-ink layer: finished strokes paint here ONCE; frames blit it.
let base = document.createElement('canvas');
let paintQueued = false;
let frameMs = 0;

function fit() {
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  for (const c of [canvas, base]) {
    c.width = Math.floor(innerWidth * dpr);
    c.height = Math.floor(innerHeight * dpr);
  }
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
  repaintBase();
  paint();
}
addEventListener('resize', fit);

function repaintBase() {
  const b = base.getContext('2d');
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.clearRect(0, 0, base.width, base.height);
  for (const s of strokes) {
    if (s.mono) drawStoredSharpieOn(b, s);
    else drawMeshOn(b, s.verts, s.idx);
  }
}

function drawMeshOn(g, verts, idx) {
  // Variable-width path: filled triangle mesh (exact pen geometry).
  if (idx.length < 3) return;
  g.beginPath();
  for (let i = 0; i < idx.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const o = idx[i + k] * 6;
      const x = verts[o] * dpr, y = verts[o + 1] * dpr;
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
  }
  g.fillStyle = '#1e4620';
  g.fill();
}
function drawMesh(verts, idx) { drawMeshOn(ctx, verts, idx); }

function drawSharpieOn(g, line, size) {
  // Sharpie path: ONE centerline stroke — no triangle seams, so overlaps
  // are pixel-identical mono ink.
  g.strokeStyle = '#1e4620';
  g.lineWidth = size * dpr;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (line.length < 4) {
    if (line.length === 2) {
      g.beginPath();
      g.arc(line[0] * dpr, line[1] * dpr, (size * dpr) / 2, 0, Math.PI * 2);
      g.fillStyle = '#1e4620';
      g.fill();
    }
    return;
  }
  g.beginPath();
  g.moveTo(line[0] * dpr, line[1] * dpr);
  for (let i = 2; i < line.length; i += 2) g.lineTo(line[i] * dpr, line[i + 1] * dpr);
  g.stroke();
}
function drawSharpie(stroke, size) {
  drawSharpieOn(ctx, stroke.centerline(), size);
}

function paint() {
  // Frame = blit the committed layer + the one live stroke. Finished ink
  // never repaints, so frame cost is O(live), not O(all).
  const t0 = performance.now();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(base, 0, 0);
  if (live) {
    if (document.getElementById('sharpie').checked) drawSharpie(live, parseFloat(sizeEl.value));
    else drawMesh(live.vertices(), live.indices());
  }
  frameMs = frameMs * 0.9 + (performance.now() - t0) * 0.1;
}

// Pointer moves paint at most once per frame (rAF coalescing).
function queuePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; paint(); });
}

function drawStoredSharpieOn(g, s) {
  drawSharpieOn(g, s.line, s.size);
}
function drawStoredSharpie(s) {
  drawStoredSharpieOn(ctx, s);
}

function info() {
  const n = live ? live.len() : 0;
  readout.textContent = `${strokes.length} strokes · live ${n} pts · ${frameMs.toFixed(1)}ms/fr`;
}

function pressureOf(e) {
  // Mouse has no pressure channel: mark unknown so Rust synthesizes.
  if (e.pointerType === 'mouse') return -1;
  return e.pressure > 0 ? e.pressure : -1;
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const mono = document.getElementById('sharpie').checked;
  live = new PenStroke(parseFloat(sizeEl.value), INK[0], INK[1], INK[2], INK[3], mono);
  live.push(e.clientX, e.clientY, pressureOf(e), e.timeStamp);
  info();
});

canvas.addEventListener('pointermove', (e) => {
  if (!live || !e.buttons) return;
  const evts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const c of evts) live.push(c.clientX, c.clientY, pressureOf(c), c.timeStamp);
  queuePaint();
  info();
});

function commit(e) {
  if (!live) return;
  const mono = document.getElementById('sharpie').checked;
  const size = parseFloat(sizeEl.value);
  const b = base.getContext('2d');
  if (mono) {
    const line = live.centerline();
    strokes.push({ mono: true, line, size });
    drawSharpieOn(b, line, size);
  } else {
    const verts = live.vertices(), idx = live.indices();
    strokes.push({ mono: false, verts, idx });
    drawMeshOn(b, verts, idx);
  }
  live.free();
  live = null;
  paint();
  info();
}
canvas.addEventListener('pointerup', commit);
canvas.addEventListener('pointercancel', () => { if (live) { live.free(); live = null; paint(); info(); } });

document.getElementById('clear').addEventListener('click', () => {
  strokes = [];
  base.getContext('2d').clearRect(0, 0, base.width, base.height);
  paint();
  info();
});

document.getElementById('iso').addEventListener('click', (e) => {
  document.body.classList.toggle('iso');
  e.target.textContent = document.body.classList.contains('iso') ? 'sq grid' : 'iso grid';
});

await init();
fit();
info();
