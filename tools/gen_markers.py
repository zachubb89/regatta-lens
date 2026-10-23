"""Printable 15 mm sticker sheet (US Letter, vector) for Regatta Lens.
Each sticker: 12.5 mm code (black square) + 1.25 mm white edge = 15 mm square.
Usage: python3 tools/gen_markers.py OUT.pdf [black_mm] [edge_mm]"""
import sys
import cv2
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, black, white

OUT = sys.argv[1] if len(sys.argv) > 1 else 'regatta-markers.pdf'
BLACK = float(sys.argv[2]) if len(sys.argv) > 2 else 12.5
EDGE = float(sys.argv[3]) if len(sys.argv) > 3 else 1.25
STICK = BLACK + 2 * EDGE
ar = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
INK = HexColor('#14213D'); MUTED = HexColor('#5B6B82'); ORANGE = HexColor('#E3742A'); WIND = HexColor('#4A9ACF')
CUT = HexColor('#9AA7B8')

def sticker(c, mid, x, y, tint):
    """x,y = sticker centre (mm). Cut line on the sticker edge, top tick outside it."""
    bits = cv2.aruco.generateImageMarker(ar, mid, 6) > 127
    cell = BLACK / 6
    h = STICK / 2
    # crop ticks at the corners, outside the sticker, so the cut line never prints on it
    c.setStrokeColor(CUT); c.setLineWidth(0.3)
    for sx in (-1, 1):
        for sy in (-1, 1):
            cx, cy = x + sx * h, y + sy * h
            c.line(cx * mm, (cy + sy * 0.8) * mm, cx * mm, (cy + sy * 2.6) * mm)
            c.line((cx + sx * 0.8) * mm, cy * mm, (cx + sx * 2.6) * mm, cy * mm)
    # white edge is the paper itself; the black square sits inside it
    c.setFillColor(black)
    c.rect((x - BLACK / 2) * mm, (y - BLACK / 2) * mm, BLACK * mm, BLACK * mm, stroke=0, fill=1)
    c.setFillColor(white)
    for j in range(6):
        for i in range(6):
            if bits[j, i]:
                c.rect((x - BLACK / 2 + i * cell) * mm, (y + BLACK / 2 - (j + 1) * cell) * mm, cell * mm + 0.02, cell * mm + 0.02, stroke=0, fill=1)
    # top tick: a coloured triangle just above the sticker, outside the cut
    c.setFillColor(tint)
    t = y + h + 1.7
    p = c.beginPath(); p.moveTo(x * mm, (t + 1.2) * mm); p.lineTo((x - 1.3) * mm, (t - 0.8) * mm); p.lineTo((x + 1.3) * mm, (t - 0.8) * mm); p.close()
    c.drawPath(p, stroke=0, fill=1)

def row(c, y, items, x0, gap, label_under=True):
    for k, (mid, label, tint) in enumerate(items):
        x = x0 + k * gap
        sticker(c, mid, x, y, tint)
        if label_under:
            c.setFont('Helvetica-Bold', 6.3); c.setFillColor(INK)
            c.drawCentredString(x * mm, (y - STICK / 2 - 4.2) * mm, label)
            c.setFont('Helvetica', 5.4); c.setFillColor(MUTED)
            c.drawCentredString(x * mm, (y - STICK / 2 - 6.6) * mm, f'id {mid}')

c = canvas.Canvas(OUT, pagesize=letter)
c.setTitle('Regatta Lens stickers (15 mm)'); c.setAuthor('Regatta Lens')
W, H = letter[0] / mm, letter[1] / mm
L = 16
c.setFillColor(INK); c.setFont('Helvetica-Bold', 17)
c.drawString(L * mm, (H - 20) * mm, f'Regatta Lens · {STICK:g} mm stickers')
c.setFont('Helvetica', 8.6); c.setFillColor(MUTED)
lines = [
    f'Print at 100% / "Actual size" on matte paper or matte sticker stock. Each sticker is a {BLACK:g} mm code with a {EDGE:g} mm white edge.',
    'Cut between the corner ticks and keep the white edge: the camera finds the code by its black-on-white outline.',
    'The coloured triangle marks each sticker\'s TOP. Stick it down before you lose track: top = bow, upwind, or toward the finish.',
]
for i, t in enumerate(lines):
    c.drawString(L * mm, (H - 28 - i * 4.4) * mm, t)
y0 = H - 46
c.setStrokeColor(INK); c.setLineWidth(0.8)
c.line(L * mm, y0 * mm, (L + 50) * mm, y0 * mm)
for k in range(0, 51, 10):
    c.line((L + k) * mm, (y0 - (1.6 if k % 50 else 2.6)) * mm, (L + k) * mm, y0 * mm)
c.setFont('Helvetica-Bold', 7.5); c.setFillColor(INK)
c.drawString((L + 53) * mm, (y0 - 1.2) * mm, '50 mm. Measure this. If it is off, your printer scaled the page.')

def section(y, title, note):
    c.setFont('Helvetica-Bold', 10); c.setFillColor(INK); c.drawString(L * mm, y * mm, title)
    c.setFont('Helvetica', 7.6); c.setFillColor(MUTED); c.drawString(L * mm, (y - 4.2) * mm, note)

GAP = 27
X0 = L + 10
boats = [(10, 'BLUE', HexColor('#4BA3DB')), (11, 'NAVY', HexColor('#22335C')), (12, 'GREEN', HexColor('#2F7A34')), (13, 'DARK BLUE', HexColor('#2D5B7B')), (14, 'PURPLE', HexColor('#8E2D8F'))]
marks = [(20, 'FINISH A', ORANGE), (21, 'FINISH B', ORANGE), (22, 'START C', ORANGE), (23, 'START C', ORANGE)]
dial = [(0, 'WIND', WIND), (1, 'COURSE', ORANGE)]

section(H - 58, 'Wind dial', 'WIND goes on the rotating arrow (top = upwind). COURSE goes on the fixed base (top = toward the finish).')
row(c, H - 74, dial + dial, X0, GAP)
section(H - 98, 'Boats', 'Flat on top of each meeple, top = bow. Two sets, so you have spares.')
row(c, H - 114, boats, X0, GAP)
row(c, H - 143, boats, X0, GAP)
section(H - 167, 'Course marks', 'On top of each cylinder, top = upwind. A + B = finish line (A on the left looking upwind). C + C = start line.')
row(c, H - 183, marks, X0, GAP)
row(c, H - 212, marks, X0, GAP)

c.setFont('Helvetica', 7.2); c.setFillColor(MUTED)
c.drawString(L * mm, 24 * mm, 'Reading range: a phone photo reads these from about 2 m away; Live camera mode from about 80 cm. Closer is always better.')
c.drawString(L * mm, 19.5 * mm, 'Printing straight onto the pieces (UV printer, waterslide decal) works too. Keep a white edge of at least 1 mm around the black square.')
c.drawString(L * mm, 12 * mm, 'ArUco 4x4 markers, ids 0-23 (same bits as OpenCV DICT_4X4_50).')
c.showPage(); c.save()
print('wrote', OUT)
