// Score marker reading on the size_sweep shots: found rate, false reads, heading error.
// Usage: node tools/size_test.js DIR [stock|small]
const fs = require('fs'), path = require('path');
const { PNG } = require('pngjs');
global.CV = require('../node_modules/js-aruco2/src/cv.js').CV;
const { AR } = require('../node_modules/js-aruco2/src/aruco.js');
const E = require('../src/engine.js');
let Reader = null;
try { Reader = require('../src/reader.js'); } catch (e) { /* not built yet */ }

const dir = process.argv[2];
const mode = process.argv[3] || 'stock';
const truth = JSON.parse(fs.readFileSync(path.join(dir, 'sweep.json')));
AR.DICTIONARIES.REGATTA_4X4 = { nBits: 16, tau: 2, codeList: E.CODES };
const KNOWN = new Set([0, 1, 10, 11, 12, 13, 14, 20, 21, 22, 23]);

function stock(img) {
  const det = new AR.Detector({ dictionaryName: 'REGATTA_4X4' });
  return det.detect(img).map((m) => ({ id: m.id, corners: m.corners }));
}
function small(img) { return Reader.detect(img, { AR, CV, codes: E.CODES }); }

const rows = new Map();
for (const s of truth.shots) {
  const png = PNG.sync.read(fs.readFileSync(path.join(dir, s.file)));
  const img = { width: png.width, height: png.height, data: png.data };
  const t0 = Date.now();
  const found = (mode === 'stock' ? stock(img) : small(img)).filter((m) => KNOWN.has(m.id));
  const ms = Date.now() - t0;
  let hit = 0, wrong = 0, hdgErr = [];
  const used = new Set();
  for (const f of found) {
    const c = f.corners.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
    // nearest truth marker
    let best = null, bd = 1e9;
    s.markers.forEach((m, i) => { const d = Math.hypot(m.img[0] - c.x, m.img[1] - c.y); if (d < bd) { bd = d; best = i; } });
    const m = s.markers[best];
    if (bd > 6 * s.pxmm || m.id !== f.id || used.has(best)) { wrong++; continue; }
    used.add(best); hit++;
    const up = { x: (f.corners[0].x + f.corners[1].x - f.corners[2].x - f.corners[3].x) / 2, y: (f.corners[0].y + f.corners[1].y - f.corners[2].y - f.corners[3].y) / 2 };
    const tu = { x: m.imgUp[0] - m.img[0], y: m.imgUp[1] - m.img[1] };
    hdgErr.push(Math.abs(E.signedAngle(tu, up) / E.DEG));
  }
  const r = rows.get(s.pxmm) || { n: 0, hit: 0, wrong: 0, err: [], ms: 0, w: png.width, h: png.height };
  r.n += s.markers.length; r.hit += hit; r.wrong += wrong; r.err.push(...hdgErr); r.ms += ms;
  rows.set(s.pxmm, r);
}
const cell = truth.black / 6;
console.log(`mode=${mode}  black ${truth.black} mm + ${truth.margin} mm margin = ${(truth.black + 2 * truth.margin).toFixed(1)} mm sticker, cell ${cell.toFixed(2)} mm`);
console.log('px/mm  px/cell  found      false  hdg med/p95   ms/MP');
for (const [pxmm, r] of [...rows].sort((a, b) => a[0] - b[0])) {
  const e = r.err.sort((a, b) => a - b), med = e[Math.floor(e.length / 2)] || 0, p95 = e[Math.floor(e.length * 0.95)] || 0;
  const mp = (r.w * r.h * 3) / 1e6;
  console.log(`${pxmm.toFixed(2).padStart(5)}  ${(pxmm * cell).toFixed(1).padStart(6)}  ${String(r.hit).padStart(3)}/${r.n} ${((100 * r.hit) / r.n).toFixed(0).padStart(3)}%  ${String(r.wrong).padStart(4)}   ${med.toFixed(1).padStart(4)}° / ${p95.toFixed(1).padStart(4)}°  ${(r.ms / mp).toFixed(0).padStart(5)}`);
}
