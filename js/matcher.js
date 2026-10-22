// 도로 그래프에서 자모 모양 찾기
import { TEMPLATES } from './templates.js';

const DEG = Math.PI / 180;
const ROT_MAX = 40 * DEG;      // 글자가 기울어져도 되는 최대 각도
const TURN_MAX = 22 * DEG;     // 한 획 안에서 허용되는 꺾임
const DIR_TOL = 24 * DEG;      // 획 방향 허용 오차
const DIR_TOL_DIAG = 38 * DEG;
const MIN_SIZE = 15, MAX_SIZE = 450; // 글자 크기 (미터)

const norm = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const ang = v => Math.atan2(v[1], v[0]);

function other(G, e, nid) { return e.u === nid ? e.v : e.u; }
function vecBetween(G, a, b) { const A = G.nodes.get(a), B = G.nodes.get(b); return [B.x - A.x, B.y - A.y]; }

// 시작 노드에서 거의 곧게 이어지는 경로들을 모두 나열
function straightWalks(G, start, maxLen) {
  const out = [];
  const S = G.nodes.get(start);
  for (const eid of S.edges) {
    const e = G.edges[eid];
    const n1 = other(G, e, start);
    const rec = (cur, path, interior, len, lastDir) => {
      const C = G.nodes.get(cur);
      const vec = [C.x - S.x, C.y - S.y];
      out.push({ end: cur, edges: path.slice(), interior: interior.slice(), vec, len });
      if (path.length >= 8) return;
      for (const eid2 of C.edges) {
        if (path.includes(eid2)) continue;
        const e2 = G.edges[eid2];
        const n2 = other(G, e2, cur);
        if (n2 === start || interior.includes(n2)) continue;
        const d = vecBetween(G, cur, n2);
        if (Math.abs(norm(ang(d) - lastDir)) > TURN_MAX) continue;
        const total = [G.nodes.get(n2).x - S.x, G.nodes.get(n2).y - S.y];
        if (Math.abs(norm(ang(total) - ang(vec))) > TURN_MAX) continue;
        if (len + e2.len > maxLen) continue;
        path.push(eid2); interior.push(cur);
        rec(n2, path, interior, len + e2.len, ang(d));
        path.pop(); interior.pop();
      }
    };
    if (e.len <= maxLen) rec(n1, [eid], [], e.len, ang(vecBetween(G, start, n1)));
  }
  return out;
}

function prepare(tpl) {
  const ids = Object.keys(tpl.nodes);
  const P = {}; for (const k of ids) P[k] = [tpl.nodes[k][0], -tpl.nodes[k][1]]; // y 위쪽으로
  const deg = {}; for (const k of ids) deg[k] = 0;
  for (const [a, b] of tpl.edges) { deg[a]++; deg[b]++; }
  const start = ids.reduce((m, k) => (deg[k] > deg[m] ? k : m), ids[0]);
  // 한쪽 끝이 이미 정해진 순서로 획을 정렬
  const order = [], done = new Set([start]), left = tpl.edges.slice();
  while (left.length) {
    const i = left.findIndex(([a, b]) => done.has(a) || done.has(b));
    let [a, b] = left.splice(i, 1)[0];
    if (!done.has(a)) [a, b] = [b, a];
    order.push([a, b]); done.add(b);
  }
  return { ids, P, deg, start, order };
}

function evaluate(G, tpl, T, st) {
  const gp = {}; for (const k of T.ids) { const n = G.nodes.get(st.map[k]); gp[k] = [n.x, n.y]; }
  let best = null;
  for (let dr = -14; dr <= 14; dr += 2) {
    const r = st.r + dr * DEG;
    if (Math.abs(r) > ROT_MAX + 6 * DEG) continue;
    const c = Math.cos(-r), s = Math.sin(-r);
    const U = [], V = [], TX = [], TY = [];
    for (const k of T.ids) {
      const [x, y] = gp[k];
      U.push(x * c - y * s); V.push(x * s + y * c); TX.push(T.P[k][0]); TY.push(T.P[k][1]);
    }
    const fit = (A, B) => {
      const n = A.length, ma = A.reduce((p, q) => p + q, 0) / n, mb = B.reduce((p, q) => p + q, 0) / n;
      let sab = 0, saa = 0; for (let i = 0; i < n; i++) { sab += (A[i] - ma) * (B[i] - mb); saa += (A[i] - ma) ** 2; }
      return saa < 1e-9 ? { k: null, ma, mb } : { k: sab / saa, ma, mb };
    };
    const fx = fit(TX, U), fy = fit(TY, V);
    let sx = fx.k, sy = fy.k;
    if (sx != null && sx <= 0) continue; // 좌우 반전 금지 (ㅏ ≠ ㅓ)
    if (sy != null && sy <= 0) continue;
    if (sx == null) sx = sy; if (sy == null) sy = sx;
    if (sx == null) continue;
    if (fx.k != null && fy.k != null) { const asp = sx / sy; if (asp < 0.33 || asp > 3) continue; }
    let res = 0;
    for (let i = 0; i < U.length; i++) {
      const pu = fx.mb + sx * (TX[i] - fx.ma), pv = fy.mb + sy * (TY[i] - fy.ma);
      res += (U[i] - pu) ** 2 + (V[i] - pv) ** 2;
    }
    const extU = Math.max(...U) - Math.min(...U), extV = Math.max(...V) - Math.min(...V);
    const size = Math.max(extU, extV);
    const err = Math.sqrt(res / U.length) / Math.max(size, 1);
    if (!best || err < best.err) best = { err, r, size, sx, sy };
  }
  if (!best) return null;
  if (best.size < MIN_SIZE || best.size > MAX_SIZE) return null;
  if (tpl.line && best.size < 35) return null;

  const shape = Math.max(0, 1 - best.err / 0.16);
  if (shape <= 0) return null;

  // 깔끔함: 글자 바깥으로 뻗은 길이 적을수록 좋음
  const used = st.used;
  let pen = 0;
  const notes = [];
  for (const k of T.ids) {
    const n = G.nodes.get(st.map[k]);
    const extra = n.edges.filter(e => !used.has(e));
    if (T.deg[k] === 1) {
      // 획 끝인데 같은 방향으로 길이 계속 이어지면 큰 감점
      const stroke = st.strokeDir[k];
      const overrun = extra.some(eid => {
        const d = vecBetween(G, n.id, other(G, G.edges[eid], n.id));
        return Math.abs(norm(ang(d) - stroke)) < 30 * DEG;
      });
      if (overrun) { pen += 0.22; notes.push('overrun'); }
      pen += 0.1 * extra.length; // 획 끝은 막다른 길일수록 좋음
    } else pen += 0.06 * extra.length;
  }
  for (const nid of st.interior) pen += 0.035 * Math.max(0, G.nodes.get(nid).edges.length - 2);
  pen = Math.min(pen, 0.85);
  const score = Math.round(100 * shape * (1 - pen));
  return { score, shape: +shape.toFixed(3), r: best.r, size: Math.round(best.size), sx: best.sx, sy: best.sy };
}

function matchGraphTemplate(G, tpl, opts) {
  const T = prepare(tpl);
  const found = new Map();
  const deadline = performance.now() + (opts.timeBudgetMs ?? 4000);
  let steps = 0;

  for (const [gid, gnode] of G.nodes) {
    if (gnode.edges.length < T.deg[T.start]) continue;
    if (performance.now() > deadline) break;
    const st = { map: { [T.start]: gid }, mapped: new Set([gid]), used: new Set(), interior: [], r: null, sx: null, sy: null, strokeDir: {} };

    const rec = k => {
      if (++steps % 5000 === 0 && performance.now() > deadline) return;
      if (k === T.order.length) {
        const key = [...st.used].sort((a, b) => a - b).join(',');
        if (found.has(key)) return;
        const ev = evaluate(G, tpl, T, st);
        if (ev && ev.score >= (opts.minScore ?? 20)) found.set(key, { ...ev, edges: [...st.used], nodes: { ...st.map } });
        return;
      }
      const [a, b] = T.order[k];
      const tv = [T.P[b][0] - T.P[a][0], T.P[b][1] - T.P[a][1]];
      const tAng = ang(tv);
      const isH = Math.abs(tv[1]) < 0.2 * Math.hypot(...tv), isV = Math.abs(tv[0]) < 0.2 * Math.hypot(...tv);
      const tol = isH || isV ? DIR_TOL : DIR_TOL_DIAG;
      let maxLen = MAX_SIZE * 1.3;
      if (isH && st.sx) maxLen = Math.abs(tv[0]) * st.sx * 2.2;
      if (isV && st.sy) maxLen = Math.abs(tv[1]) * st.sy * 2.2;
      const bMapped = st.map[b];

      for (const w of straightWalks(G, st.map[a], maxLen)) {
        if (w.edges.some(e => st.used.has(e))) continue;
        if (w.interior.some(n => st.mapped.has(n))) continue;
        if (bMapped != null) { if (w.end !== bMapped) continue; }
        else {
          if (st.mapped.has(w.end)) continue;
          if (G.nodes.get(w.end).edges.length < T.deg[b]) continue;
        }
        const gAng = ang(w.vec);
        let r = st.r, setR = false;
        if (r == null) {
          r = norm(gAng - tAng);
          if (Math.abs(r) > ROT_MAX) continue;
          setR = true;
        } else if (Math.abs(norm(gAng - tAng - r)) > tol) continue;

        // 길이 비율 확인
        const c = Math.cos(-r), s = Math.sin(-r);
        const gx = Math.abs(w.vec[0] * c - w.vec[1] * s), gy = Math.abs(w.vec[0] * s + w.vec[1] * c);
        let sx = st.sx, sy = st.sy;
        if (isH) { const v = gx / Math.abs(tv[0]); if (sx && (v / sx < 0.5 || v / sx > 2)) continue; if (!sx) sx = v; }
        else if (isV) { const v = gy / Math.abs(tv[1]); if (sy && (v / sy < 0.5 || v / sy > 2)) continue; if (!sy) sy = v; }
        else if (sx && sy) {
          const pred = Math.hypot(tv[0] * sx, tv[1] * sy), L = Math.hypot(...w.vec);
          if (L / pred < 0.45 || L / pred > 2.2) continue;
        }
        if (sx && sy && (sx / sy < 0.33 || sx / sy > 3)) continue;

        // 상태 갱신
        const prev = { r: st.r, sx: st.sx, sy: st.sy };
        st.r = r; st.sx = sx; st.sy = sy;
        for (const e of w.edges) st.used.add(e);
        for (const n of w.interior) st.mapped.add(n);
        st.interior.push(...w.interior);
        const newB = bMapped == null;
        if (newB) { st.map[b] = w.end; st.mapped.add(w.end); }
        st.strokeDir[b] = gAng; st.strokeDir[a] = norm(gAng + Math.PI);

        rec(k + 1);

        if (newB) { delete st.map[b]; st.mapped.delete(w.end); }
        st.interior.splice(st.interior.length - w.interior.length, w.interior.length);
        for (const n of w.interior) st.mapped.delete(n);
        for (const e of w.edges) st.used.delete(e);
        Object.assign(st, prev);
        if (setR) st.r = null;
      }
    };
    rec(0);
  }
  return [...found.values()];
}

// 동그라미(ㅇ): 평면 그래프의 '면'을 찾아 원형도를 측정
function matchLoops(G) {
  const out = [];
  const half = new Map(); // nodeId -> [{eid, to, a, pts}]
  for (const e of G.edges) {
    const p = e.pts;
    const fwd = { eid: e.id, from: e.u, to: e.v, pts: p, a: ang([p[1][0] - p[0][0], p[1][1] - p[0][1]]) };
    const n = p.length;
    const rp = p.slice().reverse();
    const bwd = { eid: e.id, from: e.v, to: e.u, pts: rp, a: ang([rp[1][0] - rp[0][0], rp[1][1] - rp[0][1]]) };
    if (!half.has(e.u)) half.set(e.u, []); if (!half.has(e.v)) half.set(e.v, []);
    half.get(e.u).push(fwd); half.get(e.v).push(bwd);
    fwd.twin = bwd; bwd.twin = fwd;
  }
  for (const l of half.values()) l.sort((x, y) => x.a - y.a);
  const seen = new Set();
  const seenFaces = new Set();
  for (const list of half.values()) for (const h0 of list) {
    if (seen.has(h0)) continue;
    const face = [];
    let h = h0, guard = 0;
    do {
      seen.add(h); face.push(h);
      const L = half.get(h.to);
      const i = L.indexOf(h.twin);
      h = L[(i - 1 + L.length) % L.length];
    } while (h !== h0 && ++guard < 300);
    if (h !== h0 || face.length < 2) continue;

    const poly = [];
    for (const f of face) for (let i = 0; i < f.pts.length - 1; i++) poly.push(f.pts[i]);
    let A = 0, P = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      A += a[0] * b[1] - b[0] * a[1]; P += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    A = Math.abs(A) / 2;
    if (P < 50 || P > 1400 || A < 50) continue;
    const key = [...new Set(face.map(f => f.eid))].sort((a, b) => a - b).join(',');
    if (seenFaces.has(key)) continue;
    seenFaces.add(key);

    const C = 4 * Math.PI * A / (P * P);
    // 날카롭게 꺾이는 모서리 개수 (원은 0, 사각형은 4)
    const rs = [];
    for (const p of poly) if (!rs.length || Math.hypot(p[0] - rs[rs.length - 1][0], p[1] - rs[rs.length - 1][1]) > 4) rs.push(p);
    let sharp = 0;
    for (let i = 0; i < rs.length; i++) {
      const a = rs[(i - 1 + rs.length) % rs.length], b = rs[i], c = rs[(i + 1) % rs.length];
      const t = Math.abs(norm(ang([c[0] - b[0], c[1] - b[1]]) - ang([b[0] - a[0], b[1] - a[1]])));
      if (t > 55 * DEG) sharp++;
    }
    const nodesOn = new Set(face.map(f => f.from));
    let junction = 0; for (const n of nodesOn) junction += Math.max(0, G.nodes.get(n).edges.length - 2);
    const shape = Math.max(0, Math.min(1, (C - 0.6) / 0.33));
    const pen = Math.min(0.85, sharp * 0.14 + Math.max(0, junction - 1) * 0.05);
    const score = Math.round(100 * shape * (1 - pen));
    if (score < 20) continue;
    const size = Math.round(2 * Math.sqrt(A / Math.PI));
    if (size < MIN_SIZE || size > MAX_SIZE) continue;
    out.push({ score, shape: +shape.toFixed(3), r: 0, size, edges: [...new Set(face.map(f => f.eid))] });
  }
  return out;
}

// 점수 높은 순으로, 겹치는 후보는 하나만
function suppress(list, limit) {
  list.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const m of list) {
    const s = new Set(m.edges);
    const dup = kept.some(k => { let o = 0; for (const e of k.edges) if (s.has(e)) o++; return o / Math.min(k.edges.length, s.size) >= 0.5; });
    if (!dup) kept.push(m);
    if (kept.length >= limit) break;
  }
  return kept;
}

export function findJamo(G, jamo, opts = {}) {
  const tpl = TEMPLATES[jamo];
  if (!tpl) return [];
  const variants = Array.isArray(tpl) ? tpl : [tpl];
  const raw = variants.flatMap(v => (v.kind === 'loop' ? matchLoops(G) : matchGraphTemplate(G, v, opts)));
  return suppress(raw, opts.limit ?? 12).map(m => ({ ...m, jamo, approx: !!variants[0].approx }));
}
