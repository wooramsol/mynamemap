// 지도 타일(벡터 타일, OpenFreeMap)에서 길 선을 읽어 Overpass와 같은 모양({elements})으로 돌려줌
// Overpass 서버가 붐빌 때가 많아서, 늘 빠르게 받을 수 있는 타일을 먼저 씀
const TILEJSON = 'https://tiles.openfreemap.org/planet';
const Z = 14;
// OpenMapTiles 'transportation' 레이어
const ROAD = new Set(['primary', 'secondary', 'tertiary', 'minor', 'service', 'primary_construction']);
const FOOT = new Set(['path', 'track']);
const SKIP_SUB = new Set(['steps', 'platform', 'corridor', 'elevator']);

// ── 아주 작은 protobuf 읽개 ──
function reader(buf) {
  let p = 0;
  const varint = () => { let r = 0, s = 0, b; do { b = buf[p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  const skip = w => { if (w === 0) varint(); else if (w === 1) p += 8; else if (w === 2) p += varint(); else if (w === 5) p += 4; };
  const sub = () => { const n = varint(); const s = buf.subarray(p, p + n); p += n; return s; };
  const fields = function* () { while (p < buf.length) { const t = varint(); yield [t >>> 3, t & 7]; } };
  return { varint, skip, sub, fields, get pos() { return p; } };
}
const td = new TextDecoder();
function packed(b) { const r = reader(b), out = []; while (r.pos < b.length) out.push(r.varint()); return out; }

function decodeValue(b) {
  const r = reader(b);
  for (const [f, w] of r.fields()) {
    if (f === 1) return td.decode(r.sub());
    r.skip(w);
  }
  return null;
}
function decodeLayer(b) {
  const r = reader(b);
  const L = { name: '', keys: [], values: [], extent: 4096, features: [] };
  for (const [f, w] of r.fields()) {
    if (f === 1) L.name = td.decode(r.sub());
    else if (f === 2) L.features.push(r.sub());
    else if (f === 3) L.keys.push(td.decode(r.sub()));
    else if (f === 4) L.values.push(decodeValue(r.sub()));
    else if (f === 5) L.extent = r.varint();
    else r.skip(w);
  }
  return L;
}
function decodeFeature(b) {
  const r = reader(b);
  const F = { tags: [], type: 0, geom: [] };
  for (const [f, w] of r.fields()) {
    if (f === 2) F.tags = packed(r.sub());
    else if (f === 3) F.type = r.varint();
    else if (f === 4) F.geom = packed(r.sub());
    else r.skip(w);
  }
  return F;
}
// 선 도형 → 타일 좌표 선 목록
function lines(geom) {
  const out = []; let x = 0, y = 0, cur = null, i = 0;
  while (i < geom.length) {
    const c = geom[i++], cmd = c & 7, n = c >> 3;
    for (let k = 0; k < n; k++) {
      if (cmd === 7) continue;
      const dx = geom[i++], dy = geom[i++];
      x += (dx >> 1) ^ (-(dx & 1)); y += (dy >> 1) ^ (-(dy & 1));
      if (cmd === 1) { cur = [[x, y]]; out.push(cur); } else cur.push([x, y]);
    }
  }
  return out;
}
// 타일 안쪽(0~extent)만 남기기 (이웃 타일과 겹치는 여백 제거)
function clip(line, E) {
  const out = []; let cur = null;
  for (let i = 1; i < line.length; i++) {
    let [x0, y0] = line[i - 1], [x1, y1] = line[i];
    let t0 = 0, t1 = 1; const dx = x1 - x0, dy = y1 - y0;
    let ok = true;
    for (const [p, q] of [[-dx, x0], [dx, E - x0], [-dy, y0], [dy, E - y0]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const t = q / p; if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    if (!ok || t1 < t0) { cur = null; continue; }
    const a = [x0 + dx * t0, y0 + dy * t0], b = [x0 + dx * t1, y0 + dy * t1];
    if (!cur || cur[cur.length - 1][0] !== a[0] || cur[cur.length - 1][1] !== a[1]) { cur = [a]; out.push(cur); }
    cur.push(b);
    if (t1 < 1) cur = null;
  }
  return out.filter(l => l.length > 1);
}

let tileUrl = null;
async function tileTemplate() {
  if (!tileUrl) tileUrl = fetch(TILEJSON).then(r => r.json()).then(j => j.tiles[0]);
  return tileUrl;
}
const lon2x = (lon, n) => (lon + 180) / 360 * n;
const lat2y = (lat, n) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n;

/** bounds(s,w,n,e) 안의 길 → { elements: [...nodes, ...ways] } (Overpass 'out skel' 과 같은 모양) */
export async function fetchRoadsFromTiles([s, w, n, e], foot, signal) {
  const tpl = await tileTemplate();
  const N = 2 ** Z;
  const x0 = Math.floor(lon2x(w, N)), x1 = Math.floor(lon2x(e, N)), y0 = Math.floor(lat2y(n, N)), y1 = Math.floor(lat2y(s, N));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 30) throw new Error('타일이 너무 많음');
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);
  const nodes = new Map(), ways = [];
  const mLat = (n - s) * 0.1, mLon = (e - w) * 0.1;
  const idOf = (lat, lon) => {
    const k = `${Math.round(lat * 2e5)},${Math.round(lon * 2e5)}`; // 약 0.5m 안이면 같은 점 (교차로·타일 경계 잇기)
    let id = nodes.get(k);
    if (!id) { id = { type: 'node', id: nodes.size + 1, lat, lon }; nodes.set(k, id); }
    return id.id;
  };
  await Promise.all(jobs.map(async ([x, y]) => {
    const r = await fetch(tpl.replace('{z}', Z).replace('{x}', x).replace('{y}', y), { signal });
    if (!r.ok) throw new Error('tile ' + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    const rt = reader(buf);
    for (const [f, wt] of rt.fields()) {
      if (f !== 3) { rt.skip(wt); continue; }
      const L = decodeLayer(rt.sub());
      if (L.name !== 'transportation') continue;
      for (const fb of L.features) {
        const F = decodeFeature(fb);
        if (F.type !== 2) continue;
        const tag = {};
        for (let i = 0; i < F.tags.length; i += 2) tag[L.keys[F.tags[i]]] = L.values[F.tags[i + 1]];
        if (!(ROAD.has(tag.class) || (foot && FOOT.has(tag.class)))) continue;
        if (SKIP_SUB.has(tag.subclass)) continue;
        for (const line of lines(F.geom)) for (const part of clip(line, L.extent)) {
          const ids = part.map(([px, py]) => {
            const lon = (x + px / L.extent) / N * 360 - 180;
            const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + py / L.extent) / N))) * 180 / Math.PI;
            return idOf(lat, lon);
          });
          const dedup = ids.filter((v, i) => i === 0 || v !== ids[i - 1]);
          // 보는 범위(조금 넉넉히) 밖의 길은 버림 (타일이 범위보다 넓어서)
          const inBox = part.some(([px, py]) => {
            const lon = (x + px / L.extent) / N * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + py / L.extent) / N))) * 180 / Math.PI;
            return lat > s - mLat && lat < n + mLat && lon > w - mLon && lon < e + mLon;
          });
          if (!inBox) continue;
          if (dedup.length > 1) ways.push({ type: 'way', nodes: dedup });
        }
      }
    }
  }));
  const nodeList = [...nodes.values()];
  snapTees(nodeList, ways);
  return { elements: [...nodeList, ...ways] };
}

// 타일 길은 단순화돼 있어서, 골목 끝이 큰길 '중간'에 닿는 T자 교차로가 끊겨 있곤 함.
// 끝점이 다른 길 선분에서 SNAP m 안이면 그 선분에 끝점을 끼워 넣어 잇는다.
const SNAP = 3;
function snapTees(nodeList, ways) {
  const byId = new Map(nodeList.map(nd => [nd.id, nd]));
  if (!nodeList.length) return;
  const lat0 = nodeList[0].lat, kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const xy = id => { const nd = byId.get(id); return [nd.lon * kx, nd.lat * ky]; };
  const count = new Map();
  for (const w of ways) for (const id of w.nodes) count.set(id, (count.get(id) || 0) + 1);
  const G = 30, grid = new Map();
  ways.forEach((w, wi) => {
    for (let i = 1; i < w.nodes.length; i++) {
      const [x0, y0] = xy(w.nodes[i - 1]), [x1, y1] = xy(w.nodes[i]);
      for (let gx = Math.floor(Math.min(x0, x1) / G); gx <= Math.floor(Math.max(x0, x1) / G); gx++)
        for (let gy = Math.floor(Math.min(y0, y1) / G); gy <= Math.floor(Math.max(y0, y1) / G); gy++) {
          const k = gx + ',' + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push([wi, i]);
        }
    }
  });
  const inserts = new Map(); // wi -> [[i, t, id]]
  ways.forEach((w, wi) => {
    for (const id of [w.nodes[0], w.nodes[w.nodes.length - 1]]) {
      if (count.get(id) > 1) continue;
      const [px, py] = xy(id);
      let best = null;
      for (const [wj, i] of grid.get(Math.floor(px / G) + ',' + Math.floor(py / G)) || []) {
        if (wj === wi) continue;
        const [ax, ay] = xy(ways[wj].nodes[i - 1]), [bx, by] = xy(ways[wj].nodes[i]);
        const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
        if (!L2) continue;
        const t = ((px - ax) * vx + (py - ay) * vy) / L2;
        if (t <= 0 || t >= 1) continue;
        const d = Math.hypot(ax + t * vx - px, ay + t * vy - py);
        if (d <= SNAP && (!best || d < best[0])) best = [d, wj, i, t];
      }
      if (best) { const [, wj, i, t] = best; if (!inserts.has(wj)) inserts.set(wj, []); inserts.get(wj).push([i, t, id]); count.set(id, 2); }
    }
  });
  for (const [wj, L] of inserts) {
    L.sort((a, b) => b[0] - a[0] || b[1] - a[1]); // 뒤에서부터 끼워 넣어 번호가 밀리지 않게
    for (const [i, , id] of L) ways[wj].nodes.splice(i, 0, id);
  }
}
