// Peer overlay: ephemeral cursor dots on their own canvas + rAF loop.
//
// Why separate: the ink loops in boardView idle-skip on `board.rev`, and a
// cursor move must never bump rev (full repaint per pointer-move) nor pass
// through updateScene/onChange (that would feed cursors into sync,
// snapshots, and the cell). Cursors live and die here: drawn from
// board.peers, pruned after 3s of silence, never persisted anywhere.
import type { Board } from './board.js';

const colorFor = (id: string): string => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 35%)`;
};

export const attachPeerOverlay = (
  container: HTMLElement,
  canvas: HTMLCanvasElement,
  board: Board,
): { destroy(): void } => {
  const over = document.createElement('canvas');
  Object.assign(over.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    zIndex: '5',
  });
  container.appendChild(over);
  const g = over.getContext('2d');
  let dead = false;
  let lastKey = '';
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
  const frame = () => {
    if (dead) return;
    requestAnimationFrame(frame);
    if (!g) return;
    const c = board.camera;
    // Repaint only when presence or camera moved; cursor silence costs zero.
    let key = `${c.scrollX}|${c.scrollY}|${c.zoom}|${over.clientWidth}x${over.clientHeight}`;
    const now = Date.now();
    const live: [string, { x: number; y: number; nick: string; at: number }][] = [];
    for (const [id, p] of board.peers) {
      if (now - p.at > 3000) continue;
      live.push([id, p]);
      key += `|${id.slice(0, 6)}:${Math.round(p.x)},${Math.round(p.y)}`;
    }
    if (key === lastKey) return;
    lastKey = key;
    over.width = Math.max(1, Math.floor(over.clientWidth * dpr()));
    over.height = Math.max(1, Math.floor(over.clientHeight * dpr()));
    g.setTransform(dpr() * c.zoom, 0, 0, dpr() * c.zoom, dpr() * c.scrollX * c.zoom, dpr() * c.scrollY * c.zoom);
    g.clearRect(-c.scrollX, -c.scrollY, over.width / dpr() / c.zoom, over.height / dpr() / c.zoom);
    for (const [id, p] of live) {
      const color = colorFor(id);
      g.fillStyle = color;
      g.beginPath();
      g.arc(p.x, p.y, 6 / c.zoom, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(p.x, p.y, 2.2 / c.zoom, 0, Math.PI * 2);
      g.fill();
      g.font = `${12 / c.zoom}px ui-monospace, monospace`;
      g.fillStyle = color;
      g.fillText(p.nick || id.slice(0, 6), p.x + 10 / c.zoom, p.y - 8 / c.zoom);
    }
    void canvas;
  };
  requestAnimationFrame(frame);
  return {
    destroy() {
      dead = true;
      over.remove();
    },
  };
};
