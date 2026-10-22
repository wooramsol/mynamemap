import { decompose, neededJamo, syllableBoxes, basic } from './hangul.js';
import { buildGraph } from './graph.js';
import { findJamo } from './matcher.js';
import { SUPPORTED } from './templates.js';

const COLORS = ['#e23b2e', '#2b6cdf', '#16a06a', '#d8860b', '#8a3fd1', '#d63384', '#0f8b9c', '#6b6b00', '#b5531b', '#3a4a8c'];
// 여러 Overpass 서버에 동시에 요청해서 가장 먼저 오는 응답을 사용
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const MAX_AREA_KM2 = 10;
const DEG = Math.PI / 180;

const $ = id => document.getElementById(id);
const map = L.map('map', { zoomControl: true }).setView([36.4, 127.8], 7);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, className: 'base-tiles',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const layer = L.layerGroup().addTo(map);

const qs = new URLSearchParams(location.search);
if (qs.get('name')) $('name').value = qs.get('name');
let mode = qs.get('c') ? 'local' : 'nation';
if (qs.get('c')) { const [a, b, z] = qs.get('c').split(',').map(Number); if (!isNaN(a)) map.setView([a, b], z || 16); }

// 화면에 그리는 단위: 길로 찾은 한 '조각' = { j, s, r, g: [[ [lat,lon], ... ], ...] }
// 음절 하나 = { char, kind: 'syllable'|'jamo'|'missing', s, lat, lon, r, parts:[조각], slots? }
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
    ? '전국 도로를 미리 분석해 둔 결과에서, 음절 모양 그대로 이어진 길을 먼저 찾아요.'
    : '지도를 원하는 동네로 옮긴 뒤 찾기를 누르세요. (약 3km 이내 범위)');
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)));

// ── 전국 모드 ─────────────────────────────────────────────
const shardCache = new Map();
let jamoNation = null;
async function loadJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); }
async function shard(i) {
  if (!shardCache.has(i)) shardCache.set(i, loadJSON(`data/syl/${i}.json`));
  return shardCache.get(i);
}

async function runNation(name) {
  const syllables = decompose(name);
  setStatus('전국 데이터를 불러오는 중…');
  jamoNation ??= await loadJSON('data/jamo.json');
  const out = [];
  for (const s of syllables) {
    if (s.single) { out.push(jamoUnit(s, s.single)); continue; }
    const code = s.char.charCodeAt(0) - 0xAC00;
    const data = await shard(Math.floor(code / 588));
    const cands = data[s.char] || [];
    if (cands.length && cands[0].k === 'c') out.push({ char: s.char, syl: s, kind: 'cluster', cands, sel: 0, slots: syllableBoxes(s) });
    else if (cands.length) out.push({ char: s.char, syl: s, kind: 'syllable', cands, sel: 0 });
    else out.push(jamoUnit(s));
  }
  return out;
}

// 음절이 통째로 없으면 전국 최고 자모로 조합
function jamoUnit(s) {
  const parts = syllableBoxes(s).map(([j, box], k) => {
    const L = jamoNation?.[j] || [];
    return { j, box, cands: L, sel: 0 };
  });
  return { char: s.char, syl: s, kind: 'jamo', jparts: parts };
}

// ── 지역 모드 (지금 보는 지도 범위를 실시간 분석) ────────────────
async function fetchRoads(b, foot) {
  const excl = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'proposed', 'construction', 'abandoned', 'platform',
    'elevator', 'corridor', 'steps', 'bus_stop', 'raceway', 'rest_area', 'services'];
  if (!foot) excl.push('footway', 'path', 'cycleway', 'bridleway', 'track', 'pedestrian');
  const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(v => v.toFixed(6)).join(',');
  const q = `[out:json][timeout:60];way["highway"]["highway"!~"^(${excl.join('|')})$"]["area"!="yes"]["footway"!~"^(sidewalk|crossing)$"](${bbox});(._;>;);out skel qt;`;
  const ctrls = OVERPASS.map(() => new AbortController());
  const timer = setTimeout(() => ctrls.forEach(c => c.abort()), 60000);
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
  setStatus('길 데이터를 불러오는 중…');
  const osm = await fetchRoads(b, $('foot').checked);
  const G = buildGraph(osm, [b.getCenter().lat, b.getCenter().lng]);
  const list = neededJamo(syllables);
  const found = {};
  for (let i = 0; i < list.length; i++) {
    const j = list[i];
    setStatus(`'${j}' 모양 찾는 중… (${i + 1}/${list.length}, 길 조각 ${G.edges.length}개)`);
    await tick();
    const ms = SUPPORTED.has(j) ? findJamo(G, j, { limit: 10, timeBudgetMs: 5000 }) : [];
    found[j] = ms.map(m => {
      const g = m.edges.map(eid => G.edges[eid].ll);
      const all = g.flat();
      return { j, s: m.score, r: m.r, size: m.size, g, lat: all.reduce((a, p) => a + p[0], 0) / all.length, lon: all.reduce((a, p) => a + p[1], 0) / all.length };
    });
  }
  return syllables.map(s => ({
    char: s.char, syl: s, kind: 'jamo',
    jparts: syllableBoxes(s).map(([j, box]) => ({ j, box, cands: found[j] || [], sel: 0 })),
  }));
}

async function run(ev) {
  ev?.preventDefault();
  const name = $('name').value.trim();
  if (!decompose(name).length) return setStatus('한글 이름을 입력해 주세요.', true);
  $('go').disabled = true;
  layer.clearLayers();
  try {
    const units = mode === 'nation' ? await runNation(name) : await runLocal(name);
    // 같은 자모가 여러 번 나오면 서로 다른 후보를 쓰도록
    const seen = {};
    for (const u of units) if (u.kind === 'jamo') for (const p of u.jparts) { const k = seen[p.j] = (seen[p.j] ?? -1) + 1; if (p.cands.length) p.sel = k % p.cands.length; }
    state = { units, name };
    const whole = units.filter(u => u.kind === 'syllable').length, near = units.filter(u => u.kind === 'cluster').length;
    setStatus(mode === 'nation'
      ? (whole === units.length ? `${units.length}글자 모두 음절 모양 그대로 이어진 길을 전국에서 찾았어요.`
        : `${units.length}글자 중 ${whole}글자는 음절 모양 그대로 이어진 길을 찾았어요.` + (near ? ` ${near}글자는 한 동네 안의 자모를 모아 만들었어요.` : '') + (units.length - whole - near ? ' 나머지는 전국 최고 자모로 채웠어요.' : ''))
      : `이 지역에서 자모를 찾아 이름을 만들었어요. 후보를 눌러 바꿔 볼 수 있어요.`);
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
const partPaths = p => upright(p.g, p.r, p.lat, p.lon);
const ghost = (j, box) => `<text x="${box[0] + box[2] / 2}" y="${box[1] + box[3] / 2}" font-size="${Math.min(box[2], box[3]) * .8}" text-anchor="middle" dominant-baseline="central" fill="#c9c6bd" font-family="Noto Sans KR">${j}</text>`;

function clusterSvg(u, c, ox, oy, S, color, sw) {
  return u.slots.map(([j, b], i) => {
    const box = [ox + b[0] * S / 100, oy + b[1] * S / 100, b[2] * S / 100, b[3] * S / 100];
    return c.parts[i] ? pathsSvg(partPaths(c.parts[i]), box, color, sw) : ghost(j, box);
  }).join('');
}

function unitSvg(u, ox, S, color, sw) {
  if (u.kind === 'cluster') return clusterSvg(u, u.cands[u.sel], ox, 0, S, color, sw);
  if (u.kind === 'syllable') {
    const c = u.cands[u.sel];
    const paths = c.parts.flatMap(p => upright(p.g, c.r, c.lat, c.lon));
    return pathsSvg(paths, [ox, 0, S, S], color, sw);
  }
  let body = '';
  for (const p of u.jparts) {
    const box = [ox + p.box[0] * S / 100, p.box[1] * S / 100, p.box[2] * S / 100, p.box[3] * S / 100];
    const m = p.cands[p.sel];
    body += m ? pathsSvg(partPaths(m), box, color, sw) : ghost(p.j, box);
  }
  return body;
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
  if (u.kind === 'syllable' || u.kind === 'cluster') return u.cands[u.sel].parts;
  return u.jparts.map(p => p.cands[p.sel]).filter(Boolean);
}
function renderMap() {
  layer.clearLayers();
  state.units.forEach((u, i) => {
    const color = COLORS[i % COLORS.length];
    for (const p of unitPieces(u)) {
      const pl = L.polyline(p.g, { color, weight: 6, opacity: .9, lineCap: 'round' }).addTo(layer);
      pl.on('click', () => focusUnit(u));
    }
    const at = u.cands ? u.cands[u.sel] : unitPieces(u)[0];
    if (at) L.marker([at.lat, at.lon], { icon: L.divIcon({ className: 'syl-pin', html: `<span style="background:${color}">${u.char}</span>`, iconSize: [30, 30] }) })
      .on('click', () => focusUnit(u)).addTo(layer);
  });
}
function piecesBounds(pieces) { return L.latLngBounds(pieces.flatMap(p => p.g.flat())); }
function focusUnit(u) {
  const pcs = unitPieces(u);
  if (pcs.length) map.fitBounds(piecesBounds(pcs).pad(u.kind === 'jamo' ? 1.2 : 0.6), { maxZoom: 18 });
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
    const kindTxt = { syllable: '음절 모양 그대로 이어진 길', cluster: '한 동네의 자모를 모아 만듦', jamo: '전국 최고 자모를 모아 만듦' }[u.kind];
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
    if (u.kind === 'syllable' || u.kind === 'cluster') {
      u.cands.forEach((c, k) => {
        const inner = u.kind === 'cluster' ? clusterSvg(u, c, 2, 2, 36, color, 2) : pathsSvg(c.parts.flatMap(p => upright(p.g, c.r, c.lat, c.lon)), [0, 0, 40, 40], color, 2.5);
        chip(inner, `${c.s}`, k === u.sel, () => { u.sel = k; render(); focusUnit(u); },
          `점수 ${c.s} · 약 ${c.size}m · ${placeLabel(c.lat, c.lon)}`);
      });
    } else {
      for (const p of u.jparts) {
        if (!p.cands.length) { const s = document.createElement('span'); s.className = 'none'; s.textContent = `${p.j}: 못 찾음`; row.appendChild(s); continue; }
        p.cands.slice(0, 6).forEach((m, k) => {
          chip(pathsSvg(partPaths(m), [0, 0, 40, 40], color, 3), `${p.j}${m.s}`, k === p.sel, () => { p.sel = k; render(); focusUnit(u); },
            `점수 ${m.s} · ${placeLabel(m.lat, m.lon)}`);
        });
      }
    }
    div.appendChild(row);
    const at = u.cands ? u.cands[u.sel] : unitPieces(u)[0];
    if (at) {
      const a = document.createElement('a');
      a.className = 'where'; a.href = `https://map.kakao.com/link/map/${encodeURIComponent(u.char)},${at.lat},${at.lon}`;
      a.target = '_blank'; a.rel = 'noopener'; a.textContent = `${placeLabel(at.lat, at.lon)} · 카카오맵에서 보기 ↗`;
      div.appendChild(a);
    }
    wrap.appendChild(div);
  });
}

function render() { renderCard(); renderMap(); renderList(); }

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
setMode(mode);
// 공유 링크로 들어오면 지도 크기가 잡힌 뒤 자동으로 찾기
if (qs.get('name')) setTimeout(() => { map.invalidateSize(); run(); }, 400);
