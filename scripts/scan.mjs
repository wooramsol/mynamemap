// 전국 스캔: ways.bin을 작은 격자(타일)로 나눠 모든 자모 후보를 찾는다
// 사용: node scripts/scan.mjs data/ways.bin data/cands.jsonl [workers]
import fs from 'node:fs';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { buildGraph } from '../js/graph.js';
import { findJamo } from '../js/matcher.js';
import { TEMPLATES } from '../js/templates.js';

const TILE_LAT = 0.04, TILE_LON = 0.05; // 약 4.4km
const BUF = 0.006;                        // 약 600m 겹침 (경계에 걸친 글자도 온전히 보이게)
const JAMO = (process.env.JAMO ? process.env.JAMO.split(',') : Object.keys(TEMPLATES)).filter(j => j !== 'ㅎ'); // ㅎ은 ㅇ 결과를 그대로 씀
const KEEP = 250, MIN_SCORE = 30, MIN_LINE = 45;

function readWays(file) {
  const buf = fs.readFileSync(file);
  let o = 0;
  const n = buf.readUInt32LE(o); o += 4;
  const ways = new Array(n);
  for (let i = 0; i < n; i++) {
    const m = buf.readUInt32LE(o); o += 4;
    const ids = new Float64Array(m), lat = new Float64Array(m), lon = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      ids[k] = Number(buf.readBigInt64LE(o)); lat[k] = buf.readInt32LE(o + 8) / 1e7; lon[k] = buf.readInt32LE(o + 12) / 1e7; o += 16;
    }
    ways[i] = { ids, lat, lon };
  }
  return ways;
}

const tkey = (a, b) => `${a}_${b}`;

// 타일마다 (버퍼 포함) 들어가는 길 조각을 모은다
function bucket(ways) {
  const tiles = new Map();
  for (let wi = 0; wi < ways.length; wi++) {
    const w = ways[wi];
    let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
    for (let k = 0; k < w.lat.length; k++) { la0 = Math.min(la0, w.lat[k]); la1 = Math.max(la1, w.lat[k]); lo0 = Math.min(lo0, w.lon[k]); lo1 = Math.max(lo1, w.lon[k]); }
    const a0 = Math.floor((la0 - BUF) / TILE_LAT), a1 = Math.floor((la1 + BUF) / TILE_LAT);
    const b0 = Math.floor((lo0 - BUF) / TILE_LON), b1 = Math.floor((lo1 + BUF) / TILE_LON);
    for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) {
      const k = tkey(a, b);
      if (!tiles.has(k)) tiles.set(k, []);
      tiles.get(k).push(wi);
    }
  }
  return tiles;
}

function tileElements(ways, list, a, b) {
  const s = a * TILE_LAT - BUF, n = (a + 1) * TILE_LAT + BUF, w = b * TILE_LON - BUF, e = (b + 1) * TILE_LON + BUF;
  const nodes = new Map(), out = [];
  for (const wi of list) {
    const W = ways[wi];
    let run = [];
    const flush = () => { if (run.length > 1) out.push({ type: 'way', nodes: run }); run = []; };
    for (let k = 0; k < W.lat.length; k++) {
      const inside = W.lat[k] >= s && W.lat[k] <= n && W.lon[k] >= w && W.lon[k] <= e;
      if (!inside) { flush(); continue; }
      const id = W.ids[k];
      if (!nodes.has(id)) nodes.set(id, { type: 'node', id, lat: W.lat[k], lon: W.lon[k] });
      run.push(id);
    }
    flush();
  }
  return { elements: [...nodes.values(), ...out] };
}

function describe(G, m) {
  // 글자 방향(r)으로 세운 좌표에서의 상자와 중심
  const c = Math.cos(-m.r), s = Math.sin(-m.r);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  const geom = [];
  for (const eid of m.edges) {
    const E = G.edges[eid];
    for (const [x, y] of E.pts) {
      const u = x * c - y * s, v = x * s + y * c;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    geom.push(E.ll.map(([la, lo]) => [+la.toFixed(6), +lo.toFixed(6)]));
  }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  // 중심을 원래 좌표로 되돌림
  const ci = Math.cos(m.r), si = Math.sin(m.r);
  const [lat, lon] = G.proj.inv(cu * ci - cv * si, cu * si + cv * ci);
  return { lat: +lat.toFixed(6), lon: +lon.toFixed(6), w: Math.round(u1 - u0), h: Math.round(v1 - v0), geom };
}

function scanTile(ways, list, a, b) {
  const osm = tileElements(ways, list, a, b);
  if (osm.elements.length < 4) return [];
  const clat = (a + 0.5) * TILE_LAT, clon = (b + 0.5) * TILE_LON;
  const G = buildGraph(osm, [clat, clon]);
  const res = [];
  for (const j of JAMO) {
    const tpl = TEMPLATES[j];
    const isLine = !Array.isArray(tpl) && tpl.line;
    const ms = findJamo(G, j, { limit: KEEP * 2, timeBudgetMs: 20000, minScore: isLine ? MIN_LINE : MIN_SCORE });
    let kept = 0;
    for (const m of ms) {
      const d = describe(G, m);
      // 중심이 이 타일의 본래 영역 안에 있는 것만 (겹침 영역 중복 방지)
      if (d.lat < a * TILE_LAT || d.lat >= (a + 1) * TILE_LAT || d.lon < b * TILE_LON || d.lon >= (b + 1) * TILE_LON) continue;
      const rec = { j, s: m.score, r: +m.r.toFixed(3), size: m.size, ...d };
      res.push(rec);
      if (j === 'ㅇ') res.push({ ...rec, j: 'ㅎ', approx: 1 });
      if (++kept >= KEEP) break;
    }
  }
  return res;
}

export { readWays, bucket, tileElements, scanTile };
if (isMainThread && !process.env.NOMAIN) {
  const [src, dst, nw] = process.argv.slice(2);
  const workers = +(nw || os.cpus().length);
  console.time('read');
  const ways = readWays(src);
  console.timeEnd('read');
  let tiles = [...bucket(ways).entries()].sort((x, y) => y[1].length - x[1].length);
  if (process.env.TILES) { const want = process.env.TILES.split(','); tiles = want.map(k => want.length && tiles.find(t => t[0] === k) || tiles[+k]).filter(Boolean); }
  console.log('ways', ways.length, 'tiles', tiles.length);
  const out = fs.createWriteStream(dst);
  let next = 0, done = 0, total = 0;
  const t0 = Date.now();
  const sab = null;
  const pool = [];
  // 워커에게 ways 전체를 넘기는 대신 파일 경로를 넘겨 각자 읽게 함
  for (let i = 0; i < workers; i++) {
    const wk = new Worker(new URL(import.meta.url), { workerData: { src } });
    const feed = () => {
      if (next >= tiles.length) { wk.postMessage(null); return; }
      const [k, list] = tiles[next++];
      wk.postMessage({ k, list });
    };
    wk.on('message', msg => {
      if (msg.ready) return feed();
      for (const r of msg.res) out.write(JSON.stringify({ t: msg.k, ...r }) + '\n');
      total += msg.res.length; done++;
      if (done % 200 === 0 || process.env.TILES) console.log(`${done}/${tiles.length} tiles, ${total} cands, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      feed();
    });
    wk.on('exit', () => { pool.splice(pool.indexOf(wk), 1); if (!pool.length) { out.end(); console.log('done', done, total, ((Date.now() - t0) / 1000).toFixed(0) + 's'); } });
    pool.push(wk);
  }
} else if (!isMainThread) {
  const ways = readWays(workerData.src);
  parentPort.on('message', msg => {
    if (!msg) return process.exit(0);
    const [a, b] = msg.k.split('_').map(Number);
    let res = [];
    try { res = scanTile(ways, msg.list, a, b); } catch (e) { console.error(msg.k, e.message); }
    parentPort.postMessage({ k: msg.k, res });
  });
  parentPort.postMessage({ ready: true });
}
