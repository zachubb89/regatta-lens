/* Regatta Lens engine: marker IDs, table-plane geometry, and the Regatta rules.
   Pure functions, no DOM. Units on the table plane are millimetres.
   Plane axes: x to the right, y down (same handedness as an image),
   so rot(v, +θ) turns clockwise on screen. */
(function (root) {
  'use strict';

  const DEG = Math.PI / 180;

  // Boat meeple colours follow the rules doc (page 3), left to right.
  const BOATS = [
    { id: 10, key: 'blue', name: 'Blue', color: '#4BA3DB', ink: '#0B1A26' },
    { id: 11, key: 'navy', name: 'Navy', color: '#22335C', ink: '#FFFFFF' },
    { id: 12, key: 'green', name: 'Green', color: '#2F7A34', ink: '#FFFFFF' },
    { id: 13, key: 'dkblue', name: 'Dark Blue', color: '#2D5B7B', ink: '#FFFFFF' },
    { id: 14, key: 'purple', name: 'Purple', color: '#8E2D8F', ink: '#FFFFFF' },
  ];
  const IDS = { WIND: 0, COURSE: 1, FINISH_A: 20, FINISH_B: 21, START_1: 22, START_2: 23 };
  const MARKS = [
    { id: 20, label: 'A', role: 'finish' },
    { id: 21, label: 'B', role: 'finish' },
    { id: 22, label: 'C', role: 'start' },
    { id: 23, label: 'C', role: 'start' },
  ];

  // First 24 codes of the ArUco 4x4 family (same bits as OpenCV DICT_4X4_50 ids 0-23).
  // Minimum Hamming distance between them, rotations included, is 5.
  const CODES = [[181,50],[15,154],[51,45],[153,70],[84,158],[121,205],[158,46],[196,242],[254,218],[207,86],[249,145],[17,167],[14,183],[42,15],[36,177],[38,62],[70,101],[102,0],[108,94],[118,175],[134,139],[176,43],[204,213],[221,130]];

  const DEFAULTS = {
    cardW: 63.5,       // card width = one move (rules p.6)
    cardL: 88.9,       // card length
    closeHauled: 45,   // degrees off the wind (the dial's PORT / STARBOARD arrows)
    lowest: 135,       // how far "lower" the fan reaches, degrees off the wind
    tickDeg: 20,       // one wind dial tick
    dial: 0,           // manual dial value when the dial marker is not in view
    collideR: 26,      // boats closer than this (centre to centre) are touching
    boatLen: 46, boatBeam: 30, // ghost meeple size
    marker: { wind: 40, course: 40, boat: 20, mark: 25 }, // black square edge, mm
  };

  function config(over) {
    const c = JSON.parse(JSON.stringify(DEFAULTS));
    if (over) {
      for (const k of Object.keys(over)) {
        if (k === 'marker') Object.assign(c.marker, over.marker);
        else c[k] = over[k];
      }
    }
    return c;
  }

  function markerSize(id, cfg) {
    if (id === IDS.WIND) return cfg.marker.wind;
    if (id === IDS.COURSE) return cfg.marker.course;
    if (id >= 10 && id <= 14) return cfg.marker.boat;
    if (id >= 20 && id <= 23) return cfg.marker.mark;
    return null;
  }
  const knownId = (id) => markerSize(id, DEFAULTS) != null;
  const boatInfo = (id) => BOATS.find((b) => b.id === id);

  // ---------- vector + projective helpers ----------
  const V = {
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    mul: (a, k) => ({ x: a.x * k, y: a.y * k }),
    dot: (a, b) => a.x * b.x + a.y * b.y,
    cross: (a, b) => a.x * b.y - a.y * b.x,
    len: (a) => Math.hypot(a.x, a.y),
    norm: (a) => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; },
    rot: (a, t) => { const c = Math.cos(t), s = Math.sin(t); return { x: a.x * c - a.y * s, y: a.x * s + a.y * c }; },
    mid: (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
    lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
    dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  };
  // signed angle from a to b, radians, positive = clockwise on screen
  const signedAngle = (a, b) => Math.atan2(V.cross(a, b), V.dot(a, b));

  function solve(A, b) { // Gaussian elimination, partial pivoting
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
      const d = A[i][i];
      if (Math.abs(d) < 1e-12) return null;
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / d;
        if (!f) continue;
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / A[i][i];
    }
    return x;
  }

  // 3x3 homography (row-major, 9 numbers) mapping src[i] -> dst[i], 4 points
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i], X = dst[i].x, Y = dst[i].y;
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
    }
    const h = solve(A, b);
    return h ? [...h, 1] : null;
  }
  function applyH(H, p) {
    const w = H[6] * p.x + H[7] * p.y + H[8];
    return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
  }
  function invert3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-15) return null;
    const r = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
    return r.map((v) => v / det);
  }
  const polyArea = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a.x * b.y - b.x * a.y; } return Math.abs(s) / 2; };

  // rectangle starting at `origin`, running `length` along unit `dir`, `width` across
  function rectAlong(origin, dir, length, width) {
    const n = { x: -dir.y, y: dir.x }, hw = width / 2;
    const far = V.add(origin, V.mul(dir, length));
    return [V.add(origin, V.mul(n, hw)), V.add(far, V.mul(n, hw)), V.sub(far, V.mul(n, hw)), V.sub(origin, V.mul(n, hw))];
  }
  function inConvex(poly, p) {
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const c = V.cross(V.sub(b, a), V.sub(p, a));
      if (Math.abs(c) < 1e-9) continue;
      const s = c > 0 ? 1 : -1;
      if (!sign) sign = s; else if (s !== sign) return false;
    }
    return true;
  }
  function segIntersect(p, r, a, b) { // ray/segment p + t*r vs segment a..b; returns t>=0 or null
    const s = V.sub(b, a), den = V.cross(r, s);
    if (Math.abs(den) < 1e-9) return null;
    const ap = V.sub(a, p), t = V.cross(ap, s) / den, u = V.cross(ap, r) / den;
    return t >= 0 && u >= 0 && u <= 1 ? t : null;
  }

  // ---------- multi-marker refinement ----------
  // One small marker gives a shaky homography far from itself. Every marker of
  // known size is a square on the same table, so we solve for the projective +
  // affine part K (4 numbers) that makes all of them square AND the same scale,
  // then take rotation/translation from the reference marker.
  function refineHomography(list, cfg, Href, ref, imgW, imgH) {
    if (list.length < 2) return { H: Href, rms: null };
    const sc = 2 / Math.max(imgW, imgH);
    const N = [sc, 0, -imgW / 2 * sc, 0, sc, -imgH / 2 * sc, 0, 0, 1];
    const Ni = invert3(N);
    const quads = list.map((d) => ({ id: d.id, s: markerSize(d.id, cfg), q: d.corners.map((p) => applyH(N, p)), w: Math.sqrt(d.area) }));
    const wMean = quads.reduce((a, q) => a + q.w, 0) / quads.length;
    quads.forEach((q) => (q.w = Math.min(2, q.w / wMean)));

    // initial guess from the single-marker homography: H' = Href * N^-1 ~ Sim * A * P
    const Hp = mul3(Href, Ni);
    const l1 = Hp[6] / Hp[8], l2 = Hp[7] / Hp[8];
    const Pinv = [1, 0, 0, 0, 1, 0, -l1, -l2, 1];
    const M = mul3(Hp, Pinv);
    const B00 = M[0] / M[8], B01 = M[1] / M[8], B10 = M[3] / M[8], B11 = M[4] / M[8];
    const t00 = Math.hypot(B00, B10), q1 = { x: B00 / t00, y: B10 / t00 };
    const t01 = q1.x * B01 + q1.y * B11;
    const t11 = Math.hypot(B01 - t01 * q1.x, B11 - t01 * q1.y);
    let p = [t00 / t11, t01 / t11, l1, l2];

    const Kof = (p) => [p[0], p[1], 0, 0, 1, 0, p[2], p[3], 1];
    const resid = (p) => {
      const K = Kof(p);
      const mapped = quads.map((q) => q.q.map((c) => applyH(K, c)));
      let sum = 0, n = 0;
      mapped.forEach((m, i) => { for (let j = 0; j < 4; j++) { sum += V.dist(m[j], m[(j + 1) % 4]) / quads[i].s; n++; } });
      const sigma = sum / n;
      const r = [];
      mapped.forEach((m, i) => {
        const s = quads[i].s * sigma, w = quads[i].w;
        for (let j = 0; j < 4; j++) r.push(w * (V.dist(m[j], m[(j + 1) % 4]) / s - 1));
        r.push(w * (V.dist(m[0], m[2]) / (s * Math.SQRT2) - 1));
        r.push(w * (V.dist(m[1], m[3]) / (s * Math.SQRT2) - 1));
      });
      return { r, sigma };
    };
    const sq = (r) => r.reduce((a, v) => a + v * v, 0);
    let cur = resid(p), cost = sq(cur.r), lambda = 1e-3;
    for (let it = 0; it < 40; it++) {
      const J = [], h = 1e-6;
      for (let k = 0; k < 4; k++) {
        const pp = p.slice(); pp[k] += h;
        const rr = resid(pp).r;
        J.push(rr.map((v, i) => (v - cur.r[i]) / h));
      }
      const JTJ = [0, 1, 2, 3].map((a) => [0, 1, 2, 3].map((b) => J[a].reduce((s, v, i) => s + v * J[b][i], 0)));
      const JTr = [0, 1, 2, 3].map((a) => J[a].reduce((s, v, i) => s + v * cur.r[i], 0));
      let improved = false;
      for (let tries = 0; tries < 8 && !improved; tries++) {
        const A = JTJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
        const step = solve(A, JTr.map((v) => -v));
        if (!step) { lambda *= 10; continue; }
        const np = p.map((v, i) => v + step[i]);
        if (np[0] <= 0.05) { lambda *= 10; continue; }
        const nr = resid(np), nc = sq(nr.r);
        if (nc < cost) { p = np; cur = nr; improved = cost - nc > 1e-12; cost = nc; lambda = Math.max(1e-9, lambda / 5); }
        else lambda *= 10;
      }
      if (!improved) break;
    }
    // similarity from the reference marker, with the shared scale
    const K = Kof(p);
    const kq = ref.corners.map((c) => applyH(K, applyH(N, c)));
    const s = markerSize(ref.id, cfg);
    const sqr = [{ x: -s / 2, y: -s / 2 }, { x: s / 2, y: -s / 2 }, { x: s / 2, y: s / 2 }, { x: -s / 2, y: s / 2 }];
    const kc = V.mul(kq.reduce((a, c) => V.add(a, c), { x: 0, y: 0 }), 0.25);
    let re = 0, im = 0;
    kq.forEach((z, i) => { const zx = z.x - kc.x, zy = z.y - kc.y, w = sqr[i]; re += zx * w.x + zy * w.y; im += zx * w.y - zy * w.x; });
    const ang = Math.atan2(im, re), scale = 1 / cur.sigma;
    const c = Math.cos(ang) * scale, sn = Math.sin(ang) * scale;
    const Sim = [c, -sn, -(c * kc.x - sn * kc.y), sn, c, -(sn * kc.x + c * kc.y), 0, 0, 1];
    const H = mul3(Sim, mul3(K, N));
    return { H, rms: Math.sqrt(cost / cur.r.length) };
  }
  function squareError(d, H, cfg) {
    const m = d.corners.map((c) => applyH(H, c)), s = markerSize(d.id, cfg);
    let e = 0;
    for (let j = 0; j < 4; j++) e = Math.max(e, Math.abs(V.dist(m[j], m[(j + 1) % 4]) / s - 1));
    return e;
  }
  function mul3(a, b) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return r;
  }

  // ---------- detections -> table scene ----------
  // dets: [{id, corners:[{x,y} x4]}] in image pixels, corner 0 = marker top-left, clockwise.
  // opts: {imgW, imgH, dial} (dial = manual wind dial value, used only without the dial marker)
  function solveScene(dets, cfg, opts) {
    opts = opts || {};
    const byId = new Map();
    for (const d of dets) {
      if (!knownId(d.id)) continue;
      const area = polyArea(d.corners), hd = d.hd || 0;
      const prev = byId.get(d.id);
      if (!prev || prev.hd > hd || (prev.hd === hd && prev.area < area)) byId.set(d.id, { id: d.id, corners: d.corners, area, hd });
    }
    const scene = { ok: false, boats: [], marks: {}, warnings: [], ref: null, H: null, Hi: null, wind: null, course: null };
    if (!byId.size) { scene.reason = 'no-markers'; return scene; }

    let ref = byId.get(IDS.WIND) || byId.get(IDS.COURSE);
    if (!ref) ref = [...byId.values()].sort((a, b) => b.area - a.area)[0];
    const s = markerSize(ref.id, cfg);
    const sq = [{ x: -s / 2, y: -s / 2 }, { x: s / 2, y: -s / 2 }, { x: s / 2, y: s / 2 }, { x: -s / 2, y: s / 2 }];
    let H = homography(ref.corners, sq);
    let rms = null;
    if (H && opts.imgW && opts.refine !== false) {
      let pool = [...byId.values()];
      for (let round = 0; round < 3; round++) {
        const out = refineHomography(pool, cfg, H, ref, opts.imgW, opts.imgH);
        if (!out.H || !invert3(out.H)) break;
        H = out.H; rms = out.rms;
        // drop a marker that refuses to be a square of its printed size (misread or wrong size)
        const bad = pool.filter((d) => d.id !== ref.id).map((d) => ({ d, e: squareError(d, H, cfg) })).sort((a, b) => b.e - a.e)[0];
        if (!bad || bad.e < 0.18 || pool.length <= 2) break;
        pool = pool.filter((d) => d !== bad.d);
        byId.delete(bad.d.id);
        scene.warnings.push({ code: 'outlier', id: bad.d.id, err: bad.e });
      }
    }
    const Hi = H && invert3(H);
    scene.fitRms = rms;
    if (!H || !Hi) { scene.reason = 'bad-geometry'; return scene; }
    Object.assign(scene, { ok: true, ref: ref.id, H, Hi });

    const pose = (d) => {
      const pc = d.corners.map((p) => applyH(H, p));
      const center = applyH(H, {
        x: (d.corners[0].x + d.corners[1].x + d.corners[2].x + d.corners[3].x) / 4,
        y: (d.corners[0].y + d.corners[1].y + d.corners[2].y + d.corners[3].y) / 4,
      });
      // true centre = diagonal intersection (perspective-correct)
      const t = segIntersect(pc[0], V.sub(pc[2], pc[0]), pc[1], pc[3]);
      const pos = t != null ? V.add(pc[0], V.mul(V.sub(pc[2], pc[0]), t)) : center;
      const up = V.norm(V.sub(V.mid(pc[0], pc[1]), V.mid(pc[3], pc[2])));
      const size = (V.dist(pc[0], pc[1]) + V.dist(pc[1], pc[2]) + V.dist(pc[2], pc[3]) + V.dist(pc[3], pc[0])) / 4;
      const imgC = { x: (d.corners[0].x + d.corners[2].x) / 2, y: (d.corners[0].y + d.corners[2].y) / 2 };
      return { pos, up, size, corners: pc, img: imgC, imgCorners: d.corners };
    };

    for (const [id, d] of byId) {
      const p = pose(d);
      const expected = markerSize(id, cfg);
      if (id !== ref.id && Math.abs(p.size / expected - 1) > 0.3) {
        scene.warnings.push({ code: 'size', id, ratio: p.size / expected });
      }
      if (id === IDS.WIND) scene.windMarker = p;
      else if (id === IDS.COURSE) scene.courseMarker = p;
      else if (id >= 10 && id <= 14) {
        const info = boatInfo(id);
        scene.boats.push({ ...info, pos: p.pos, heading: p.up, img: p.img, imgCorners: p.imgCorners, size: p.size });
      } else if (id >= 20 && id <= 23) {
        const m = MARKS.find((k) => k.id === id);
        scene.marks[id] = { ...m, pos: p.pos, img: p.img };
      }
    }

    // course axis: course marker > finish line > start line > top of the photo
    let c = null, cSrc = null;
    const A = scene.marks[IDS.FINISH_A], B = scene.marks[IDS.FINISH_B];
    if (scene.courseMarker) { c = scene.courseMarker.up; cSrc = 'course'; }
    else if (A && B) { c = V.rot(V.norm(V.sub(B.pos, A.pos)), -90 * DEG); cSrc = 'finish'; }
    let screenUp = null;
    if (opts.imgW) {
      const ic = { x: opts.imgW / 2, y: opts.imgH / 2 };
      screenUp = V.norm(V.sub(applyH(H, { x: ic.x, y: ic.y - 30 }), applyH(H, ic)));
    }
    let u, uSrc, dial = null;
    if (scene.windMarker) {
      u = scene.windMarker.up; uSrc = 'dial';
      if (c) dial = -signedAngle(c, u) / DEG / cfg.tickDeg;
    } else {
      if (!c && screenUp) { c = screenUp; cSrc = 'screen'; }
      if (!c) { c = { x: 0, y: -1 }; cSrc = 'screen'; }
      dial = opts.dial != null ? opts.dial : cfg.dial;
      u = V.rot(c, -dial * cfg.tickDeg * DEG); uSrc = 'manual';
    }
    scene.course = c ? { c, src: cSrc } : null;
    scene.wind = { u, src: uSrc, dial, dialRounded: dial == null ? null : Math.round(dial) };
    return analyze(scene, cfg);
  }

  // a scene built directly from known poses (sandbox mode)
  function sceneFromPoses(boats, marks, cfg, dial) {
    const c = { x: 0, y: -1 };
    const u = V.rot(c, -dial * cfg.tickDeg * DEG);
    const scene = {
      ok: true, warnings: [], ref: 'sandbox',
      boats: boats.map((b) => ({ ...boatInfo(b.id), pos: { ...b.pos }, heading: V.norm(b.heading) })),
      marks: {}, course: { c, src: 'sandbox' }, wind: { u, src: 'manual', dial, dialRounded: Math.round(dial) },
    };
    for (const m of marks || []) scene.marks[m.id] = { ...MARKS.find((k) => k.id === m.id), pos: { ...m.pos } };
    return analyze(scene, cfg);
  }

  function closeHauledDirs(u, cfg) {
    return { port: V.rot(u, cfg.closeHauled * DEG), starboard: V.rot(u, -cfg.closeHauled * DEG) };
  }

  function analyze(scene, cfg) {
    const u = scene.wind.u;
    const right = V.rot(u, 90 * DEG);
    const dirs = closeHauledDirs(u, cfg);
    scene.dirs = dirs;
    for (const b of scene.boats) {
      const a = signedAngle(u, b.heading) / DEG;
      b.offWind = Math.abs(a);
      b.tack = a >= 0 ? 'port' : 'starboard';
      b.inIrons = b.offWind < cfg.closeHauled - 10;
      b.shadow = rectAlong(b.pos, V.mul(u, -1), cfg.cardL, cfg.cardW);
      b.control = b.tack === 'starboard' ? rectAlong(b.pos, b.heading, cfg.cardL, cfg.cardW) : null;
      b.upwind = V.dot(b.pos, u);
      b.across = V.dot(b.pos, right);
    }
    // turn order: highest into the wind first; level boats -> furthest right first
    const order = [...scene.boats].sort((p, q) => (Math.abs(q.upwind - p.upwind) > 4 ? q.upwind - p.upwind : q.across - p.across));
    order.forEach((b, i) => (b.turn = i + 1));
    scene.order = order.map((b) => b.id);

    // which tack does the shift favour?
    scene.favored = null;
    if (scene.course && scene.course.src !== 'screen') {
      const c = scene.course.c;
      const dp = V.dot(dirs.port, c), ds = V.dot(dirs.starboard, c);
      scene.favored = Math.abs(dp - ds) < 0.03 ? 'even' : dp > ds ? 'port' : 'starboard';
      for (const b of scene.boats) b.lift = scene.favored === 'even' ? 'even' : b.tack === scene.favored ? 'lifted' : 'headed';
    }

    // laylines for the finish line (outer bounds: port from A, starboard from B)
    const A = scene.marks[IDS.FINISH_A], B = scene.marks[IDS.FINISH_B];
    scene.laylines = [];
    if (A && B) {
      const L = 1400;
      scene.laylines.push({ tack: 'port', from: A.pos, to: V.add(A.pos, V.mul(dirs.port, -L)) });
      scene.laylines.push({ tack: 'starboard', from: B.pos, to: V.add(B.pos, V.mul(dirs.starboard, -L)) });
      scene.finish = { a: A.pos, b: B.pos };
    }
    return scene;
  }

  // ---------- move options for one boat ----------
  function evalMove(scene, boat, opt, cfg) {
    const others = scene.boats.filter((o) => o.id !== boat.id);
    const start = opt.path[0], goal = opt.path[opt.path.length - 1];
    const dist = V.dist(start, goal);
    const steps = Math.max(1, Math.ceil(dist / 2));
    let stopT = 1, blockedBy = null, reason = null;
    const receive = new Set();
    const movingTack = opt.kind === 'roll-a' ? opt.tack : boat.tack;
    for (let i = 1; i <= steps && dist > 0; i++) {
      const t = i / steps, p = V.lerp(start, goal, t), travelled = t * dist;
      for (const o of others) {
        if (V.dist(p, o.pos) < cfg.collideR) { blockedBy = o; reason = 'collision'; break; }
        if (movingTack === 'port' && o.control && travelled > 4 && inConvex(o.control, p)) { blockedBy = o; reason = 'give-way'; break; }
      }
      if (blockedBy) { stopT = Math.max(0, (i - 1) / steps); break; }
      if (travelled > 4) for (const o of others) if (inConvex(o.shadow, p)) receive.add(o.id);
    }
    const end = V.lerp(start, goal, stopT);
    const give = new Set();
    if (dist > 0 && stopT > 0) {
      const myShadow = rectAlong(end, V.mul(scene.wind.u, -1), cfg.cardL, cfg.cardW);
      for (const o of others) if (inConvex(myShadow, o.pos)) give.add(o.id);
    }
    const name = (id) => boatInfo(id).name;
    return {
      ...opt, start, goal, end, stopT, travelled: dist * stopT,
      blocked: blockedBy ? { id: blockedBy.id, name: blockedBy.name, reason } : null,
      receive: [...receive].map((id) => ({ id, name: name(id) })),
      give: [...give].map((id) => ({ id, name: name(id) })),
    };
  }

  function movesFor(scene, boatId, cfg) {
    const b = scene.boats.find((x) => x.id === boatId);
    if (!b) return null;
    const u = scene.wind.u, ch = cfg.closeHauled * DEG;
    const side = b.tack === 'port' ? 1 : -1;
    const dCur = V.rot(u, side * ch), dOther = V.rot(u, -side * ch);
    const other = b.tack === 'port' ? 'starboard' : 'port';
    const W = cfg.cardW;
    const opts = [];
    for (let k = 1; k <= 3; k++) {
      opts.push(evalMove(scene, b, { key: 'sail' + k, kind: 'sail', cards: k, label: 'Sail ' + k, play: k + '× SAIL ON ' + b.tack.toUpperCase(), path: [b.pos, V.add(b.pos, V.mul(dCur, k * W))], heading: dCur, tack: b.tack }, cfg));
    }
    opts.push(evalMove(scene, b, { key: 'tack', kind: 'tack', cards: 1, label: 'Tack', play: '1× TACK', path: [b.pos], heading: dOther, tack: other }, cfg));
    opts.push(evalMove(scene, b, { key: 'rollA', kind: 'roll-a', cards: 2, label: 'Roll tack, then sail', play: '2× TACK', path: [b.pos, V.add(b.pos, V.mul(dOther, W))], heading: dOther, tack: other }, cfg));
    opts.push(evalMove(scene, b, { key: 'rollB', kind: 'roll-b', cards: 2, label: 'Sail, then roll tack', play: '2× TACK', path: [b.pos, V.add(b.pos, V.mul(dCur, W))], heading: dOther, tack: other }, cfg));

    // reachable fan: from close-hauled down to `lowest`, up to 3 cards out
    const fan = [];
    for (let a = cfg.closeHauled; a <= cfg.lowest + 0.01; a += 5) fan.push(V.rot(u, side * a * DEG));

    // does the close-hauled line on each tack reach the finish line?
    const fetch = {};
    if (scene.finish) {
      for (const [tk, d] of [[b.tack, dCur], [other, dOther]]) {
        const t = segIntersect(b.pos, d, scene.finish.a, scene.finish.b);
        fetch[tk] = t == null ? null : t / W;
      }
    }
    return { boat: b, dCur, dOther, options: opts, fan, fanRadius: 3 * W, fetch };
  }

  // the meeple outline (a teardrop), centred on pos, bow along heading
  function boatShape(pos, heading, cfg, scale) {
    const L = cfg.boatLen * (scale || 1), r = (cfg.boatBeam * (scale || 1)) / 2;
    const h = V.norm(heading), n = { x: -h.y, y: h.x };
    const pts = [V.add(pos, V.mul(h, L * 0.55))];
    const cc = V.sub(pos, V.mul(h, L * 0.45 - r));
    for (let i = 0; i <= 14; i++) {
      const ang = (i / 14) * Math.PI; // sweep around the stern
      pts.push(V.add(cc, V.add(V.mul(n, Math.cos(ang) * r), V.mul(h, -Math.sin(ang) * r))));
    }
    return pts;
  }

  // 3D4 wind roll per rules p.9: 1 -> -1, 2/3 -> 0, 4 -> +1
  function rollWind(rand) {
    rand = rand || Math.random;
    const dice = [0, 0, 0].map(() => 1 + Math.floor(rand() * 4));
    const delta = dice.reduce((s, d) => s + (d === 1 ? -1 : d === 4 ? 1 : 0), 0);
    return { dice, delta };
  }

  const api = { DEG, BOATS, IDS, MARKS, CODES, DEFAULTS, config, markerSize, V, signedAngle, homography, applyH, invert3, rectAlong, inConvex, solveScene, sceneFromPoses, movesFor, boatShape, rollWind, closeHauledDirs };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RegattaEngine = api;
})(this);
