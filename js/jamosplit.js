// 찾은 음절 결과를 자모 자리별로 나누고, 자모끼리 실제로 떨어져 있는지 확인
// (앱과 전국 데이터 검사 스크립트가 함께 씀)
import { syllableBoxes } from './hangul.js';
import { strokeSegs } from './glyph.js';

const DEG = Math.PI / 180;
// 위경도 선들을 기준점·방향(r)으로 세운 미터 좌표(y 아래쪽)로
export function upright(lines, r, lat0, lon0) {
  const kx = 111320 * Math.cos(lat0 * DEG), c = Math.cos(-r), s = Math.sin(-r);
  return lines.map(l => l.map(([la, lo]) => { const x = (lo - lon0) * kx, y = (la - lat0) * 110540; return [x * c - y * s, -(x * s + y * c)]; }));
}
export const comboBoxes = syl => syl.single ? [[syl.single, [5, 5, 90, 90]]] : syllableBoxes(syl);

// 찾은 음절 결과 → 자리별 선 묶음 [{j, box, paths}] (paths: 미터 좌표)
export function splitCand(c, syl) {
  const boxes = comboBoxes(syl);
  const out = boxes.map(([j, box]) => ({ j, box, paths: [] }));
  const byPart = c.parts.length > 1 && c.parts.every(p => p.j && p.j !== syl.char);
  if (byPart) {
    // 자모 조합으로 찾은 결과: 조각마다 어느 자모인지 알고 있음
    const used = new Set(), left = [];
    for (const p of c.parts) {
      const k = out.findIndex((o, i) => !used.has(i) && o.j === p.j);
      if (k >= 0) { used.add(k); out[k].paths.push(...upright(p.g, c.r, c.lat, c.lon)); } else left.push(p);
    }
    for (const p of left) { // 나눠 찾은 조각(예: ㅈ = ㅡ + ㅅ)은 비어 있는 자리로
      const k = out.findIndex((o, i) => !used.has(i)); const t = out[k >= 0 ? k : out.length - 1];
      t.paths.push(...upright(p.g, c.r, c.lat, c.lon));
    }
  } else {
    // 음절 모양 비교로 찾은 결과: 선분마다 가장 가까운 자모 글꼴 뼈대로
    const tsegs = out.map(o => strokeSegs(o.j, o.box));
    const segs = upright(c.parts.flatMap(p => p.g), c.r, c.lat, c.lon);
    const k = 100 / c.size;
    for (const line of segs) for (let i = 1; i < line.length; i++) {
      const [x0, y0] = line[i - 1], [x1, y1] = line[i];
      const U = 50 + (x0 + x1) / 2 * k, V = 50 + (y0 + y1) / 2 * k;
      let best = 0, bd = Infinity;
      tsegs.forEach((T, bi) => {
        for (const [[ax, ay], [bx, by]] of T) {
          const d = ptSeg(U, V, ax, ay, bx, by);
          if (d < bd) { bd = d; best = bi; }
        }
      });
      out[best].paths.push([line[i - 1], line[i]]);
    }
  }
  return out;
}

function ptSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L2)) : 0;
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}
function segSeg(a, b, c, d) {
  // 두 선분 사이 최소 거리 (교차하면 0)
  const cr = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cr(a, b, c), d2 = cr(a, b, d), d3 = cr(c, d, a), d4 = cr(c, d, b);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return 0;
  return Math.min(ptSeg(a[0], a[1], c[0], c[1], d[0], d[1]), ptSeg(b[0], b[1], c[0], c[1], d[0], d[1]),
    ptSeg(c[0], c[1], a[0], a[1], b[0], b[1]), ptSeg(d[0], d[1], a[0], a[1], b[0], b[1]));
}

/** 자모 묶음들 사이의 가장 가까운 거리(m)와 글자 크기(m) */
export function jamoGap(groups) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const S = groups.map(g => g.paths.flatMap(p => p.slice(1).map((q, i) => [p[i], q])));
  for (const L of S) for (const [p, q] of L) for (const [x, y] of [p, q]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  let gap = Infinity;
  for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++)
    for (const [a, b] of S[i]) for (const [c, d] of S[j]) gap = Math.min(gap, segSeg(a, b, c, d));
  return { gap, size: Math.max(x1 - x0, y1 - y0) };
}

// 자모가 서로 길로 붙어 있지 않고 떨어져 있어야 한 글자로 또렷이 읽힘
export const MIN_GAP_RATIO = 0.04, MIN_GAP_M = 2;
export function jamoSeparated(c, syl) {
  const groups = splitCand(c, syl);
  if (groups.length < 2) return true;
  if (groups.some(g => !g.paths.length)) return false;
  const { gap, size } = jamoGap(groups);
  return gap >= Math.max(MIN_GAP_M, MIN_GAP_RATIO * size);
}
