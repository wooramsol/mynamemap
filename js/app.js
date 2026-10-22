import { decompose, neededJamo, basic, VERTICAL_VOWELS, HORIZONTAL_VOWELS } from './hangul.js';
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

const $ = id => document.getElementById(id);
const map = L.map('map', { zoomControl: true }).setView([37.5195, 127.0975], 16);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, className: 'base-tiles',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const layer = L.layerGroup().addTo(map);

// URL로 공유: ?name=정우람솔&c=37.5,127.1,16
const qs = new URLSearchParams(location.search);
if (qs.get('name')) $('name').value = qs.get('name');
if (qs.get('c')) { const [a, b, z] = qs.get('c').split(',').map(Number); if (!isNaN(a)) map.setView([a, b], z || 16); }

let state = null; // { G, syllables, jamo:[{j, color, matches, sel}] }

function setStatus(msg, err = false) { $('status').textContent = msg; $('status').className = 'status' + (err ? ' err' : ''); }
const tick = () => new Promise(r => setTimeout(r, 0));

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
  const w = (b.getEast() - b.getWest()) * 111.32 * Math.cos(b.getCenter().lat * Math.PI / 180);
  return h * w;
}

async function run(ev) {
  ev?.preventDefault();
  const name = $('name').value.trim();
  const syllables = decompose(name);
  if (!syllables.length) return setStatus('한글 이름을 입력해 주세요.', true);
  const b = map.getBounds();
  if (areaKm2(b) > MAX_AREA_KM2) return setStatus(`범위가 너무 넓어요 (${areaKm2(b).toFixed(1)}km²). 지도를 조금 더 확대해 주세요.`, true);

  $('go').disabled = true;
  layer.clearLayers();
  try {
    setStatus('길 데이터를 불러오는 중…');
    const osm = await fetchRoads(b, $('foot').checked);
    const G = buildGraph(osm, [b.getCenter().lat, b.getCenter().lng]);
    const list = neededJamo(syllables);
    const jamo = [];
    for (let i = 0; i < list.length; i++) {
      const j = list[i];
      setStatus(`'${j}' 모양 찾는 중… (${i + 1}/${list.length}, 길 조각 ${G.edges.length}개)`);
      await tick();
      const matches = SUPPORTED.has(j) ? findJamo(G, j, { limit: 10, timeBudgetMs: 5000 }) : [];
      jamo.push({ j, color: COLORS[i % COLORS.length], matches, sel: 0 });
    }
    state = { G, syllables, jamo };
    const found = jamo.filter(x => x.matches.length).length;
    setStatus(`${list.length}개 자모 중 ${found}개를 찾았어요. 후보를 눌러 바꿔 볼 수 있어요.`);
    history.replaceState(null, '', `?name=${encodeURIComponent(name)}&c=${map.getCenter().lat.toFixed(5)},${map.getCenter().lng.toFixed(5)},${map.getZoom()}`);
    render();
  } catch (e) {
    console.error(e);
    setStatus('길 데이터를 불러오지 못했어요. 잠시 후 다시 시도해 주세요. (' + e.message + ')', true);
  } finally {
    $('go').disabled = false;
  }
}

// ── 그리기 ─────────────────────────────────────────

// 매칭된 길을 똑바로 세운 좌표 (y 아래쪽)
function uprightPaths(m) {
  const c = Math.cos(-m.r), s = Math.sin(-m.r);
  return m.edges.map(eid => state.G.edges[eid].pts.map(([x, y]) => [x * c - y * s, -(x * s + y * c)]));
}

function shapeSvg(m, box, color, sw) {
  const paths = uprightPaths(m);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths) for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const [bx, by, bw, bh] = box;
  const pad = sw;
  const k = Math.min((bw - 2 * pad) / Math.max(x1 - x0, 1e-6), (bh - 2 * pad) / Math.max(y1 - y0, 1e-6));
  const ox = bx + (bw - (x1 - x0) * k) / 2, oy = by + (bh - (y1 - y0) * k) / 2;
  const d = paths.map(p => 'M' + p.map(([x, y]) => `${(ox + (x - x0) * k).toFixed(1)},${(oy + (y - y0) * k).toFixed(1)}`).join('L')).join('');
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

// 음절 안에서 자모 자리 나누기 (100×100 상자)
function syllableBoxes(s) {
  if (s.single) return [[s.single, [5, 5, 90, 90]]];
  const v = s.jung, jong = s.jong;
  const out = [];
  const put = (j, box) => {
    const parts = basic(j);
    if (parts.length === 1) return out.push([j, box]);
    const [x, y, w, h] = box;
    parts.forEach((p, i) => out.push([p, [x + i * w / parts.length, y, w / parts.length, h]])); // 쌍자음·겹받침은 나란히
  };
  if (VERTICAL_VOWELS.has(v)) {
    const H = jong ? 60 : 100;
    put(s.cho, [0, 0, 56, H]); put(v, [56, 0, 44, H]);
  } else if (HORIZONTAL_VOWELS.has(v)) {
    if (jong) { put(s.cho, [15, 0, 70, 38]); put(v, [0, 38, 100, 26]); }
    else { put(s.cho, [10, 0, 80, 55]); put(v, [0, 55, 100, 45]); }
  } else { // ㅘ ㅝ ㅢ 같은 섞인 모음
    const H = jong ? 72 : 100;
    const [h, vv] = basic(v);
    put(s.cho, [0, 0, 60, H * .5]); put(h, [0, H * .5, 66, H * .5]); put(vv, [66, 0, 34, H]);
  }
  if (jong) put(jong, [10, 64, 80, 36]);
  return out;
}

function renderCard() {
  const S = 120, gap = 10;
  const n = state.syllables.length;
  const W = n * S + (n - 1) * gap;
  const used = {};
  let body = '';
  state.syllables.forEach((s, i) => {
    const ox = i * (S + gap);
    for (const [j, [x, y, w, h]] of syllableBoxes(s)) {
      const box = [ox + x * S / 100, y * S / 100, w * S / 100, h * S / 100];
      const J = state.jamo.find(z => z.j === j);
      const k = used[j] = (used[j] ?? -1) + 1;
      if (J && J.matches.length) {
        const m = J.matches[(J.sel + k) % J.matches.length];
        body += shapeSvg(m, box, '#1d1d1b', 5);
      } else {
        body += `<text x="${box[0] + box[2] / 2}" y="${box[1] + box[3] / 2}" font-size="${Math.min(box[2], box[3]) * .8}" text-anchor="middle" dominant-baseline="central" fill="#c9c6bd" font-family="Noto Sans KR">${j}</text>`;
      }
    }
  });
  $('card').innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 -6 ${W + 12} ${S + 12}"><rect x="-6" y="-6" width="${W + 12}" height="${S + 12}" fill="#fff"/>${body}</svg>`;
  $('card-wrap').hidden = false;
}

function renderMap() {
  layer.clearLayers();
  for (const J of state.jamo) {
    const m = J.matches[J.sel];
    if (!m) continue;
    const lines = m.edges.map(eid => state.G.edges[eid].ll);
    const pl = L.polyline(lines, { color: J.color, weight: 7, opacity: .85, lineCap: 'round' }).addTo(layer);
    pl.bindTooltip(J.j, { permanent: true, direction: 'center', className: 'jl' });
    pl.on('click', () => focus(J));
  }
}

function focus(J) {
  const m = J.matches[J.sel];
  if (!m) return;
  const lines = m.edges.map(eid => state.G.edges[eid].ll);
  map.fitBounds(L.latLngBounds(lines.flat()).pad(1.2), { maxZoom: 18 });
}

function renderList() {
  const wrap = $('jamo-list');
  wrap.innerHTML = '';
  for (const J of state.jamo) {
    const div = document.createElement('div');
    div.className = 'jamo';
    const note = J.matches[0]?.approx ? ' · 동그라미로 근사' : '';
    div.innerHTML = `<h3><span class="big" style="background:${J.color}">${J.j}</span><span class="cnt">후보 ${J.matches.length}개${note}</span></h3>`;
    const cands = document.createElement('div');
    cands.className = 'cands';
    if (!J.matches.length) cands.innerHTML = `<span class="none">${SUPPORTED.has(J.j) ? '이 지역에선 못 찾았어요. 지도를 옮겨 다시 찾아보세요.' : '아직 지원하지 않는 자모예요.'}</span>`;
    J.matches.forEach((m, i) => {
      const b = document.createElement('button');
      b.className = 'cand' + (i === J.sel ? ' on' : '');
      b.title = `점수 ${m.score} · 크기 약 ${m.size}m`;
      b.innerHTML = `<svg viewBox="0 0 40 40">${shapeSvg(m, [0, 0, 40, 40], J.color, 3)}</svg>${m.score}`;
      b.onclick = () => { J.sel = i; render(); focus(J); };
      cands.appendChild(b);
    });
    div.appendChild(cands);
    wrap.appendChild(div);
  }
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
if (qs.get('name') && qs.get('c')) run();
