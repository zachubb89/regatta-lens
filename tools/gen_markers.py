"""Printable marker sheet (US Letter, vector) for Regatta Lens."""
import sys
import cv2
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, black, white

OUT = sys.argv[1] if len(sys.argv) > 1 else 'regatta-markers.pdf'
ar = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
INK = HexColor('#14213D'); MUTED = HexColor('#5B6B82'); ORANGE = HexColor('#E3742A')
PORT = HexColor('#C0322A'); STBD = HexColor('#4C9A44')

def marker(c, mid, x, y, size, label, sub, ring=None, arrow='TOP'):
    """x,y = centre (mm). size = black square edge (mm)."""
    bits = cv2.aruco.generateImageMarker(ar, mid, 6) > 127
    cell = size / 6
    quiet = max(cell * 1.4, 3.5)
    half = size / 2 + quiet
    # cut line
    c.setDash(2, 2); c.setLineWidth(0.4); c.setStrokeColor(MUTED)
    c.rect((x - half) * mm, (y - half) * mm, 2 * half * mm, 2 * half * mm, stroke=1, fill=0)
    c.setDash()
    if ring is not None:
        c.setStrokeColor(ring); c.setLineWidth(1.6)
        r = half - 0.6
        c.rect((x - r) * mm, (y - r) * mm, 2 * r * mm, 2 * r * mm, stroke=1, fill=0)
    c.setFillColor(black)
    c.rect((x - size / 2) * mm, (y - size / 2) * mm, size * mm, size * mm, stroke=0, fill=1)
    c.setFillColor(white)
    for j in range(6):
        for i in range(6):
            if bits[j, i]:
                c.rect((x - size / 2 + i * cell) * mm, (y + size / 2 - (j + 1) * cell) * mm, cell * mm + 0.02, cell * mm + 0.02, stroke=0, fill=1)
    # orientation tick: small triangle above the square = the top edge
    c.setFillColor(INK)
    t = y + size / 2 + quiet * 0.55
    p = c.beginPath(); p.moveTo(x * mm, (t + 1.3) * mm); p.lineTo((x - 1.4) * mm, (t - 0.9) * mm); p.lineTo((x + 1.4) * mm, (t - 0.9) * mm); p.close()
    c.drawPath(p, stroke=0, fill=1)
    c.setFont('Helvetica-Bold', 7.5); c.setFillColor(INK)
    c.drawCentredString(x * mm, (y - half - 4) * mm, label)
    if sub:
        c.setFont('Helvetica', 6.2); c.setFillColor(MUTED)
        c.drawCentredString(x * mm, (y - half - 7) * mm, sub)

c = canvas.Canvas(OUT, pagesize=letter)
c.setTitle('Regatta Lens markers'); c.setAuthor('Regatta Lens')
W, H = letter[0] / mm, letter[1] / mm
L = 16
c.setFillColor(INK); c.setFont('Helvetica-Bold', 17)
c.drawString(L * mm, (H - 20) * mm, 'Regatta Lens · tracking markers')
c.setFont('Helvetica', 8.6); c.setFillColor(MUTED)
lines = [
    'Print at 100% / "Actual size" on matte paper or sticker stock. Glossy finishes glare under lamps and break tracking.',
    'The small triangle marks each marker\'s TOP edge. Cut on the dashed line and keep the white border; it is part of the marker.',
    'Sizes here match the app defaults (wind + course 40 mm, boats 20 mm, course marks 25 mm). Change them in Settings if you print others.',
]
for i, t in enumerate(lines):
    c.drawString(L * mm, (H - 28 - i * 4.4) * mm, t)
# scale bar
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

# wind + course
section(H - 58, 'Wind dial', 'Wind (0) goes on the ROTATING arrow hub, top edge pointing upwind (12:00 at the start). Course (1) goes on the FIXED base, top edge toward the finish.')
marker(c, 0, L + 32, H - 93, 40, 'WIND · id 0', 'rotating hub · top = upwind', ring=HexColor('#4A9ACF'))
marker(c, 1, L + 100, H - 93, 40, 'COURSE · id 1', 'fixed base · top = toward finish', ring=ORANGE)

# boats
section(H - 137, 'Boats', 'One per meeple, stuck flat on top. Top edge = the bow. Print the page twice if you want spares.')
boats = [(10, 'BLUE', '#4BA3DB'), (11, 'NAVY', '#22335C'), (12, 'GREEN', '#2F7A34'), (13, 'DARK BLUE', '#2D5B7B'), (14, 'PURPLE', '#8E2D8F')]
gap = (W - 2 * L) / 5
for k, (mid, name, col) in enumerate(boats):
    marker(c, mid, L + gap * (k + 0.5), H - 163, 20, f'{name} · id {mid}', 'top = bow', ring=HexColor(col))

# marks
section(H - 192, 'Course marks', 'On the TOP of each cylinder. A + B = finish line (A on the left looking upwind). C + C = start line.')
for k, (mid, lab) in enumerate([(20, 'FINISH A · id 20'), (21, 'FINISH B · id 21'), (22, 'START C · id 22'), (23, 'START C · id 23')]):
    marker(c, mid, L + (W - 2 * L) / 4 * (k + 0.5), H - 222, 25, lab, 'top = upwind', ring=ORANGE)

c.setFont('Helvetica', 6.8); c.setFillColor(MUTED)
c.drawString(L * mm, 12 * mm, 'ArUco 4x4 markers, ids 0-23 (same bits as OpenCV DICT_4X4_50). Plain black-and-white squares track far better than QR codes at this size.')
c.showPage(); c.save()
print('wrote', OUT)
