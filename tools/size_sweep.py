"""Render test shots of small markers at a range of camera resolutions (px per mm).

Each shot: wood table, coloured teardrop meeples and cards as distractors, all 11 game
markers (twice each) at random headings, mild tilt, lens blur, sensor noise, JPEG.
Usage: python3 tools/size_sweep.py OUTDIR [marker_black_mm] [margin_mm]
Writes OUTDIR/sweep-<pxmm>-<k>.png and OUTDIR/sweep.json (ground truth).
"""
import json, math, sys, os
import numpy as np
import cv2

OUT = sys.argv[1]
BLACK = float(sys.argv[2]) if len(sys.argv) > 2 else 12.5   # black square edge, mm
MARGIN = float(sys.argv[3]) if len(sys.argv) > 3 else 1.25  # white border each side, mm
os.makedirs(OUT, exist_ok=True)
ar = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
IDS = [0, 1, 10, 11, 12, 13, 14, 20, 21, 22, 23]
COLORS = [(219, 163, 75), (92, 51, 34), (47, 122, 52), (123, 91, 45), (143, 45, 142), (40, 110, 220)]
AREA = (420, 300)          # mm of table in each shot
SS = 10.0                  # supersample: px per mm for the master render
PXMM = [0.9, 1.1, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0]
SHOTS = 3
truth = {'black': BLACK, 'margin': MARGIN, 'shots': []}

def render_master(rng):
    W, H = int(AREA[0] * SS), int(AREA[1] * SS)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    grain = np.sin(xx / SS * 0.06 + np.sin(yy / SS * 0.02) * 3) * 0.5 + 0.5
    img = np.clip((0.84 + 0.1 * grain)[..., None] * np.array([112, 152, 196], np.float32) * 1.08, 0, 255).astype(np.uint8)
    P = lambda x, y: (int(round(x * SS)), int(round(y * SS)))
    # cards (white with a coloured band) as distractors
    for _ in range(3):
        cx, cy, a = rng.uniform(40, AREA[0] - 40), rng.uniform(40, AREA[1] - 40), rng.uniform(0, 180)
        box = cv2.boxPoints(((cx * SS, cy * SS), (63.5 * SS, 88.9 * SS), a)).astype(np.int32)
        cv2.fillPoly(img, [box], (245, 245, 245), cv2.LINE_AA)
        cv2.polylines(img, [box], True, (40, 40, 40), int(SS * 0.4), cv2.LINE_AA)
    markers = []
    placed = []
    for rep in range(2):
        for mid in IDS:
            for _ in range(200):
                x, y = rng.uniform(22, AREA[0] - 22), rng.uniform(22, AREA[1] - 22)
                if all(math.hypot(x - px, y - py) > 34 for px, py in placed):
                    break
            placed.append((x, y))
            ang = rng.uniform(0, 360)
            h = (math.cos(math.radians(ang)), math.sin(math.radians(ang)))
            n = (-h[1], h[0])
            col = COLORS[rng.integers(len(COLORS))]
            # teardrop meeple ~ 24 x 32 mm
            L, r = 32, 12
            bow = (x + h[0] * L * 0.55, y + h[1] * L * 0.55)
            cc = (x - h[0] * (L * 0.45 - r), y - h[1] * (L * 0.45 - r))
            pts = [bow] + [(cc[0] + n[0] * math.cos(t) * r - h[0] * math.sin(t) * r, cc[1] + n[1] * math.cos(t) * r - h[1] * math.sin(t) * r) for t in np.linspace(0, math.pi, 24)]
            cv2.fillPoly(img, [np.array([P(*p) for p in pts], np.int32)], col, cv2.LINE_AA)
            # marker: white margin square, then 6x6 black/white cells. top edge = heading
            bits = cv2.aruco.generateImageMarker(ar, mid, 6) > 127
            cell = BLACK / 6
            def at(i, j, off=0.0):
                a = (i - 3) * cell; b = (j - 3) * cell
                return (x + n[0] * a + h[0] * -b, y + n[1] * a + h[1] * -b)
            q = 3 + MARGIN / cell
            sq = [(x + n[0] * a * cell - h[0] * b * cell, y + n[1] * a * cell - h[1] * b * cell) for a, b in [(-q, q), (q, q), (q, -q), (-q, -q)]]
            cv2.fillPoly(img, [np.array([P(*p) for p in sq], np.int32)], (250, 250, 250), cv2.LINE_AA)
            for j in range(6):
                for i in range(6):
                    c = (240, 240, 240) if bits[j, i] else (20, 20, 20)
                    quad = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]
                    cv2.fillPoly(img, [np.array([P(*p) for p in quad], np.int32)], c, cv2.LINE_AA)
            markers.append({'id': mid, 'pos': (x, y), 'up': h})
    return img, markers

rng = np.random.default_rng(11)
for pxmm in PXMM:
    for k in range(SHOTS):
        master, markers = render_master(rng)
        # downsample to target px/mm (area filter), then a mild perspective tilt
        tw, th = int(AREA[0] * pxmm), int(AREA[1] * pxmm)
        small = cv2.resize(master, (tw, th), interpolation=cv2.INTER_AREA)
        j = lambda s: rng.uniform(-s, s)
        src = np.float32([[0, 0], [tw, 0], [tw, th], [0, th]])
        dst = np.float32([[j(0.03) * tw, j(0.03) * th], [tw * (1 + j(0.03)), j(0.03) * th], [tw * (1 + j(0.03)), th * (1 + j(0.03))], [j(0.03) * tw, th * (1 + j(0.03))]])
        M = cv2.getPerspectiveTransform(src, dst)
        shot = cv2.warpPerspective(small, M, (tw, th), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        gy, gx = np.mgrid[0:th, 0:tw].astype(np.float32)
        light = 0.8 + 0.28 * np.exp(-(((gx - tw * 0.6) / (tw * 0.8)) ** 2 + ((gy - th * 0.3) / (th * 0.8)) ** 2))
        shot = cv2.GaussianBlur(shot.astype(np.float32) * light[..., None], (0, 0), 0.75)
        shot = np.clip(shot + rng.normal(0, 3.5, shot.shape), 0, 255).astype(np.uint8)
        ok, enc = cv2.imencode('.jpg', shot, [cv2.IMWRITE_JPEG_QUALITY, 85])
        shot = cv2.imdecode(enc, cv2.IMREAD_COLOR)
        name = f'sweep-{pxmm:.2f}-{k}.png'
        cv2.imwrite(os.path.join(OUT, name), shot)
        # truth in image coordinates
        T = M @ np.array([[pxmm, 0, 0], [0, pxmm, 0], [0, 0, 1]])
        def tp(p):
            v = T @ np.array([p[0], p[1], 1.0]); return [float(v[0] / v[2]), float(v[1] / v[2])]
        ms = [{'id': m['id'], 'img': tp(m['pos']), 'imgUp': tp((m['pos'][0] + m['up'][0] * 10, m['pos'][1] + m['up'][1] * 10))} for m in markers]
        truth['shots'].append({'file': name, 'pxmm': pxmm, 'markers': ms})
json.dump(truth, open(os.path.join(OUT, 'sweep.json'), 'w'))
print('rendered', len(truth['shots']), 'shots; black', BLACK, 'mm, margin', MARGIN, 'mm, cell', round(BLACK / 6, 2), 'mm')
