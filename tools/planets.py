"""Renders the Cosmic card planets (docs/planets/*.webp): the Sun, the Moon, Earth, Mars, Neptune, Venus and Jupiter.

Everything is drawn from scratch here (3D noise on a sphere, then lighting, an atmosphere and a glow), so the images are
original art with no outside rights. Each body gets a few variants (a different face turned to us and a different light),
and a card picks one by its player. Run: python3 tools/planets.py
"""
import os
import numpy as np
from PIL import Image

S = 512                    # image size (px); the globe fills the middle, leaving room for its glow
R = 0.78                   # globe radius, as a share of half the image
VARIANTS = 4
OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "planets")


# ---------- 3D gradient noise (improved Perlin), vectorised ----------
def _perm(seed):
    p = np.random.default_rng(seed).permutation(256)
    return np.concatenate([p, p])


_G = np.array([[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
               [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1], [1, 1, 0], [0, -1, 1], [-1, 1, 0], [0, -1, -1]], float)


def perlin(x, y, z, perm):
    xi, yi, zi = np.floor(x).astype(int) & 255, np.floor(y).astype(int) & 255, np.floor(z).astype(int) & 255
    xf, yf, zf = x - np.floor(x), y - np.floor(y), z - np.floor(z)
    fade = lambda t: t * t * t * (t * (t * 6 - 15) + 10)
    u, v, w = fade(xf), fade(yf), fade(zf)

    def g(h, dx, dy, dz):
        gv = _G[h & 15]
        return gv[..., 0] * dx + gv[..., 1] * dy + gv[..., 2] * dz

    a, b = perm[xi] + yi, perm[xi + 1] + yi
    aa, ab, ba, bb = perm[a] + zi, perm[a + 1] + zi, perm[b] + zi, perm[b + 1] + zi
    lerp = lambda t, p, q: p + t * (q - p)
    x1 = lerp(u, g(perm[aa], xf, yf, zf), g(perm[ba], xf - 1, yf, zf))
    x2 = lerp(u, g(perm[ab], xf, yf - 1, zf), g(perm[bb], xf - 1, yf - 1, zf))
    x3 = lerp(u, g(perm[aa + 1], xf, yf, zf - 1), g(perm[ba + 1], xf - 1, yf, zf - 1))
    x4 = lerp(u, g(perm[ab + 1], xf, yf - 1, zf - 1), g(perm[bb + 1], xf - 1, yf - 1, zf - 1))
    return lerp(w, lerp(v, x1, x2), lerp(v, x3, x4))


def fbm(p, perm, octaves=6, freq=1.0, gain=0.5):
    x, y, z = p
    total, amp, norm = 0.0, 1.0, 0.0
    for o in range(octaves):
        total = total + amp * perlin(x * freq + o * 17.1, y * freq + o * 31.7, z * freq + o * 7.3, perm)
        norm += amp
        amp *= gain
        freq *= 2.0
    return total / norm            # about -0.5..0.5


def ridged(p, perm, octaves=5, freq=1.0):
    x, y, z = p
    total, amp, norm = 0.0, 1.0, 0.0
    for o in range(octaves):
        n = 1 - np.abs(perlin(x * freq + o * 11.3, y * freq + o * 5.9, z * freq + o * 23.1, perm) * 2)
        total = total + amp * n * n
        norm += amp
        amp *= 0.5
        freq *= 2.0
    return total / norm


def ramp(t, stops):
    """Colour lookup: stops = [(t, (r, g, b)), ...] with t rising from 0 to 1."""
    t = np.clip(t, 0, 1)
    ts = np.array([s[0] for s in stops])
    cs = np.array([s[1] for s in stops], float) / 255
    out = np.zeros(t.shape + (3,))
    for c in range(3):
        out[..., c] = np.interp(t, ts, cs[:, c])
    return out


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ---------- the sphere ----------
def sphere(rot, tilt):
    c = (np.arange(S) + 0.5) / S * 2 - 1
    X, Y = np.meshgrid(c, -c)
    X, Y = X / R, Y / R
    r2 = X * X + Y * Y
    inside = r2 <= 1
    Z = np.sqrt(np.clip(1 - r2, 0, 1))
    n = np.stack([X, Y, Z])                          # the view-space normal
    # turn the globe (longitude), then tilt its axis
    cr, sr, ct, st = np.cos(rot), np.sin(rot), np.cos(tilt), np.sin(tilt)
    x1, z1 = n[0] * cr + n[2] * sr, -n[0] * sr + n[2] * cr
    y1 = n[1]
    x2, y2 = x1 * ct - y1 * st, x1 * st + y1 * ct
    return n, np.stack([x2, y2, z1]), inside, r2


def light(n, ldir, wrap=0.0):
    l = np.array(ldir, float)
    l /= np.linalg.norm(l)
    d = n[0] * l[0] + n[1] * l[1] + n[2] * l[2]
    return np.clip((d + wrap) / (1 + wrap), 0, 1), d


def compose(col, alpha, glow_col, glow_amt, glow_w, r2, extra=None):
    """Globe colour over a soft outer glow, as RGBA."""
    rr = np.sqrt(r2)
    g = np.exp(-np.clip(rr - 1, 0, None) / glow_w) * (rr > 1) * glow_amt
    rgb = col * alpha[..., None] + np.array(glow_col, float)[None, None, :] / 255 * g[..., None] * (1 - alpha[..., None])
    a = np.clip(alpha + g * (1 - alpha), 0, 1)
    if extra is not None:
        rgb, a = extra(rgb, a)
    rgb = rgb / np.maximum(a[..., None], 1e-6)            # back to straight alpha
    return np.dstack([np.clip(rgb, 0, 1), a])


def edge_alpha(r2):
    rr = np.sqrt(r2)
    px = 2 / (S * R)                                  # one pixel, in globe units
    return np.clip((1 - rr) / px + 0.5, 0, 1)


def atmosphere(n, r2, lit, color, strength, width=0.18):
    """A thin lit rim: brighter toward the edge of the globe, on the lit side."""
    rim = np.clip(1 - n[2], 0, 1) ** (1 / width * 0.35)
    return np.array(color, float)[None, None, :] / 255 * (rim * strength * np.clip(lit + 0.25, 0, 1))[..., None]


# ---------- the bodies ----------
def jupiter(p, n, lit, d, perm, v):
    lat = p[1]
    warp = fbm((p[0] * 3, p[1] * 1.5, p[2] * 3), perm, 5, 1.6)
    t = lat * 0.5 + 0.5 + warp * 0.025 + fbm((p[0] * 10, p[1] * 50, p[2] * 10), perm, 3) * 0.006
    col = ramp((t * 4.2 + .1) % 1, [(0, (232, 216, 186)), (.2, (214, 180, 132)), (.32, (170, 118, 78)), (.42, (196, 150, 104)), (.52, (240, 230, 208)),
                               (.7, (226, 204, 166)), (.82, (182, 134, 94)), (.9, (214, 184, 140)), (1, (232, 216, 186))])
    polar = smooth(.62, .95, np.abs(lat))
    col = col * (1 - polar[..., None] * .45) + np.array([.55, .5, .47]) * polar[..., None] * .45
    # the Great Red Spot, in the southern belt
    lon = np.arctan2(p[0], p[2])
    spot_lon = 0.55 + v * 0.3
    dl = np.angle(np.exp(1j * (lon - spot_lon)))
    e = (dl / .28) ** 2 + ((lat + .38) / .09) ** 2
    swirl = fbm((p[0] * 14, p[1] * 14, p[2] * 14), perm, 3) * .25
    spot = smooth(1.15, .35, e + swirl)
    col = col * (1 - spot[..., None]) + ramp(np.clip(e, 0, 1), [(0, (178, 70, 44)), (.6, (200, 104, 70)), (1, (215, 150, 110))]) * spot[..., None]
    turb = fbm((p[0] * 20, p[1] * 60, p[2] * 20), perm, 3) * .08
    return col * (1 + turb[..., None])


def earth(p, n, lit, d, perm, v):
    h = fbm((p[0] * 1.1, p[1] * 1.1, p[2] * 1.1), perm, 8) - .02
    land = smooth(.02, .04, h)
    lat = np.abs(p[1])
    ocean = ramp(np.clip(h + .5, 0, .6) / .6, [(0, (8, 30, 80)), (.7, (20, 70, 150)), (1, (40, 120, 180))])
    dry = smooth(.3, .6, 1 - np.abs(lat - .28) * 4) * smooth(.0, .12, fbm((p[0] * 3, p[1] * 3, p[2] * 3), perm, 4) + .02)
    green = ramp(np.clip(h * 5, 0, 1), [(0, (52, 96, 40)), (.4, (70, 112, 48)), (.8, (110, 118, 70)), (1, (140, 125, 95))])
    desert = ramp(np.clip(h * 4, 0, 1), [(0, (200, 170, 115)), (1, (170, 135, 95))])
    ground = green * (1 - dry[..., None]) + desert * dry[..., None]
    col = ocean * (1 - land[..., None]) + ground * land[..., None]
    ice = smooth(.8, .88, lat + fbm((p[0] * 6, p[1] * 6, p[2] * 6), perm, 3) * .15)
    col = col * (1 - ice[..., None]) + np.array([.93, .96, 1]) * ice[..., None]
    # clouds: swirled, thicker in bands
    q = (p[0] * 2 + fbm((p[1] * 3, p[2] * 3, p[0] * 3), perm, 4) * 2.2, p[1] * 6, p[2] * 2 + fbm((p[2] * 3, p[0] * 3, p[1] * 3), perm, 3) * 1.5)
    cl = smooth(.0, .38, fbm(q, perm, 8) + .05 * np.cos(p[1] * 9)) ** 1.6
    col = col * (1 - cl[..., None] * .8) + np.array([1, 1, 1]) * cl[..., None] * .8
    return col, (1 - land) * (1 - cl) * (1 - ice)      # where the sea shines


def mars(p, n, lit, d, perm, v):
    h = fbm((p[0] * 2.2, p[1] * 2.2, p[2] * 2.2), perm, 7)
    col = ramp(h + .5, [(0, (110, 45, 22)), (.35, (160, 72, 36)), (.55, (196, 104, 58)), (.75, (214, 140, 90)), (1, (225, 170, 120))])
    dark = smooth(.05, -.12, fbm((p[0] * 1.2 + 4, p[1] * 1.2, p[2] * 1.2), perm, 5))
    col = col * (1 - dark[..., None] * .45)
    # a long canyon across the middle
    can = np.exp(-((p[1] + .1 + .15 * p[0] + fbm((p[0] * 9, p[1] * 9, p[2] * 9), perm, 3) * .03) / .04) ** 2) * smooth(-.6, 0, p[2]) * smooth(.9, .2, np.abs(p[0]))
    col = col * (1 - can[..., None] * .22)
    cap = smooth(.86, .92, p[1] + fbm((p[0] * 8, p[1] * 8, p[2] * 8), perm, 3) * .06)
    col = col * (1 - cap[..., None]) + np.array([.97, .95, .93]) * cap[..., None]
    return col * (1 + ridged((p[0] * 6, p[1] * 6, p[2] * 6), perm, 4)[..., None] * .12)


def craters(p, rng, count, rmin, rmax):
    """A bowl and a bright rim for each crater: returns a shade (-1..1) to add."""
    shade = np.zeros(p[0].shape)
    for _ in range(count):
        c = rng.normal(size=3)
        c /= np.linalg.norm(c)
        r = rng.uniform(rmin, rmax) ** 1.0
        dist = np.sqrt((p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2) / r
        bowl = np.where(dist < 1, -(1 - dist ** 2) * .5, 0)
        rim = np.exp(-((dist - 1) / .15) ** 2) * .35
        shade += (bowl + rim) * min(1, r * 8)
    return shade


def moon(p, n, lit, d, perm, v):
    rng = np.random.default_rng(100 + v)
    h = fbm((p[0] * 2, p[1] * 2, p[2] * 2), perm, 6)
    maria = smooth(.02, -.1, fbm((p[0] * 1.1 + 9, p[1] * 1.1, p[2] * 1.1), perm, 4))
    base = ramp(h + .5, [(0, (120, 118, 114)), (.5, (170, 168, 163)), (1, (205, 203, 198))])
    base = base * (1 - maria[..., None] * .42)
    cr = craters(p, rng, 90, .02, .12) + craters(p, rng, 10, .1, .22)
    return base * (1 + cr[..., None] * .5)


def venus(p, n, lit, d, perm, v):
    q = (p[0] * 1.5 + fbm((p[0] * 2, p[1] * 2, p[2] * 2), perm, 4) * 1.2, p[1] * 5, p[2] * 1.5)
    t = fbm(q, perm, 6) + .5
    col = ramp(t, [(0, (180, 130, 60)), (.4, (220, 180, 110)), (.6, (240, 215, 160)), (1, (250, 238, 205))])
    chev = np.cos(p[1] * 7 + np.abs(p[0]) * 3 + fbm((p[0] * 4, p[1] * 4, p[2] * 4), perm, 3) * 2) * .05
    return col * (1 + chev[..., None])


def neptune(p, n, lit, d, perm, v):
    lat = p[1]
    t = lat * .5 + .5 + fbm((p[0] * 2, p[1] * 6, p[2] * 2), perm, 4) * .05
    col = ramp((t * 3) % 1, [(0, (52, 90, 205)), (.35, (40, 72, 185)), (.6, (66, 110, 220)), (1, (52, 90, 205))])
    lon = np.arctan2(p[0], p[2])
    dl = np.angle(np.exp(1j * (lon - (.4 + v * .3))))
    e = (dl / .2) ** 2 + ((lat + .3) / .07) ** 2
    spot = smooth(1.1, .4, e)
    col = col * (1 - spot[..., None] * .55)
    streak = (np.exp(-((lat + .2) / .02) ** 2) * smooth(.4, .05, np.abs(dl - .25)) + np.exp(-((lat - .35) / .015) ** 2) * smooth(.7, .1, np.abs(dl + .6))) * smooth(.15, .45, n[2])
    col = col * (1 - streak[..., None] * .8) + np.array([.95, .97, 1]) * streak[..., None] * .8
    return col


def sun_texture(p, perm):
    gran = ridged((p[0] * 60, p[1] * 60, p[2] * 60), perm, 2)
    big = fbm((p[0] * 5, p[1] * 5, p[2] * 5), perm, 4)
    t = gran * .25 + big * .5 + .58
    col = ramp(t, [(0, (220, 90, 10)), (.4, (250, 160, 30)), (.7, (255, 210, 80)), (1, (255, 246, 200))])
    spots = smooth(-.3, -.42, fbm((p[0] * 3 + 3, p[1] * 3, p[2] * 3), perm, 3)) * smooth(.55, .2, np.abs(p[1]))
    return col * (1 - spots[..., None] * .0)      # (sunspots read as blemishes at card size)


BODIES = {
    "jupiter": dict(fn=jupiter, glow=(230, 190, 140), glow_amt=.35, glow_w=.08, atm=((245, 225, 190), .25), tilt=.05),
    "venus": dict(fn=venus, glow=(255, 225, 150), glow_amt=.55, glow_w=.1, atm=((255, 240, 200), .7), tilt=.1),
    "neptune": dict(fn=neptune, glow=(90, 140, 255), glow_amt=.55, glow_w=.1, atm=((140, 180, 255), .8), tilt=.3),
    "mars": dict(fn=mars, glow=(240, 140, 90), glow_amt=.3, glow_w=.06, atm=((255, 180, 140), .35), tilt=.35),
    "earth": dict(fn=earth, glow=(90, 160, 255), glow_amt=.6, glow_w=.09, atm=((110, 170, 255), 1.1), tilt=.4),
    "moon": dict(fn=moon, glow=(220, 220, 230), glow_amt=.18, glow_w=.05, atm=None, tilt=.1),
}


def render(name, v):
    perm = _perm(sum(map(ord, name)) * 7 + 1)
    rot = v * 1.7 + .4
    cfg = BODIES.get(name)
    tilt = cfg["tilt"] if cfg else .1
    n, p, inside, r2 = sphere(rot, tilt * (1 if v % 2 else -1))
    ldir = [(-.4, .38, .83), (-.45, .3, .84), (-.35, .42, .84), (-.42, .34, .84)][v % 4]     # light from over the viewer's left shoulder: a full, round globe with a thin night side
    a = edge_alpha(r2)
    if name == "sun":
        col = sun_texture(p, perm)
        mu = n[2]
        col = col * (0.5 + 0.5 * mu ** .6)[..., None] + np.array([.25, .2, .1]) * (mu ** 3)[..., None]      # limb darkening, a hot centre
        rr = np.sqrt(r2)
        cor = (np.exp(-np.clip(rr - 1, 0, None) / .08) * .8 + np.exp(-np.clip(rr - 1, 0, None) / .25) * .35) * (rr > 1)
        rays = 1 + .15 * np.cos(np.arctan2(n[1], n[0]) * 14 + v) * np.exp(-np.clip(rr - 1, 0, None) / .3)
        glow = cor * rays
        rgb = col * a[..., None] + np.array([1, .78, .35])[None, None, :] * (glow * (1 - a))[..., None]
        al = np.clip(a + glow * (1 - a), 0, 1)
        rgb = rgb / np.maximum(al[..., None], 1e-6)
        return np.dstack([np.clip(rgb, 0, 1), al])
    lit, d = light(n, ldir, .05)
    res = cfg["fn"](p, n, lit, d, perm, v)
    shine = None
    if isinstance(res, tuple):
        res, shine = res
    shade = lit ** .9
    col = res * (shade * .96 + .04)[..., None]
    if shine is not None:                                    # the sun glinting off the sea
        l = np.array(ldir) / np.linalg.norm(ldir)
        hv = l + np.array([0, 0, 1])
        hv /= np.linalg.norm(hv)
        spec = np.clip(n[0] * hv[0] + n[1] * hv[1] + n[2] * hv[2], 0, 1) ** 40 * shine * .35
        col = col + spec[..., None]
    if cfg["atm"]:
        col = col + atmosphere(n, r2, lit, cfg["atm"][0], cfg["atm"][1])
    col = np.clip(col, 0, 1)
    return compose(col, a, cfg["glow"], cfg["glow_amt"], cfg["glow_w"], r2)


def galaxy(v):
    """A face-on spiral galaxy, tilted a little: for the Grail."""
    rng = np.random.default_rng(7 + v)
    perm = _perm(99 + v)
    c = (np.arange(S) + 0.5) / S * 2 - 1
    X, Y = np.meshgrid(c, -c)
    Y = Y / .62                                             # tilted toward us
    r = np.sqrt(X * X + Y * Y) + 1e-6
    th = np.arctan2(Y, X)
    arms = np.cos(2 * (th - np.log(r) * 2.4) + v) * .5 + .5
    dust = fbm((X * 4, Y * 4, np.full_like(X, v * 3.1)), perm, 5)
    disk = np.exp(-r / .28) * (.35 + .9 * arms ** 3) * (1 + dust * 1.2)
    core = np.exp(-(r / .09) ** 2) * 1.4
    col = (np.array([.62, .7, 1])[None, None, :] * disk[..., None] + np.array([1, .86, .6])[None, None, :] * (core + np.exp(-r / .12) * .5)[..., None])
    lanes = smooth(.05, .25, -dust) * np.exp(-r / .5) * .5
    col = col * (1 - lanes[..., None])
    for _ in range(260):                                     # star clusters along the arms
        a = rng.uniform(0, 2 * np.pi)
        rad = rng.uniform(.06, .85) ** 1.2
        x0, y0 = rad * np.cos(a), rad * np.sin(a)
        b = rng.uniform(.3, 1)
        col += np.exp(-(((X - x0) ** 2 + ((Y - y0) * .62) ** 2) / (.004 ** 2))) [..., None] * np.array([.8, .85, 1]) * b
    lum = np.clip(col.max(axis=-1), 0, 1)
    a = np.clip(lum * 1.4, 0, 1) * smooth(1, .8, r * .62)
    rgb = np.clip(col / np.maximum(lum[..., None], 1e-6), 0, 1)
    return np.dstack([rgb, a])


def main():
    os.makedirs(OUT, exist_ok=True)
    for name in ["sun", "moon", "earth", "mars", "neptune", "venus", "jupiter"]:
        for v in range(VARIANTS):
            img = render(name, v)
            Image.fromarray((img * 255).round().astype(np.uint8), "RGBA").save(os.path.join(OUT, f"{name}-{v}.webp"), quality=82, method=6)
        print(name)
    Image.fromarray((galaxy(0) * 255).round().astype(np.uint8), "RGBA").save(os.path.join(OUT, "galaxy-0.webp"), quality=82, method=6)


if __name__ == "__main__":
    main()
