// Reproduce the meshFor cache thrash: 500 strokes against a 400-entry cap.
//
// The old provider evicted stale versions by scanning every cache key for an
// `id:` prefix on each miss. With more strokes than cap, every frame missed
// and ran that scan, so cost scaled as strokes x cache size. This measures
// old vs new shape on synthetic elements — no wasm, no canvas.
const N = 500;
const CAP = 400;

function makeEl(i, v) {
  return { id: `el${i}`, version: v, type: 'freedraw', points: [[0, 0], [1, 1]], pressures: [0.5, 0.5], x: 0, y: 0, strokeColor: '#1e4620' };
}

// --- OLD: scan-all-keys eviction, 400 cap.
function oldProvider(els) {
  const cache = new Map();
  let evictions = 0, scans = 0;
  const meshFor = (el) => {
    const key = `${el.id}:${el.version}`;
    const hit = cache.get(key);
    if (hit) return hit;
    for (const k of cache.keys()) {
      scans++;
      if (k.startsWith(el.id + ':') && k !== key) { cache.delete(k); evictions++; }
    }
    cache.set(key, { key });
    if (cache.size > CAP) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
    return cache.get(key);
  };
  return { meshFor, stats: () => ({ scans, evictions, size: cache.size }) };
}

// --- NEW: prevKey map, O(1) eviction, generous cap.
function newProvider(els) {
  const cache = new Map();
  const prevKey = new Map();
  let evictions = 0, scans = 0;
  const meshFor = (el) => {
    const key = `${el.id}:${el.version}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const stale = prevKey.get(el.id);
    if (stale !== undefined) { cache.delete(stale); prevKey.delete(el.id); evictions++; }
    cache.set(key, { key });
    prevKey.set(el.id, key);
    if (cache.size > 20000) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
    return cache.get(key);
  };
  return { meshFor, stats: () => ({ scans, evictions, size: cache.size }) };
}

const els = Array.from({ length: N }, (_, i) => makeEl(i, 1));

for (const [label, make] of [['OLD', oldProvider], ['NEW', newProvider]]) {
  const { meshFor, stats } = make(els);
  // One warm-up frame, then 10 pan frames. Real pan re-reads every element.
  for (let f = 0; f < 11; f++) for (const el of els) meshFor(el);
  const t0 = performance.now();
  for (let f = 0; f < 10; f++) for (const el of els) meshFor(el);
  const ms = (performance.now() - t0) / 10;
  const s = stats();
  console.log(
    `${label}: ${ms.toFixed(2)} ms/frame  scans=${s.scans} evictions=${s.evictions} cacheSize=${s.size}`,
  );
}
