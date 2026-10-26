// 음절 전체를 하나의 모양으로 비교해서 찾기
// 사용: node scripts/glyph.mjs work/ways_foot.bin work/cands_all.jsonl work/glyph.jsonl [workers]
//
// 1. 초성 자모 후보(기준점)마다, 그 자모가 음절의 초성 자리에 오도록 음절 틀(크기·방향)을 정한다.
// 2. 그 틀 안의 실제 길을 18×18 격자에 그려 '길까지의 거리' 지도를 만든다.
// 3. 음절 글꼴 뼈대(모든 자모의 획)를 같은 격자에 겹쳐서
//    - 획 위에 길이 있는지 (자모마다 따로 확인: 하나라도 비면 탈락)
//    - 글자 밖에 쓸데없는 길이 많지 않은지
//    를 점수로 매긴다. 자모를 따로 찾는 게 아니라 길 묶음 전체가 그 글자로 읽히는지를 본다.
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readWays, bucket, tileElements } from './scan.mjs';
import { makeProjection } from '../js/graph.js';
import { buildSyllableTemplates, matchGlyphs, CONSONANTS, ANCHOR_SKIP } from '../js/glyph.js';

const TILE_LAT = 0.04, TILE_LON = 0.05;
const ANCHOR_MIN = 35;
const KSX = fs.existsSync(new URL('./ksx1001.txt', import.meta.url)) ? new Set([...fs.readFileSync(new URL('./ksx1001.txt', import.meta.url), 'utf8').trim()]) : null;

function processTile(ways, list, a, b, anchors, T) {
  const osm = tileElements(ways, list, a, b);
  const proj = makeProjection((a + 0.5) * TILE_LAT, (b + 0.5) * TILE_LON);
  const nodes = new Map();
  for (const el of osm.elements) if (el.type === 'node') nodes.set(el.id, proj.fwd(el.lat, el.lon));
  // 선분과 공간 색인 (25m 칸)
  const segs = [];
  for (const el of osm.elements) if (el.type === 'way') for (let i = 1; i < el.nodes.length; i++) segs.push([nodes.get(el.nodes[i - 1]), nodes.get(el.nodes[i])]);
  return [...matchGlyphs(segs, proj, anchors, T, process.env.RELAX ? { keep: 12, minScore: 10, minPartCov: 0.4, maxClutter: 0.6, maxInk: 4 } : {}).entries()];
}

// ── 실행 ───────────────────────────────────────────────────
if (isMainThread && process.argv[1]?.endsWith('glyph.mjs')) {
  const [src, candFile, dst, nw] = process.argv.slice(2);
  const workers = +(nw || os.cpus().length);
  // 기준점: 초성으로 쓸 수 있는 자모 후보 (같은 자리 중복 제거)
  let byTile = new Map();
  let nA = 0;
  const cache = candFile + (process.env.ANCHOR_ALL ? '.anchors_all.json' : '.anchors.json');
  if (process.env.RESUME && fs.existsSync(cache)) {  // 나눠 돌릴 때: 기준점 목록을 한 번만 만들고 다시 씀
    byTile = new Map(JSON.parse(fs.readFileSync(cache, 'utf8')));
    for (const L of byTile.values()) nA += L.length;
  } else for await (const line of readline.createInterface({ input: fs.createReadStream(candFile) })) {
    const i = line.indexOf('"j":"'); const j = line[i + 5];
    if (!process.env.ANCHOR_ALL && ANCHOR_SKIP.has(j)) continue;
    const o = JSON.parse(line);
    if (o.s < ANCHOR_MIN || (o.approx && o.j === 'ㅎ')) continue;
    let L = byTile.get(o.t); if (!L) byTile.set(o.t, L = []);
    if (L.some(x => x.j === o.j && Math.abs(x.lat - o.lat) < 8e-5 && Math.abs(x.lon - o.lon) < 8e-5 && x.s >= o.s)) continue;
    L.push({ j: o.j, s: o.s, r: o.r, lat: o.lat, lon: o.lon, w: Math.max(o.w, 6), h: Math.max(o.h, 6) }); nA++;
  }
  if (process.env.RESUME && !fs.existsSync(cache)) fs.writeFileSync(cache, JSON.stringify([...byTile]));
  console.log('anchors', nA, 'tiles', byTile.size);
  const ways = readWays(src, true);
  const tiles = [...bucket(ways).entries()].filter(([k]) => byTile.has(k)).sort((x, y) => (byTile.get(y[0]).length * y[1].length) - (byTile.get(x[0]).length * x[1].length));
  const pick = process.env.TILES ? process.env.TILES.split(',') : null;
  let todo = pick ? tiles.filter(t => pick.includes(t[0])) : tiles;
  // RESUME=1 / BUDGET=초 : scan.mjs 와 같음
  const doneSet = process.env.RESUME && fs.existsSync(dst + '.done') ? new Set(fs.readFileSync(dst + '.done', 'utf8').split('\n')) : null;
  if (doneSet) todo = todo.filter(t => !doneSet.has(t[0]));
  const out = process.env.RESUME ? { write: s => fs.appendFileSync(dst, s), end: () => {} } : fs.createWriteStream(dst);
  const budget = +(process.env.BUDGET || 0) * 1000;
  let next = 0, done = 0, live = 0; const t0 = Date.now();
  for (let i = 0; i < workers; i++) {
    const wk = new Worker(new URL(import.meta.url), { workerData: { src, kind: 'glyph', ways } }); live++;
    const feed = () => {
      if (next >= todo.length || (budget && Date.now() - t0 > budget)) return wk.postMessage(null);
      const [k, list] = todo[next++];
      wk.postMessage({ k, list, anchors: byTile.get(k) });
    };
    wk.on('message', m => {
      if (m.ready) return feed();
      let buf = '';
      for (const [ch, L] of m.res) for (const r of L) buf += JSON.stringify({ c: ch, ...r }) + '\n';
      out.write(buf);
      if (process.env.RESUME) fs.appendFileSync(dst + '.done', m.k + '\n');
      done++;
      if (done % 100 === 0 || pick) console.log(`${done}/${todo.length} tiles ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      feed();
    });
    wk.on('exit', () => { if (--live === 0) { out.end(); console.log('done', done, 'left', todo.length - done, ((Date.now() - t0) / 1000).toFixed(0) + 's'); } });
  }
} else if (!isMainThread && workerData?.kind === 'glyph') {
  const ways = workerData.ways || readWays(workerData.src);
  const T = buildSyllableTemplates(process.env.ONLY ? new Set([...process.env.ONLY]) : KSX, process.env.ANCHOR_ALL ? new Set() : undefined);
  parentPort.on('message', m => {
    if (!m) return process.exit(0);
    const [a, b] = m.k.split('_').map(Number);
    let res = [];
    try { res = processTile(ways, m.list, a, b, m.anchors, T); } catch (e) { console.error(m.k, e.stack); }
    parentPort.postMessage({ k: m.k, res });
  });
  parentPort.postMessage({ ready: true });
}

