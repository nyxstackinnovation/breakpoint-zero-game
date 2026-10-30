"""Tileable detail textures for the first-person hands (skin, glove leather, stretch fabric, velcro).

Run:  python tools/textures/hand_textures.py      (numpy + Pillow)
Writes tools/blender/textures/*.png, which tools/blender/build_fp_hands.py packs into fp_hands.glb.
These are surface detail maps (pores, leather grain, weave) tiled over UVs, not pictures of hands.
"""
import os
import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'tools', 'blender', 'textures')
os.makedirs(OUT, exist_ok=True)


def pnoise(n, scale, seed):
    r = np.random.default_rng(seed)
    w = r.standard_normal((n, n))
    fx = np.fft.fftfreq(n)[:, None]
    fy = np.fft.fftfreq(n)[None, :]
    f = np.sqrt(fx * fx + fy * fy)
    out = np.real(np.fft.ifft2(np.fft.fft2(w) * np.exp(-(f * scale) ** 2 * 6)))
    out -= out.min()
    return out / (out.max() + 1e-9)


def cells(n, count, seed):
    """Tileable Worley distance (F1, F2) for pebbled grain."""
    r = np.random.default_rng(seed)
    pts = r.random((count, 2)) * n
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    f1 = np.full((n, n), 1e9, np.float32)
    f2 = np.full((n, n), 1e9, np.float32)
    for ox in (-n, 0, n):
        for oy in (-n, 0, n):
            for px, py in pts:
                d = (x - px - ox) ** 2 + (y - py - oy) ** 2
                m = d < f1
                f2 = np.where(m, f1, np.minimum(f2, d))
                f1 = np.where(m, d, f1)
    return np.sqrt(f1), np.sqrt(f2)


def normal_map(h, strength):
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    nx, ny, nz = -dx * strength, dy * strength, np.ones_like(h)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    return (np.stack([nx / l, ny / l, nz / l], -1) * 0.5 + 0.5)


def save(name, arr, mode='RGB'):
    a = np.clip(arr, 0, 1)
    img = Image.fromarray((a * 255 + 0.5).astype(np.uint8), mode)
    if name.endswith('_albedo.png'):
        name = name.replace('.png', '.jpg')                    # colour maps compress well as JPEG
        img.save(os.path.join(OUT, name), quality=90)
    else:
        img.save(os.path.join(OUT, name), optimize=True)
    print('wrote', name)


def skin():
    n = 512
    blot = pnoise(n, 60, 1)
    mid = pnoise(n, 15, 2)
    fine = pnoise(n, 1.6, 3)
    pore_n = pnoise(n, 0.9, 4)
    pores = np.clip((pore_n - 0.68) * 6, 0, 1)
    # fine criss-cross skin lines in two directions
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    warp = pnoise(n, 20, 5) * 15
    l1 = np.abs(np.sin((x * 0.7 + y * 0.7 + warp) * (2 * np.pi / 11)))
    l2 = np.abs(np.sin((x * 0.7 - y * 0.7 + warp * 0.6) * (2 * np.pi / 13.5)))
    lines = np.clip(1 - np.minimum(l1, l2) * 9, 0, 1) * (pnoise(n, 12, 6) > 0.45)
    lum = 0.93 + (blot - 0.5) * 0.08 + (mid - 0.5) * 0.05 + (fine - 0.5) * 0.04 - pores * 0.06 - lines * 0.03
    red = (pnoise(n, 35, 7) - 0.5) * 0.05
    freck = np.clip((pnoise(n, 2, 8) - 0.8) * 4, 0, 1) * 0.08
    rgb = np.stack([lum + red - freck * 0.5, lum - red * 0.4 - freck, lum - red * 0.6 - freck * 1.2], -1)
    save('skin_albedo.png', rgb)
    h = mid * 0.25 + fine * 0.35 - pores * 0.8 - lines * 0.45
    save('skin_normal.png', normal_map(h, 2.2))


def leather():
    n = 512
    f1, f2 = cells(n, 900, 11)
    edge = f2 - f1
    grain = np.clip(edge / 7.0, 0, 1)                     # raised pebbles, creases between them
    blot = pnoise(n, 60, 12)
    fine = pnoise(n, 1.5, 13)
    lum = 0.16 + grain * 0.05 + (blot - 0.5) * 0.04 + (fine - 0.5) * 0.02
    scuff = np.clip((pnoise(n, 25, 14) - 0.7) * 3, 0, 1) * 0.05
    save('leather_albedo.png', np.stack([lum + scuff, lum * 0.98 + scuff, lum * 0.96 + scuff], -1))
    h = grain * 0.8 + fine * 0.2
    save('leather_normal.png', normal_map(h, 3.5))
    rough = 0.62 + (1 - grain) * 0.18 + (blot - 0.5) * 0.1 - scuff
    save('leather_mr.png', np.stack([np.zeros_like(rough), rough, np.zeros_like(rough)], -1))


def fabric():
    n = 512
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    p = 8.0
    a = np.sin(x * 2 * np.pi / p) * np.sin(y * 2 * np.pi / p)     # stretch-knit cells
    rib = np.abs(np.sin((x + y) * np.pi / p)) * 0.5 + np.abs(np.sin((x - y) * np.pi / p)) * 0.5
    fine = pnoise(n, 1.2, 21)
    h = (a * 0.5 + 0.5) * 0.5 + rib * 0.4 + fine * 0.1
    lum = 0.13 + h * 0.06 + (pnoise(n, 50, 22) - 0.5) * 0.03
    save('fabric_albedo.png', np.stack([lum, lum, lum * 1.02], -1))
    save('fabric_normal.png', normal_map(h, 2.6))


def velcro():
    n = 256
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    loops = pnoise(n, 1.1, 31)
    stripes = np.abs(np.sin(y * 2 * np.pi / 6)) * 0.4
    h = loops * 0.7 + stripes
    lum = 0.17 + h * 0.06
    save('velcro_albedo.png', np.stack([lum, lum, lum], -1))
    save('velcro_normal.png', normal_map(h, 3.0))


if __name__ == '__main__':
    skin()
    leather()
    fabric()
    velcro()
