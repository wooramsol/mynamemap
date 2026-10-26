// 자모 하나(기본 자모 + 쌍자음 + 겹모음 40개)를 크게 쓴 모양의 길 찾기 (길만 사용)
// 사용: node scripts/jamo.mjs work/ways_foot.bin work/cands_all.jsonl work/jamo.jsonl [workers]
// glyph.mjs 와 같은 방식(글자 상자 안의 길 전체를 뼈대와 겹쳐 봄)으로, 음절 대신 자모 틀을 씀
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readWays, bucket, tileElements } from './scan.mjs';
import { makeProjection } from '../js/graph.js';
import { buildJamoTemplates, matchGlyphs } from '../js/glyph.js';

const TILE_LAT = 0.04, TILE_LON = 0.05;
const ANCHOR_MIN = 40, LINE_PER_TILE = 40; // ㅡ·ㅣ는 너무 많아서 칸마다 점수 높은 것만

// 자모별 배치: [구성 자모, [x, y, w, h]] (0~100 상자)
export const LAYOUTS = {
  ㄱ: [['ㄱ', [0, 0, 100, 100]]], ㄴ: [['ㄴ', [0, 0, 100, 100]]], ㄷ: [['ㄷ', [0, 0, 100, 100]]],
  ㄹ: [['ㄹ', [0, 0, 100, 100]]], ㅁ: [['ㅁ', [0, 0, 100, 100]]], ㅂ: [['ㅂ', [0, 0, 100, 100]]],
  ㅅ: [['ㅅ', [0, 0, 100, 100]]], ㅇ: [['ㅇ', [0, 0, 100, 100]]], ㅈ: [['ㅈ', [0, 0, 100, 100]]],
  ㅊ: [['ㅊ', [0, 0, 100, 100]]], ㅋ: [['ㅋ', [0, 0, 100, 100]]], ㅌ: [['ㅌ', [0, 0, 100, 100]]],
  ㅍ: [['ㅍ', [0, 0, 100, 100]]],
  ㅎ: [['ㅣ', [40, 0, 20, 18]], ['ㅡ', [5, 10, 90, 20]], ['ㅇ', [18, 30, 64, 70]]],
  'ㅎ#': [['ㅡ', [5, 5, 90, 20]], ['ㅇ', [18, 25, 64, 75]]], // 꼭지 없는 ㅎ
  ㄲ: [['ㄱ', [0, 0, 52, 100]], ['ㄱ', [48, 0, 52, 100]]], ㄸ: [['ㄷ', [0, 0, 52, 100]], ['ㄷ', [48, 0, 52, 100]]],
  ㅃ: [['ㅂ', [0, 0, 52, 100]], ['ㅂ', [48, 0, 52, 100]]], ㅆ: [['ㅅ', [0, 0, 52, 100]], ['ㅅ', [48, 0, 52, 100]]],
  ㅉ: [['ㅈ', [0, 0, 52, 100]], ['ㅈ', [48, 0, 52, 100]]],
  ㅏ: [['ㅏ', [0, 0, 100, 100]]], ㅑ: [['ㅑ', [0, 0, 100, 100]]], ㅓ: [['ㅓ', [0, 0, 100, 100]]],
  ㅕ: [['ㅕ', [0, 0, 100, 100]]], ㅗ: [['ㅗ', [0, 0, 100, 100]]], ㅛ: [['ㅛ', [0, 0, 100, 100]]],
  ㅜ: [['ㅜ', [0, 0, 100, 100]]], ㅠ: [['ㅠ', [0, 0, 100, 100]]], ㅡ: [['ㅡ', [0, 0, 100, 100]]],
  ㅣ: [['ㅣ', [0, 0, 100, 100]]], ㅐ: [['ㅐ', [0, 0, 100, 100]]],
  ㅔ: [['ㅓ', [0, 0, 70, 100]], ['ㅣ', [62, 0, 38, 100]]],
  ㅒ: [['ㅑ', [0, 0, 70, 100]], ['ㅣ', [62, 0, 38, 100]]],
  ㅖ: [['ㅕ', [0, 0, 70, 100]], ['ㅣ', [62, 0, 38, 100]]],
  ㅘ: [['ㅗ', [0, 30, 62, 70]], ['ㅏ', [52, 0, 48, 100]]],
  ㅙ: [['ㅗ', [0, 30, 55, 70]], ['ㅐ', [45, 0, 55, 100]]],
  ㅚ: [['ㅗ', [0, 30, 68, 70]], ['ㅣ', [62, 0, 38, 100]]],
  ㅝ: [['ㅜ', [0, 0, 62, 65]], ['ㅓ', [45, 0, 55, 100]]],
  ㅞ: [['ㅜ', [0, 0, 55, 65]], ['ㅓ', [38, 0, 40, 100]], ['ㅣ', [70, 0, 30, 100]]],
  ㅟ: [['ㅜ', [0, 0, 68, 65]], ['ㅣ', [62, 0, 38, 100]]],
  ㅢ: [['ㅡ', [0, 35, 68, 30]], ['ㅣ', [62, 0, 38, 100]]],
};
const NAME = k => k.replace('#', '');

function processTile(ways, list, a, b, anchors, T) {
  const osm = tileElements(ways, list, a, b);
  const proj = makeProjection((a + 0.5) * TILE_LAT, (b + 0.5) * TILE_LON);
  const nodes = new Map();
  for (const el of osm.elements) if (el.type === 'node') nodes.set(el.id, proj.fwd(el.lat, el.lon));
  const segs = [];
  for (const el of osm.elements) if (el.type === 'way') for (let i = 1; i < el.nodes.length; i++) segs.push([nodes.get(el.nodes[i - 1]), nodes.get(el.nodes[i])]);
  return [...matchGlyphs(segs, proj, anchors, T, process.env.RELAX ? { keep: 3, minScore: 15, minPartCov: 0.45, maxClutter: 0.45, maxInk: 3.2 } : { keep: 3, minScore: 30 }).entries()];
}

if (isMainThread && process.argv[1]?.endsWith('jamo.mjs')) {
  const [src, candFile, dst, nw] = process.argv.slice(2);
  const workers = +(nw || os.cpus().length);
  const byTile = new Map();
  let nA = 0;
  for await (const line of readline.createInterface({ input: fs.createReadStream(candFile) })) {
    const o = JSON.parse(line);
    if (o.s < ANCHOR_MIN || o.approx) continue;
    let L = byTile.get(o.t); if (!L) byTile.set(o.t, L = []);
    L.push({ j: o.j, s: o.s, r: o.r, lat: o.lat, lon: o.lon, w: Math.max(o.w, 6), h: Math.max(o.h, 6) });
  }
  for (const [k, L] of byTile) {
    // ㅡ·ㅣ: 칸마다 점수 높은 것만, 같은 자리 중복 제거
    const keep = [], line = { 'ㅡ': [], 'ㅣ': [] };
    for (const x of L) (line[x.j] || keep).push(x);
    for (const j of ['ㅡ', 'ㅣ']) keep.push(...line[j].sort((p, q) => q.s - p.s).slice(0, LINE_PER_TILE));
    const out = [];
    for (const x of keep) if (!out.some(y => y.j === x.j && Math.abs(y.lat - x.lat) < 8e-5 && Math.abs(y.lon - x.lon) < 8e-5)) out.push(x);
    byTile.set(k, out); nA += out.length;
  }
  console.log('anchors', nA, 'tiles', byTile.size);
  const ways = readWays(src, true);
  const todo = [...bucket(ways).entries()].filter(([k]) => byTile.has(k));
  const out = fs.createWriteStream(dst);
  let next = 0, done = 0, live = 0; const t0 = Date.now();
  for (let i = 0; i < workers; i++) {
    const wk = new Worker(new URL(import.meta.url), { workerData: { src, kind: 'jamo', ways } }); live++;
    const feed = () => {
      if (next >= todo.length) return wk.postMessage(null);
      const [k, list] = todo[next++];
      wk.postMessage({ k, list, anchors: byTile.get(k) });
    };
    wk.on('message', m => {
      if (m.ready) return feed();
      for (const [ch, L] of m.res) for (const r of L) out.write(JSON.stringify({ c: NAME(ch), ...r }) + '\n');
      if (++done % 200 === 0) console.log(`${done}/${todo.length} tiles ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      feed();
    });
    wk.on('exit', () => { if (--live === 0) { out.end(); console.log('done', ((Date.now() - t0) / 1000).toFixed(0) + 's'); } });
  }
} else if (!isMainThread && workerData?.kind === 'jamo') {
  const ways = workerData.ways;
  const only = process.env.ONLY ? new Set([...process.env.ONLY]) : null; // 이 자모만 (예: ONLY=ㅈㅊㅍ)
  const T = buildJamoTemplates(only ? Object.fromEntries(Object.entries(LAYOUTS).filter(([k]) => only.has(NAME(k)))) : LAYOUTS);
  parentPort.on('message', m => {
    if (!m) return process.exit(0);
    const [a, b] = m.k.split('_').map(Number);
    let res = [];
    try { res = processTile(ways, m.list, a, b, m.anchors, T); } catch (e) { console.error(m.k, e.stack); }
    parentPort.postMessage({ k: m.k, res });
  });
  parentPort.postMessage({ ready: true });
}
