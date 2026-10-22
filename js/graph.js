// Overpass(OSM) 도로 데이터 → 단순화된 도로 그래프
// 노드: 교차로, 막다른 길 끝, 꺾이는 지점 / 엣지: 거의 직선인 도로 조각

export function makeProjection(lat0, lon0) {
  const kx = Math.cos(lat0 * Math.PI / 180) * 111320, ky = 110540;
  return {
    fwd: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    inv: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

const ekey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L;
}

// 폴리라인을 거의 직선인 조각들로 나눈다 (Douglas–Peucker 방식). 분할 인덱스 반환
function splitStraight(pts, i0, i1, out) {
  if (i1 - i0 < 2) return;
  const a = pts[i0], b = pts[i1];
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let best = -1, bi = -1;
  for (let i = i0 + 1; i < i1; i++) {
    const d = chord < 1e-6 ? Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]) : perpDist(pts[i], a, b);
    if (d > best) { best = d; bi = i; }
  }
  if (chord < 1e-6 || best > Math.max(3, 0.1 * chord)) {
    splitStraight(pts, i0, bi, out);
    out.push(bi);
    splitStraight(pts, bi, i1, out);
  }
}

/**
 * @param osm Overpass JSON ({elements:[...]})
 * @returns {nodes: Map<id,{id,x,y,lat,lon,edges:number[]}>, edges: {id,u,v,pts,ll,len}[], proj}
 */
export function buildGraph(osm, center) {
  const raw = new Map();
  const ways = [];
  for (const el of osm.elements) {
    if (el.type === 'node') raw.set(el.id, el);
    else if (el.type === 'way' && el.nodes && el.nodes.length > 1) ways.push(el.nodes);
  }
  let lat0 = center?.[0], lon0 = center?.[1];
  if (lat0 == null) {
    let s = 0, t = 0, n = 0;
    for (const v of raw.values()) { s += v.lat; t += v.lon; n++; }
    lat0 = s / n; lon0 = t / n;
  }
  const proj = makeProjection(lat0, lon0);

  // 원본 인접 리스트
  const adj = new Map();
  const link = (a, b) => {
    if (a === b || !raw.has(a) || !raw.has(b)) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b); adj.get(b).add(a);
  };
  for (const w of ways) for (let i = 1; i < w.length; i++) link(w[i - 1], w[i]);

  const xy = new Map();
  for (const id of adj.keys()) { const n = raw.get(id); xy.set(id, proj.fwd(n.lat, n.lon)); }

  const isKey = new Set();
  for (const [id, s] of adj) if (s.size !== 2) isKey.add(id);

  const visited = new Set();
  const chains = [];
  const trace = (start, next) => {
    const ids = [start, next];
    visited.add(ekey(start, next));
    let prev = start, cur = next;
    while (!isKey.has(cur)) {
      let nxt = null;
      for (const n of adj.get(cur)) if (n !== prev) { nxt = n; break; }
      if (nxt == null || visited.has(ekey(cur, nxt))) break;
      visited.add(ekey(cur, nxt));
      ids.push(nxt); prev = cur; cur = nxt;
    }
    chains.push(ids);
  };
  for (const k of isKey) for (const n of adj.get(k)) if (!visited.has(ekey(k, n))) trace(k, n);
  // 교차로 없이 혼자 닫힌 고리 (예: 단지 안 순환로)
  for (const [id, s] of adj) {
    for (const n of s) {
      if (!visited.has(ekey(id, n))) { isKey.add(id); trace(id, n); }
    }
  }

  const nodes = new Map();
  const edges = [];
  const getNode = id => {
    if (!nodes.has(id)) {
      const [x, y] = xy.get(id); const r = raw.get(id);
      nodes.set(id, { id, x, y, lat: r.lat, lon: r.lon, edges: [] });
    }
    return nodes.get(id);
  };
  for (const ids of chains) {
    const pts = ids.map(i => xy.get(i));
    const cuts = [];
    splitStraight(pts, 0, pts.length - 1, cuts);
    const bounds = [0, ...cuts, pts.length - 1];
    for (let k = 1; k < bounds.length; k++) {
      const i0 = bounds[k - 1], i1 = bounds[k];
      if (i1 <= i0) continue;
      const seg = ids.slice(i0, i1 + 1);
      const u = getNode(seg[0]), v = getNode(seg[seg.length - 1]);
      if (u === v) continue;
      const p = seg.map(i => xy.get(i));
      let len = 0;
      for (let i = 1; i < p.length; i++) len += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      const e = { id: edges.length, u: u.id, v: v.id, pts: p, ll: seg.map(i => [raw.get(i).lat, raw.get(i).lon]), len };
      edges.push(e);
      u.edges.push(e.id); v.edges.push(e.id);
    }
  }
  return { nodes, edges, proj };
}
