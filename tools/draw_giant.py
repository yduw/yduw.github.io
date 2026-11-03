"""Generate giant.svg: a heavy black-and-white ink drawing of a boy standing on a giant's shoulder.

Every line is a filled, tapered "brush" polygon with a slightly wobbly centreline, so the result
reads as hand-inked rather than vector-perfect. Shading is hand-style hatching computed against
region polygons. Run: python3 tools/draw_giant.py > giant.svg
"""
import math
import random

R = random.Random(20261103)
INK = "#111"
W, H = 800, 1000
out = []


# ---------- geometry helpers ----------
def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def catmull(pts, closed=False, step=3.0):
    if len(pts) < 2:
        return list(pts)
    P = ([pts[-1]] + pts + [pts[0], pts[1]]) if closed else ([pts[0]] + pts + [pts[-1]])
    res = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        m = max(2, int(dist(p1, p2) / step))
        for k in range(m):
            t = k / m
            t2, t3 = t * t, t * t * t
            x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3)
            y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
            res.append((x, y))
    if not closed:
        res.append(pts[-1])
    return res


def fmt(pts):
    return " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)


def circle_pts(cx, cy, r, n=None, ry=None, start=0.0, wob=0.0):
    ry = r if ry is None else ry
    n = n or max(8, int(r / 4))
    pts = []
    for i in range(n):
        a = start + 2 * math.pi * i / n
        k = 1 + wob * (R.random() - 0.5)
        pts.append((cx + r * k * math.cos(a), cy + ry * k * math.sin(a)))
    return pts


def arc_pts(cx, cy, r, a0, a1, n=8, ry=None):
    ry = r if ry is None else ry
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / (n - 1))),
             cy + ry * math.sin(math.radians(a0 + (a1 - a0) * i / (n - 1)))) for i in range(n)]


# ---------- ink primitives ----------
def brush(pts, w=4.0, closed=False, taper=(0.18, 0.18), jitter=0.7, wob=0.18, color=INK, smooth=True, minw=0.12):
    """A tapered, slightly wobbly ink stroke rendered as a filled polygon."""
    c = catmull(pts, closed) if smooth else list(pts)
    if closed:
        c = c + [c[0]]
    n = len(c)
    if n < 2:
        return
    s = [0.0]
    for i in range(1, n):
        s.append(s[-1] + dist(c[i - 1], c[i]))
    L = s[-1] or 1.0
    ph = [R.random() * 6.283 for _ in range(4)]
    fr = [R.uniform(1.5, 3.0), R.uniform(4, 7), R.uniform(0.8, 1.6), R.uniform(3, 6)]
    left, right = [], []
    for i in range(n):
        a = c[max(0, i - 1)]
        b = c[min(n - 1, i + 1)]
        tx, ty = b[0] - a[0], b[1] - a[1]
        tl = math.hypot(tx, ty) or 1.0
        nx, ny = -ty / tl, tx / tl
        t = s[i] / L
        off = jitter * (math.sin(fr[0] * 6.283 * t + ph[0]) + 0.5 * math.sin(fr[1] * 6.283 * t + ph[1]))
        ww = w * (1 + wob * math.sin(fr[2] * 6.283 * t + ph[2]) + 0.5 * wob * math.sin(fr[3] * 6.283 * t + ph[3]))
        if not closed:
            ta, tb = taper
            f = 1.0
            if ta > 0 and t < ta:
                f = min(f, minw + (1 - minw) * (t / ta) ** 0.7)
            if tb > 0 and t > 1 - tb:
                f = min(f, minw + (1 - minw) * ((1 - t) / tb) ** 0.7)
            ww *= f
        px, py = c[i][0] + nx * off, c[i][1] + ny * off
        left.append((px + nx * ww / 2, py + ny * ww / 2))
        right.append((px - nx * ww / 2, py - ny * ww / 2))
    if closed:
        out.append(f'<path fill="{color}" fill-rule="evenodd" d="M{fmt(left)}Z M{fmt(right[::-1])}Z"/>')
    else:
        out.append(f'<path fill="{color}" d="M{fmt(left + right[::-1])}Z"/>')


def fill(pts, color="#fff", closed=True, smooth=True):
    c = catmull(pts, closed) if smooth else pts
    out.append(f'<path fill="{color}" d="M{fmt(c)}Z"/>')


def shape(pts, w=4.0, color="#fff", **kw):
    """White-filled closed shape with an ink outline."""
    fill(pts, color)
    brush(pts, w=w, closed=True, **kw)


def line_poly_intersections(p, d, poly):
    hits = []
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        ex, ey = b[0] - a[0], b[1] - a[1]
        den = d[0] * ey - d[1] * ex
        if abs(den) < 1e-9:
            continue
        wx, wy = a[0] - p[0], a[1] - p[1]
        t = (wx * ey - wy * ex) / den
        u = (wx * d[1] - wy * d[0]) / den
        if 0 <= u < 1:
            hits.append(t)
    return sorted(hits)


def hatch(region, angle, spacing, w=1.4, shrink=0.12, skip=0.0, bend=1.5, smooth_region=True, wobble=0.6):
    """Ink hatching inside a region, each line tapered and trimmed a little at random."""
    poly = catmull(region, True, step=4) if smooth_region else region
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    diag = math.hypot(max(xs) - min(xs), max(ys) - min(ys))
    a = math.radians(angle)
    d = (math.cos(a), math.sin(a))
    nrm = (-d[1], d[0])
    o = -diag / 2
    while o < diag / 2:
        oo = o + R.uniform(-0.25, 0.25) * spacing
        p = (cx + nrm[0] * oo, cy + nrm[1] * oo)
        hits = line_poly_intersections(p, d, poly)
        for i in range(0, len(hits) - 1, 2):
            if R.random() < skip:
                continue
            t0, t1 = hits[i], hits[i + 1]
            ln = t1 - t0
            if ln < 3:
                continue
            t0 += ln * R.uniform(0, shrink)
            t1 -= ln * R.uniform(0, shrink)
            a0 = (p[0] + d[0] * t0, p[1] + d[1] * t0)
            a1 = (p[0] + d[0] * t1, p[1] + d[1] * t1)
            mid = ((a0[0] + a1[0]) / 2 + nrm[0] * R.uniform(-bend, bend), (a0[1] + a1[1]) / 2 + nrm[1] * R.uniform(-bend, bend))
            brush([a0, mid, a1], w=w * R.uniform(0.8, 1.15), taper=(0.25, 0.3), jitter=wobble * 0.5, wob=0.1)
        o += spacing


def tuft(x, y, h=12, n=4, lean=-0.3, w=1.6, spread=0.6):
    for i in range(n):
        ang = -math.pi / 2 + lean + spread * (i / max(1, n - 1) - 0.5) + R.uniform(-0.15, 0.15)
        hh = h * R.uniform(0.6, 1.1)
        bx = x + R.uniform(-3, 3)
        tip = (bx + math.cos(ang) * hh, y + math.sin(ang) * hh)
        mid = (bx + math.cos(ang) * hh * 0.5 + lean * 2, y + math.sin(ang) * hh * 0.5)
        brush([(bx, y), mid, tip], w=w, taper=(0.0, 0.9), jitter=0.2)


def blade(x, y, h, lean, w=2.6):
    tip = (x + lean * h, y - h)
    mid = (x + lean * h * 0.25, y - h * 0.55)
    brush([(x, y), mid, tip], w=w, taper=(0.0, 0.95), jitter=0.3, minw=0.05)


def daisy(x, y, r=5.0, w=1.3, petals=6):
    for i in range(petals):
        a = 2 * math.pi * i / petals + R.uniform(-0.15, 0.15)
        px, py = x + math.cos(a) * r, y + math.sin(a) * r * 0.75
        pts = circle_pts(px, py, r * 0.55, n=7, ry=r * 0.38)
        rot = [(x + (qx - x), y + (qy - y)) for qx, qy in pts]
        shape(rot, w=w)
    c = circle_pts(x, y, r * 0.38, n=7)
    fill(c, INK)


def bird(x, y, s=1.0):
    brush([(x - 14 * s, y - 2 * s), (x - 7 * s, y - 7 * s), (x, y)], w=2.6 * s, taper=(0.9, 0.1), jitter=0.2)
    brush([(x, y), (x + 8 * s, y - 8 * s), (x + 16 * s, y - 4 * s)], w=2.6 * s, taper=(0.1, 0.9), jitter=0.2)


def lump(cx, cy, r, w=4.2):
    shape(circle_pts(cx, cy, r, n=max(10, int(r / 6)), wob=0.04), w=w, jitter=0.6)


# =================== SCENE ===================
# --- sun and rays (behind everything) ---
SUN = (668, 652)
for i in range(30):
    a = math.radians(188 + i * (164 / 29) + R.uniform(-1.2, 1.2))
    r0 = 58 + R.uniform(0, 10)
    r1 = r0 + R.uniform(140, 420) * (0.55 if i % 2 else 1.0)
    brush([(SUN[0] + r0 * math.cos(a), SUN[1] + r0 * math.sin(a)),
           (SUN[0] + r1 * math.cos(a), SUN[1] + r1 * math.sin(a))], w=1.3, taper=(0.05, 0.9), jitter=0.2, wob=0.05)
shape(circle_pts(SUN[0], SUN[1], 40, n=16), w=3.2)
brush(arc_pts(SUN[0], SUN[1], 48, 195, 345, 10), w=1.4, taper=(0.4, 0.4))

# --- birds ---
bird(612, 452, 1.0)
bird(646, 426, 0.8)
bird(588, 478, 0.6)
bird(700, 402, 0.55)

# --- clouds: union of lumps, with inner edges only where a front lump overlaps one behind it ---
def inside(p, c):
    return (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 < (c[2] - 0.5) ** 2


def cloud(lumps, base_y, w=4.4, inner_w=2.4, cid="cl"):
    out.append(f'<clipPath id="{cid}"><rect x="0" y="0" width="800" height="{base_y + 1}"/></clipPath><g clip-path="url(#{cid})">')
    for cx, cy, r in lumps:
        brush(circle_pts(cx, cy, r, n=max(12, int(r / 5)), wob=0.03), w=w, closed=True, jitter=0.5)
    for cx, cy, r in lumps:
        fill(circle_pts(cx, cy, r - w * 0.42, n=max(12, int(r / 5))))
    # inner edges
    for i, (cx, cy, r) in enumerate(lumps):
        seg = []
        for k in range(73):
            a = math.radians(k * 5)
            p = (cx + r * math.cos(a), cy + r * math.sin(a))
            vis = p[1] < base_y - 4 and any(inside(p, c) for c in lumps[:i]) and not any(inside(p, c) for c in lumps[i + 1:])
            if vis:
                seg.append(p)
            elif len(seg) > 2:
                brush(seg, w=inner_w, taper=(0.35, 0.35)); seg = []
            else:
                seg = []
        if len(seg) > 2:
            brush(seg, w=inner_w, taper=(0.35, 0.35))
    out.append('</g>')
    xs0 = min(cx - r for cx, cy, r in lumps if cy + r > base_y)
    xs1 = max(cx + r for cx, cy, r in lumps if cy + r > base_y)
    brush([(xs0 - 4, base_y + 1), ((xs0 + xs1) / 2, base_y + 3), (xs1 + 4, base_y)], w=w * 0.9, taper=(0.12, 0.12))


big = [(420, 110, 64), (318, 112, 50), (510, 165, 52), (222, 190, 44), (468, 145, 54),
       (360, 190, 96), (480, 228, 80), (252, 238, 76),
       (165, 296, 52), (560, 288, 60), (305, 292, 62), (430, 292, 68)]
cloud(big, 326, cid="cl1")
# shadowed underside and lumps' lower curves
hatch([(126, 306), (220, 300), (420, 298), (612, 302), (616, 322), (420, 324), (220, 324), (124, 322)], 0, 4.6, w=1.15, shrink=0.3, smooth_region=False)
hatch([(196, 252), (236, 290), (214, 300), (176, 296), (180, 270)], -38, 5.5, w=1.0, shrink=0.2)
hatch([(500, 258), (536, 286), (520, 300), (486, 298), (484, 276)], -38, 5.5, w=1.0, shrink=0.2)
hatch([(316, 236), (350, 270), (330, 284), (300, 270)], -38, 6, w=0.9, shrink=0.3)

# --- small clouds ---
cloud([(96, 120, 22), (128, 106, 28), (158, 122, 20), (118, 126, 18)], 134, w=3.0, inner_w=1.6, cid="cl2")
hatch([(80, 128), (172, 128), (170, 133), (82, 133)], 0, 2.6, w=0.8, smooth_region=False)
cloud([(690, 170, 22), (722, 152, 30), (754, 170, 20), (712, 174, 18)], 182, w=3.0, inner_w=1.6, cid="cl3")
hatch([(674, 176), (768, 176), (766, 181), (676, 181)], 0, 2.6, w=0.8, smooth_region=False)


# --- distant mountains ---
ridge = [(0, 628), (55, 598), (100, 612), (168, 568), (222, 606), (290, 588), (350, 615), (430, 592), (500, 622), (575, 578), (640, 606), (710, 588), (800, 612)]
fill(ridge + [(800, 1000), (0, 1000)], smooth=False)
brush(ridge, w=2.2, taper=(0.05, 0.05), smooth=False)
for (a, b) in [((168, 568), (222, 606)), ((575, 578), (640, 606)), ((55, 598), (100, 612)), ((710, 588), (800, 612))]:
    reg = [a, b, (b[0] - 6, b[1] + 22), (a[0] + 6, a[1] + 20)]
    hatch(reg, 70, 5, w=1.0, smooth_region=False, shrink=0.3)

# --- far hill ---
hill1 = [(0, 690), (150, 655), (300, 668), (420, 684), (560, 698), (680, 660), (800, 668)]
fill(hill1 + [(800, 1000), (0, 1000)])
brush(hill1, w=3.0, taper=(0.02, 0.02))
# little trees on the far hill (solid ink silhouettes)
for x, y, s in [(612, 680, 1.0), (630, 676, 0.75), (700, 666, 0.9), (118, 670, 0.85), (82, 678, 0.6), (740, 664, 0.6)]:
    brush([(x, y + 2), (x, y - 6 * s)], w=1.6, taper=(0, 0))
    fill(circle_pts(x, y - 13 * s, 7 * s, n=9, ry=10 * s, wob=0.15), INK)
# sun-side grass texture on far hill
for _ in range(26):
    x = R.uniform(10, 790)
    y = 700 + R.uniform(0, 50)
    if 150 < x < 680:
        continue
    brush([(x, y), (x + R.uniform(6, 14), y - R.uniform(0, 2))], w=1.0, taper=(0.4, 0.4))

# --- near hill ---
hill2 = [(0, 790), (120, 755), (260, 762), (380, 790), (520, 822), (660, 775), (800, 765)]
fill(hill2 + [(800, 1000), (0, 1000)])
brush(hill2, w=3.6, taper=(0.02, 0.02))
for x in range(8, 800, 22):
    y = 790 if x < 120 else None
    # find y on hill2 by interpolation
    pts = catmull(hill2)
    yy = min(pts, key=lambda p: abs(p[0] - x))[1]
    if 150 < x < 670:
        continue
    tuft(x + R.uniform(-5, 5), yy + 2, h=R.uniform(7, 13), n=3, lean=-0.35)
for _ in range(60):
    x = R.choice([R.uniform(6, 150), R.uniform(668, 794)])
    pts = catmull(hill2)
    yy = min(pts, key=lambda p: abs(p[0] - x))[1]
    y = yy + R.uniform(12, 130)
    ln = R.uniform(6, 16)
    brush([(x, y), (x + ln / 2, y - 1.2), (x + ln, y - 0.4)], w=1.2, taper=(0.4, 0.5))

# =================== THE GIANT ===================
giant = [
    (162, 1000), (158, 900), (160, 800), (170, 722), (188, 668), (212, 632), (252, 608), (305, 592),
    (342, 574), (364, 552), (370, 520),
    (452, 520), (456, 552), (482, 576), (532, 592), (582, 604), (612, 618), (634, 646), (648, 700),
    (654, 780), (656, 880), (660, 1000),
]
fill(giant + [(660, 1010), (162, 1010)], smooth=True)

# shading (light comes from the low sun on the right)
shadow_l = [(160, 1000), (158, 860), (162, 760), (175, 700), (195, 655), (225, 622), (262, 604), (276, 640),
            (268, 700), (262, 800), (266, 900), (270, 1000)]
hatch(shadow_l, 62, 6.2, w=1.5, shrink=0.05)
deep_l = [(160, 1000), (158, 860), (162, 760), (175, 700), (195, 655), (210, 642), (214, 720), (208, 850), (212, 1000)]
hatch(deep_l, -28, 6.5, w=1.4, shrink=0.05)
# cast shadow of the head on the upper back
cast = [(360, 556), (380, 548), (446, 548), (468, 566), (456, 590), (424, 602), (392, 600), (366, 584)]
hatch(cast, 40, 4.6, w=1.4, shrink=0.12)
hatch([(376, 552), (446, 552), (440, 572), (390, 574)], -45, 5.5, w=1.1, shrink=0.15)
# shading between shoulder blades and along the arm creases
hatch([(240, 700), (262, 690), (258, 820), (250, 1000), (232, 1000), (236, 820)], 75, 5, w=1.2)
hatch([(586, 692), (604, 700), (612, 820), (610, 1000), (590, 1000), (594, 820)], 75, 6, w=1.0, skip=0.2)
hatch([(300, 720), (370, 716), (382, 760), (330, 780), (290, 760)], 50, 7, w=1.0, skip=0.15, shrink=0.25)

# vines trailing down from the left shoulder, and soft turning-shade on the back
def point_in(p, poly):
    x, y = p; c = False
    for i in range(len(poly)):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % len(poly)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


gpoly = catmull(giant)
for _ in range(5200):
    q = (R.uniform(200, 600), R.uniform(590, 1000))
    prob = max(0.0, min(1.0, (560 - q[0]) / 300)) ** 1.6
    if R.random() > prob or not point_in(q, gpoly):
        continue
    fill(circle_pts(q[0], q[1], R.uniform(0.7, 1.3), n=5), INK, smooth=False)
hatch([(272, 640), (300, 620), (318, 660), (312, 760), (318, 880), (300, 1000), (272, 1000), (268, 820)], 62, 7.5, w=1.0, skip=0.3, shrink=0.25)

# outline
brush(giant[:11], w=6.5, taper=(0.0, 0.25))
brush(giant[11:], w=5.6, taper=(0.25, 0.0))
# arm separation creases
brush([(244, 676), (238, 740), (234, 830), (238, 1000)], w=4.2, taper=(0.6, 0.0))
brush([(582, 676), (590, 760), (594, 860), (590, 1000)], w=3.6, taper=(0.6, 0.0))
# spine and shoulder blades
brush([(408, 610), (402, 700), (400, 800), (404, 900)], w=2.4, taper=(0.4, 0.4))
brush([(282, 700), (310, 730), (346, 734), (372, 704)], w=2.6, taper=(0.35, 0.35))
brush([(438, 704), (466, 736), (504, 736), (530, 704)], w=2.4, taper=(0.35, 0.35))
# stone cracks and texture
for crack in [
    [(300, 790), (318, 812), (312, 842), (326, 866)],
    [(318, 812), (338, 820)],
    [(500, 840), (522, 866), (518, 896)],
    [(522, 866), (542, 872)],
    [(456, 640), (470, 662)],
    [(560, 950), (552, 920), (566, 900)],
]:
    brush(crack, w=1.8, taper=(0.3, 0.5))
for cx, cy, r in [(350, 880, 9), (366, 892, 6), (470, 790, 7), (230, 900, 8)]:
    brush(circle_pts(cx, cy, r, n=8, ry=r * 0.7, wob=0.2), w=1.6, closed=True)
# moss patches on the back
for cx, cy in [(310, 640), (520, 650), (380, 940), (500, 980)]:
    for _ in range(9):
        x = cx + R.uniform(-22, 22)
        y = cy + R.uniform(-8, 8)
        brush(arc_pts(x, y, R.uniform(3, 5), 180, 360, 5), w=1.4, taper=(0.3, 0.3))

# neck lines
brush([(372, 512), (368, 552)], w=4.0, taper=(0.1, 0.5))
brush([(452, 516), (456, 552)], w=3.6, taper=(0.1, 0.5))

# head: three-quarter from behind, turned toward the sun so the profile shows on the right
head = [(402, 355), (440, 358), (466, 374), (482, 398), (492, 420), (496, 432), (490, 440), (500, 452), (512, 462),
        (512, 470), (500, 474), (502, 484), (496, 490), (500, 498), (492, 508), (476, 518), (452, 526), (420, 528),
        (384, 520), (354, 498), (338, 466), (335, 428), (346, 392), (370, 366)]
fill(head)
# shadowed back of the skull
hatch([(370, 380), (348, 400), (338, 436), (342, 470), (358, 500), (386, 520), (402, 524), (388, 492), (378, 450), (380, 410)],
      52, 4.8, w=1.35, shrink=0.06)
hatch([(346, 448), (342, 474), (358, 500), (384, 518), (370, 488), (356, 462)], -36, 5.2, w=1.15, shrink=0.08)
# under the jaw
hatch([(424, 512), (476, 506), (488, 508), (476, 518), (452, 526), (420, 528), (404, 522)], 25, 4.2, w=1.1)
brush(head, w=6.2, closed=True, jitter=0.6)
# face details on the lit profile
brush([(466, 414), (477, 411), (488, 415)], w=2.2, taper=(0.3, 0.6))          # brow
brush([(470, 434), (478, 431), (487, 434)], w=2.4, taper=(0.2, 0.2))           # upper lid
brush([(472, 436), (480, 440), (487, 436)], w=1.4, taper=(0.3, 0.3))           # lower lid
fill(circle_pts(483, 435, 2.6, n=7), INK)                                       # eye, gazing at the horizon
brush([(488, 434), (494, 431)], w=1.6, taper=(0.1, 0.7))                        # lash
brush([(492, 470), (500, 474)], w=1.8, taper=(0.3, 0.3))                        # nostril
brush([(470, 472), (478, 480), (481, 490)], w=1.4, taper=(0.5, 0.5))            # cheek fold
brush([(486, 490), (492, 492), (497, 489)], w=1.6, taper=(0.3, 0.5))                        # mouth
hatch([(444, 458), (462, 454), (466, 474), (452, 484)], 70, 6, w=0.8, skip=0.3, shrink=0.35)  # cheek
# ear
ear = [(344, 428), (330, 434), (323, 454), (329, 476), (344, 488)]
fill(ear + [(352, 458)])
hatch([(344, 432), (332, 438), (327, 456), (332, 474), (344, 484)], 60, 3.5, w=0.9, smooth_region=False)
brush(ear, w=4.2, taper=(0.15, 0.15))
brush([(338, 444), (332, 458), (338, 472)], w=2.0, taper=(0.3, 0.3))

# mossy, grassy hair over the crown, with a fringe of blades along its lower edge
top = [(338, 438), (342, 404), (360, 376), (390, 358), (424, 356), (452, 364), (472, 382)]
lower = []
for i in range(17):
    t = i / 16
    x = 472 + (338 - 472) * t
    y = 392 + (438 - 392) * t + 10 * math.sin(t * math.pi) + (6 if i % 2 else -2)
    lower.append((x, y))
cap = top + lower
fill(cap, smooth=False)
hatch(cap, 80, 4.2, w=1.15, shrink=0.15, smooth_region=False)
hatch([(338, 438), (342, 404), (360, 376), (378, 366), (370, 404), (356, 432)], -20, 4.4, w=1.0)
brush(top, w=4.8, taper=(0.1, 0.1))
for i in range(0, len(lower), 1):
    x, y = lower[i]
    brush([(x + 4, y - 8), (x + 1, y - 2), (x - 2, y + 4)], w=2.2, taper=(0.1, 0.9))
for i in range(34):
    t = i / 33
    a = math.radians(192 + t * 140)
    x = 410 + 74 * math.cos(a)
    y = 440 + 84 * math.sin(a)
    if y > 420:
        continue
    lean = (x - 410) / 110
    blade(x, y + 6, R.uniform(10, 19), lean, w=2.6)
# the sapling growing from his crown
brush([(418, 360), (416, 340), (420, 322), (428, 304)], w=3.0, taper=(0.0, 0.5))
for lf, vein in [([(419, 334), (402, 324), (390, 328), (403, 338)], [(417, 334), (396, 328)]),
                 ([(426, 312), (442, 298), (456, 300), (442, 314)], [(428, 310), (451, 301)]),
                 ([(428, 305), (426, 290), (432, 282), (434, 296)], [(429, 302), (431, 287)])]:
    shape(lf, w=2.4)
    brush(vein, w=1.1, taper=(0.1, 0.6))

# moss, grass and flowers along both shoulders
for x, y in [(206, 640), (222, 624), (240, 614), (262, 606), (284, 600), (306, 594), (328, 584), (346, 572),
             (468, 568), (488, 580), (512, 588), (536, 594), (612, 618), (628, 636), (640, 656)]:
    tuft(x, y + 4, h=R.uniform(10, 16), n=4, lean=-0.35 + (x - 400) / 900)
for x, y, r in [(232, 618, 5.5), (300, 598, 4.5), (520, 592, 5), (626, 640, 4.5), (338, 582, 3.6)]:
    daisy(x, y - 4, r)

# a small tree growing on his left shoulder
brush([(258, 608), (256, 586), (261, 562), (257, 540)], w=4.6, taper=(0.0, 0.3))
brush([(259, 578), (276, 562)], w=2.2, taper=(0.0, 0.6))
brush([(257, 566), (242, 552)], w=2.0, taper=(0.0, 0.6))
puffs = [(240, 532, 16), (252, 512, 18), (274, 508, 17), (292, 524, 15), (280, 544, 14), (256, 546, 16), (234, 548, 12)]
out.append('<g>')
for cx, cy, r in puffs:
    brush(circle_pts(cx, cy, r, n=12, wob=0.06), w=3.2, closed=True)
for cx, cy, r in puffs:
    fill(circle_pts(cx, cy, r - 1.4, n=12))
fill(circle_pts(263, 528, 20, n=12))
out.append('</g>')
hatch([(226, 548), (244, 560), (276, 558), (300, 532), (288, 540), (262, 548), (240, 548)], 40, 3.8, w=1.1, shrink=0.05)
hatch([(222, 530), (238, 516), (240, 540)], 40, 4.2, w=1.0)
for cx, cy, r in [(252, 512, 18), (274, 508, 17), (240, 532, 16)]:
    brush(arc_pts(cx, cy, r * 0.7, 200, 260, 5), w=1.4, taper=(0.3, 0.3))
# shadow of the tree on the shoulder
hatch([(232, 612), (284, 600), (292, 608), (240, 622)], 0, 3.6, w=1.0, smooth_region=False)

# =================== THE BOY ===================
out.append('<g transform="translate(14 7)">')
# shadow under his feet
for k in range(4):
    y = 606 + k * 2.4
    brush([(560 + k * 3, y), (606 - k * 3, y)], w=1.1, taper=(0.3, 0.3))
# trousers
shape([(568, 556), (582, 556), (580, 600), (568, 601)], w=2.4, smooth=False)
shape([(582, 556), (596, 556), (601, 598), (590, 600)], w=2.4, smooth=False)
hatch([(568, 558), (574, 558), (572, 600), (568, 600)], 60, 2.6, w=0.8, smooth_region=False, shrink=0.0)
# boots
fill(circle_pts(573, 603, 8, n=10, ry=4), INK)
fill(circle_pts(597, 601, 8, n=10, ry=4), INK)
# satchel strap and bag
brush([(592, 516), (580, 534), (566, 546)], w=2.0, taper=(0.1, 0.1))
# trailing arm
shape([(570, 518), (562, 542), (568, 546), (577, 524)], w=2.4, smooth=False)
fill(circle_pts(564, 547, 3.4, n=8), "#fff")
brush(circle_pts(564, 547, 3.4, n=8), w=1.6, closed=True)
# shirt / tunic
tunic = [(569, 514), (595, 514), (598, 540), (600, 560), (566, 560), (567, 538)]
shape(tunic, w=2.8, smooth=False)
brush([(567, 548), (599, 548)], w=2.0, taper=(0.1, 0.1))  # belt
hatch([(569, 516), (577, 516), (574, 546), (568, 546)], 55, 3, w=0.8, smooth_region=False, shrink=0.0)
shape([(558, 540), (570, 538), (572, 554), (560, 556)], w=2.2, smooth=False)  # bag
# pointing arm
shape([(590, 516), (628, 491), (633, 498), (595, 526)], w=2.4, smooth=False)
fill(circle_pts(634, 493, 4, n=8), "#fff")
brush(circle_pts(634, 493, 4, n=8), w=1.6, closed=True)
brush([(636, 491), (645, 486)], w=2.0, taper=(0.0, 0.6))
# scarf: knot plus a long tail streaming in the wind (solid ink)
fill([(568, 509), (594, 509), (594, 518), (568, 518)], INK, smooth=False)
brush([(572, 513), (560, 504), (548, 506), (538, 496), (528, 494)], w=8.5, taper=(0.0, 0.75), jitter=0.4)
brush([(573, 517), (562, 516), (552, 520), (544, 514)], w=5.5, taper=(0.0, 0.8), jitter=0.3)
# head (profile, facing the horizon)
headb = [(572, 486), (580, 482), (590, 484), (597, 491), (599, 498), (603, 502), (599, 505), (598, 509), (592, 514), (582, 515), (573, 510), (568, 500)]
shape(headb, w=2.4)
fill(circle_pts(591, 497, 1.6, n=6), INK)  # eye
brush([(588, 493), (593, 492)], w=1.0, taper=(0.2, 0.2))  # brow
brush([(593, 508), (596, 508)], w=1.0, taper=(0.2, 0.2))  # mouth
# hair: a dark cap with strands swept back by the wind
hair = [(568, 500), (567, 489), (573, 481), (583, 478), (592, 480), (598, 487), (591, 488), (584, 487), (580, 492), (576, 494), (574, 501)]
fill(hair, INK)
for base, tip in [((570, 485), (556, 482)), ((569, 491), (555, 492)), ((572, 497), (560, 501)), ((578, 480), (566, 474))]:
    brush([base, ((base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2 - 1.5), tip], w=3.6, taper=(0.0, 0.9))
brush(circle_pts(575, 500, 2.6, n=6), w=1.2, closed=True)  # ear
# wind lines
for pts in [[(720, 470), (690, 462), (662, 468)], [(742, 520), (706, 512), (676, 518)]]:
    brush(pts, w=1.6, taper=(0.4, 0.5))

out.append('</g>')

# =================== FOREGROUND ===================
ground = [(0, 935), (160, 912), (300, 922), (420, 946), (560, 958), (700, 924), (800, 918)]
fill(ground + [(800, 1000), (0, 1000)])
brush(ground, w=4.2, taper=(0.02, 0.02))
hatch([(0, 960), (160, 942), (300, 950), (420, 972), (560, 984), (700, 952), (800, 948), (800, 1000), (0, 1000)], 8, 8, w=1.0, skip=0.45, shrink=0.4)
for i in range(70):
    x = R.uniform(0, 800)
    if 190 < x < 620 and R.random() < 0.7:
        continue
    pts = catmull(ground)
    yy = min(pts, key=lambda p: abs(p[0] - x))[1]
    h = R.uniform(20, 70) * (1.4 if (x < 140 or x > 680) else 0.8)
    blade(x, min(1000, yy + R.uniform(10, 60)), h, R.uniform(-0.55, -0.1), w=R.uniform(2.4, 3.6))
for x, y in [(70, 958), (112, 980), (690, 950), (738, 975), (300, 976), (520, 986), (430, 968)]:
    daisy(x, y, R.uniform(5, 7))

# =================== FRAME ===================
frame_d = "M0,0H800V1000H0Z M14,14V986H786V14Z"


def build():
    body = "\n".join(out)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" role="img" aria-labelledby="t d">
<title id="t">Standing on the shoulders of giants</title>
<desc id="d">Black and white ink drawing: a small boy with a windswept scarf stands on the shoulder of a gentle, moss-covered stone giant. Both look toward a low sun over rolling hills, beneath a towering summer cloud.</desc>
<defs><clipPath id="c"><rect x="14" y="14" width="772" height="972"/></clipPath></defs>
<rect width="{W}" height="{H}" fill="#fff"/>
<g clip-path="url(#c)">
{body}
</g>
<path fill="#fff" fill-rule="evenodd" d="{frame_d}"/>
'''


svg = build()
out.clear()
brush([(14, 14), (400, 13), (786, 14)], w=5, taper=(0, 0), smooth=False)
brush([(786, 14), (787, 500), (786, 986)], w=5, taper=(0, 0), smooth=False)
brush([(786, 986), (400, 987), (14, 986)], w=5, taper=(0, 0), smooth=False)
brush([(14, 986), (13, 500), (14, 14)], w=5, taper=(0, 0), smooth=False)
svg += "\n".join(out) + "\n</svg>\n"
print(svg)
