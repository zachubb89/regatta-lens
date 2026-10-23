"""Render a synthetic 'phone photo' of a Regatta table with ArUco markers.
Writes sample.jpg, sample.png (lossless, for tests) and truth.json.
Plane units: mm, x right, y down; upwind is -y when the dial reads 0."""
import json, math, sys
import numpy as np
import cv2

OUT = sys.argv[1] if len(sys.argv) > 1 else '.'
PHONE = len(sys.argv) > 2 and sys.argv[2] == 'phone'   # full 12 MP phone photo instead of the web sample
S = 4.0 if PHONE else 2.5    # plane render scale, px per mm
MK = 12.5                    # black square edge of every sticker, mm (15 mm sticker with a 1.25 mm white edge)
X0, X1, Y0, Y1 = -720, 640, -900, 420
W, H = int((X1 - X0) * S), int((Y1 - Y0) * S)
TICK = 20
DIAL = +1
rng = np.random.default_rng(7)
ar = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)

def P(x, y):
    return (int(round((x - X0) * S)), int(round((y - Y0) * S)))

def rot(v, deg):
    t = math.radians(deg); c, s = math.cos(t), math.sin(t)
    return (v[0] * c - v[1] * s, v[0] * s + v[1] * c)

def marker_bits(mid):
    return cv2.aruco.generateImageMarker(ar, mid, 6) > 127   # 6x6, True = white

# ---------- table ----------
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
grain = np.sin((xx * 0.012 + np.sin(yy * 0.004) * 3.0 + np.sin(yy * 0.0013 + 1) * 6)) * 0.5 + 0.5
fine = cv2.GaussianBlur(rng.normal(0, 1, (H, W)).astype(np.float32), (0, 0), sigmaX=1.2, sigmaY=14)
tone = 0.82 + 0.10 * grain + 0.035 * fine
base = np.array([112, 152, 196], np.float32)  # BGR light oak
img = np.clip(tone[..., None] * base[None, None, :] * 1.08, 0, 255).astype(np.uint8)
# plank seams
for xs in range(X0, X1, 180):
    cv2.line(img, P(xs, Y0), P(xs, Y1), (70, 100, 135), 2, cv2.LINE_AA)

shadow = np.zeros((H, W), np.float32)

SHIFT = 4  # sub-pixel vertex precision (1/16 px)

def poly_exact(pts, color):
    """Fill a convex polygon covering exactly its area: OpenCV fills include boundary pixels,
    so pull every edge in by half a pixel (otherwise small shapes render ~1 px too big)."""
    px = [((x - X0) * S - 0.5, (y - Y0) * S - 0.5) for x, y in pts]
    cx = sum(p[0] for p in px) / len(px); cy = sum(p[1] for p in px) / len(px)
    half = max(1.0, min(math.hypot(p[0] - cx, p[1] - cy) for p in px) / math.sqrt(2))
    k = (half - 0.5) / half
    arr = np.array([[(cx + (x - cx) * k) * (1 << SHIFT), (cy + (y - cy) * k) * (1 << SHIFT)] for x, y in px], np.int32)
    cv2.fillPoly(img, [arr], color, cv2.LINE_8, SHIFT)

def poly(pts, color, shadow_off=None):
    arr = np.array([P(*p) for p in pts], np.int32)
    if shadow_off:
        sh = arr + np.array([int(shadow_off[0] * S), int(shadow_off[1] * S)])
        cv2.fillPoly(shadow, [sh], 1.0)
    cv2.fillPoly(img, [arr], color, cv2.LINE_AA)

def circle(c, r, color, thick=-1):
    cv2.circle(img, P(*c), int(r * S), color, thick, cv2.LINE_AA)

def draw_marker(mid, center, size, up=(0, -1), quiet=0.25, quiet_color=(250, 250, 250)):
    """size = black square edge (mm); up = marker top direction on the plane."""
    bits = marker_bits(mid)
    ux, uy = up; n = math.hypot(ux, uy); ux, uy = ux / n, uy / n
    rx, ry = -uy, ux   # marker 'right' = up rotated +90 (clockwise on screen)
    cell = size / 6
    def at(i, j):  # cell column i, row j corner (top-left origin)
        a = (i - 3) * cell; b = (j - 3) * cell
        return (center[0] + rx * a - ux * b, center[1] + ry * a - uy * b)
    q = 3 + quiet * 6
    poly_exact([(center[0] + rx * a - ux * b, center[1] + ry * a - uy * b) for a, b in
          [(-q * cell, -q * cell), (q * cell, -q * cell), (q * cell, q * cell), (-q * cell, q * cell)]], quiet_color)
    for j in range(6):
        for i in range(6):
            col = (245, 245, 245) if bits[j, i] else (22, 22, 22)
            poly_exact([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)], col)

truth = {'tickDeg': TICK, 'dial': DIAL, 'markers': {}}
u = rot((0, -1), -DIAL * TICK)            # upwind direction
port = rot(u, 45); stbd = rot(u, -45)

# ---------- wind dial ----------
D = (-330, 210)
circle(D, 92, (60, 50, 40)); circle(D, 90, (207, 154, 74))          # fixed blue ring
for k in range(-3, 4):
    a = math.radians(90 + k * TICK)                                   # tick positions around 6 o'clock
    p0 = (D[0] + math.cos(a) * 78, D[1] + math.sin(a) * 78); p1 = (D[0] + math.cos(a) * 90, D[1] + math.sin(a) * 90)
    cv2.line(img, P(*p0), P(*p1), (30, 30, 30), 3, cv2.LINE_AA)
circle(D, 66, (40, 40, 40))
# rotating disk: halves + Y arrows
def ang_pts(a0, a1, r, c=D, n=40):
    return [(c[0] + math.cos(math.radians(a)) * r, c[1] + math.sin(math.radians(a)) * r) for a in np.linspace(a0, a1, n)]
ua = math.degrees(math.atan2(u[1], u[0]))     # angle of upwind on plane
poly([D] + ang_pts(ua + 45, ua + 180, 62), (110, 105, 190))         # port half (reddish)
poly([D] + ang_pts(ua - 180, ua - 45, 62), (150, 215, 160))         # starboard half (green)
poly([D] + ang_pts(ua - 45, ua + 45, 62), (20, 20, 20))             # no-sail zone
for d, col in ((port, (40, 40, 180)), (stbd, (70, 160, 90))):
    tip = (D[0] + d[0] * 86, D[1] + d[1] * 86)
    cv2.line(img, P(*D), P(*tip), col, int(12 * S), cv2.LINE_AA)
dn = (-u[0], -u[1])
cv2.line(img, P(*D), P(D[0] + dn[0] * 80, D[1] + dn[1] * 80), (35, 35, 35), int(22 * S), cv2.LINE_AA)
draw_marker(0, D, MK, up=u, quiet=0.1)
truth['markers']['0'] = {'pos': D, 'up': u}

# course placard (fixed, points down the course)
CP = (-170, 255)
poly([(CP[0] - 34, CP[1] - 40), (CP[0] + 34, CP[1] - 40), (CP[0] + 34, CP[1] + 40), (CP[0] - 34, CP[1] + 40)], (240, 240, 240), shadow_off=(3, 4))
draw_marker(1, CP, MK, up=(0, -1), quiet=0.1)
truth['markers']['1'] = {'pos': CP, 'up': (0, -1)}

# finish marks (orange cylinder tops)
for mid, pos in ((20, (-110, -560)), (21, (250, -560))):
    cv2.circle(shadow, P(pos[0] + 6, pos[1] + 8), int(30 * S), 1.0, -1)
    circle(pos, 30, (40, 110, 220))
    circle(pos, 30, (30, 80, 170), 2)
    draw_marker(mid, pos, MK, up=(0, -1), quiet=0.1)
    truth['markers'][str(mid)] = {'pos': pos, 'up': (0, -1)}

# boats: id, colour (BGR), position, tack
BOATS = [
    (14, (143, 45, 142), (95, -340), 'port'),
    (11, (92, 51, 34), (-80, -250), 'starboard'),
    (13, (123, 91, 45), (72, -207), 'port'),
    (12, (52, 122, 47), (-200, -105), 'port'),
    (10, (219, 163, 75), (-46, -76), 'starboard'),
]
for mid, col, pos, tack in BOATS:
    h = port if tack == 'port' else stbd
    jitter = rng.normal(0, 2.5)               # players never place pieces perfectly
    h = rot(h, jitter)
    n = (-h[1], h[0]); L, r = 50, 16
    bow = (pos[0] + h[0] * L * 0.55, pos[1] + h[1] * L * 0.55)
    cc = (pos[0] - h[0] * (L * 0.45 - r), pos[1] - h[1] * (L * 0.45 - r))
    pts = [bow] + [(cc[0] + n[0] * math.cos(a) * r - h[0] * math.sin(a) * r,
                    cc[1] + n[1] * math.cos(a) * r - h[1] * math.sin(a) * r) for a in np.linspace(0, math.pi, 24)]
    poly(pts, col, shadow_off=(4, 6))
    draw_marker(mid, pos, MK, up=h, quiet=0.1)
    truth['markers'][str(mid)] = {'pos': pos, 'up': h, 'tack': tack}

# soft contact shadows
sh = cv2.GaussianBlur(shadow, (0, 0), 7) * 0.35
img = np.clip(img.astype(np.float32) * (1 - sh[..., None]), 0, 255).astype(np.uint8)

# ---------- photograph it ----------
OW, OH = (3024, 4032) if PHONE else (1500, 2000)
# a real pinhole camera: phone held ~1 m over the table, tilted forward a little, slight roll
def rotx(a): c, s_ = math.cos(a), math.sin(a); return np.array([[1, 0, 0], [0, c, -s_], [0, s_, c]])
def roty(a): c, s_ = math.cos(a), math.sin(a); return np.array([[c, 0, s_], [0, 1, 0], [-s_, 0, c]])
def rotz(a): c, s_ = math.cos(a), math.sin(a); return np.array([[c, -s_, 0], [s_, c, 0], [0, 0, 1]])
fpx = 0.75 * max(OW, OH)                         # ~26 mm-equivalent main camera
K = np.array([[fpx, 0, OW / 2], [0, fpx, OH / 2], [0, 0, 1]])
R0 = np.array([[1, 0, 0], [0, 1, 0], [0, 0, -1.0]])  # looking straight down: image x = table x, image y = table y
R = rotz(math.radians(2.5)) @ rotx(math.radians(-12)) @ roty(math.radians(3)) @ R0
Cw = np.array([-40.0, 60.0, 900.0])              # camera centre over the table, mm
t = -R @ Cw
Himg = K @ np.column_stack([R[:, 0], R[:, 1], t])   # table mm -> image px
Hplane = np.array([[S, 0, -X0 * S], [0, S, -Y0 * S], [0, 0, 1.0]])  # table mm -> master render px
M = Himg @ np.linalg.inv(Hplane)
# render through an intermediate scale to get proper area filtering
photo = cv2.warpPerspective(img, M, (OW, OH), flags=cv2.INTER_AREA, borderMode=cv2.BORDER_REFLECT)
for name, (x, y) in {'top-left': (0, 0), 'bottom-right': (OW, OH)}.items():
    v = np.linalg.inv(Himg) @ np.array([x, y, 1.0]); print(name, 'of photo sees table at', (v[:2] / v[2]).round())
# light falloff + a warm lamp hotspot
gy, gx = np.mgrid[0:OH, 0:OW].astype(np.float32)
light = 0.78 + 0.32 * np.exp(-(((gx - OW * 0.62) / (OW * 0.8)) ** 2 + ((gy - OH * 0.35) / (OH * 0.7)) ** 2))
photo = np.clip(photo.astype(np.float32) * light[..., None], 0, 255)
photo = cv2.GaussianBlur(photo, (0, 0), 0.8)
photo = np.clip(photo + rng.normal(0, 3.5, photo.shape), 0, 255).astype(np.uint8)

tag = 'phone' if PHONE else 'sample'
cv2.imwrite(f'{OUT}/{tag}.png', photo)
cv2.imwrite(f'{OUT}/{tag}.jpg', photo, [cv2.IMWRITE_JPEG_QUALITY, 80])
truth['M'] = M.tolist(); truth['focal_norm'] = fpx / (max(OW, OH) / 2); truth['S'] = S; truth['X0'] = X0; truth['Y0'] = Y0
json.dump(truth, open(f'{OUT}/truth-{tag}.json', 'w'), indent=1)  # headings get their own random jitter per shot

# OpenCV's own detector, as an independent reference
det = cv2.aruco.ArucoDetector(ar, cv2.aruco.DetectorParameters())
corners, ids, _ = det.detectMarkers(cv2.cvtColor(photo, cv2.COLOR_BGR2GRAY))
print('opencv sees', sorted(int(i) for i in ids.flatten()) if ids is not None else [])
