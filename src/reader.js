/* Regatta Lens marker reader, tuned for small (≈15 mm) stickers.
   Candidate squares come from js-aruco's contour finder; corners are then refined to
   sub-pixel accuracy from the black/white edge, and bits are read at cell centres
   against the sticker's own black border and white margin.
   Works in a Web Worker or on the page. Needs the js-aruco globals AR and CV. */
(function (root) {
  'use strict';

  function prepCodes(codes, ids) {
    // byte pairs -> 16 bits, row-major 4x4; optionally only the ids in use
    const list = [];
    codes.forEach((c, id) => {
      if (ids && ids.indexOf(id) < 0) return;
      const s = c.map((b) => b.toString(2).padStart(8, '0')).join('').slice(0, 16);
      list.push({ id, bits: s.split('').map(Number) });
    });
    return list;
  }

  function bilinear(g, w, h, x, y) {
    if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return -1;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
  }

  // homography mapping unit-square grid (0..n) to the quad (c0 top-left, clockwise)
  function quadMap(c, n) {
    const [p0, p1, p2, p3] = c;
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
    const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
    const den = dx1 * dy2 - dx2 * dy1;
    let g = 0, hh = 0;
    if (Math.abs(den) > 1e-9) { g = (sx * dy2 - dx2 * sy) / den; hh = (dx1 * sy - sx * dy1) / den; }
    const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + hh * p3.x, cc = p0.x;
    const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + hh * p3.y, f = p0.y;
    return (u, v) => { u /= n; v /= n; const w = g * u + hh * v + 1; return { x: (a * u + b * v + cc) / w, y: (d * u + e * v + f) / w }; };
  }

  // move each side onto the true dark/bright edge, then re-intersect the sides.
  // level: the grey value halfway between the code's black and the paper's white, when known.
  // Without it each profile uses its own midpoint, which reads a thin, blurred white edge as dimmer
  // than it is and pulls the outline inward (a few % small at ~1.5 px/mm).
  function refineCorners(g, w, h, quad, level) {
    const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4, cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
    const lines = [];
    for (let k = 0; k < 4; k++) {
      const a = quad[k], b = quad[(k + 1) % 4];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 4) return null;
      const tx = (b.x - a.x) / L, ty = (b.y - a.y) / L;
      let nx = -ty, ny = tx;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; } // outward
      const pts = [];
      const N = Math.max(4, Math.min(16, Math.round(L / 2)));
      const reach = Math.max(1.6, Math.min(3, L * 0.08));
      for (let i = 0; i < N; i++) {
        const t = 0.18 + (0.64 * i) / (N - 1);
        const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
        const prof = [];
        for (let s = -reach; s <= reach + 1e-6; s += 0.25) prof.push(bilinear(g, w, h, px + nx * s, py + ny * s));
        if (prof.some((v) => v < 0)) continue;
        let dark = 255, bright = 0;
        for (const v of prof) { if (v < dark) dark = v; if (v > bright) bright = v; }
        if (bright - dark < 18) continue;
        const lvl = level != null && bright >= level + 4 && dark <= level - 4 ? level : (dark + bright) / 2;
        // first dark->bright crossing outward of the darkest inner sample (the black border)
        const mid = Math.round(reach / 0.25);
        let jmin = 0;
        for (let j = 1; j <= mid + 2 && j < prof.length; j++) if (prof[j] < prof[jmin]) jmin = j;
        let hit = null;
        for (let j = jmin + 1; j < prof.length; j++) if (prof[j - 1] < lvl && prof[j] >= lvl) { hit = j - 1 + (lvl - prof[j - 1]) / (prof[j] - prof[j - 1]); break; }
        if (hit == null) continue;
        const s = -reach + hit * 0.25;
        pts.push({ x: px + nx * s, y: py + ny * s });
      }
      if (pts.length < 3) return null;
      // total least squares line fit
      let sx = 0, sy = 0;
      for (const p of pts) { sx += p.x; sy += p.y; }
      sx /= pts.length; sy /= pts.length;
      let xx = 0, xy = 0, yy = 0;
      for (const p of pts) { const dx = p.x - sx, dy = p.y - sy; xx += dx * dx; xy += dx * dy; yy += dy * dy; }
      const ang = 0.5 * Math.atan2(2 * xy, xx - yy);
      lines.push({ p: { x: sx, y: sy }, d: { x: Math.cos(ang), y: Math.sin(ang) } });
    }
    const out = [];
    for (let k = 0; k < 4; k++) {
      const l1 = lines[(k + 3) % 4], l2 = lines[k];
      const den = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
      if (Math.abs(den) < 1e-6) return null;
      const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / den;
      const q = { x: l1.p.x + l1.d.x * t, y: l1.p.y + l1.d.y * t };
      if (Math.hypot(q.x - quad[k].x, q.y - quad[k].y) > 3.5) return null; // refinement wandered off
      out.push(q);
    }
    return out;
  }

  function sampleCell(g, w, h, map, u, v, r) {
    let s = 0, n = 0;
    for (const du of [-r, 0, r]) for (const dv of [-r, 0, r]) {
      const p = map(u + du, v + dv), val = bilinear(g, w, h, p.x, p.y);
      if (val < 0) return -1;
      s += val; n++;
    }
    return s / n;
  }

  // read one candidate: returns {id, corners, hd} or null
  function decode(g, w, h, quad, dict) {
    const corners = refineCorners(g, w, h, quad) || quad;
    const map = quadMap(corners, 6);
    const side = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
    if (side < 12) return null; // below ~2 px per cell nothing reads reliably
    // fix one flipped bit only on tiny markers, where blur flips bits; bigger ones must read exactly
    const maxHd = side < 22 ? 1 : 0;
    const r = Math.min(0.22, 0.6 / Math.max(1, side / 6)) ; // keep samples inside the cell
    const cells = [];
    for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) {
      const v = sampleCell(g, w, h, map, i + 0.5, j + 0.5, r);
      if (v < 0) return null;
      cells.push(v);
    }
    // white margin just outside the black square
    const ring = [];
    for (let k = 0; k < 6; k++) {
      for (const [u, v] of [[k + 0.5, -0.3], [k + 0.5, 6.3], [-0.3, k + 0.5], [6.3, k + 0.5]]) {
        const p = map(u, v), val = bilinear(g, w, h, p.x, p.y);
        if (val >= 0) ring.push(val);
      }
    }
    if (ring.length < 12) return null;
    ring.sort((a, b) => a - b);
    const bright = ring[Math.floor(ring.length * 0.5)];
    const border = [];
    for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) if (i === 0 || j === 0 || i === 5 || j === 5) border.push(cells[j * 6 + i]);
    border.sort((a, b) => a - b);
    const dark = border[Math.floor(border.length * 0.5)];
    if (bright - dark < 25) return null;
    // inner cells: the brightest inner cell is usually white; use it to place the cut
    const inner = [];
    for (let j = 1; j < 5; j++) for (let i = 1; i < 5; i++) inner.push(cells[j * 6 + i]);
    const thr = dark + (Math.max(bright * 0.85, Math.max(...inner)) - dark) * 0.5;
    let badBorder = 0;
    for (const v of border) if (v > thr) badBorder++;
    if (badBorder > 2) return null;
    const bits = inner.map((v) => (v > thr ? 1 : 0));
    // try the four rotations: rotation k means marker top-left is at corner k
    let best = null;
    for (let k = 0; k < 4; k++) {
      const rb = new Array(16);
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
        // cell (i,j) in the marker frame whose top-left is corner k
        let si = i, sj = j;
        for (let t = 0; t < k; t++) { const ni = 3 - sj, nj = si; si = ni; sj = nj; }
        rb[j * 4 + i] = bits[sj * 4 + si];
      }
      for (const c of dict) {
        let d = 0;
        for (let q = 0; q < 16 && d <= maxHd; q++) if (c.bits[q] !== rb[q]) d++;
        if (d <= maxHd && (!best || d < best.hd)) best = { id: c.id, hd: d, k };
      }
      if (best && best.hd === 0) break;
    }
    if (!best) return null;
    // second pass: put every edge at the halfway grey between the code's black and the paper's true white.
    // The brightest white code cell is wider than the white edge, so it shows the paper's real brightness.
    let white = bright;
    inner.forEach((v, i) => { if (bits[i] && v > white) white = v; });
    const final = refineCorners(g, w, h, corners, (dark + white) / 2) || corners;
    const ordered = [0, 1, 2, 3].map((t) => final[(t + best.k) % 4]);
    return { id: best.id, hd: best.hd, corners: ordered, side };
  }

  function detectOne(img, env, dict, ox, oy) {
    const { CV, AR } = env;
    const grey = new CV.Image(), thres = new CV.Image();
    CV.grayscale(img, grey);
    const det = Object.create(AR.Detector.prototype);
    let cands = [];
    // Two contrast windows, like OpenCV's ArUco: the narrow one finds tiny codes, the wide one keeps a
    // code's black square solid when it sits on a dark meeple behind a thin white edge.
    for (const k of env.windows || [2, 6]) {
      CV.adaptiveThreshold(grey, thres, k, 7);
      cands.push(...det.findCandidates(CV.findContours(thres, []), 24, 0.05, 6));
    }
    cands = det.clockwiseCorners(cands);
    // only drop exact duplicates: with a thin white edge the code's outline and the sticker's outline
    // are ~2 px apart, and the stock filter would keep the wrong (bigger) one. Decoding sorts them out.
    cands = det.notTooNear(cands, 1);
    const out = [];
    for (const q of cands) {
      const m = decode(grey.data, grey.width, grey.height, q, dict);
      if (m) {
        m.corners = m.corners.map((p) => ({ x: p.x + ox, y: p.y + oy }));
        out.push(m);
      }
    }
    return out;
  }

  function crop(img, x, y, w, h) {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let r = 0; r < h; r++) d.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
    return { width: w, height: h, data: d };
  }

  // img: {width,height,data RGBA}. Tiles big images so memory stays bounded.
  function detect(img, env) {
    const dict = env._dict || (env._dict = prepCodes(env.codes, env.ids));
    const T = env.tile || 1400, OV = env.overlap || 160;
    let found = [];
    if (img.width * img.height <= T * T * 1.3) found = detectOne(img, env, dict, 0, 0);
    else {
      for (let y = 0; y < img.height; y += T - OV) for (let x = 0; x < img.width; x += T - OV) {
        const w = Math.min(T, img.width - x), h = Math.min(T, img.height - y);
        if (w < 40 || h < 40) continue;
        found.push(...detectOne(crop(img, x, y, w, h), env, dict, x, y));
      }
    }
    // merge duplicates from overlapping tiles
    const merged = [];
    for (const m of found) {
      const c = m.corners.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
      const dup = merged.find((o) => o.id === m.id && Math.hypot(o.c.x - c.x, o.c.y - c.y) < Math.max(6, m.side * 0.5));
      if (!dup) merged.push({ ...m, c });
      else if (m.hd < dup.hd || (m.hd === dup.hd && m.side > dup.side)) Object.assign(dup, m, { c });
    }
    return merged.map(({ id, hd, corners }) => ({ id, hd, corners }));
  }

  const api = { detect, decode, refineCorners, prepCodes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RegattaReader = api;
})(this);
