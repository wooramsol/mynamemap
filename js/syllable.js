// 자모 후보들 중에서 '한 음절 모양'으로 실제로 붙어 있는 조합 찾기
// (scripts/compose.mjs 의 전국 계산과 같은 기준. 지역 모드에서 브라우저로 돌림)
import { syllableBoxes } from './hangul.js';

const DEG = Math.PI / 180;
const LOOP = new Set(['ㅇ', 'ㅎ']);

/**
 * @param cands [{j,s,r,lat,lon,w,h,...}] 이 지역의 자모 후보
 * @param syl decompose() 결과 한 음절
 * @returns 상위 3곳 [{s, lat, lon, r, size, parts:[cand...]}]
 */
export function findSyllable(cands, syl, top = 3) {
  const parts = syllableBoxes(syl);
  const out = [];
  const anchors = cands.filter(c => c.j === parts[0][0] && c.s >= 25);
  for (const A of anchors) {
    const size = Math.max(A.w, A.h);
    const kx = 111320 * Math.cos(A.lat * DEG), ca = Math.cos(-A.r), sa = Math.sin(-A.r);
    const N = [];
    for (const B of cands) {
      if (B === A) continue;
      if (!LOOP.has(A.j) && !LOOP.has(B.j) && Math.abs(B.r - A.r) > 30 * DEG) continue;
      const dx = (B.lon - A.lon) * kx, dy = (B.lat - A.lat) * 110540;
      if (Math.hypot(dx, dy) > size * 4 + 30) continue;
      N.push({ B, u: dx * ca - dy * sa, y: -(dx * sa + dy * ca) });
    }
    const [sx, sy, sw, sh] = parts[0][1];
    const k = Math.min(sw / A.w, sh / A.h), cx = sx + sw / 2, cy = sy + sh / 2, S = 100 / k;
    const used = [A];
    let sumPf = 0, logQ = Math.log(A.s / 100), ok = true;
    for (let p = 1; p < parts.length && ok; p++) {
      const [j, [x, y, w, h]] = parts[p];
      const tu = (x + w / 2 - cx) / k, ty = (y + h / 2 - cy) / k, tw = w / k, th = h / k;
      let best = null;
      for (const n of N) {
        if (n.B.j !== j || used.includes(n.B)) continue;
        const d = Math.hypot(n.u - tu, n.y - ty) / S;
        if (d > 0.38) continue;
        const fitness = 1 - Math.abs(Math.log2(Math.min(tw / n.B.w, th / n.B.h))) / 1.6;
        const pf = (1 - d / 0.38) * fitness;
        if (pf > 0.1 && (!best || pf > best.pf)) best = { B: n.B, pf };
      }
      if (!best) ok = false;
      else { used.push(best.B); sumPf += best.pf; logQ += Math.log(best.B.s / 100); }
    }
    if (!ok) continue;
    const score = Math.round(100 * (parts.length > 1 ? sumPf / (parts.length - 1) : 1) * Math.exp(logQ / parts.length));
    if (score < 15) continue;
    const rec = { s: score, lat: A.lat, lon: A.lon, r: A.r, size: Math.round(S), parts: used };
    const dup = out.findIndex(o => Math.hypot((o.lat - rec.lat) * 110540, (o.lon - rec.lon) * 88000) < 300);
    if (dup >= 0) { if (out[dup].s < rec.s) out[dup] = rec; } else out.push(rec);
  }
  return out.sort((a, b) => b.s - a.s).slice(0, top);
}
