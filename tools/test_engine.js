// Run the real detector + engine on the synthetic photo and compare with ground truth.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
global.CV = require('../node_modules/js-aruco2/src/cv.js').CV;
const { AR } = require('../node_modules/js-aruco2/src/aruco.js');
const E = require('../src/engine.js');

AR.DICTIONARIES.REGATTA_4X4 = { nBits: 16, tau: 2, codeList: E.CODES };

const dir = process.argv[2] || path.join(__dirname, '../test');
const png = PNG.sync.read(fs.readFileSync(path.join(dir, 'sample.png')));
const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json')));

function detect(img, maxW) {
  // downscale like the browser does
  const k = Math.min(1, maxW / img.width);
  const w = Math.round(img.width * k), h = Math.round(img.height * k);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(img.width - 1, Math.round(x / k)), sy = Math.min(img.height - 1, Math.round(y / k));
    const si = (sy * img.width + sx) * 4, di = (y * w + x) * 4;
    data[di] = img.data[si]; data[di + 1] = img.data[si + 1]; data[di + 2] = img.data[si + 2]; data[di + 3] = 255;
  }
  const det = new AR.Detector({ dictionaryName: 'REGATTA_4X4' });
  const t0 = Date.now();
  const ms = det.detect({ width: w, height: h, data });
  // (the app also runs a second, smaller pass and merges by id)
  const dt = Date.now() - t0;
  return { markers: ms.map((m) => ({ id: m.id, hd: m.hammingDistance, corners: m.corners.map((c) => ({ x: c.x / k, y: c.y / k })) })), dt, w, h };
}

const cfg = E.config();
let fails = 0;
const check = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) fails++; };

for (const maxW of [1200, 960, 720]) {
  const r = detect(png, maxW);
  const ids = r.markers.map((m) => m.id).sort((a, b) => a - b);
  console.log(`\n== detect at ${r.w}x${r.h}: ${r.dt} ms, ids ${JSON.stringify(ids)}`);
  if (maxW !== 1200) { console.log('  info  (lower res is only informational)'); continue; }
  check(JSON.stringify(ids) === JSON.stringify([0, 1, 10, 11, 12, 13, 14, 20, 21]), 'all 9 markers found, no strays');

  // corner order: corner 0 should be marker top-left in plane truth
  const scene = E.solveScene(r.markers, cfg, { imgW: png.width, imgH: png.height });
  check(scene.ok && scene.ref === 0, 'scene solved from wind dial marker');
  check(scene.wind.src === 'dial', 'wind read from the dial');
  check(scene.course && scene.course.src === 'course', 'course axis from course marker');
  check(Math.abs(scene.wind.dial - truth.dial) < 0.2, `dial reads ${scene.wind.dial.toFixed(2)} (truth ${truth.dial})`);
  check(scene.favored === 'port', 'dial +1 favours port: ' + scene.favored);

  // distances between markers vs truth (frame-independent)
  const T = truth.markers;
  const tpos = (id) => ({ x: T[id].pos[0], y: T[id].pos[1] });
  const spos = (id) => (id === 0 ? scene.windMarker.pos : id === 1 ? scene.courseMarker.pos : (scene.boats.find((b) => b.id === id) || scene.marks[id]).pos);
  let maxErr = 0;
  const idsAll = [0, 1, 10, 11, 12, 13, 14, 20, 21];
  for (let i = 0; i < idsAll.length; i++) for (let j = i + 1; j < idsAll.length; j++) {
    const dt = E.V.dist(tpos(idsAll[i]), tpos(idsAll[j])), ds = E.V.dist(spos(idsAll[i]), spos(idsAll[j]));
    maxErr = Math.max(maxErr, Math.abs(dt - ds));
  }
  check(maxErr < 12, `pairwise distance error max ${maxErr.toFixed(1)} mm (course is ~900 mm long)`);

  // tacks + heading angle relative to wind
  for (const b of scene.boats) {
    const tb = T[b.id];
    const tu = { x: T[0].up[0], y: T[0].up[1] }, th = { x: tb.up[0], y: tb.up[1] };
    const ta = E.signedAngle(tu, th) / E.DEG, sa = E.signedAngle(scene.wind.u, b.heading) / E.DEG;
    check(b.tack === tb.tack && Math.abs(ta - sa) < 4, `${b.name.padEnd(9)} ${b.tack.padEnd(9)} off-wind ${sa.toFixed(1)}° (truth ${ta.toFixed(1)}°) turn #${b.turn} ${b.lift || ''}`);
  }
  console.log('  turn order:', scene.order.map((id) => E.BOATS.find((b) => b.id === id).name).join(' > '));
  for (const b of scene.boats) {
    const mv = E.movesFor(scene, b.id, cfg);
    const fmt = (o) => `${o.label}${o.blocked ? ` [BLOCKED ${o.blocked.reason} ${o.blocked.name} @${(o.travelled / cfg.cardW).toFixed(2)}c]` : ''}${o.receive.length ? ' +dirty from ' + o.receive.map((x) => x.name) : ''}${o.give.length ? ' gives dirty to ' + o.give.map((x) => x.name) : ''}`;
    console.log(`  ${b.name}: ` + mv.options.map(fmt).join(' | ') + (mv.fetch && Object.keys(mv.fetch).length ? `  fetch ${JSON.stringify(Object.fromEntries(Object.entries(mv.fetch).map(([k, v]) => [k, v && +v.toFixed(1)])))}` : ''));
  }
  fs.writeFileSync(path.join(dir, 'detections.json'), JSON.stringify(r.markers));
}

// manual-wind fallback: drop the dial marker
{
  const r = detect(png, 1200);
  const noDial = r.markers.filter((m) => m.id !== 0);
  const s2 = E.solveScene(noDial, cfg, { imgW: png.width, imgH: png.height, dial: 1 });
  check(s2.ok && s2.wind.src === 'manual' && s2.course.src === 'course', 'no dial in view -> course marker + manual dial');
  const s1 = E.solveScene(r.markers, cfg, { imgW: png.width, imgH: png.height });
  const tacks1 = s1.boats.map((b) => b.tack).join(), tacks2 = s2.boats.map((b) => b.tack).join();
  check(tacks1 === tacks2, 'same tacks with manual dial = +1');
  const s3 = E.solveScene(noDial.filter((m) => m.id !== 1), cfg, { imgW: png.width, imgH: png.height, dial: 1 });
  check(s3.ok && s3.course.src === 'finish', 'no dial, no course marker -> finish line sets the course axis');
}

// wind roll odds match the table on p.9
{
  let n = 200000, hist = {};
  for (let i = 0; i < n; i++) { const d = E.rollWind().delta; hist[d] = (hist[d] || 0) + 1; }
  const p0 = hist[0] / n;
  check(Math.abs(p0 - 20 / 64) < 0.01, `P(shift 0) = ${(p0 * 100).toFixed(1)}% (rules say 31%)`);
}
console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
