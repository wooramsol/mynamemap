import { decompose, neededJamo, SPLIT, syllableBoxes } from './hangul.js';
import { buildGraph } from './graph.js';
import { findJamo } from './matcher.js';
import { SUPPORTED } from './templates.js';
import { findSyllable } from './syllable.js';
import { buildSyllableTemplates, matchGlyphs, strokeSegs } from './glyph.js';

const COLORS = ['#e23b2e', '#2b6cdf', '#16a06a', '#d8860b', '#8a3fd1', '#d63384', '#0f8b9c', '#6b6b00', '#b5531b', '#3a4a8c'];
// 여러 Overpass 서버에 동시에 요청해서 가장 먼저 오는 응답을 사용
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const MAX_AREA_KM2 = 10;
// 지역 모드 기준: 사람 눈으로 검토한 미리 찾은 결과에서, 이 점수 이상이어야 대부분 바로 읽혔음
// (미리 찾은 데이터는 하나하나 눈으로 보고 읽히는 것만 남겼으므로 점수로 거르지 않음)
const MIN_SYL = 50;   // 자모 조합 점수
const MIN_GLYPH = 70; // 음절 모양 비교 점수
const DEG = Math.PI / 180;

const $ = id => document.getElementById(id);
const map = L.map('map', { zoomControl: true }).setView([36.4, 127.8], 7);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, className: 'base-tiles',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const layer = L.layerGroup().addTo(map);
const jlayer = L.layerGroup().addTo(map); // 자모 도감에서 고른 자모

const qs = new URLSearchParams(location.search);
if (qs.get('name')) $('name').value = qs.get('name');
let mode = qs.get('c') ? 'local' : 'nation';
if (qs.get('c')) { const [a, b, z] = qs.get('c').split(',').map(Number); if (!isNaN(a)) map.setView([a, b], z || 16); }

// 화면에 그리는 단위: 길로 찾은 한 '조각' = { j, s, r, g: [[ [lat,lon], ... ], ...] }
// 음절 하나 = { char, kind: 'syllable'|'missing', cands:[{s, lat, lon, r, size, parts:[조각]}], sel }
let state = null;

function setStatus(msg, err = false) { $('status').textContent = msg; $('status').className = 'status' + (err ? ' err' : ''); }
const tick = () => new Promise(r => setTimeout(r, 0));

// ── 모드 전환 ─────────────────────────────────────────────
function setMode(m) {
  mode = m;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.mode === m));
  $('go').textContent = m === 'nation' ? '전국에서 찾기' : '이 지역에서 찾기';
  $('foot-wrap').hidden = m === 'nation';
  setStatus(m === 'nation'
    ? '전국 길을 미리 분석해 둔 결과에서, 한 글자로 읽히는 길만 찾아요.'
    : '지도를 원하는 동네로 옮긴 뒤 찾기를 누르세요. (약 3km 이내 범위)');
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)));

// ── 전 세계 모드 (미리 찾아 둔 결과) ─────────────────────────────────────────────
const shardCache = new Map();
async function loadJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); }
async function shard(i) {
  if (!shardCache.has(i)) shardCache.set(i, loadJSON(`data/syl/${i}.json`));
  return shardCache.get(i);
}

// 음절은 자모가 실제로 한 덩어리로 붙어 있는 곳만 인정한다 (따로 찾아 붙이지 않음)
async function runNation(name) {
  const syllables = decompose(name);
  setStatus('미리 찾아 둔 결과를 불러오는 중…');
  const out = [];
  for (const s of syllables) {
    if (s.single) { out.push({ char: s.char, syl: s, kind: 'missing' }); continue; }
    const code = s.char.charCodeAt(0) - 0xAC00;
    const data = await shard(Math.floor(code / 588));
    const cands = (data[s.char] || []).filter(c => c.k !== 'c');
    out.push(cands.length ? { char: s.char, syl: s, kind: 'syllable', cands, sel: 0 } : { char: s.char, syl: s, kind: 'missing' });
  }
  return out;
}

// ── 지역 모드 (지금 보는 지도 범위를 실시간 분석) ────────────────
async function fetchRoads(b, foot) {
  const excl = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'proposed', 'construction', 'abandoned', 'platform',
    'elevator', 'corridor', 'steps', 'bus_stop', 'raceway', 'rest_area', 'services'];
  if (!foot) excl.push('footway', 'path', 'cycleway', 'bridleway', 'track', 'pedestrian');
  const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(v => v.toFixed(6)).join(',');
  const q = `[out:json][timeout:120];way["highway"]["highway"!~"^(${excl.join('|')})$"]["area"!="yes"]["footway"!~"^(sidewalk|crossing)$"](${bbox});(._;>;);out skel qt;`;
  const ctrls = OVERPASS.map(() => new AbortController());
  const timer = setTimeout(() => ctrls.forEach(c => c.abort()), 150000); // 붐빌 때는 1~2분 걸리기도 함
  try {
    return await Promise.any(OVERPASS.map(async (url, i) => {
      const res = await fetch(url, {
        method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctrls[i].signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      ctrls.forEach((c, k) => k !== i && c.abort()); // 나머지 요청은 취소
      return json;
    }));
  } catch (e) {
    throw new Error('모든 지도 데이터 서버가 응답하지 않음');
  } finally {
    clearTimeout(timer);
  }
}

function areaKm2(b) {
  const h = (b.getNorth() - b.getSouth()) * 110.54;
  const w = (b.getEast() - b.getWest()) * 111.32 * Math.cos(b.getCenter().lat * DEG);
  return h * w;
}

async function runLocal(name) {
  const syllables = decompose(name);
  const b = map.getBounds();
  if (areaKm2(b) > MAX_AREA_KM2) throw new Error(`범위가 너무 넓어요 (${areaKm2(b).toFixed(1)}km²). 지도를 조금 더 확대해 주세요.`);
  setStatus('길 데이터를 불러오는 중… (지도 서버가 붐비면 1~2분 걸릴 수 있어요)');
  const osm = await fetchRoads(b, $('foot').checked);
  const G = buildGraph(osm, [b.getCenter().lat, b.getCenter().lng]);
  const list = neededJamo(syllables);
  const cands = [];
  for (let i = 0; i < list.length; i++) {
    const j = list[i];
    setStatus(`'${j}' 모양 찾는 중… (${i + 1}/${list.length}, 길 조각 ${G.edges.length}개)`);
    await tick();
    const ms = SUPPORTED.has(j) ? findJamo(G, j, { limit: 80, timeBudgetMs: 5000, minScore: 25 }) : [];
    for (const m of ms) cands.push(describe(G, m, j));
  }
  setStatus('길 묶음이 이름 글자 모양인 곳을 찾는 중…');
  await tick();
  // 음절 전체 모양 비교 (js/glyph.js)
  const segs = [];
  for (const e of G.edges) for (let i = 1; i < e.pts.length; i++) segs.push([e.pts[i - 1], e.pts[i]]);
  const T = buildSyllableTemplates(new Set(syllables.map(s => s.char)));
  const glyphs = matchGlyphs(segs, G.proj, cands.filter(c => c.s >= 30), T, { keep: 3, minScore: MIN_GLYPH });
  return syllables.map(s => {
    if (s.single) return { char: s.char, syl: s, kind: 'missing' };
    const a = findSyllable(cands, s).filter(c => c.s >= MIN_SYL);
    const b = (glyphs.get(s.char) || []).map(glyphToCand(s.char));
    const found = mergeCands([...a, ...b]);
    return found.length ? { char: s.char, syl: s, kind: 'syllable', cands: found, sel: 0 } : { char: s.char, syl: s, kind: 'missing' };
  });
}

// 음절 모양 비교 결과 → 화면용 후보 (조각 하나 = 음절 전체)
const glyphToCand = ch => r => ({ s: r.s, lat: r.lat, lon: r.lon, r: r.r, size: r.size, parts: [{ j: ch, s: r.s, r: r.r, lat: r.lat, lon: r.lon, g: r.g }] });
// 같은 곳(300m 안)은 하나만, 점수순 상위 3개
function mergeCands(list) {
  const out = [];
  for (const c of list.sort((a, b) => b.s - a.s)) {
    if (out.some(o => Math.hypot((o.lat - c.lat) * 110540, (o.lon - c.lon) * 88000) < 300)) continue;
    out.push(c); if (out.length >= 3) break;
  }
  return out;
}

// 매칭 결과 → 글자 방향으로 세운 상자 크기·중심 (scan.mjs와 같은 방식)
function describe(G, m, j) {
  const c = Math.cos(-m.r), s = Math.sin(-m.r);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  const g = [];
  for (const eid of m.edges) {
    const E = G.edges[eid];
    for (const [x, y] of E.pts) { const u = x * c - y * s, v = x * s + y * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    g.push(E.ll);
  }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, ci = Math.cos(m.r), si = Math.sin(m.r);
  const [lat, lon] = G.proj.inv(cu * ci - cv * si, cu * si + cv * ci);
  return { j, s: m.score, r: m.r, lat, lon, w: Math.max(4, u1 - u0), h: Math.max(4, v1 - v0), g };
}

async function run(ev) {
  ev?.preventDefault();
  const name = $('name').value.trim();
  if (!decompose(name).length) return setStatus('한글 이름을 입력해 주세요.', true);
  $('go').disabled = true;
  layer.clearLayers();
  try {
    const units = mode === 'nation' ? await runNation(name) : await runLocal(name);
    await loadDex();
    // 음절을 못 찾은 글자: 자모 도감의 길로 조합 (자모마다 다른 곳)
    for (const u of units) if (u.kind === 'missing') { const cb = comboOf(u.syl); if (cb) { u.kind = 'combo'; u.combo = cb; } }
    state = { units, name };
    const whole = units.filter(u => u.kind === 'syllable').length;
    const combo = units.filter(u => u.kind === 'combo').length;
    const where = mode === 'nation' ? '전국에서' : '이 지역에서';
    setStatus(whole === units.length ? `${units.length}글자 모두 한 글자 모양 그대로인 길을 ${where} 찾았어요.`
      : `${units.length}글자 중 ${whole}글자는 한 글자 모양 그대로인 길을 ${where} 찾았어요.`
        + (combo ? ` ${combo}글자는 자모마다 다른 곳의 길을 모아 만들었어요(조합, 회갈색).` : '')
        + (whole + combo < units.length ? ' 못 찾은 글자는 회색으로 표시했어요.' : ''));
    const c = map.getCenter();
    history.replaceState(null, '', `?name=${encodeURIComponent(name)}` + (mode === 'local' ? `&c=${c.lat.toFixed(5)},${c.lng.toFixed(5)},${map.getZoom()}` : ''));
    render();
    if (mode === 'nation') fitAll();
  } catch (e) {
    console.error(e);
    setStatus(e.message.startsWith('범위') ? e.message : '불러오지 못했어요. 잠시 후 다시 시도해 주세요. (' + e.message + ')', e.message);
  } finally {
    $('go').disabled = false;
  }
}

// ── 자모 도감: 자모 하나를 크게 쓴 길 (사람 눈으로 검토한 것만) ──────────
let DEX = {};
let dexLoading = null;
function loadDex() {
  if (!dexLoading) dexLoading = loadJSON('data/jamo.json').then(d => { DEX = d; }).catch(() => {});
  return dexLoading;
}
// 음절을 이루는 자모 (도감에 없는 겹받침 등은 기본 자모로 나눔)
function jamoOf(syl) {
  if (syl.single) return [syl.single];
  return [syl.cho, syl.jung, syl.jong].filter(Boolean).flatMap(j => DEX[j] ? [j] : (SPLIT[j] || [j]));
}
function showJamo(j, rec, color, linkEl) {
  jlayer.clearLayers();
  L.polyline(rec.g, { color, weight: 6, opacity: .9, lineCap: 'round', dashArray: '1 9' }).addTo(jlayer);
  L.polyline(rec.g, { color, weight: 4, opacity: .9, lineCap: 'round' }).addTo(jlayer);
  L.marker([rec.lat, rec.lon], { icon: L.divIcon({ className: 'syl-pin', html: `<span style="background:${color}">${j}</span>`, iconSize: [30, 30] }) }).addTo(jlayer);
  map.fitBounds(L.latLngBounds(rec.g.flat()).pad(0.6), { maxZoom: 18 });
  if (linkEl) setWhere(linkEl, j, rec);
}
function setWhere(a, label, at) {
  const inKorea = at.lat > 33 && at.lat < 38.7 && at.lon > 124.5 && at.lon < 131;
  a.className = 'where';
  a.href = inKorea ? `https://map.kakao.com/link/map/${encodeURIComponent(label)},${at.lat},${at.lon}` : `https://www.google.com/maps?q=${at.lat},${at.lon}&z=17&t=k`;
  a.target = '_blank'; a.rel = 'noopener'; a.textContent = `${placeLabel(at.lat, at.lon)} · ${inKorea ? '카카오맵' : '구글 지도'}에서 보기 ↗`;
}
// 자모 칩 줄 (누르면 지도에 그 길을 보여줌)
function jamoChips(list, color) {
  const box = document.createElement('div');
  const row = document.createElement('div'); row.className = 'cands';
  const a = document.createElement('a');
  for (const j of list) {
    const rec = DEX[j]?.[0];
    const b = document.createElement('button');
    b.className = 'cand' + (rec ? '' : ' off');
    b.title = rec ? `'${j}' 모양 길 · ${placeLabel(rec.lat, rec.lon)}` : `'${j}' 모양 길은 아직 못 찾음`;
    b.innerHTML = `<svg viewBox="0 0 40 40">${rec ? pathsSvg(upright(rec.g, rec.r, rec.lat, rec.lon), [0, 0, 40, 40], color, 2.5) : ghost(j, [0, 0, 40, 40])}</svg>${j}`;
    if (rec) b.onclick = () => { row.querySelectorAll('.cand').forEach(x => x.classList.remove('on')); b.classList.add('on'); showJamo(j, rec, color, a); };
    else b.disabled = true;
    row.appendChild(b);
  }
  box.appendChild(row); box.appendChild(a);
  return box;
}

// ── 그리기 ─────────────────────────────────────────────
// 위경도 선들을 기준점·방향(r)으로 세운 미터 좌표(y 아래쪽)로
function upright(lines, r, lat0, lon0) {
  const kx = 111320 * Math.cos(lat0 * DEG), c = Math.cos(-r), s = Math.sin(-r);
  return lines.map(l => l.map(([la, lo]) => { const x = (lo - lon0) * kx, y = (la - lat0) * 110540; return [x * c - y * s, -(x * s + y * c)]; }));
}
function pathsSvg(paths, box, color, sw) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths) for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const [bx, by, bw, bh] = box;
  const k = Math.min((bw - 2 * sw) / Math.max(x1 - x0, 1e-6), (bh - 2 * sw) / Math.max(y1 - y0, 1e-6));
  const ox = bx + (bw - (x1 - x0) * k) / 2, oy = by + (bh - (y1 - y0) * k) / 2;
  const d = paths.map(p => 'M' + p.map(([x, y]) => `${(ox + (x - x0) * k).toFixed(1)},${(oy + (y - y0) * k).toFixed(1)}`).join('L')).join('');
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
}
const ghost = (j, box) => `<text x="${box[0] + box[2] / 2}" y="${box[1] + box[3] / 2}" font-size="${Math.min(box[2], box[3]) * .8}" text-anchor="middle" dominant-baseline="central" fill="#c9c6bd" font-family="Noto Sans KR">${j}</text>`;

// ── 자모를 자리마다 또렷이 나눠 그리기 ──────────────────────
// 실제 길에서는 자음과 모음이 길로 이어져 있기도 해서, 그대로 그리면 붙어 보임.
// 자모마다 자기 자리(syllableBoxes)에 여백을 두고 따로 맞춰 그린다.
const comboBoxes = syl => syl.single ? [[syl.single, [5, 5, 90, 90]]] : syllableBoxes(syl);
function comboOf(syl) {
  const boxes = comboBoxes(syl);
  if (!boxes.every(([j]) => DEX[j])) return null;
  return boxes.map(([j, box]) => ({ j, box, paths: upright(DEX[j][0].g, DEX[j][0].r, DEX[j][0].lat, DEX[j][0].lon) }));
}
// 찾은 음절 결과 → 자리별 선 묶음
function splitCand(c, syl) {
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
    // 음절 모양 비교로 찾은 결과: 선분마다 가장 가까운 자모 자리로
    for (const o of out) o.tsegs = strokeSegs(o.j, o.box);
    const segs = upright(c.parts.flatMap(p => p.g), c.r, c.lat, c.lon);
    const k = 100 / c.size;
    for (const line of segs) for (let i = 1; i < line.length; i++) {
      const [x0, y0] = line[i - 1], [x1, y1] = line[i];
      const U = 50 + (x0 + x1) / 2 * k, V = 50 + (y0 + y1) / 2 * k;
      let best = 0, bd = Infinity;
      out.forEach((o, bi) => {
        // 그 자모 글꼴 뼈대까지의 거리
        for (const [[ax, ay], [bx, by]] of o.tsegs) {
          const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
          const t = L2 ? Math.max(0, Math.min(1, ((U - ax) * vx + (V - ay) * vy) / L2)) : 0;
          const d = Math.hypot(U - ax - t * vx, V - ay - t * vy);
          if (d < bd) { bd = d; best = bi; }
        }
      });
      out[best].paths.push([line[i - 1], line[i]]);
    }
  }
  return out;
}
function groupsSvg(groups, [ox, oy, W, H], color, sw) {
  return groups.map(({ j, box: [bx, by, bw, bh], paths }) => {
    const x = ox + bx / 100 * W, y = oy + by / 100 * H, w = bw / 100 * W, h = bh / 100 * H;
    const pad = Math.min(w, h) * 0.07;
    const inner = [x + pad, y + pad, w - 2 * pad, h - 2 * pad];
    return paths.length ? pathsSvg(paths, inner, color, sw) : ghost(j, inner);
  }).join('');
}
const COMBO_COLOR = '#9a8466';
function unitSvg(u, ox, S, color, sw) {
  if (u.kind === 'missing') return ghost(u.char, [ox, 0, S, S]);
  if (u.kind === 'combo') return groupsSvg(u.combo, [ox, 0, S, S], COMBO_COLOR, sw);
  if (u.kind === 'syllable') return groupsSvg(splitCand(u.cands[u.sel], u.syl), [ox, 0, S, S], color, sw);
  return '';
}

function renderCard() {
  const S = 120, gap = 10, n = state.units.length;
  const W = n * S + (n - 1) * gap;
  const body = state.units.map((u, i) => unitSvg(u, i * (S + gap), S, '#1d1d1b', 5)).join('');
  $('card').innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 -6 ${W + 12} ${S + 12}"><rect x="-6" y="-6" width="${W + 12}" height="${S + 12}" fill="#fff"/>${body}</svg>`;
  $('card-wrap').hidden = false;
}

// 지도에 표시할 조각들
function unitPieces(u) {
  if (u.kind !== 'syllable') return [];
  return u.cands[u.sel].parts;
}
function renderMap() {
  layer.clearLayers();
  state.units.forEach((u, i) => {
    const color = COLORS[i % COLORS.length];
    for (const p of unitPieces(u)) {
      const pl = L.polyline(p.g, { color, weight: 6, opacity: .9, lineCap: 'round' }).addTo(layer);
      pl.on('click', () => focusUnit(u));
    }
    const at = u.cands?.[u.sel];
    if (at) L.marker([at.lat, at.lon], { icon: L.divIcon({ className: 'syl-pin', html: `<span style="background:${color}">${u.char}</span>`, iconSize: [30, 30] }) })
      .on('click', () => focusUnit(u)).addTo(layer);
  });
}
function piecesBounds(pieces) { return L.latLngBounds(pieces.flatMap(p => p.g.flat())); }
function focusUnit(u) {
  const pcs = unitPieces(u);
  if (pcs.length) map.fitBounds(piecesBounds(pcs).pad(0.6), { maxZoom: 18 });
}
function fitAll() {
  const pcs = state.units.flatMap(unitPieces);
  if (pcs.length) map.fitBounds(piecesBounds(pcs).pad(0.2), { maxZoom: 17 });
}

function placeLabel(lat, lon) { return `${lat.toFixed(4)}, ${lon.toFixed(4)}`; }

function renderList() {
  const wrap = $('jamo-list');
  wrap.innerHTML = '';
  state.units.forEach((u, i) => {
    const color = COLORS[i % COLORS.length];
    const div = document.createElement('div');
    div.className = 'jamo';
    const head = document.createElement('h3');
    const kindTxt = u.kind === 'syllable' ? '한 글자 모양 그대로인 길' : u.kind === 'combo' ? '자모 조합 (자모마다 다른 곳)' : '아직 못 찾음';
    head.innerHTML = `<span class="big" style="background:${color}">${u.char}</span><span class="cnt">${kindTxt}</span>`;
    div.appendChild(head);
    const row = document.createElement('div');
    row.className = 'cands';
    const chip = (svgInner, label, on, onclick, title) => {
      const b = document.createElement('button');
      b.className = 'cand' + (on ? ' on' : '');
      b.title = title || '';
      b.innerHTML = `<svg viewBox="0 0 40 40">${svgInner}</svg>${label}`;
      b.onclick = onclick;
      row.appendChild(b);
    };
    if (u.kind === 'missing' || u.kind === 'combo') {
      const m = document.createElement('span'); m.className = 'none';
      m.textContent = `'${u.char}' 모양으로 자모가 붙어 있는 길을 ${mode === 'nation' ? '전국에서' : '이 지역에서'} 아직 못 찾았어요.`;
      row.appendChild(m);
      const js = jamoOf(u.syl);
      if (js.some(j => DEX[j])) {
        const t = document.createElement('p'); t.className = 'none sub2';
        t.textContent = '대신 이 글자를 이루는 자모 모양의 길이에요 (자모마다 다른 곳):';
        row.appendChild(t);
        row.appendChild(jamoChips(js, color));
      }
    } else if (u.kind === 'syllable') {
      u.cands.forEach((c, k) => {
        const inner = groupsSvg(splitCand(c, u.syl), [0, 0, 40, 40], color, 2);
        chip(inner, `${c.s}`, k === u.sel, () => { u.sel = k; render(); focusUnit(u); },
          `점수 ${c.s} · 약 ${c.size}m · ${placeLabel(c.lat, c.lon)}`);
      });
    }
    div.appendChild(row);
    const at = u.cands?.[u.sel];
    if (at) {
      const a = document.createElement('a');
      setWhere(a, u.char, at);
      div.appendChild(a);
    }
    wrap.appendChild(div);
  });
}

function render() { jlayer.clearLayers(); renderCard(); renderMap(); renderList(); }

function savePng() {
  const svg = $('card').querySelector('svg');
  const vb = svg.viewBox.baseVal;
  const scale = 1200 / vb.width;
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = vb.width * scale; c.height = vb.height * scale + 60;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, vb.width * scale, vb.height * scale);
    g.fillStyle = '#999'; g.font = '22px "Noto Sans KR", sans-serif'; g.textAlign = 'right';
    g.fillText('mynamemap · © OpenStreetMap', c.width - 20, c.height - 22);
    const a = document.createElement('a');
    a.download = `mynamemap-${$('name').value.trim()}.png`;
    a.href = c.toDataURL('image/png');
    a.click();
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.outerHTML);
}

$('search').addEventListener('submit', run);
$('save').addEventListener('click', savePng);
// 자모 도감 전체 보기
$('dex').addEventListener('click', async () => {
  await loadDex();
  const wrap = $('jamo-list'); wrap.innerHTML = '';
  const div = document.createElement('div'); div.className = 'jamo';
  const head = document.createElement('h3');
  head.innerHTML = `<span class="cnt">자모 도감 · 자모 하나를 크게 쓴 모양의 길 (${Object.keys(DEX).length}개)</span>`;
  div.appendChild(head);
  div.appendChild(jamoChips(['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'], COLORS[0]));
  div.appendChild(jamoChips(['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'], COLORS[1]));
  wrap.appendChild(div);
});
setMode(mode);
// 공유 링크로 들어오면 지도 크기가 잡힌 뒤 자동으로 찾기
if (qs.get('name')) setTimeout(() => { map.invalidateSize(); run(); }, 400);
