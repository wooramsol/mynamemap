// 음절 전체를 하나의 모양으로 비교하는 엔진 (전국 스크립트와 지역 모드가 함께 씀)
// - 기준 자모(초성 후보)로 음절 틀(크기·방향)을 정하고
// - 틀 안의 실제 길을 30×30 격자에 그려, 음절 글꼴 뼈대와 겹쳐 본다
//   · 자모마다 획 위에 길이 있는지 (하나라도 비면 탈락)
//   · 글자 밖에 쓸데없는 길이 많지 않은지, 획 옆에 길이 겹겹이 있지 않은지
import { CHO, JUNG, JONG, syllableBoxes } from './hangul.js';
import { TEMPLATES } from './templates.js';

const GRID = 30, LO = -10, HI = 110, CELL = (HI - LO) / GRID; // 음절 좌표(0~100) 기준 격자
const SCALES = [0.82, 0.87, 0.92, 0.96, 1, 1.04, 1.09, 1.14, 1.2]; // 격자 반올림에 덜 민감하도록 촘촘히
export const ANCHOR_SKIP = new Set(['ㅡ', 'ㅣ']);
export const CONSONANTS = new Set(['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']);

// ── 글꼴 뼈대 ───────────────────────────────────────────────
const PAD = 0.12; // 자모 자리 안쪽 여백 (글꼴처럼 자모끼리 붙지 않게)
// 글씨체 변형 수 (ㅈ·ㅊ: 가로획+ㅅ / 손글씨 'ㄱ자 사선+다리', ㅎ: 꼭지 있음 / 없음)
const VARIANTS = { 'ㅈ': 2, 'ㅊ': 2, 'ㅎ': 2 };
// 자모 획을 자리 안쪽(여백 제외)에 꽉 차게 놓고, 선 하나짜리(ㅣ,ㅡ)는 가운데로
// 반환: 획 목록. 획 하나 = 선분 묶음 (동그라미는 선분 16개가 한 획)
function jamoStrokes(j, v = 0) {
  const raw = rawStrokes(j, v);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const g of raw) for (const seg of g) for (const [x, y] of seg) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const fx = t => x1 - x0 < 1e-6 ? 0.5 : PAD + (t - x0) / (x1 - x0) * (1 - 2 * PAD);
  const fy = t => y1 - y0 < 1e-6 ? 0.5 : PAD + (t - y0) / (y1 - y0) * (1 - 2 * PAD);
  return raw.map(g => g.map(seg => seg.map(([x, y]) => [fx(x), fy(y)])));
}
/** 자모 j의 뼈대 선분을 상자 [x,y,w,h](0~100 좌표) 안에 놓은 것 */
export function strokeSegs(j, [x, y, w, h], v = 0) {
  return jamoStrokes(j, v).flat().map(seg => seg.map(([u, t]) => [x + u * w, y + t * h]));
}
function rawStrokes(j, v = 0) {
  // 단위 상자(0~1) 안의 획 목록
  if (j === 'ㅇ') return [ellipse(0.5, 0.5, 0.45, 0.45)];
  if (j === 'ㅎ') {
    const body = [[[[0.12, 0.16], [0.88, 0.16]]], ellipse(0.5, 0.62, 0.32, 0.32)];
    return v === 0 ? [[[[0.5, 0], [0.5, 0.14]]], ...body] : body;
  }
  let t = TEMPLATES[j];
  if (Array.isArray(t)) t = t[Math.min(v, t.length - 1)];
  if (!t || !t.edges) return [];
  return t.edges.map(([a, b]) => [[t.nodes[a], t.nodes[b]]]);
}
function ellipse(cx, cy, rx, ry) {
  const out = [];
  for (let i = 0; i < 16; i++) {
    const a0 = i / 16 * 2 * Math.PI, a1 = (i + 1) / 16 * 2 * Math.PI;
    out.push([[cx + rx * Math.cos(a0), cy + ry * Math.sin(a0)], [cx + rx * Math.cos(a1), cy + ry * Math.sin(a1)]]);
  }
  return out;
}
function samplePoints(segs, step) {
  const pts = [];
  for (const [[x0, y0], [x1, y1]] of segs) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let i = 0; i <= n; i++) pts.push([x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]);
  }
  return pts;
}
const cellOf = v => Math.floor((v - LO) / CELL);

function distanceTransform(occ) {
  const INF = 1e9, d = new Float32Array(GRID * GRID).fill(INF);
  for (let i = 0; i < occ.length; i++) if (occ[i]) d[i] = 0;
  const D1 = 1, D2 = Math.SQRT2;
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
    const i = y * GRID + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + D1);
    if (y > 0) { v = Math.min(v, d[i - GRID] + D1); if (x > 0) v = Math.min(v, d[i - GRID - 1] + D2); if (x < GRID - 1) v = Math.min(v, d[i - GRID + 1] + D2); }
    d[i] = v;
  }
  for (let y = GRID - 1; y >= 0; y--) for (let x = GRID - 1; x >= 0; x--) {
    const i = y * GRID + x; let v = d[i];
    if (x < GRID - 1) v = Math.min(v, d[i + 1] + D1);
    if (y < GRID - 1) { v = Math.min(v, d[i + GRID] + D1); if (x < GRID - 1) v = Math.min(v, d[i + GRID + 1] + D2); if (x > 0) v = Math.min(v, d[i + GRID - 1] + D2); }
    d[i] = v;
  }
  return d;
}

// 음절마다: 자모별 획 점(격자 칸), 뼈대 거리 지도
/** @param only 이 음절들만 (Set, 없으면 전부) */
export function buildSyllableTemplates(only, skip = ANCHOR_SKIP) {
  // 기준 자모는 음절의 어느 자리든 될 수 있다 (예: '정'은 받침 ㅇ이나 ㅓ로도 찾음). 단 ㅡ·ㅣ는 너무 흔해서 제외
  const groups = new Map(); // `${기준 자모}|${자리}` -> {slot, list:[{char, parts:[cells[]], tdt}]}
  for (let code = 0; code < 11172; code++) {
    const char = String.fromCharCode(0xAC00 + code);
    if (only && !only.has(char)) continue;
    const s = { char, cho: CHO[Math.floor(code / 588)], jung: JUNG[Math.floor((code % 588) / 28)], jong: JONG[code % 28] };
    addTemplate(groups, char, syllableBoxes(s), skip);
  }
  return groupByJamo(groups);
}

/**
 * 자모 하나(쌍자음·겹모음 포함)를 글자 상자 전체에 크게 그린 틀
 * @param layouts { 이름: [[구성 자모, [x,y,w,h]], ...] } (0~100 상자 안 자리)
 */
export function buildJamoTemplates(layouts, skip = new Set()) {
  const groups = new Map();
  for (const [name, boxes] of Object.entries(layouts)) addTemplate(groups, name, boxes, skip);
  return groupByJamo(groups);
}

function addTemplate(groups, char, boxes, skip) {
  {
    // 획(선분) 단위로 칸을 모은다: 획 하나라도 길이 없으면 그 글자가 아님 (예: 가로줄 셋 '≡'은 'ㄷ+ㅡ'가 아님)
    // 글씨체 변형 조합마다 따로 비교 (예: '정'의 ㅈ을 두 가지 모양으로)
    let combos = [[]];
    for (const [j] of boxes) combos = combos.flatMap(c => Array.from({ length: VARIANTS[j] || 1 }, (_, v) => [...c, v]));
    for (const combo of combos) {
    const occ = new Uint8Array(GRID * GRID);
    // 획 단위로 칸을 모은다: 획 하나라도 길이 없으면 그 글자가 아님 (예: 가로줄 셋 '≡'은 'ㄷ+ㅡ'가 아님)
    const parts = [];
    boxes.forEach(([j, [x, y, w, h]], pi) => {
      for (const g of jamoStrokes(j, combo[pi])) {
        const segs = g.map(seg => seg.map(([u, v]) => [x + u * w, y + v * h]));
        const cells = [];
        for (const [px, py] of samplePoints(segs, 1.5)) {
          const cx = cellOf(px), cy = cellOf(py);
          if (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) continue;
          cells.push(cy * GRID + cx); occ[cy * GRID + cx] = 1;
        }
        const u = Int16Array.from(new Set(cells));
        if (u.length) parts.push(u);
      }
    });
    const rec = { char, parts, tdt: distanceTransform(occ), tcount: occ.reduce((a, b) => a + b, 0) };
    const seen = new Set();
    for (const [j, slot] of boxes) {
      if (skip.has(j)) continue;
      const key = `${j}|${slot.join(',')}`;
      if (seen.has(key)) continue; seen.add(key);
      if (!groups.has(key)) groups.set(key, { slot, list: [] });
      groups.get(key).list.push(rec);
    }
    }
  }
}

function groupByJamo(groups) {
  const byJamo = new Map();
  for (const [key, g] of groups) {
    const j = key.split('|')[0];
    if (!byJamo.has(j)) byJamo.set(j, []);
    byJamo.get(j).push(g);
  }
  return byJamo;
}


/**
 * @param segs [[ [x,y], [x,y] ], ...] 미터 좌표 선분 (proj.fwd 기준)
 * @param proj makeProjection 결과
 * @param anchors 자모 후보 [{j,s,r,lat,lon,w,h}]
 * @param T buildSyllableTemplates 결과
 * @returns Map 음절 -> 상위 결과 [{s,lat,lon,r,size,g}]
 */
export function matchGlyphs(segs, proj, anchors, T, { keep = 2, minScore = 25, minPartCov = 0.5, maxClutter = 0.3, maxInk = 2.2 } = {}) {
  const KEEP_PER_TILE = keep, MIN_SCORE = minScore;
  const SH = 25, hash = new Map();
  segs.forEach((sg, i) => {
    const x0 = Math.floor(Math.min(sg[0][0], sg[1][0]) / SH), x1 = Math.floor(Math.max(sg[0][0], sg[1][0]) / SH);
    const y0 = Math.floor(Math.min(sg[0][1], sg[1][1]) / SH), y1 = Math.floor(Math.max(sg[0][1], sg[1][1]) / SH);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = x * 100003 + y; if (!hash.has(k)) hash.set(k, []); hash.get(k).push(i); }
  });
  const query = (cx, cy, rad) => {
    const out = new Set();
    for (let x = Math.floor((cx - rad) / SH); x <= Math.floor((cx + rad) / SH); x++)
      for (let y = Math.floor((cy - rad) / SH); y <= Math.floor((cy + rad) / SH); y++) { const L = hash.get(x * 100003 + y); if (L) for (const i of L) out.add(i); }
    return out;
  };

  const best = new Map(); // char -> [rec]
  const occ = new Uint8Array(GRID * GRID);
  for (const A of anchors) {
    const groups = T.get(A.j);
    if (!groups) continue;
    const [ax, ay] = proj.fwd(A.lat, A.lon);
    const c = Math.cos(-A.r), s = Math.sin(-A.r), ci = Math.cos(A.r), si = Math.sin(A.r);
    for (const { slot, list: syls } of groups) {
      const [sx, sy, sw, sh] = slot;
      const k0 = (1 - 2 * PAD) * Math.min(sw / A.w, sh / A.h); // 기준 자모를 자리 안쪽에 맞춤
      for (const f of SCALES) {
        const k = k0 * f, cx = sx + sw / 2, cy = sy + sh / 2;
        // 음절 상자 중심(50,50)의 실제 위치
        const mu = (50 - cx) / k, my = (50 - cy) / k;
        const wx = ax + mu * ci - (-my) * si, wy = ay + mu * si + (-my) * ci;
        const rad = 75 / k;
        if (rad > 600) continue;
        occ.fill(0);
        const toXY = (px, py) => { const dx = px - ax, dy = py - ay; const u = dx * c - dy * s, v = dx * s + dy * c; return [u * k + cx, -v * k + cy]; };
        const near = query(wx, wy, rad);
        for (const i of near) {
          const [p, q] = segs[i];
          const [X0, Y0] = toXY(p[0], p[1]), [X1, Y1] = toXY(q[0], q[1]);
          const n = Math.max(1, Math.ceil(Math.hypot(X1 - X0, Y1 - Y0) / 1));
          for (let t = 0; t <= n; t++) {
            const X = X0 + (X1 - X0) * t / n, Y = Y0 + (Y1 - Y0) * t / n;
            const gx = cellOf(X), gy = cellOf(Y);
            if (gx >= 0 && gy >= 0 && gx < GRID && gy < GRID) occ[gy * GRID + gx] = 1;
          }
        }
        // 글자 상자(0~100) 안에 길이 너무 적거나 빽빽하면 건너뜀
        let inside = 0;
        const lo = cellOf(0), hi = cellOf(100);
        for (let y = lo; y <= hi; y++) for (let x = lo; x <= hi; x++) inside += occ[y * GRID + x];
        if (inside < 15 || inside > 0.45 * (hi - lo + 1) ** 2) continue;
        const rdt = distanceTransform(occ);
        for (const syl of syls) {
          // 자모마다 획 위에 길이 있는지
          let sum = 0, cnt = 0, minPart = 1;
          for (const cells of syl.parts) {
            let ps = 0;
            for (const ce of cells) ps += Math.max(0, 1 - rdt[ce] / 1.6);
            const pc = cells.length ? ps / cells.length : 0;
            minPart = Math.min(minPart, pc); sum += ps; cnt += cells.length;
          }
          if (minPart < minPartCov) continue;
          const cov = sum / cnt;
          // 글자 밖의 길
          let clutter = 0;
          for (let y = lo; y <= hi; y++) for (let x = lo; x <= hi; x++) { const i = y * GRID + x; if (occ[i] && syl.tdt[i] > 2) clutter++; }
          const clut = clutter / inside;
          if (clut > maxClutter) continue; // 글자 밖 길이 많으면 글자로 안 읽힘
          const ink = inside / syl.tcount;  // 글자 획보다 길이 훨씬 많으면(획 옆에 길이 겹겹이) 지저분함
          if (ink > maxInk) continue;
          const score = Math.round(100 * Math.sqrt(cov * minPart) * Math.pow(1 - clut, 3) * Math.min(1, 1.5 / ink) * Math.pow(A.s / 100, 0.25));
          if (score < MIN_SCORE) continue;
          let L = best.get(syl.char);
          if (L && L.length >= KEEP_PER_TILE && L[L.length - 1].s >= score) continue;
          // 지오메트리: 글자 획 근처(1칸 이내)의 길만
          const g = [];
          for (const i of near) {
            const [p, q] = segs[i];
            const [X0, Y0] = toXY(p[0], p[1]), [X1, Y1] = toXY(q[0], q[1]);
            // 글자 상자(-5~105) 밖으로 길게 뻗은 길은 상자 안 부분만 남김 (통째로 버리면 획이 빠짐)
            let t0 = 0, t1 = 1;
            const dX = X1 - X0, dY = Y1 - Y0;
            for (const [pp, qq] of [[-dX, X0 + 5], [dX, 105 - X0], [-dY, Y0 + 5], [dY, 105 - Y0]]) {
              if (Math.abs(pp) < 1e-9) { if (qq < 0) { t0 = 1; t1 = 0; } continue; }
              const t = qq / pp;
              if (pp < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
            }
            if (t1 - t0 < 1e-6) continue;
            const mX = X0 + dX * (t0 + t1) / 2, mY = Y0 + dY * (t0 + t1) / 2;
            const mx = cellOf(mX), myc = cellOf(mY);
            if (mx < 0 || myc < 0 || mx >= GRID || myc >= GRID || syl.tdt[myc * GRID + mx] > 1.5) continue;
            const a = [p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0], b = [p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1];
            g.push([a, b].map(([x, y]) => proj.inv(x, y).map(v => +v.toFixed(6))));
          }
          const [clat, clon] = proj.inv(wx, wy);
          const rec = { s: score, lat: +clat.toFixed(6), lon: +clon.toFixed(6), r: +A.r.toFixed(3), size: Math.round(100 / k), g };
          if (!L) best.set(syl.char, L = []);
          const dup = L.findIndex(x => Math.hypot((x.lat - rec.lat) * 110540, (x.lon - rec.lon) * 88000) < 150);
          if (dup >= 0) { if (L[dup].s < rec.s) L[dup] = rec; } else L.push(rec);
          L.sort((p, q) => q.s - p.s); if (L.length > KEEP_PER_TILE) L.length = KEEP_PER_TILE;
        }
      }
    }
  }
  return best;
}

