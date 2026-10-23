// Run the real detector + engine on the synthetic photo and compare with ground truth.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
global.CV = require('../node_modules/js-aruco2/src/cv.js').CV;
const { AR } = require('../node_modules/js-aruco2/src/aruco.js');
const E = require('../src/engine.js');

const R = require('../src/reader.js');
const KNOWN = [0, 1, 10, 11, 12, 13, 14, 20, 21, 22, 23];

const dir = process.argv[2] || path.join(__dirname, '../test');

function load(name) { return PNG.sync.read(fs.readFileSync(path.join(dir, name))); }
// read markers the way the app does: full resolution (tiled inside the reader)
function detect(png) {
  const t0 = Date.now();
  const ms = R.detect({ width: png.width, height: png.height, data: png.data }, { AR, CV, codes: E.CODES, ids: KNOWN });
  return { markers: ms, dt: Date.now() - t0, w: png.width, h: png.height };
}

const cfg = E.config();
let fails = 0;
const check = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) fails++; };

const shots = ['sample.png', 'phone.png'].filter((f) => fs.existsSync(path.join(dir, f)));
let png = null;
let truth = null;
for (const shot of shots) {
  png = load(shot);
  truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth-' + shot.replace('.png', '') + '.json')));
  const r = detect(png);
  const ids = r.markers.map((m) => m.id).sort((a, b) => a - b);
  console.log(`\n== ${shot} ${r.w}x${r.h}: ${r.dt} ms, ids ${JSON.stringify(ids)}`);
  check(JSON.stringify(ids) === JSON.stringify([0, 1, 10, 11, 12, 13, 14, 20, 21]), 'all 9 stickers found, no strays');

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
  // local = pieces within 30 cm of each other (what moves, shadows and right of way use); global = whole course
  let maxErr = 0, maxRel = 0, localErr = 0;
  const idsAll = [0, 1, 10, 11, 12, 13, 14, 20, 21];
  for (let i = 0; i < idsAll.length; i++) for (let j = i + 1; j < idsAll.length; j++) {
    const dt = E.V.dist(tpos(idsAll[i]), tpos(idsAll[j])), ds = E.V.dist(spos(idsAll[i]), spos(idsAll[j]));
    maxErr = Math.max(maxErr, Math.abs(dt - ds));
    maxRel = Math.max(maxRel, Math.abs(dt - ds) / dt);
    if (dt < 300) localErr = Math.max(localErr, Math.abs(dt - ds));
  }
  const big = png.width * png.height > 6e6;
  check(localErr < (big ? 3 : 6), `nearby pieces: distance error max ${localErr.toFixed(1)} mm`);
  check(big ? maxErr < 8 : maxRel < 0.03, `whole course: distance error max ${maxErr.toFixed(1)} mm (${(maxRel * 100).toFixed(1)}%)`);
  console.log('  info  fit rms', scene.fitRms && scene.fitRms.toFixed(4), 'warnings', JSON.stringify(scene.warnings));

  // tacks + heading angle relative to wind
  for (const b of scene.boats) {
    const tb = T[b.id];
    const tu = { x: T[0].up[0], y: T[0].up[1] }, th = { x: tb.up[0], y: tb.up[1] };
    const ta = E.signedAngle(tu, th) / E.DEG, sa = E.signedAngle(scene.wind.u, b.heading) / E.DEG;
    check(b.tack === tb.tack && Math.abs(ta - sa) < (big ? 2 : 3), `${b.name.padEnd(9)} ${b.tack.padEnd(9)} off-wind ${sa.toFixed(1)}° (truth ${ta.toFixed(1)}°) turn #${b.turn} ${b.lift || ''}`);
  }
  console.log('  turn order:', scene.order.map((id) => E.BOATS.find((b) => b.id === id).name).join(' > '));
  for (const b of scene.boats) {
    const mv = E.movesFor(scene, b.id, cfg);
    const fmt = (o) => `${o.label}${o.blocked ? ` [BLOCKED ${o.blocked.reason} ${o.blocked.name} @${(o.travelled / cfg.cardW).toFixed(2)}c]` : ''}${o.receive.length ? ' +dirty from ' + o.receive.map((x) => x.name) : ''}${o.give.length ? ' gives dirty to ' + o.give.map((x) => x.name) : ''}`;
    console.log(`  ${b.name}: ` + mv.options.map(fmt).join(' | ') + (mv.fetch && Object.keys(mv.fetch).length ? `  fetch ${JSON.stringify(Object.fromEntries(Object.entries(mv.fetch).map(([k, v]) => [k, v && +v.toFixed(1)])))}` : ''));
  }
}

// manual-wind fallback: drop the dial marker
{
  png = load(shots[0]);
  const r = detect(png);
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
