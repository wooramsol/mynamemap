// 검토용 모음 그림: node sheet.mjs pool.jsonl outdir [per=48]
// 칸마다 번호·글자를 적고, 길 묶음을 똑바로 세워(회전 r) 상자에 맞춰 그림
import fs from 'node:fs';
import { chromium } from 'playwright';
const [file, outDir, perArg] = process.argv.slice(2);
const per = +(perArg || 48);
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
fs.mkdirSync(outDir, { recursive: true });
const DEG = Math.PI / 180;
function cell(r) {
  const kx = 111320 * Math.cos(r.lat * DEG), c = Math.cos(-r.r), s = Math.sin(-r.r);
  const P = r.g.map(seg => seg.map(([la, lo]) => { const x = (lo - r.lon) * kx, y = (la - r.lat) * 110540; return [x * c - y * s, -(x * s + y * c)]; }));
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const q of P) for (const [x, y] of q) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, h = Math.max(x1 - x0, y1 - y0) / 2 * 1.15 + 1;
  const path = P.map(q => `<path d="M${q.map(v => v.join(',')).join('L')}" stroke="#111" stroke-width="${h / 14}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
  return `<div class="c"><svg viewBox="${cx - h} ${cy - h} ${2 * h} ${2 * h}" width="118" height="118">${path}</svg><b>${r.id}</b><i>${r.c}</i></div>`;
}
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell' });
const p = await b.newPage({ viewport: { width: 1000, height: 800 } });
for (let k = 0; k * per < rows.length; k++) {
  const part = rows.slice(k * per, (k + 1) * per);
  const html = `<style>body{margin:4px;display:grid;grid-template-columns:repeat(8,122px);gap:3px;font:13px sans-serif}.c{position:relative;border:1px solid #bbb;width:118px;height:118px}.c b{position:absolute;left:2px;top:0;color:#c00;font-size:11px}.c i{position:absolute;right:3px;top:0;font-style:normal;font-size:18px;color:#06c}</style>${part.map(cell).join('')}`;
  await p.setContent(html);
  await p.screenshot({ path: `${outDir}/s${String(k).padStart(3, '0')}.png`, fullPage: true });
}
await b.close();
console.log(Math.ceil(rows.length / per), 'sheets');
