// 전국 자모 후보 → 음절 단위 조합 + 자모별 전국 순위
// 사용: node scripts/compose.mjs data/cands.jsonl web-data/
// 결과: web-data/syl/<초성번호>.json, web-data/jamo.json
import fs from 'node:fs';
import readline from 'node:readline';
import { CHO, JUNG, JONG, syllableBoxes } from '../js/hangul.js';

const [src, outDir] = process.argv.slice(2);
const DEG = Math.PI / 180;
const ANCHOR_MIN = 40;       // 첫 자모(초성) 후보 최소 점수
const PART_MIN = 0.12;       // 자리 맞춤 최소 점수
const TOP_SYL = 3, TOP_JAMO = 20;
const LOOP = new Set(['ㅇ', 'ㅎ']);

// ── 1. 후보 읽기 (지오메트리는 나중에 필요한 것만) ─────────────
const C = [];
{
  const rl = readline.createInterface({ input: fs.createReadStream(src) });
  let i = 0;
  for await (const line of rl) {
    const o = JSON.parse(line);
    // ㅇ을 그대로 복사한 ㅎ은 점수를 낮춰서, 진짜 ㅎ(가로획+동그라미)이 있으면 그쪽이 이기게
    C.push({ i: i++, j: o.j, s: o.approx ? Math.round(o.s * 0.6) : o.s, r: o.r, lat: o.lat, lon: o.lon, w: Math.max(o.w, 4), h: Math.max(o.h, 4) });
  }
}
console.log('cands', C.length);

// 격자 색인 (약 1km)
const CELL = 0.01;
const grid = new Map();
const gk = (a, b) => a * 100000 + b;
for (const c of C) {
  const k = gk(Math.floor(c.lat / CELL), Math.floor(c.lon / CELL));
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(c);
}
function near(c, radiusM) {
  const dl = radiusM / 110540, dn = radiusM / (111320 * Math.cos(c.lat * DEG));
  const out = [];
  for (let a = Math.floor((c.lat - dl) / CELL); a <= Math.floor((c.lat + dl) / CELL); a++)
    for (let b = Math.floor((c.lon - dn) / CELL); b <= Math.floor((c.lon + dn) / CELL); b++) {
      const L = grid.get(gk(a, b)); if (L) for (const x of L) out.push(x);
    }
  return out;
}

// ── 1-2. 두 자모를 위아래로 붙여 만드는 자모: ㅈ = ㅡ + ㅅ, ㅎ = ㅡ + ㅇ ─────────
// (길에서 ㅈ 모양 교차로는 아주 드물어서, 가로 길 바로 아래 ㅅ 모양이 있으면 ㅈ으로 인정)
const SUB = new Map(); // 합성 후보 i -> [윗획 i,아래 i]
function synth(baseJ, newJ) {
  const bars = C.filter(c => c.j === 'ㅡ');
  if (!bars.length) return 0;
  let made = 0;
  for (const c of C.filter(x => x.j === baseJ && x.s >= 40)) {
    const ca = Math.cos(-c.r), sa = Math.sin(-c.r), kx = 111320 * Math.cos(c.lat * DEG);
    let bestT = null;
    for (const T of near(c, Math.max(c.w, c.h) * 1.5 + 20)) {
      if (T.j !== 'ㅡ' || Math.abs(T.r - c.r) > 25 * DEG && !LOOP.has(baseJ)) continue;
      const dx = (T.lon - c.lon) * kx, dy = (T.lat - c.lat) * 110540;
      const u = dx * ca - dy * sa, y = -(dx * sa + dy * ca);
      const top = -c.h / 2;
      if (y > top + 0.1 * c.h || y < top - 0.7 * c.h) continue;   // 바로 위에
      if (Math.abs(u) > 0.3 * c.w) continue;                     // 가운데 정렬
      const wr = T.w / c.w; if (wr < 0.6 || wr > 1.9) continue;   // 폭 비슷
      const f = (1 - Math.abs(u) / (0.3 * c.w)) * (1 - Math.abs(y - (top - 0.25 * c.h)) / (0.6 * c.h));
      if (!bestT || f > bestT.f) bestT = { T, f, u, y };
    }
    if (!bestT) continue;
    const { T, f, u, y } = bestT;
    const l = Math.min(-c.w / 2, u - T.w / 2), r = Math.max(c.w / 2, u + T.w / 2), t = Math.min(-c.h / 2, y - 2), b = c.h / 2;
    const cu = (l + r) / 2, cy = (t + b) / 2; // 세운 좌표에서의 새 중심 → 위경도
    const ci = Math.cos(c.r), si = Math.sin(c.r), vx = cu, vy = -cy;
    const ex = vx * ci - vy * si, ny = vx * si + vy * ci;
    const rec = { i: C.length, j: newJ, s: Math.round(Math.sqrt(c.s * T.s) * (0.6 + 0.3 * Math.max(0, f))), r: c.r,
      lat: c.lat + ny / 110540, lon: c.lon + ex / kx, w: r - l, h: b - t };
    SUB.set(rec.i, [T.i, c.i]);
    C.push(rec);
    const k = gk(Math.floor(rec.lat / CELL), Math.floor(rec.lon / CELL));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(rec);
    made++;
  }
  return made;
}
console.log('synth ㅈ', synth('ㅅ', 'ㅈ'), 'ㅎ', synth('ㅇ', 'ㅎ'));

// ── 2. 음절 목록: 첫 자모와 그 자리로 묶기 ──────────────────
const groups = new Map(); // `${jamo}|${slot}` -> [{code, parts}]
for (let code = 0; code < 11172; code++) {
  const s = { char: String.fromCharCode(0xAC00 + code), cho: CHO[Math.floor(code / 588)], jung: JUNG[Math.floor((code % 588) / 28)], jong: JONG[code % 28] };
  const parts = syllableBoxes(s);
  const key = `${parts[0][0]}|${parts[0][1].join(',')}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({ code, parts });
}
const groupsByJamo = new Map();
for (const [key, list] of groups) {
  const j = key.split('|')[0];
  if (!groupsByJamo.has(j)) groupsByJamo.set(j, []);
  groupsByJamo.get(j).push({ slot: list[0].parts[0][1], list });
}

// ── 3. 첫 자모를 기준으로 나머지 자리를 채워 보기 ──────────────
const best = new Map();    // code -> [{score, parts:[candIdx], ...}]  음절 모양 그대로
const cluster = new Map(); // code -> 같은 동네(수백 m 안)의 자모를 모은 것
function offer(code, rec, store = best) {
  let L = store.get(code);
  if (!L) store.set(code, L = []);
  // 같은 곳(500m 이내)의 결과는 하나만
  const dup = L.findIndex(x => Math.hypot((x.lat - rec.lat) * 110540, (x.lon - rec.lon) * 88000) < 500);
  if (dup >= 0) { if (L[dup].score >= rec.score) return; L.splice(dup, 1); }
  L.push(rec); L.sort((a, b) => b.score - a.score);
  if (L.length > TOP_SYL) L.length = TOP_SYL;
}

const t0 = Date.now();
let anchors = 0;
for (const A of C) {
  if (A.s < ANCHOR_MIN || !groupsByJamo.has(A.j)) continue;
  anchors++;
  const size = Math.max(A.w, A.h);
  const N = near(A, size * 4 + 30).filter(B => B !== A && (LOOP.has(A.j) || LOOP.has(B.j) || Math.abs(B.r - A.r) < 30 * DEG));
  if (!N.length) continue;
  // A의 방향으로 세운 좌표 (u 오른쪽, y 아래쪽, 미터)
  const ca = Math.cos(-A.r), sa = Math.sin(-A.r), kx = 111320 * Math.cos(A.lat * DEG);
  for (const B of N) {
    const dx = (B.lon - A.lon) * kx, dy = (B.lat - A.lat) * 110540;
    B._u = dx * ca - dy * sa; B._y = -(dx * sa + dy * ca);
  }
  // 같은 동네 조합용: 자모별로 가깝고 크기 비슷한 후보 상위 2개
  const near2 = new Map();
  for (const B of N) {
    const sz = Math.max(B.w, B.h), ratio = sz / size;
    if (ratio < 0.4 || ratio > 2.5) continue;
    const dist = Math.hypot(B._u, B._y);
    const q = (B.s / 100) * Math.max(0, 1 - dist / (size * 4 + 30)) * (1 - Math.abs(Math.log2(ratio)) / 2);
    if (q <= 0) continue;
    let L = near2.get(B.j); if (!L) near2.set(B.j, L = []);
    L.push({ B, q }); L.sort((x, y) => y.q - x.q); if (L.length > 2) L.length = 2;
  }
  for (const { slot, list } of groupsByJamo.get(A.j)) {
    const [sx, sy, sw, sh] = slot;
    const k = Math.min(sw / A.w, sh / A.h); // 단위/미터
    const cx = sx + sw / 2, cy = sy + sh / 2;
    const S = 100 / k;                       // 음절 한 변 (미터)
    const cache = new Map();
    const fit = (j, box, exclude) => {
      const key = j + box.join(',');
      let top = cache.get(key);
      if (!top) {
        const [x, y, w, h] = box;
        const tu = (x + w / 2 - cx) / k, ty = (y + h / 2 - cy) / k, tw = w / k, th = h / k;
        top = [];
        for (const B of N) {
          if (B.j !== j) continue;
          const d = Math.hypot(B._u - tu, B._y - ty) / S;
          if (d > 0.38) continue;
          const f = Math.min(tw / B.w, th / B.h);
          const fitness = 1 - Math.abs(Math.log2(f)) / 1.6;
          const pf = (1 - d / 0.38) * fitness;
          if (pf > PART_MIN) top.push({ B, pf });
        }
        top.sort((p, q) => q.pf - p.pf); top.length = Math.min(top.length, 3);
        cache.set(key, top);
      }
      // 같은 길을 두 번 쓰지 않기 (ㅎ 후보는 ㅇ과 같은 위치라 위치로도 비교)
      return top.find(t => !exclude.some(u => u === t.B || (Math.abs(u.lat - t.B.lat) < 2e-5 && Math.abs(u.lon - t.B.lon) < 2e-5)));
    };
    for (const { code, parts } of list) {
      {
        const cu = [A]; let lq = Math.log(A.s / 100), okc = true;
        for (let p = 1; p < parts.length; p++) {
          const L = near2.get(parts[p][0]);
          const t = L && L.find(x => !cu.some(u => u === x.B || (Math.abs(u.lat - x.B.lat) < 2e-5 && Math.abs(u.lon - x.B.lon) < 2e-5)));
          if (!t) { okc = false; break; }
          cu.push(t.B); lq += Math.log(Math.max(t.q, 0.01));
        }
        if (okc) {
          const sc = Math.round(100 * Math.exp(lq / parts.length) * 0.8);
          if (sc >= 10) offer(code, { score: sc, lat: A.lat, lon: A.lon, r: A.r, size: Math.round(size * 2.5), parts: cu.map(c => c.i) }, cluster);
        }
      }
      const used = [A];
      let sumPf = 0, logQ = Math.log(A.s / 100), ok = true;
      for (let p = 1; p < parts.length; p++) {
        const t = fit(parts[p][0], parts[p][1], used);
        if (!t) { ok = false; break; }
        used.push(t.B); sumPf += t.pf; logQ += Math.log(t.B.s / 100);
      }
      if (!ok) continue;
      const layout = sumPf / (parts.length - 1);
      const quality = Math.exp(logQ / parts.length);
      const score = Math.round(100 * layout * quality);
      if (score < 15) continue;
      offer(code, { score, lat: A.lat, lon: A.lon, r: A.r, size: Math.round(S), parts: used.map(c => c.i) });
    }
  }
}
console.log('anchors', anchors, 'syllables found', best.size, 'cluster', cluster.size, ((Date.now() - t0) / 1000).toFixed(0) + 's');

// ── 4. 자모별 전국 순위 ─────────────────────────────────────
const jamoTop = new Map();
for (const c of [...C].sort((a, b) => b.s - a.s)) {
  let L = jamoTop.get(c.j);
  if (!L) jamoTop.set(c.j, L = []);
  if (L.length >= TOP_JAMO) continue;
  if (L.some(x => Math.hypot((x.lat - c.lat) * 110540, (x.lon - c.lon) * 88000) < 2000)) continue; // 지역 다양하게
  L.push(c);
}

// ── 5. 필요한 후보의 지오메트리만 다시 읽기 ───────────────────
const need = new Set();
for (const [code, L] of cluster) if (best.has(code)) cluster.delete(code); // 통째로 찾은 음절은 조합 불필요
for (const L of best.values()) for (const r of L) for (const i of r.parts) need.add(i);
for (const L of cluster.values()) for (const r of L) for (const i of r.parts) need.add(i);
for (const L of jamoTop.values()) for (const c of L) need.add(c.i);
for (const i of [...need]) if (SUB.has(i)) for (const k of SUB.get(i)) need.add(k);
const geom = new Map();
{
  const rl = readline.createInterface({ input: fs.createReadStream(src) });
  let i = 0;
  for await (const line of rl) {
    if (need.has(i)) { const o = JSON.parse(line); geom.set(i, { j: o.j, s: o.s, r: o.r, lat: o.lat, lon: o.lon, w: o.w, h: o.h, g: o.geom }); }
    i++;
  }
}

for (const [i, [a, b]] of SUB) {
  if (!need.has(i)) continue;
  const c = C[i], A = geom.get(a), B = geom.get(b);
  geom.set(i, { j: c.j, s: c.s, r: c.r, lat: +c.lat.toFixed(6), lon: +c.lon.toFixed(6), w: Math.round(c.w), h: Math.round(c.h), g: [...A.g, ...B.g] });
}
fs.mkdirSync(`${outDir}/syl`, { recursive: true });
const shards = Array.from({ length: 19 }, () => ({}));
for (const [code, L] of best) {
  shards[Math.floor(code / 588)][String.fromCharCode(0xAC00 + code)] =
    L.map(r => ({ s: r.score, lat: r.lat, lon: r.lon, r: r.r, size: r.size, parts: r.parts.map(i => geom.get(i)) }));
}
for (const [code, L] of cluster) {
  shards[Math.floor(code / 588)][String.fromCharCode(0xAC00 + code)] =
    L.map(r => ({ k: 'c', s: r.score, lat: r.lat, lon: r.lon, r: r.r, size: r.size, parts: r.parts.map(i => geom.get(i)) }));
}
shards.forEach((sh, i) => fs.writeFileSync(`${outDir}/syl/${i}.json`, JSON.stringify(sh)));
const jout = {};
for (const [j, L] of jamoTop) jout[j] = L.map(c => geom.get(c.i));
fs.writeFileSync(`${outDir}/jamo.json`, JSON.stringify(jout));
fs.writeFileSync(`${outDir}/meta.json`, JSON.stringify({ built: new Date().toISOString().slice(0, 10), cands: C.length, syllables: best.size, clusters: cluster.size }));
console.log('written', best.size, 'syllables');
