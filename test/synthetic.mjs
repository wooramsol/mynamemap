// 합성 도로 데이터로 매칭 엔진 확인: node test/synthetic.mjs
import { buildGraph } from '../js/graph.js';
import { findJamo } from '../js/matcher.js';

const LAT0 = 37.5, LON0 = 127.0;
const kx = Math.cos(LAT0 * Math.PI / 180) * 111320, ky = 110540;
let nid = 1, wid = 1;
const elements = [];
const nodeAt = new Map();
function node(x, y) {
  const k = `${Math.round(x * 10)}_${Math.round(y * 10)}`;
  if (nodeAt.has(k)) return nodeAt.get(k);
  const id = nid++;
  elements.push({ type: 'node', id, lat: LAT0 + y / ky, lon: LON0 + x / kx });
  nodeAt.set(k, id);
  return id;
}
function way(pts) { elements.push({ type: 'way', id: wid++, nodes: pts.map(([x, y]) => node(x, y)) }); }
// 글자 하나를 (ox,oy)에 크기 s, 회전 rot(도)로 그리기. 템플릿 좌표계(y 아래)
function glyph(strokes, ox, oy, s, rot) {
  const c = Math.cos(rot * Math.PI / 180), si = Math.sin(rot * Math.PI / 180);
  const tf = ([x, y]) => { const X = x * s, Y = -y * s; return [ox + X * c - Y * si, oy + X * si + Y * c]; };
  for (const st of strokes) way(st.map(tf));
}
const lerp = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);

// ㅁ (20도 회전, 출입 도로 1개)
glyph([[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], [[1, .5], [1.6, .5]]], 0, 0, 60, 20);
// ㅏ
glyph([[...lerp([0, 0], [0, .5], 3), ...lerp([0, .5], [0, 1], 3).slice(1)], [[0, .5], [.5, .5]]], 300, 0, 80, -10);
// ㄹ
glyph([[[0, 0], [1, 0], [1, .5], [0, .5], [0, 1], [1, 1]]], 600, 0, 70, 5);
// ㅇ (원)
glyph([Array.from({ length: 25 }, (_, i) => [.5 + .5 * Math.cos(i / 24 * 2 * Math.PI), .5 + .5 * Math.sin(i / 24 * 2 * Math.PI)])], 900, 0, 70, 0);
// ㅌ
glyph([[[1, 0], [0, 0], [0, .5], [0, 1], [1, 1]], [[0, .5], [1, .5]]], 0, -300, 70, 0);
// 잡음: 격자 도로
for (let i = 0; i < 6; i++) way(lerp([-200 + i * 150, -600], [-200 + i * 150, -450], 1));

const G = buildGraph({ elements });
console.log('graph', G.nodes.size, 'nodes', G.edges.length, 'edges');
for (const j of ['ㅁ', 'ㅏ', 'ㅓ', 'ㄹ', 'ㅇ', 'ㅌ', 'ㄷ', 'ㅅ']) {
  const t = performance.now();
  const r = findJamo(G, j, { limit: 3 });
  const where = m => { const e = G.edges[m.edges[0]]; return `x≈${Math.round(e.pts[0][0])}`; };
  console.log(j, `${(performance.now() - t).toFixed(0)}ms`, r.map(m => `${m.score}(${where(m)},size ${m.size},rot ${Math.round(m.r * 180 / Math.PI)})`).join('  ') || '-');
}
