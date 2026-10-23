(() => {
  'use strict';
  const E = window.RegattaEngine, V = E.V, DEG = E.DEG;
  const $ = (s) => document.querySelector(s);
  const COL = { port: '#ef5a48', stbd: '#6cc160', wind: '#58a6dc', flag: '#f2994a', dirty: '#9a6a45', crit: '#ff6b6b', warn: '#f2c14e', text: '#e9eef5', muted: '#93a3bb', ink: '#0b1524' };
  const tackCol = (t) => (t === 'port' ? COL.port : COL.stbd);
  const HOSTED_URL = 'https://zachubb89.github.io/regatta-lens/', HOSTED_HOST = 'zachubb89.github.io';
  const KNOWN = new Set([0, 1, 10, 11, 12, 13, 14, 20, 21, 22, 23]);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('regatta-lens:' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('regatta-lens:' + k, JSON.stringify(v)); } catch (e) { /* storage off */ } },
  };

  // ---------- state ----------
  const st = {
    mode: 'photo',
    cfg: E.config(store.get('cfg15', null)),
    layers: Object.assign({ moves: true, shadows: true, row: true, laylines: true, order: true }, store.get('layers', {})),
    selected: null,
    focus: null,
    manualDial: 0,
    sandbox: null,
    photo: { img: null, dets: [], scene: null, isSample: true, busy: false, error: null },
    live: { stream: null, running: false, busy: false, scene: null, smooth: new Map(), lastPanel: 0, lastSeen: 0, vw: 0, vh: 0, error: null },
    vt: { photo: { z: 1, x: 0, y: 0 }, sandbox: { z: 1, x: 0, y: 0 } },
  };

  // ---------- marker reading ----------
  // Full-resolution reading for 15 mm stickers. Runs in a background worker so the page
  // stays responsive; falls back to the page itself if a worker can't start here.
  const reader = (() => {
    let worker = null, ready = null, seq = 0;
    const pending = new Map();
    const env = () => ({ AR: window.AR, CV: window.CV, codes: E.CODES, ids: [...KNOWN] });
    function onPage(img) {
      if (!window.AR || !window.CV || !window.RegattaReader) return null;
      return window.RegattaReader.detect(img, env());
    }
    function drop() {
      if (worker) worker.terminate();
      worker = null;
      for (const p of pending.values()) p(null);
      pending.clear();
    }
    function start() {
      const src = document.getElementById('reader-src'), urls = window.REGATTA_ARUCO_URLS || [];
      if (!window.Worker || !window.Blob || !src || !urls.length) return Promise.resolve(false);
      return new Promise((resolve) => {
        let settled = false;
        const settle = (ok) => { if (!settled) { settled = true; if (!ok) drop(); resolve(ok); } };
        try {
          const code = 'importScripts(' + urls.map((u) => JSON.stringify(u)).join(',') + ');\n' + src.textContent +
            '\nvar env=null;onmessage=function(e){var d=e.data;if(!env)env={AR:self.AR,CV:self.CV,codes:d.codes,ids:d.ids};' +
            'var out=self.RegattaReader.detect({width:d.width,height:d.height,data:new Uint8ClampedArray(d.buf)},env);postMessage({seq:d.seq,markers:out});};' +
            'postMessage({ready:true});';
          worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
          worker.onmessage = (e) => {
            if (e.data.ready) { settle(true); return; }
            const p = pending.get(e.data.seq);
            if (p) { pending.delete(e.data.seq); p(e.data.markers); }
          };
          worker.onerror = (e) => { if (e.preventDefault) e.preventDefault(); settle(false); drop(); };
          setTimeout(() => settle(false), 8000);
        } catch (err) { settle(false); }
      });
    }
    return {
      // img: ImageData. Resolves to [{id, hd, corners}], or null when no reader could load.
      async read(img) {
        if (!ready) ready = start();
        const usingWorker = (await ready) && !!worker;
        window.__regattaReader = usingWorker ? 'worker' : 'page'; // handy when testing
        if (usingWorker) {
          const id = ++seq, buf = img.data.buffer.slice(0);
          const out = await new Promise((resolve) => {
            pending.set(id, resolve);
            worker.postMessage({ seq: id, width: img.width, height: img.height, buf, codes: E.CODES, ids: [...KNOWN] }, [buf]);
          });
          if (out) return out;
        }
        return onPage(img);
      },
    };
  })();
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });
  async function readFrom(src, sw, sh, maxSide) {
    const k = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.round(sw * k), h = Math.round(sh * k);
    if (work.width !== w) work.width = w;
    if (work.height !== h) work.height = h;
    wctx.drawImage(src, 0, 0, w, h);
    const found = await reader.read(wctx.getImageData(0, 0, w, h));
    if (!found) return null;
    return found.filter((m) => KNOWN.has(m.id)).map((m) => ({ id: m.id, hd: m.hd, corners: m.corners.map((c) => ({ x: c.x / k, y: c.y / k })) }));
  }
  // Photos: full resolution (capped where phone browsers cap canvases), plus a small pass
  // that catches stickers filling a big part of a close-up.
  async function readPhoto(img) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const full = await readFrom(img, iw, ih, 4096);
    if (!full) return null;
    if (Math.max(iw, ih) > 1500) {
      const seen = new Set(full.map((m) => m.id));
      for (const m of (await readFrom(img, iw, ih, 1200)) || []) if (!seen.has(m.id)) { full.push(m); seen.add(m.id); }
    }
    return full;
  }
  // how far away the camera can be and still read 15 mm stickers (≈1.5 px per mm, ~49° across the short side)
  const reachCm = (w, h) => Math.max(20, Math.round(Math.min(w, h) / 1.5 / 0.92 / 100) * 10);

  // ---------- sandbox ----------
  function sandboxFresh() {
    const dial = 1;
    const u = V.rot({ x: 0, y: -1 }, -dial * st.cfg.tickDeg * DEG);
    const d = E.closeHauledDirs(u, st.cfg);
    const B = (id, x, y, t) => ({ id, pos: { x, y }, heading: t === 'port' ? d.port : d.starboard });
    return {
      dial,
      boats: [B(14, 95, -340, 'port'), B(11, -80, -250, 'starboard'), B(13, 72, -207, 'port'), B(12, -200, -105, 'port'), B(10, -46, -76, 'starboard')],
      marks: [{ id: 20, pos: { x: -110, y: -560 } }, { id: 21, pos: { x: 250, y: -560 } }, { id: 22, pos: { x: -250, y: 200 } }, { id: 23, pos: { x: 270, y: 200 } }],
      moved: new Set(), roundOrder: null, history: [], lastRoll: null,
    };
  }
  function sandboxScene() {
    const sb = st.sandbox;
    const sc = E.sceneFromPoses(sb.boats, sb.marks, st.cfg, sb.dial);
    if (!sb.roundOrder) sb.roundOrder = sc.order.slice();
    return sc;
  }

  // ---------- canvas + view mapping ----------
  const stage = $('#stage'), canvas = $('#view'), ctx = canvas.getContext('2d'), video = $('#video');
  let cw = 0, ch = 0, dpr = 1;
  function resize() {
    const r = stage.getBoundingClientRect();
    dpr = Math.min(2.5, window.devicePixelRatio || 1);
    cw = r.width; ch = r.height;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    draw();
  }
  const WORLD = { x0: -430, x1: 470, y0: -640, y1: 270 };

  function view() {
    const m = st.mode;
    if (m === 'sandbox') {
      const sc = sandboxScene();
      const pad = 18, bw = WORLD.x1 - WORLD.x0, bh = WORLD.y1 - WORLD.y0;
      const k = Math.min((cw - pad * 2) / bw, (ch - pad * 2) / bh);
      const ox = cw / 2 - k * (WORLD.x0 + bw / 2), oy = ch / 2 - k * (WORLD.y0 + bh / 2) + 22;
      const t = st.vt.sandbox;
      const P = (p) => ({ x: t.x + t.z * (ox + k * p.x), y: t.y + t.z * (oy + k * p.y) });
      const inv = (s) => ({ x: ((s.x - t.x) / t.z - ox) / k, y: ((s.y - t.y) / t.z - oy) / k });
      return { scene: sc, P, inv, pxPerMm: k * t.z, bg: () => drawWater(P, k * t.z) };
    }
    if (m === 'photo') {
      const ph = st.photo;
      if (!ph.img) return { scene: null };
      const iw = ph.img.naturalWidth, ih = ph.img.naturalHeight;
      const s = Math.min(cw / iw, ch / ih), ox = (cw - iw * s) / 2, oy = (ch - ih * s) / 2;
      const t = st.vt.photo;
      const I = (p) => ({ x: t.x + t.z * (ox + s * p.x), y: t.y + t.z * (oy + s * p.y) });
      const sc = ph.scene;
      return {
        scene: sc, I, P: sc && sc.ok ? planeMapper(sc, I) : null,
        bg: () => { const a = I({ x: 0, y: 0 }), b = I({ x: iw, y: ih }); ctx.drawImage(ph.img, a.x, a.y, b.x - a.x, b.y - a.y); ctx.fillStyle = 'rgba(6,12,22,0.18)'; ctx.fillRect(0, 0, cw, ch); },
      };
    }
    // live
    const lv = st.live;
    if (!lv.running || !video.videoWidth) return { scene: null };
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.max(cw / vw, ch / vh), ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
    const I = (p) => ({ x: ox + s * p.x, y: oy + s * p.y });
    const sc = lv.scene;
    return { scene: sc, I, P: sc && sc.ok ? planeMapper(sc, I) : null };
  }
  // plane (mm) -> screen, through the photo's homography; null behind the horizon
  function planeMapper(sc, I) {
    const Hi = sc.Hi, w0 = Hi[8];
    const P = (p) => {
      const w = Hi[6] * p.x + Hi[7] * p.y + Hi[8];
      if (w * w0 <= 0 || Math.abs(w) < Math.abs(w0) * 0.05) return null;
      return I({ x: (Hi[0] * p.x + Hi[1] * p.y + Hi[2]) / w, y: (Hi[3] * p.x + Hi[4] * p.y + Hi[5]) / w });
    };
    return P;
  }

  // ---------- drawing ----------
  function pathPlane(P, pts, close) {
    const s = pts.map(P);
    if (s.some((p) => !p)) return false;
    ctx.beginPath();
    s.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (close) ctx.closePath();
    return true;
  }
  function linePlane(P, a, b, n) { // sampled so long lines survive perspective clipping
    n = n || 24;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i <= n; i++) {
      const q = P(V.lerp(a, b, i / n));
      if (!q) { pen = false; continue; }
      if (pen) ctx.lineTo(q.x, q.y); else { ctx.moveTo(q.x, q.y); pen = true; }
    }
  }
  function sector(c, u, a0, a1, r0, r1) {
    const pts = [];
    for (let a = a0; a <= a1 + 0.01; a += 3) pts.push(V.add(c, V.mul(V.rot(u, a * DEG), r1)));
    for (let a = a1; a >= a0 - 0.01; a -= 3) pts.push(V.add(c, V.mul(V.rot(u, a * DEG), r0)));
    return pts;
  }
  function circlePts(c, r, n) { const p = []; for (let i = 0; i < (n || 28); i++) { const a = (i / (n || 28)) * Math.PI * 2; p.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }); } return p; }
  function text(str, x, y, o) {
    o = o || {};
    ctx.font = (o.weight || 700) + ' ' + (o.size || 12) + 'px ' + (o.font || "'Atkinson Hyperlegible', system-ui, sans-serif");
    ctx.textAlign = o.align || 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = o.halo == null ? 3.5 : o.halo; ctx.strokeStyle = 'rgba(6,12,22,0.9)';
    if (ctx.lineWidth) ctx.strokeText(str, x, y);
    ctx.fillStyle = o.color || COL.text; ctx.fillText(str, x, y);
  }
  function pennant(x, y, label, fill, ink) {
    const w = 18, h = 18;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - w / 2 - 2, y - h / 2 - 2, w + 4, h + 4, 6) : ctx.rect(x - w / 2 - 2, y - h / 2 - 2, w + 4, h + 4); ctx.fillStyle = 'rgba(6,12,22,0.85)'; ctx.fill();
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - w / 2, y - h / 2, w, h, 4) : ctx.rect(x - w / 2, y - h / 2, w, h); ctx.fillStyle = fill; ctx.fill();
    text(label, x, y + 0.5, { size: 12, color: ink || '#fff', halo: 0, font: "'IBM Plex Mono', ui-monospace, monospace", weight: 500 });
  }
  function badge(x, y, label, fill, ink, r) {
    r = r || 10;
    ctx.beginPath(); ctx.arc(x, y, r + 2, 0, Math.PI * 2); ctx.fillStyle = 'rgba(6,12,22,0.85)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
    text(label, x, y + 0.5, { size: r * 1.15, color: ink || '#fff', halo: 0, font: "'IBM Plex Mono', ui-monospace, monospace", weight: 500 });
  }

  function drawWater(P, k) {
    const g = ctx.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, '#0d2036'); g.addColorStop(1, '#0a1828');
    ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch);
    // chart grid, one card wide
    const W = st.cfg.cardW;
    ctx.strokeStyle = 'rgba(120,160,210,0.07)'; ctx.lineWidth = 1;
    for (let x = Math.floor(-900 / W) * W; x < 900; x += W) { linePlane(P, { x, y: -1100 }, { x, y: 700 }, 2); ctx.stroke(); }
    for (let y = Math.floor(-1100 / W) * W; y < 700; y += W) { linePlane(P, { x: -900, y }, { x: 900, y }, 2); ctx.stroke(); }
    // wind streaks
    const u = st.sandbox ? V.rot({ x: 0, y: -1 }, -st.sandbox.dial * st.cfg.tickDeg * DEG) : { x: 0, y: -1 };
    const dn = V.mul(u, -1);
    ctx.strokeStyle = 'rgba(88,166,220,0.16)'; ctx.lineWidth = 1.2;
    for (let gx = -400; gx <= 460; gx += 140) for (let gy = -600; gy <= 240; gy += 140) {
      const c = { x: gx + ((gy / 140) % 2 ? 70 : 0), y: gy };
      const a = P(V.add(c, V.mul(dn, -16))), b = P(V.add(c, V.mul(dn, 16)));
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const s = V.norm(V.sub(b, a)), n = { x: -s.y, y: s.x };
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - s.x * 5 + n.x * 3, b.y - s.y * 5 + n.y * 3); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - s.x * 5 - n.x * 3, b.y - s.y * 5 - n.y * 3); ctx.stroke();
    }
    // scale bar
    const px = W * k;
    const x0 = 14, y0 = ch - 18;
    ctx.strokeStyle = COL.muted; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + px, y0); ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0 + 4); ctx.moveTo(x0 + px, y0 - 4); ctx.lineTo(x0 + px, y0 + 4); ctx.stroke();
    text('1 card · ' + W + ' mm', x0 + px + 8, y0, { align: 'left', size: 11, color: COL.muted, font: "'IBM Plex Mono', monospace", weight: 500 });
  }

  function drawMark(P, m, k) {
    const c = P(m.pos); if (!c) return;
    if (st.mode === 'sandbox') {
      ctx.beginPath(); ctx.arc(c.x, c.y, Math.max(6, 24 * k), 0, Math.PI * 2); ctx.fillStyle = COL.flag; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke();
    } else {
      if (pathPlane(P, circlePts(m.pos, 26), true)) { ctx.lineWidth = 2.5; ctx.strokeStyle = COL.flag; ctx.stroke(); }
    }
    text(m.label, c.x, c.y - Math.max(16, 34 * k), { size: 13, color: COL.flag });
  }

  function drawBoatPiece(P, b, k) { // sandbox meeple
    if (!pathPlane(P, E.boatShape(b.pos, b.heading, st.cfg), true)) return;
    ctx.fillStyle = b.color; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.stroke();
    const s = Math.max(3, 9 * k), c = P(b.pos);
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(Math.atan2(b.heading.y, b.heading.x) + Math.PI / 2);
    ctx.fillStyle = '#fff'; ctx.fillRect(-s, -s, s * 2, s * 2); ctx.fillStyle = '#111'; ctx.fillRect(-s * 0.7, -s * 0.7, s * 1.4, s * 1.4);
    ctx.fillStyle = '#fff'; ctx.fillRect(-s * 0.35, -s * 0.7, s * 0.7, s * 0.35);
    ctx.restore();
  }

  function draw() {
    if (!cw) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const v = view();
    if (v.bg) v.bg();
    const sc = v.scene, P = v.P;
    if (!sc || !sc.ok || !P) return;
    const cfg = st.cfg, L = st.layers, u = sc.wind.u;
    const k = v.pxPerMm || Math.max(0.2, V.dist(P({ x: 0, y: 0 }) || { x: 0, y: 0 }, P({ x: 100, y: 0 }) || { x: 0, y: 0 }) / 100);

    // finish + start lines, laylines
    const A = sc.marks[20], Bm = sc.marks[21];
    if (L.laylines) for (const l of sc.laylines) {
      ctx.setLineDash([10, 7]); ctx.lineWidth = 2; ctx.strokeStyle = tackCol(l.tack); ctx.globalAlpha = 0.75;
      linePlane(P, l.from, l.to, 30); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      const lp = P(V.lerp(l.from, l.to, 0.22));
      if (lp) text((l.tack === 'port' ? 'PORT' : 'STBD') + ' LAYLINE', lp.x, lp.y, { size: 11, color: tackCol(l.tack) });
    }
    if (A && Bm) {
      ctx.lineWidth = 3; ctx.strokeStyle = COL.flag; ctx.setLineDash([6, 6]);
      linePlane(P, A.pos, Bm.pos, 12); ctx.stroke(); ctx.setLineDash([]);
      const m = P(V.mid(A.pos, Bm.pos)); if (m) text('FINISH', m.x, m.y - 12, { size: 12, color: COL.flag });
    }
    const C1 = sc.marks[22], C2 = sc.marks[23];
    if (C1 && C2) { ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(242,153,74,0.6)'; ctx.setLineDash([3, 6]); linePlane(P, C1.pos, C2.pos, 12); ctx.stroke(); ctx.setLineDash([]); const m = P(V.mid(C1.pos, C2.pos)); if (m) text('START', m.x, m.y + 14, { size: 11, color: COL.flag }); }
    for (const id of Object.keys(sc.marks)) drawMark(P, sc.marks[id], k);

    // wind shadows + starboard control zones
    for (const b of sc.boats) {
      if (L.shadows && pathPlane(P, b.shadow, true)) {
        ctx.fillStyle = 'rgba(154,106,69,0.20)'; ctx.fill();
        ctx.setLineDash([4, 4]); ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(214,160,118,0.55)'; ctx.stroke(); ctx.setLineDash([]);
        const c = P(V.add(b.pos, V.mul(u, -cfg.cardL * 0.62)));
        if (c && cfg.cardW * k > 26) text('💩', c.x, c.y, { size: Math.min(18, cfg.cardW * k * 0.28), halo: 0 });
      }
      if (L.row && b.control && pathPlane(P, b.control, true)) {
        ctx.fillStyle = 'rgba(108,193,96,0.07)'; ctx.fill();
        ctx.setLineDash([7, 5]); ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(108,193,96,0.85)'; ctx.stroke(); ctx.setLineDash([]);
      }
    }

    // selected boat: no-sail wedge, fan, options
    const sel = sc.boats.find((b) => b.id === st.selected);
    let mv = null;
    if (sel && L.moves) {
      mv = E.movesFor(sc, sel.id, cfg);
      const W = cfg.cardW, side = sel.tack === 'port' ? 1 : -1;
      if (pathPlane(P, sector(sel.pos, u, -cfg.closeHauled, cfg.closeHauled, 0, W * 1.5), true)) {
        ctx.fillStyle = 'rgba(0,0,0,0.42)'; ctx.fill();
        const c = P(V.add(sel.pos, V.mul(u, W * 1.3))); if (c) text('NO SAIL', c.x, c.y, { size: 9, color: COL.muted });
      }
      const a0 = side > 0 ? cfg.closeHauled : -cfg.lowest, a1 = side > 0 ? cfg.lowest : -cfg.closeHauled;
      if (pathPlane(P, sector(sel.pos, u, a0, a1, 0, W * 3), true)) { ctx.fillStyle = side > 0 ? 'rgba(239,90,72,0.09)' : 'rgba(108,193,96,0.09)'; ctx.fill(); }
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(233,238,245,0.18)';
      for (let r = 1; r <= 3; r++) { const pts = sector(sel.pos, u, a0, a1, 0, W * r).slice(0, Math.ceil(((a1 - a0) / 3) + 1)); if (pathPlane(P, pts, false)) ctx.stroke(); }

      const focus = mv.options.find((o) => o.key === st.focus);
      // cards for the focused move
      if (focus && focus.kind !== 'tack') {
        const n = focus.kind === 'sail' ? focus.cards : 1;
        const dir = focus.kind === 'roll-a' ? mv.dOther : mv.dCur;
        const tk = focus.kind === 'roll-a' ? focus.tack : sel.tack;
        for (let i = 0; i < n; i++) drawCard(P, V.add(focus.start, V.mul(dir, i * W)), dir, u, tk, focus.kind !== 'sail', i * W < focus.travelled - 1);
      }
      for (const o of mv.options) {
        const isF = focus && o.key === focus.key, dim = focus && !isF;
        ctx.globalAlpha = dim ? 0.28 : 1;
        const col = o.kind === 'roll-a' || o.kind === 'tack' ? tackCol(o.tack) : tackCol(sel.tack);
        if (o.kind !== 'tack') {
          ctx.lineWidth = isF ? 3.5 : 2; ctx.strokeStyle = col;
          if (o.kind === 'roll-a' || o.kind === 'roll-b') ctx.setLineDash([6, 4]);
          linePlane(P, o.start, o.end, 6); ctx.stroke(); ctx.setLineDash([]);
          if (o.blocked) {
            ctx.strokeStyle = COL.crit; ctx.setLineDash([3, 5]); ctx.lineWidth = 2; linePlane(P, o.end, o.goal, 6); ctx.stroke(); ctx.setLineDash([]);
          }
        }
        // ghost boat at the end
        if (pathPlane(P, E.boatShape(o.end, o.heading, cfg), true)) {
          ctx.fillStyle = hexA(sel.color, isF ? 0.75 : 0.32); ctx.fill();
          ctx.setLineDash(o.kind === 'tack' || o.kind.startsWith('roll') ? [4, 3] : []);
          ctx.lineWidth = isF ? 2.2 : 1.4; ctx.strokeStyle = o.blocked ? COL.crit : col; ctx.stroke(); ctx.setLineDash([]);
        }
        const e = P(o.end);
        if (e && o.kind === 'sail') {
          text(o.cards + '×', e.x + 18, e.y - 12, { size: 12, color: o.blocked ? COL.crit : col, font: "'IBM Plex Mono', ui-monospace, monospace", weight: 500 });
          let tx = e.x + 30;
          if (o.receive.length) { text('💩', tx + 4, e.y - 14, { size: 14, halo: 0 }); tx += 18; }
          if (o.give.length) { text('→💩', tx + 10, e.y - 14, { size: 12, halo: 3 }); }
        }
        if (e && o.blocked) { text('✕', e.x, e.y, { size: 18, color: COL.crit }); }
        ctx.globalAlpha = 1;
      }
    }

    // pieces
    for (const b of sc.boats) {
      const c = P(b.pos); if (!c) continue;
      if (st.mode === 'sandbox') drawBoatPiece(P, b, k);
      if (b.id === st.selected && pathPlane(P, circlePts(b.pos, 34, 36), true)) { ctx.lineWidth = 3; ctx.strokeStyle = COL.text; ctx.stroke(); }
      if (st.mode !== 'sandbox' && pathPlane(P, circlePts(b.pos, 24, 28), true)) { ctx.lineWidth = 3; ctx.strokeStyle = b.color; ctx.stroke(); }
      // heading tick
      const h1 = P(V.add(b.pos, V.mul(b.heading, 40)));
      if (h1 && st.mode !== 'sandbox') { ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(h1.x, h1.y); ctx.lineWidth = 2.5; ctx.strokeStyle = tackCol(b.tack); ctx.stroke(); }
      if (L.order) pennant(c.x - 24, c.y - 22, String(b.turn), b.color, b.ink);
      if (b.inIrons) text('IN IRONS', c.x, c.y + 26, { size: 10, color: COL.warn });
    }

    // wind arrow at the dial in camera views
    if (sc.windMarker && st.mode !== 'sandbox') {
      const c = sc.windMarker.pos, dn = V.mul(u, -1);
      ctx.lineWidth = 4; ctx.strokeStyle = COL.wind;
      linePlane(P, V.add(c, V.mul(u, 60)), V.add(c, V.mul(dn, 60)), 4); ctx.stroke();
      const t = P(V.add(c, V.mul(dn, 60))), t0 = P(V.add(c, V.mul(dn, 40)));
      if (t && t0) { const s = V.norm(V.sub(t, t0)), n = { x: -s.y, y: s.x }; ctx.beginPath(); ctx.moveTo(t.x + s.x * 4, t.y + s.y * 4); ctx.lineTo(t.x - s.x * 10 + n.x * 7, t.y - s.y * 10 + n.y * 7); ctx.lineTo(t.x - s.x * 10 - n.x * 7, t.y - s.y * 10 - n.y * 7); ctx.closePath(); ctx.fillStyle = COL.wind; ctx.fill(); }
    }
  }
  function drawCard(P, origin, dir, u, tack, isTack, reached) {
    const cfg = st.cfg, W = cfg.cardW, Lc = cfg.cardL;
    const rect = E.rectAlong(origin, dir, W, Lc);
    if (!pathPlane(P, rect, true)) return;
    ctx.fillStyle = reached ? 'rgba(245,247,250,0.88)' : 'rgba(245,247,250,0.35)'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#0b1524'; ctx.stroke();
    // coloured band on the leeward short edge (as the cards are drawn in the rules)
    const n = { x: -dir.y, y: dir.x }, lee = V.dot(n, V.mul(u, -1)) > 0 ? n : V.mul(n, -1);
    const a = V.add(origin, V.mul(lee, Lc / 2)), b = V.add(origin, V.mul(lee, Lc / 2 - Lc * 0.22));
    const band = [a, V.add(a, V.mul(dir, W)), V.add(b, V.mul(dir, W)), b];
    if (isTack) {
      const c = V.add(V.add(origin, V.mul(dir, W / 2)), V.mul(lee, Lc * 0.25));
      const tri = [V.add(c, V.mul(lee, 10)), V.add(V.sub(c, V.mul(dir, 10)), V.mul(lee, -6)), V.add(V.add(c, V.mul(dir, 10)), V.mul(lee, -6))];
      if (pathPlane(P, tri, true)) { ctx.fillStyle = '#2a5577'; ctx.fill(); }
    } else if (pathPlane(P, band, true)) { ctx.fillStyle = tackCol(tack); ctx.fill(); }
  }
  function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }

  // ---------- HUD + panel ----------
  const fmtDial = (d) => (d > 0 ? '+' + d : d < 0 ? '−' + Math.abs(d) : '0');
  function currentScene() { return view().scene; }

  function renderGauge(sc) {
    const g = $('#gauge');
    g.hidden = (st.mode === 'live' && !st.live.running) || (st.mode === 'photo' && !st.photo.img);
    const w = sc && sc.ok ? sc.wind : null;
    const manual = st.mode === 'sandbox' || (w && w.src === 'manual') || !w;
    const dial = st.mode === 'sandbox' ? st.sandbox.dial : w ? w.dialRounded : st.manualDial;
    const known = dial != null;
    const rot = known ? -dial * st.cfg.tickDeg : 0;
    const ticks = [-3, -2, -1, 0, 1, 2, 3].map((t) => { const a = (90 + t * st.cfg.tickDeg) * DEG; return `<line x1="${(Math.cos(a) * 40).toFixed(1)}" y1="${(Math.sin(a) * 40).toFixed(1)}" x2="${(Math.cos(a) * 47).toFixed(1)}" y2="${(Math.sin(a) * 47).toFixed(1)}" stroke="#0b1524" stroke-width="${t === 0 ? 3 : 2}"/>`; }).join('');
    const src = st.mode === 'sandbox' ? 'sandbox' : w && w.src === 'dial' ? (w.dial == null ? 'dial seen' : 'read off dial') : 'set by hand';
    const fav = sc && sc.ok ? sc.favored : null;
    const favTxt = fav === 'port' ? 'Port favored' : fav === 'starboard' ? 'Starboard favored' : fav === 'even' ? 'Square to course' : !known ? 'Course marker not in view' : '';
    g.innerHTML = `
      <svg viewBox="-50 -50 100 100" aria-hidden="true">
        <circle r="47" fill="${COL.wind}"/>${ticks}
        <g transform="rotate(${rot})">
          <path d="M0 0 L0 -36 A36 36 0 0 1 25.5 25.5 Z" fill="#b65e57" transform="rotate(45)"/>
          <path d="M0 0 L0 -36 A36 36 0 0 0 -25.5 25.5 Z" fill="#8fcf86" transform="rotate(-45)"/>
          <path d="M0 0 L-25.5 -25.5 A36 36 0 0 1 25.5 -25.5 Z" fill="#0b1524"/>
          <line x1="0" y1="0" x2="25" y2="-25" stroke="${COL.port}" stroke-width="6"/>
          <line x1="0" y1="0" x2="-25" y2="-25" stroke="${COL.stbd}" stroke-width="6"/>
          <line x1="0" y1="-6" x2="0" y2="30" stroke="#0b1524" stroke-width="8"/>
          <path d="M-9 26 L9 26 L0 40 Z" fill="#0b1524"/>
        </g>
      </svg>
      <div>
        <div class="g-lab">Wind · ${src}</div>
        <div class="g-num">${known ? fmtDial(dial) : '—'}</div>
        <div class="g-fav ${fav || ''}">${favTxt}</div>
      </div>
      ${manual ? `<div class="g-btns"><button type="button" id="dial-dn" aria-label="Wind dial minus one">−</button><button type="button" id="dial-up" aria-label="Wind dial plus one">+</button></div>` : ''}`;
    const dn = $('#dial-dn'), up = $('#dial-up');
    if (dn) dn.onclick = () => nudgeDial(-1);
    if (up) up.onclick = () => nudgeDial(1);
  }
  function nudgeDial(d) {
    if (st.mode === 'sandbox') { st.sandbox.dial = clamp(st.sandbox.dial + d, -3, 3); }
    else { st.manualDial = clamp(st.manualDial + d, -3, 3); resolveCamera(); }
    refresh();
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function renderOrder(sc) {
    const o = $('#order');
    if (!sc || !sc.ok || !sc.boats.length) { o.hidden = true; return; }
    o.hidden = false;
    const order = st.mode === 'sandbox' && st.sandbox.roundOrder ? st.sandbox.roundOrder.filter((id) => sc.boats.some((b) => b.id === id)) : sc.order;
    o.innerHTML = '<span class="lab">Turn</span>' + order.map((id, i) => {
      const b = sc.boats.find((x) => x.id === id);
      const done = st.mode === 'sandbox' && st.sandbox.moved.has(id);
      return `<button type="button" data-id="${id}" class="${done ? 'done' : ''}" aria-pressed="${id === st.selected}" style="background:${b.color};color:${b.ink}" aria-label="${b.name}, moves ${ordinal(i + 1)}">${i + 1}</button>`;
    }).join('');
    o.querySelectorAll('button').forEach((bt) => (bt.onclick = () => select(+bt.dataset.id)));
  }
  const ordinal = (n) => n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');

  function renderPanel(sc) {
    const p = $('#panel');
    const parts = [];
    if (st.mode !== 'sandbox' && sc && sc.ok) parts.push(seenRow(sc));
    const sel = sc && sc.ok ? sc.boats.find((b) => b.id === st.selected) : null;
    if (!sel) {
      parts.push(`<p class="empty">${sc && sc.ok && sc.boats.length ? 'Tap a boat to see its moves.' : st.mode === 'live' ? 'Boats show up here once the camera sees their markers.' : 'No boats found yet.'}</p>`);
    } else {
      const mv = E.movesFor(sc, sel.id, st.cfg);
      const lift = sel.lift === 'lifted' ? ' · <b>lifted</b> ⬆' : sel.lift === 'headed' ? ' · <b>headed</b> ⬇' : '';
      const fetch = mv.fetch && mv.fetch[sel.tack] != null ? `Fetches the finish on this tack in <b class="num">${mv.fetch[sel.tack].toFixed(1)}</b> cards.` : sc.finish ? 'Does not fetch the finish on this tack. A tack is coming.' : '';
      parts.push(`
        <div class="boat-head">
          <span class="swatch" style="background:${sel.color}"></span>
          <h2>${sel.name}</h2>
          <span class="tack ${sel.tack}">${sel.tack} tack</span>
          <div class="facts"><span><b class="num">${Math.round(sel.offWind)}°</b> off the wind${lift}</span><span>moves <b>${ordinal(sel.turn)}</b></span>${sel.inIrons ? '<span style="color:var(--warn)">pointing into the no-sail zone</span>' : ''}</div>
        </div>`);
      parts.push(`<div><p class="sec-lab">Moves <span>tap one to lay out the cards</span></p><ol class="moves">${mv.options.map((o) => moveRow(o, sel, sc)).join('')}</ol></div>`);
      if (fetch) parts.push(`<p class="note">${fetch}</p>`);
    }
    if (st.mode === 'sandbox') {
      const sb = st.sandbox;
      const roundDone = sb.roundOrder && sb.roundOrder.every((id) => sb.moved.has(id));
      const focusOpt = sel && st.focus ? E.movesFor(sc, sel.id, st.cfg).options.find((o) => o.key === st.focus) : null;
      parts.push(`<div class="actions">
        <button type="button" class="btn primary" id="apply" ${focusOpt && !sb.moved.has(sel.id) ? '' : 'disabled'}>${focusOpt ? 'Play ' + focusOpt.label.toLowerCase() : 'Pick a move to play it'}</button>
        <button type="button" class="btn ${roundDone ? 'pulse' : ''}" id="roll">🎲 End round, roll wind</button>
        <button type="button" class="btn" id="undo" ${sb.history.length ? '' : 'disabled'}>Undo</button>
        <button type="button" class="btn" id="reset">Reset</button>
      </div>
      ${sb.lastRoll ? `<p class="note dice">Last roll ${sb.lastRoll.dice.join(' · ')} → shift ${fmtDial(sb.lastRoll.delta)}</p>` : '<p class="note">Drag boats to set up any situation. Moves you play here follow the rules engine.</p>'}`);
    }
    parts.push(`<div><p class="sec-lab">Show</p><div class="layers">${[
      ['moves', 'Moves', COL.flag], ['shadows', 'Wind shadows', COL.dirty], ['row', 'Right of way', COL.stbd], ['laylines', 'Laylines', COL.port], ['order', 'Turn order', COL.text],
    ].map(([k, l, c]) => `<button type="button" class="chip" data-layer="${k}" aria-pressed="${!!st.layers[k]}" style="--k:${c}"><span class="dot"></span>${l}</button>`).join('')}</div></div>`);
    p.innerHTML = parts.join('');
    p.querySelectorAll('.move').forEach((b) => (b.onclick = () => { st.focus = st.focus === b.dataset.key ? null : b.dataset.key; refresh(); }));
    p.querySelectorAll('[data-layer]').forEach((b) => (b.onclick = () => { st.layers[b.dataset.layer] = !st.layers[b.dataset.layer]; store.set('layers', st.layers); refresh(); }));
    p.querySelectorAll('[data-snap]').forEach((b) => (b.onclick = () => $('#file').click()));
    const ap = $('#apply'); if (ap) ap.onclick = applyMove;
    const rl = $('#roll'); if (rl) rl.onclick = rollRound;
    const ud = $('#undo'); if (ud) ud.onclick = undo;
    const rs = $('#reset'); if (rs) rs.onclick = () => { st.sandbox = sandboxFresh(); st.focus = null; st.selected = 14; refresh(); };
  }
  function seenRow(sc) {
    const items = [];
    items.push(`<span class="${sc.windMarker ? 'on' : ''}" style="--k:${COL.wind}">wind</span>`);
    items.push(`<span class="${sc.courseMarker ? 'on' : ''}" style="--k:${COL.flag}">course</span>`);
    for (const b of E.BOATS) items.push(`<span class="${sc.boats.some((x) => x.id === b.id) ? 'on' : ''}" style="--k:${b.color}">${b.name.toLowerCase()}</span>`);
    for (const m of E.MARKS) items.push(`<span class="${sc.marks[m.id] ? 'on' : ''}" style="--k:${COL.flag}">${m.label}${m.id === 22 ? '₁' : m.id === 23 ? '₂' : ''}</span>`);
    const warn = sc.warnings.filter((w) => w.code === 'size').map((w) => {
      const b = E.BOATS.find((x) => x.id === w.id); const name = b ? b.name : w.id === 0 ? 'wind' : w.id === 1 ? 'course' : 'mark ' + w.id;
      return `<p class="note" style="color:var(--warn)">The ${name} marker reads ${Math.round((w.ratio - 1) * 100)}% off its size in Settings. Check the printed size.</p>`;
    }).join('');
    return `<div><p class="sec-lab">In view</p><div class="seen">${items.join('')}</div>${warn}</div>`;
  }
  function moveRow(o, sel, sc) {
    const tags = [];
    const W = st.cfg.cardW;
    if (o.blocked) tags.push(`<span class="tag crit">${o.blocked.reason === 'give-way' ? 'Give way to ' + o.blocked.name : 'Hits ' + o.blocked.name} · stops at ${(o.travelled / W).toFixed(1)}</span>`);
    for (const r of o.receive) tags.push(`<span class="tag warn">💩 you draw (${r.name})</span>`);
    for (const g of o.give) tags.push(`<span class="tag good">💩 ${g.name} draws</span>`);
    if (o.kind !== 'sail') tags.push(`<span class="tag ${o.tack}">now ${o.tack}${sc.favored && sc.favored !== 'even' ? (o.tack === sc.favored ? ', lifted' : ', headed') : ''}</span>`);
    if (!o.blocked && !o.receive.length && !o.give.length && o.kind === 'sail') tags.push('<span class="tag good">clear air</span>');
    const n = o.kind === 'sail' ? o.cards : o.cards;
    const cards = Array.from({ length: n }, (_, i) => `<i class="${o.kind === 'sail' ? '' : 'tk'}" style="left:${i * 7}px;--c:${tackCol(sel.tack)}"></i>`).join('');
    return `<li><button type="button" class="move" data-key="${o.key}" aria-pressed="${st.focus === o.key}">
      <span class="cards" aria-hidden="true">${cards}</span>
      <span class="mv-name">${o.label}<em>${o.play}</em></span>
      <span class="mv-tags">${tags.join('')}</span></button></li>`;
  }

  // ---------- sandbox actions ----------
  function applyMove() {
    const sc = sandboxScene(), sel = sc.boats.find((b) => b.id === st.selected);
    if (!sel) return;
    const o = E.movesFor(sc, sel.id, st.cfg).options.find((x) => x.key === st.focus);
    if (!o) return;
    const sb = st.sandbox;
    sb.history.push(JSON.stringify({ boats: sb.boats, moved: [...sb.moved], dial: sb.dial, roundOrder: sb.roundOrder, selected: st.selected, lastRoll: sb.lastRoll }));
    const b = sb.boats.find((x) => x.id === sel.id);
    b.pos = { ...o.end }; b.heading = { ...o.heading };
    sb.moved.add(sel.id);
    st.focus = null;
    const next = sb.roundOrder.find((id) => !sb.moved.has(id));
    if (next != null) st.selected = next;
    refresh();
  }
  function rollRound() {
    const sb = st.sandbox;
    sb.history.push(JSON.stringify({ boats: sb.boats, moved: [...sb.moved], dial: sb.dial, roundOrder: sb.roundOrder, selected: st.selected, lastRoll: sb.lastRoll }));
    const r = E.rollWind();
    sb.lastRoll = r;
    sb.dial = clamp(sb.dial + r.delta, -3, 3);
    sb.moved = new Set();
    sb.roundOrder = null;
    const sc = sandboxScene();
    st.selected = sc.order[0]; st.focus = null;
    refresh();
  }
  function undo() {
    const sb = st.sandbox, h = sb.history.pop();
    if (!h) return;
    const s = JSON.parse(h);
    sb.boats = s.boats; sb.moved = new Set(s.moved); sb.dial = s.dial; sb.roundOrder = s.roundOrder; sb.lastRoll = s.lastRoll || null; st.selected = s.selected; st.focus = null;
    refresh();
  }

  // ---------- camera modes ----------
  function resolveCamera() {
    if (st.mode === 'photo' && st.photo.img && st.photo.dets) {
      st.photo.scene = E.solveScene(st.photo.dets, st.cfg, { imgW: st.photo.img.naturalWidth, imgH: st.photo.img.naturalHeight, dial: st.manualDial });
      ensureSelection(st.photo.scene);
    }
  }
  function ensureSelection(sc) {
    if (!sc || !sc.ok || !sc.boats.length) return;
    if (!sc.boats.some((b) => b.id === st.selected)) { st.selected = sc.order[0]; st.focus = null; }
  }
  async function loadPhoto(src, isSample) {
    const ph = st.photo;
    ph.busy = true; ph.error = null; ph.isSample = isSample;
    renderStageChrome();
    const img = new Image();
    img.src = src;
    try { await img.decode(); } catch (e) { ph.busy = false; ph.error = 'That file did not open as an image.'; renderStageChrome(); return; }
    ph.img = img;
    st.vt.photo = { z: 1, x: 0, y: 0 };
    await new Promise((r) => setTimeout(r, 30)); // let the "reading" banner paint
    const dets = await readPhoto(img);
    if (ph.img !== img) return; // a newer photo took over while this one was reading
    ph.busy = false;
    if (!dets) { ph.error = 'The marker reader did not load. Check the connection and reload.'; ph.dets = []; ph.scene = null; refresh(); return; }
    ph.dets = dets;
    if (isSample) st.manualDial = 1;
    resolveCamera();
    if (ph.scene && ph.scene.ok && isSample) { st.selected = 12; st.focus = 'sail3'; }
    fitAction();
    refresh();
  }
  // zoom the photo so the boats fill the stage (phones show a lot of table otherwise)
  function fitAction() {
    const ph = st.photo, sc = ph.scene;
    st.vt.photo = { z: 1, x: 0, y: 0 };
    if (!sc || !sc.ok || !ph.img || !cw) return;
    const pts = sc.boats.map((b) => b.img);
    if (pts.length < 1) return;
    const iw = ph.img.naturalWidth, ih = ph.img.naturalHeight;
    const s = Math.min(cw / iw, ch / ih), ox = (cw - iw * s) / 2, oy = (ch - ih * s) / 2;
    let x0 = Math.min(...pts.map((p) => p.x)), x1 = Math.max(...pts.map((p) => p.x));
    let y0 = Math.min(...pts.map((p) => p.y)), y1 = Math.max(...pts.map((p) => p.y));
    const padX = Math.max(iw * 0.08, (x1 - x0) * 0.3), padY = Math.max(ih * 0.06, (y1 - y0) * 0.3);
    x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
    const top = 70, bottom = 50;
    const z = clamp(Math.min(cw / ((x1 - x0) * s), (ch - top - bottom) / ((y1 - y0) * s)), 1, 2.6);
    if (z <= 1.05) return;
    const cx = ox + s * (x0 + x1) / 2, cy = oy + s * (y0 + y1) / 2;
    st.vt.photo = { z, x: cw / 2 - z * cx, y: top + (ch - top - bottom) / 2 - z * cy };
  }
  $('#file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setMode('photo');
    loadPhoto(URL.createObjectURL(f), false);
    e.target.value = '';
  });

  async function startLive() {
    const lv = st.live;
    lv.error = null;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { lv.error = 'blocked'; renderStageChrome(); return; }
    try {
      lv.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (e) {
      lv.error = e && e.name === 'NotAllowedError' ? 'denied' : 'blocked';
      renderStageChrome();
      return;
    }
    video.srcObject = lv.stream; video.hidden = false;
    try { await video.play(); } catch (e) { /* autoplay with muted is fine */ }
    lv.running = true; lv.busy = false; lv.lastSeen = 0; lv.smooth.clear();
    renderStageChrome();
    requestAnimationFrame(liveTick);
  }
  function stopLive() {
    const lv = st.live;
    lv.running = false;
    if (lv.stream) lv.stream.getTracks().forEach((t) => t.stop());
    lv.stream = null; video.srcObject = null; video.hidden = true; lv.scene = null;
  }
  // Live: read every frame at full video resolution; the worker sets the pace (a few reads a second)
  function liveTick() {
    const lv = st.live;
    if (!lv.running || st.mode !== 'live') return;
    if (!lv.busy && video.readyState >= 2 && video.videoWidth) {
      lv.busy = true;
      const vw = video.videoWidth, vh = video.videoHeight;
      readFrom(video, vw, vh, 1920).then((raw) => {
        lv.busy = false;
        if (!lv.running || st.mode !== 'live') return;
        liveUpdate(raw || [], performance.now(), vw, vh);
      });
    }
    requestAnimationFrame(liveTick);
  }
  function liveUpdate(raw, now, vw, vh) {
    const lv = st.live;
    lv.vw = vw; lv.vh = vh;
    // smooth corners per marker, hold briefly when a marker flickers out
    const seen = new Set();
    for (const m of raw) {
      seen.add(m.id);
      const s = lv.smooth.get(m.id);
      if (s && now - s.t < 900 && V.dist(s.corners[0], m.corners[0]) < 40) {
        s.corners = s.corners.map((c, i) => V.lerp(c, m.corners[i], 0.6)); s.t = now; s.hd = m.hd;
      } else lv.smooth.set(m.id, { id: m.id, hd: m.hd, corners: m.corners, t: now });
    }
    for (const [id, s] of lv.smooth) if (!seen.has(id) && now - s.t > 800) lv.smooth.delete(id);
    const dets = [...lv.smooth.values()];
    if (dets.length) lv.lastSeen = now;
    lv.scene = dets.length ? E.solveScene(dets, st.cfg, { imgW: vw, imgH: vh, dial: st.manualDial }) : null;
    ensureSelection(lv.scene);
    draw();
    if (now - lv.lastPanel > 300) { lv.lastPanel = now; renderChrome(lv.scene); }
  }

  // ---------- stage chrome (banners, call-to-action cards) ----------
  function renderStageChrome() {
    const banner = $('#banner'), cta = $('#cta');
    banner.hidden = true; cta.hidden = true; banner.className = 'banner';
    $('#zoom').hidden = st.mode === 'live';
    if (st.mode === 'photo') {
      const ph = st.photo;
      if (ph.busy) { banner.hidden = false; banner.innerHTML = 'Reading markers…'; return; }
      if (ph.error) { cta.hidden = false; cta.innerHTML = `<div class="card"><h2>Couldn't read that</h2><p>${ph.error}</p><button type="button" class="btn primary" data-snap>Try another photo</button></div>`; }
      else if (ph.scene && !ph.scene.ok) {
        cta.hidden = false;
        cta.innerHTML = `<div class="card"><h2>No markers found</h2><p>Shoot from straight above in even light, no more than about ${ph.img ? reachCm(ph.img.naturalWidth, ph.img.naturalHeight) : 150} cm over the table for this camera. Glossy stickers and blur are the usual culprits.</p><button type="button" class="btn primary" data-snap>Snap another</button><button type="button" class="btn" id="back-sample">Back to the sample</button></div>`;
      } else {
        banner.hidden = false;
        const sc = ph.scene;
        const windNote = sc && sc.ok && sc.wind.src === 'manual' ? ` <span class="pill">wind dial not in shot · set by hand</span>` : '';
        if (sc && sc.ok && sc.wind.src === 'manual') banner.classList.add('warn');
        banner.innerHTML = ph.isSample
          ? `<span>Sample table.</span> <button type="button" class="btn primary" data-snap>📸 Snap your table</button>`
          : `<span>${sc ? sc.boats.length : 0} boats read.</span>${windNote} <button type="button" class="btn" data-snap>📸 New photo</button>`;
      }
    } else if (st.mode === 'live') {
      const lv = st.live;
      if (lv.running) {
        const sc = lv.scene;
        banner.hidden = false;
        const reach = lv.vw ? reachCm(lv.vw, lv.vh) : 80;
        banner.innerHTML = sc && sc.ok
          ? `<span class="pill">live</span> ${sc.boats.length} boats${sc.wind.src === 'manual' ? ' · dial not in view' : ''}`
          : `<span class="pill">live</span> Looking for markers. Hold the phone flat, no more than about ${reach} cm above the table.`;
      } else {
        cta.hidden = false;
        cta.innerHTML = lv.error
          ? `<div class="card"><h2>${lv.error === 'denied' ? 'Camera permission is off' : 'Camera is blocked here'}</h2><p>${lv.error === 'denied' ? 'Allow camera access for this page in your browser settings, then try again.' : 'This preview window does not allow the camera. Photo mode does the same job one shot at a time, and the hosted copy of this page runs Live.'}</p>${lv.error !== 'denied' && location.hostname !== HOSTED_HOST ? `<a class="btn primary" href="${HOSTED_URL}" target="_blank" rel="noopener">Open the hosted copy</a>` : ''}<button type="button" class="btn ${lv.error === 'denied' || location.hostname === HOSTED_HOST ? 'primary' : ''}" data-snap>📸 Use a photo instead</button><button type="button" class="btn" id="live-retry">Try the camera again</button></div>`
          : `<div class="card"><h2>Point at the table</h2><p>Hold the phone above the course so the wind dial and the boats are in view. Tap a boat to see its moves.</p><button type="button" class="btn primary" id="live-start">Start camera</button></div>`;
      }
    }
    stage.querySelectorAll('[data-snap]').forEach((b) => (b.onclick = () => $('#file').click()));
    const ls = $('#live-start'); if (ls) ls.onclick = startLive;
    const lr = $('#live-retry'); if (lr) lr.onclick = startLive;
    const bs = $('#back-sample'); if (bs) bs.onclick = () => loadPhoto(window.REGATTA_SAMPLE, true);
  }

  function renderChrome(sc) {
    renderGauge(sc);
    renderOrder(sc);
    renderPanel(sc);
    if (st.mode === 'live') renderStageChrome();
  }
  function refresh() {
    draw();
    const sc = currentScene();
    renderChrome(sc);
    renderStageChrome();
  }
  function select(id) { if (st.selected !== id) { st.selected = id; st.focus = null; } refresh(); }

  function setMode(m) {
    if (st.mode === m) return;
    if (st.mode === 'live') stopLive();
    st.mode = m; st.focus = null;
    document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    if (m === 'sandbox') { if (!st.sandbox) st.sandbox = sandboxFresh(); st.selected = st.selected || 14; }
    if (m === 'photo') resolveCamera();
    refresh();
  }
  document.querySelectorAll('.modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

  // ---------- pointer: select, drag boats (sandbox), pan + pinch zoom ----------
  const pointers = new Map();
  let drag = null;
  function screenPt(e) { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function hitBoat(s) {
    const v = view(); if (!v.scene || !v.scene.ok || !v.P) return null;
    let best = null, bd = 30;
    for (const b of v.scene.boats) { const c = v.P(b.pos); if (!c) continue; const d = V.dist(c, s); if (d < bd) { bd = d; best = b; } }
    return best;
  }
  canvas.addEventListener('pointerdown', (e) => {
    const s = screenPt(e);
    pointers.set(e.pointerId, s);
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; drag = { kind: 'pinch', d0: V.dist(a, b), m0: V.mid(a, b), vt0: { ...curVt() } }; return; }
    const hit = hitBoat(s);
    if (hit) {
      select(hit.id);
      if (st.mode === 'sandbox') { const v = view(); drag = { kind: 'boat', id: hit.id, off: V.sub(hit.pos, v.inv(s)), moved: false }; }
      else drag = null;
    } else if (st.mode !== 'live') drag = { kind: 'pan', s0: s, vt0: { ...curVt() }, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const s = screenPt(e); pointers.set(e.pointerId, s);
    if (!drag) return;
    if (drag.kind === 'boat') {
      const v = view(), b = st.sandbox.boats.find((x) => x.id === drag.id);
      if (!drag.moved) { st.sandbox.history.push(JSON.stringify({ boats: st.sandbox.boats, moved: [...st.sandbox.moved], dial: st.sandbox.dial, roundOrder: st.sandbox.roundOrder, selected: st.selected, lastRoll: st.sandbox.lastRoll })); drag.moved = true; }
      b.pos = V.add(v.inv(s), drag.off);
      draw();
    } else if (drag.kind === 'pan') {
      const t = curVt(); t.x = drag.vt0.x + s.x - drag.s0.x; t.y = drag.vt0.y + s.y - drag.s0.y; drag.moved = true; draw();
    } else if (drag.kind === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()], m = V.mid(a, b);
      const z = clamp(drag.vt0.z * V.dist(a, b) / drag.d0, 1, 6);
      const t = curVt();
      t.z = z; t.x = m.x - (drag.m0.x - drag.vt0.x) * (z / drag.vt0.z); t.y = m.y - (drag.m0.y - drag.vt0.y) * (z / drag.vt0.z);
      draw();
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (drag && drag.kind === 'boat' && drag.moved) { st.focus = null; refresh(); }
    if (pointers.size < 2 && drag && drag.kind === 'pinch') drag = null;
    if (!pointers.size) drag = null;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('wheel', (e) => { if (st.mode === 'live') return; e.preventDefault(); zoomAt(screenPt(e), e.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
  function curVt() { return st.vt[st.mode] || { z: 1, x: 0, y: 0 }; }
  function zoomAt(f, k) {
    const t = curVt(), z = clamp(t.z * k, 1, 6);
    t.x = f.x - (f.x - t.x) * (z / t.z); t.y = f.y - (f.y - t.y) * (z / t.z); t.z = z;
    if (z === 1) { t.x = 0; t.y = 0; }
    draw();
  }
  $('#zoom-in').onclick = () => {
    const v = view(), sel = v.scene && v.scene.ok && v.scene.boats.find((b) => b.id === st.selected);
    const f = sel && v.P ? v.P(sel.pos) : { x: cw / 2, y: ch / 2 };
    zoomAt(f || { x: cw / 2, y: ch / 2 }, 1.6);
  };
  $('#zoom-out').onclick = () => zoomAt({ x: cw / 2, y: ch / 2 }, 1 / 1.6);

  // ---------- sheets: settings, help, markers ----------
  function openSheet(id) { const s = $(id); s.hidden = false; const f = s.querySelector('button, input'); if (f) f.focus(); }
  function closeSheets() { document.querySelectorAll('.sheet-wrap').forEach((s) => (s.hidden = true)); }
  $('#open-help').onclick = () => openSheet('#help');
  $('#open-settings').onclick = () => { fillSettings(); openSheet('#settings'); };
  document.querySelectorAll('.sheet-wrap').forEach((w) => {
    w.addEventListener('click', (e) => { if (e.target === w || e.target.closest('[data-close]')) closeSheets(); });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });
  function fillSettings() {
    document.querySelectorAll('#settings [data-k]').forEach((i) => (i.value = st.cfg[i.dataset.k]));
    document.querySelectorAll('#settings [data-m]').forEach((i) => (i.value = st.cfg.marker[i.dataset.m]));
  }
  document.querySelectorAll('#settings input').forEach((inp) => inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (!isFinite(v) || v <= 0) { fillSettings(); return; }
    if (inp.dataset.k) st.cfg[inp.dataset.k] = v; else st.cfg.marker[inp.dataset.m] = v;
    store.set('cfg15', st.cfg);
    resolveCamera(); refresh();
  }));
  $('#reset-settings').onclick = () => { st.cfg = E.config(); store.set('cfg15', null); fillSettings(); resolveCamera(); refresh(); };

  function markerSVG(id) {
    const c = E.CODES[id], bits = c.map((b) => b.toString(2).padStart(8, '0')).join('').slice(0, 16);
    let s = '<svg viewBox="0 0 6 6" shape-rendering="crispEdges" aria-hidden="true"><rect width="6" height="6" fill="#000"/>';
    for (let i = 0; i < 16; i++) if (bits[i] === '1') s += `<rect x="${1 + (i % 4)}" y="${1 + Math.floor(i / 4)}" width="1" height="1" fill="#fff"/>`;
    return s + '</svg>';
  }
  $('#marker-grid').innerHTML = [
    [0, 'Wind hub', COL.wind], [1, 'Course base', COL.flag],
    ...E.BOATS.map((b) => [b.id, b.name, b.color]),
    [20, 'Finish A', COL.flag], [21, 'Finish B', COL.flag], [22, 'Start C', COL.flag], [23, 'Start C', COL.flag],
  ].map(([id, l, c]) => `<figure style="--k:${c}">${markerSVG(id)}<figcaption>${l}<br><span style="font-family:var(--mono)">id ${id}</span></figcaption></figure>`).join('');

  $('#save-markers').onclick = async () => {
    const status = $('#save-status');
    const bin = atob(window.REGATTA_MARKERS_PDF), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    let dl = null;
    try { dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (e) { dl = null; }
    if (dl) {
      try { await dl.save({ filename: 'regatta-markers.pdf', data: blob }); status.textContent = 'Saved. Print it at 100%.'; }
      catch (e) { status.textContent = e && e.code === 'declined' ? 'Save cancelled.' : 'Saving is not available in this view. Ask for the PDF in chat, or open the hosted copy.'; }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'regatta-markers.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    status.textContent = 'Downloading regatta-markers.pdf. Print it at 100%.';
  };

  // ---------- boot ----------
  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
  st.sandbox = sandboxFresh();
  resize();
  refresh();
  loadPhoto(window.REGATTA_SAMPLE, true);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => draw());
})();
