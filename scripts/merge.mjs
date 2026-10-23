// 두 방식의 전국 결과를 합쳐 사이트용 data/ 만들기
//  - compose.mjs: 자모 후보가 음절 배치로 붙어 있는 곳 (점수 20 이상)
//  - glyph.mjs  : 길 묶음 전체가 음절 글꼴 모양과 겹치는 곳 (점수 42 이상)
// 사용: node scripts/merge.mjs <compose 결과 폴더> work/glyph.jsonl data
import fs from 'node:fs';
import readline from 'node:readline';

const [composeDir, glyphFile, outDir] = process.argv.slice(2);
const MIN_COMPOSE = 20, MIN_GLYPH = 42, TOP = 3; // 모양 비교는 42점 아래부터 지저분한 경우가 많아 제외

const all = new Map(); // 음절 -> 후보들
const add = (ch, c) => { if (!all.has(ch)) all.set(ch, []); all.get(ch).push(c); };
for (let i = 0; i < 19; i++) {
  const f = `${composeDir}/syl/${i}.json`;
  if (!fs.existsSync(f)) continue;
  for (const [ch, L] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8'))))
    for (const c of L) if (c.k !== 'c' && c.s >= MIN_COMPOSE) add(ch, { ...c, m: 'j' });
}
let g = 0;
for await (const line of readline.createInterface({ input: fs.createReadStream(glyphFile) })) {
  const o = JSON.parse(line);
  if (o.s < MIN_GLYPH) continue;
  g++;
  add(o.c, { s: o.s, lat: o.lat, lon: o.lon, r: o.r, size: o.size, m: 'g', parts: [{ j: o.c, s: o.s, r: o.r, lat: o.lat, lon: o.lon, g: o.g }] });
}

const shards = Array.from({ length: 19 }, () => ({}));
let n = 0, byG = 0;
for (const [ch, L] of all) {
  L.sort((a, b) => b.s - a.s);
  const out = [];
  for (const c of L) {
    if (out.some(o => Math.hypot((o.lat - c.lat) * 110540, (o.lon - c.lon) * 88000) < 300)) continue;
    out.push(c); if (out.length >= TOP) break;
  }
  shards[Math.floor((ch.charCodeAt(0) - 0xAC00) / 588)][ch] = out;
  n++; if (out[0].m === 'g') byG++;
}
fs.mkdirSync(`${outDir}/syl`, { recursive: true });
shards.forEach((sh, i) => fs.writeFileSync(`${outDir}/syl/${i}.json`, JSON.stringify(sh)));
fs.writeFileSync(`${outDir}/meta.json`, JSON.stringify({ built: new Date().toISOString().slice(0, 10), syllables: n, bestFromGlyph: byG }));
console.log('glyph rows', g, 'syllables', n, 'best from glyph', byG);
