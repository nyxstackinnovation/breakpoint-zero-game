"""Generate tileable material textures (albedo + normal) for the voxel world, plus effect sprites.

Run:  python tools/textures/gen_textures.py   (needs numpy + Pillow)
Writes client/assets/textures/voxel_albedo.png and voxel_normal.png (layers stacked vertically),
decals.png (bullet holes / blood) and sprites.png (smoke, spark, flash, debris dust).
"""
import os
import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'client', 'assets', 'textures')
os.makedirs(OUT, exist_ok=True)
N = 256
rng = np.random.default_rng(1234)

# layer order must match shared/materials.js
LAYERS = ['plain', 'concrete', 'brick', 'plaster', 'wood', 'metal', 'corrugated', 'asphalt', 'paving', 'grass',
          'sand', 'rock', 'shingles', 'leaves', 'floor', 'fabric', 'stone', 'mud']


def periodic_noise(scale, seed=None, n=N):
    """Tileable band-limited noise in [0,1]; scale ~ feature size in pixels."""
    r = np.random.default_rng(seed) if seed is not None else rng
    w = r.standard_normal((n, n))
    fx = np.fft.fftfreq(n)[:, None]
    fy = np.fft.fftfreq(n)[None, :]
    f = np.sqrt(fx * fx + fy * fy)
    filt = np.exp(-(f * scale) ** 2 * 6)
    out = np.real(np.fft.ifft2(np.fft.fft2(w) * filt))
    out -= out.min()
    return out / (out.max() + 1e-9)


def fbm(scales, weights, seed=0):
    acc = np.zeros((N, N))
    for i, (s, wgt) in enumerate(zip(scales, weights)):
        acc += periodic_noise(s, seed + i * 17) * wgt
    acc -= acc.min()
    return acc / (acc.max() + 1e-9)


def normal_from_height(h, strength=2.0):
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    nx, ny, nz = -dx * strength, dy * strength, np.ones_like(h)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / l, ny / l, nz / l], -1)


def grid_coords():
    y, x = np.mgrid[0:N, 0:N]
    return x, y


def layer_plain():
    n = fbm([40, 10, 3], [0.5, 0.3, 0.2], 1)
    return 0.9 + (n - 0.5) * 0.08, n * 0.2


def layer_concrete():
    n = fbm([64, 16, 4, 1.5], [0.35, 0.3, 0.2, 0.15], 2)
    pits = (periodic_noise(1.2, 3) > 0.82).astype(float)
    stain = periodic_noise(90, 4)
    alb = 0.82 + (n - 0.5) * 0.16 - pits * 0.12 - (stain > 0.7) * (stain - 0.7) * 0.4
    # formwork seams
    x, y = grid_coords()
    seam = ((x % 128) < 2) | ((y % 128) < 2)
    alb = np.where(seam, alb * 0.86, alb)
    h = n * 0.6 - pits * 0.5 - seam * 0.4
    return alb, h


def layer_brick():
    x, y = grid_coords()
    bh, bw, mortar = 32, 64, 4
    row = y // bh
    xo = (x + (row % 2) * (bw // 2)) % N
    col = xo // bw
    in_m = ((y % bh) < mortar) | ((xo % bw) < mortar)
    rnd = np.random.default_rng(5).random((N // bh + 1, N // bw + 2))
    brick_var = rnd[row, col]
    n = fbm([12, 3, 1.2], [0.4, 0.35, 0.25], 6)
    alb = np.where(in_m, 1.08 + (n - 0.5) * 0.1, 0.78 + (brick_var - 0.5) * 0.24 + (n - 0.5) * 0.14)
    # chipped edges
    chip = periodic_noise(2, 7) > 0.86
    alb = np.where(chip & ~in_m, alb * 0.85, alb)
    h = np.where(in_m, 0.0, 0.7 + n * 0.3)
    return alb, h


def layer_plaster():
    n = fbm([80, 20, 3, 1], [0.3, 0.3, 0.25, 0.15], 8)
    alb = 0.9 + (n - 0.5) * 0.12
    cracks = np.abs(periodic_noise(30, 9) - 0.5) < 0.0025
    alb = np.where(cracks, alb * 0.75, alb)
    return alb, n * 0.5 - cracks.astype(float) * 0.6


def layer_wood():
    x, y = grid_coords()
    pw = 64
    plank = x // pw
    rnd = np.random.default_rng(10).random(N // pw + 1)
    streak = periodic_noise(1.2, 11)
    for k in range(5):
        streak = (streak + np.roll(streak, 2 ** k, 0) + np.roll(streak, -(2 ** k), 0)) / 3
    streak = (streak - streak.min()) / (streak.max() - streak.min() + 1e-9)
    warp = periodic_noise(40, 12)
    rings = np.sin((x + warp * 30) * 0.55) * 0.5 + 0.5
    grain = 0.55 * streak + 0.3 * rings + 0.15 * periodic_noise(1.0, 13)
    gap = (x % pw) < 2
    alb = 0.75 + (rnd[plank] - 0.5) * 0.25 + (grain - 0.5) * 0.18
    # end joints
    joint = ((y + plank * 97) % 256) < 2
    alb = np.where(gap | joint, alb * 0.45, alb)
    h = grain * 0.3 - (gap | joint) * 0.8
    return alb, h


def layer_metal():
    x, y = grid_coords()
    seam = ((x % 128) < 3) | ((y % 128) < 3)
    rivx = ((x % 128) - 12) ** 2
    rivets = np.zeros((N, N), bool)
    for cy in (12, 64, 116):
        for cx in (12, 64, 116):
            d = ((x % 128) - cx) ** 2 + ((y % 128) - cy) ** 2
            rivets |= d < 16
    brushed = periodic_noise(1.0, 14)
    brushed = (brushed + np.roll(brushed, 1, 1) + np.roll(brushed, 2, 1) + np.roll(brushed, 3, 1)) / 4
    n = fbm([60, 10], [0.6, 0.4], 15)
    alb = 0.8 + (brushed - 0.5) * 0.1 + (n - 0.5) * 0.12
    alb = np.where(seam, alb * 0.7, alb)
    alb = np.where(rivets, alb * 1.1, alb)
    h = -seam.astype(float) * 0.6 + rivets.astype(float) * 0.8 + brushed * 0.05
    return alb, h


def layer_corrugated():
    x, y = grid_coords()
    wave = np.sin(x / N * 2 * np.pi * 16) * 0.5 + 0.5
    n = fbm([50, 6], [0.6, 0.4], 16)
    rust = periodic_noise(25, 17)
    alb = 0.72 + wave * 0.18 + (n - 0.5) * 0.1 - np.clip(rust - 0.72, 0, 1) * 0.6
    return alb, wave * 1.4


def layer_asphalt():
    n = fbm([30, 4, 1], [0.3, 0.3, 0.4], 18)
    speck = periodic_noise(0.8, 19)
    alb = 0.8 + (n - 0.5) * 0.18 + (speck > 0.75) * 0.12 - (speck < 0.2) * 0.1
    cracks = np.abs(periodic_noise(40, 20) - 0.5) < 0.003
    alb = np.where(cracks, alb * 0.6, alb)
    return alb, n * 0.4 + speck * 0.2 - cracks * 0.6


def layer_paving():
    x, y = grid_coords()
    s = 64
    grout = ((x % s) < 3) | ((y % s) < 3)
    tile = (y // s) * 7 + (x // s) * 13
    var = (np.sin(tile * 12.9898) * 43758.5453) % 1
    n = fbm([20, 3], [0.6, 0.4], 21)
    alb = np.where(grout, 0.7, 0.86 + (var - 0.5) * 0.12 + (n - 0.5) * 0.1)
    h = np.where(grout, 0.0, 0.6 + n * 0.2)
    return alb, h


def layer_grass():
    n = fbm([20, 4, 1], [0.3, 0.3, 0.4], 22)
    blades = periodic_noise(0.7, 23)
    blades = (blades + np.roll(blades, 1, 0) + np.roll(blades, 2, 0)) / 3
    alb = 0.78 + (n - 0.5) * 0.25 + (blades - 0.5) * 0.25
    return alb, blades


def layer_sand():
    x, y = grid_coords()
    n = fbm([40, 6, 1], [0.3, 0.3, 0.4], 24)
    ripple = np.sin((y + periodic_noise(30, 25) * 40) * 0.25) * 0.5 + 0.5
    alb = 0.86 + (n - 0.5) * 0.12 + (ripple - 0.5) * 0.06
    return alb, ripple * 0.5 + n * 0.3


def layer_rock():
    n = fbm([70, 25, 6, 1.5], [0.3, 0.3, 0.25, 0.15], 26)
    cr = np.abs(periodic_noise(14, 27) - 0.5)
    cracks = cr < 0.008
    alb = 0.78 + (n - 0.5) * 0.3 - cracks * 0.25
    h = n - cracks * 0.6
    return alb, h


def layer_shingles():
    x, y = grid_coords()
    rh = 32
    row = y // rh
    xo = (x + (row % 2) * 24) % N
    edge = (y % rh) > rh - 4
    sep = (xo % 48) < 2
    shade = (y % rh) / rh
    n = fbm([10, 2], [0.5, 0.5], 28)
    alb = 0.7 + shade * 0.2 + (n - 0.5) * 0.12
    alb = np.where(edge | sep, alb * 0.6, alb)
    return alb, shade - (edge | sep) * 0.5


def layer_leaves():
    n = fbm([8, 3, 1], [0.5, 0.3, 0.2], 29)
    blobs = periodic_noise(4, 30)
    alb = 0.6 + n * 0.45
    alb = np.where(blobs < 0.3, alb * 0.55, alb)
    return alb, n


def layer_floor():
    x, y = grid_coords()
    s = 128
    grout = ((x % s) < 2) | ((y % s) < 2)
    marble = periodic_noise(40, 31)
    veins = np.abs(np.sin(marble * 12)) < 0.08
    alb = np.where(grout, 0.7, 0.9 + (marble - 0.5) * 0.08 - veins * 0.08)
    return alb, -grout.astype(float) * 0.5


def layer_fabric():
    x, y = grid_coords()
    weave = ((x // 2 + y // 2) % 2) * 0.06
    n = fbm([30, 4], [0.5, 0.5], 32)
    alb = 0.82 + weave + (n - 0.5) * 0.1
    return alb, weave * 4


def layer_stone():
    # cut stone blocks, one voxel tall (texture covers 2 x 2 voxels), staggered widths, chipped worn edges
    x, y = grid_coords()
    bh = 128
    row = y // bh
    widths = [128, 256, 128]
    off = (row % 2) * 64
    xo = (x + off) % N
    col = np.where(row % 2 == 0, xo // 128, xo // 256 * 2)
    edge = np.minimum(np.minimum(y % bh, bh - 1 - (y % bh)), np.minimum(xo % 128 if True else 0, 127 - (xo % 128)))
    edge = np.where((row % 2 == 1), np.minimum(np.minimum(y % bh, bh - 1 - (y % bh)), np.minimum(xo % 256, 255 - (xo % 256))), edge)
    rnd = np.random.default_rng(41).random((N // bh + 1, 8))
    var = rnd[row, np.clip(col, 0, 7)]
    n = fbm([40, 10, 3, 1.2], [0.3, 0.3, 0.25, 0.15], 42)
    wobble = periodic_noise(6, 43) * 6
    mortar = edge < (2 + wobble * 0.45)
    bevel = np.clip((edge - 3) / 10.0, 0, 1)
    soot = np.clip((periodic_noise(70, 44) - 0.55) * 2.2, 0, 1)
    chip = (periodic_noise(3, 45) > 0.8) & (edge < 14)
    pit = periodic_noise(0.9, 50) > 0.83
    alb = 0.8 + (var - 0.5) * 0.26 + (n - 0.5) * 0.22 - pit * 0.08
    alb = alb * (0.86 + 0.14 * bevel) - soot * 0.07
    alb = np.where(chip, alb * 0.8, alb)
    alb = np.where(mortar, 0.55 + n * 0.1, alb)
    h = np.where(mortar, 0.0, 0.5 + bevel * 0.4 + n * 0.25) - chip * 0.3
    return alb, h


def layer_mud():
    # churned dirt: dark wet patches, pebbles and boot / tyre ruts
    x, y = grid_coords()
    n = fbm([60, 18, 5, 1.5], [0.3, 0.3, 0.25, 0.15], 46)
    wet = np.clip((periodic_noise(50, 47) - 0.5) * 2.5, 0, 1)
    peb = periodic_noise(1.6, 48)
    pebbles = peb > 0.8
    rut = np.abs(np.sin((x + periodic_noise(40, 49) * 60) * (2 * np.pi / 128))) < 0.12
    alb = 0.78 + (n - 0.5) * 0.3 - wet * 0.22 - rut * 0.025
    alb = np.where(pebbles, 0.7 + (peb - 0.8) * 2.0, alb)
    h = n * 0.6 + pebbles * 0.5 - rut * 0.12
    return alb, h


BUILD = {
    'plain': layer_plain, 'concrete': layer_concrete, 'brick': layer_brick, 'plaster': layer_plaster, 'wood': layer_wood,
    'metal': layer_metal, 'corrugated': layer_corrugated, 'asphalt': layer_asphalt, 'paving': layer_paving,
    'grass': layer_grass, 'sand': layer_sand, 'rock': layer_rock, 'shingles': layer_shingles, 'leaves': layer_leaves,
    'floor': layer_floor, 'fabric': layer_fabric, 'stone': layer_stone, 'mud': layer_mud,
}
NORMAL_STRENGTH = {'stone': 3.5, 'mud': 2.5, 'brick': 3.0, 'corrugated': 5.0, 'metal': 3.0, 'paving': 2.5, 'shingles': 3.0, 'rock': 4.0, 'wood': 2.0, 'floor': 2.0}


def build_voxel_textures():
    albs, nors = [], []
    for name in LAYERS:
        a, h = BUILD[name]()
        a = np.clip(a, 0, 1.2) / 1.2  # keep headroom; shader rescales by 1.2
        rgb = np.stack([a, a, a], -1)
        albs.append((rgb * 255).astype(np.uint8))
        nm = normal_from_height(h.astype(float), NORMAL_STRENGTH.get(name, 1.5))
        nors.append(((nm * 0.5 + 0.5) * 255).astype(np.uint8))
    Image.fromarray(np.concatenate(albs, 0), 'RGB').save(os.path.join(OUT, 'voxel_albedo.png'), optimize=True)
    Image.fromarray(np.concatenate(nors, 0), 'RGB').save(os.path.join(OUT, 'voxel_normal.png'), optimize=True)
    print('voxel textures:', len(LAYERS), 'layers')


def radial(n, falloff=1.0):
    y, x = np.mgrid[0:n, 0:n]
    d = np.sqrt((x - n / 2 + 0.5) ** 2 + (y - n / 2 + 0.5) ** 2) / (n / 2)
    return np.clip(1 - d, 0, 1) ** falloff, d


def build_decals():
    """4x2 atlas of 128px decals: bullet holes (concrete, metal, wood, generic), blood splats x2, scorch, crack."""
    S = 128
    atlas = np.zeros((S * 2, S * 4, 4), np.float32)

    def put(i, rgba):
        r, c = divmod(i, 4)
        atlas[r * S:(r + 1) * S, c * S:(c + 1) * S] = rgba

    y, x = np.mgrid[0:S, 0:S]
    cx = cy = S / 2
    d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
    ang = np.arctan2(y - cy, x - cx)
    loc = np.random.default_rng(40)
    # concrete hole: dark core, chipped light ring, radial cracks
    core = d < 9
    ring = (d < 24 + 6 * np.sin(ang * 7 + 1)) & ~core
    cracks = np.zeros((S, S), bool)
    for a0 in loc.uniform(0, 2 * np.pi, 6):
        da = np.abs(((ang - a0 + np.pi) % (2 * np.pi)) - np.pi)
        cracks |= (da < 0.04 * (1 + 8 / (d + 1))) & (d < loc.uniform(30, 55))
    rgba = np.zeros((S, S, 4))
    rgba[..., :3] = 0.08
    rgba[..., 3] = np.where(core, 1.0, 0)
    rgba[ring, :3] = 0.55
    rgba[ring, 3] = 0.55
    rgba[cracks & ~core, :3] = 0.12
    rgba[cracks & ~core, 3] = 0.7
    put(0, rgba)
    # metal hole: dark core, bright bent rim
    rgba = np.zeros((S, S, 4))
    core = d < 8
    rim = (d >= 8) & (d < 13)
    rgba[core, :3] = 0.03
    rgba[core, 3] = 1
    rgba[rim, :3] = 0.85
    rgba[rim, 3] = 0.9
    halo = (d >= 13) & (d < 26)
    rgba[halo, :3] = 0.25
    rgba[halo, 3] = (1 - (d[halo] - 13) / 13) * 0.4
    put(1, rgba)
    # wood hole: splintered
    rgba = np.zeros((S, S, 4))
    core = d < 8
    splint = (np.abs(np.sin(ang * 2)) * 28 > d) & ~core & (np.abs(y - cy) < 30)
    rgba[core, :3] = 0.05
    rgba[core, 3] = 1
    rgba[splint, :3] = (0.75, 0.6, 0.42)
    rgba[splint, 3] = 0.8
    put(2, rgba)
    # generic soft hole
    rgba = np.zeros((S, S, 4))
    rgba[..., :3] = 0.05
    rgba[..., 3] = np.clip(1 - d / 22, 0, 1) ** 1.5
    put(3, rgba)
    # blood splats
    for k in range(2):
        rgba = np.zeros((S, S, 4))
        m = np.zeros((S, S))
        for _ in range(14):
            bx, by = loc.normal(cx, 18), loc.normal(cy, 18)
            br = loc.uniform(4, 16)
            m = np.maximum(m, np.clip(1 - np.sqrt((x - bx) ** 2 + (y - by) ** 2) / br, 0, 1))
        for _ in range(10):
            a0 = loc.uniform(0, 2 * np.pi)
            for t in range(5):
                rr = 20 + t * 8
                bx, by = cx + np.cos(a0) * rr, cy + np.sin(a0) * rr
                m = np.maximum(m, np.clip(1 - np.sqrt((x - bx) ** 2 + (y - by) ** 2) / (4 - t * 0.6 + 1), 0, 1))
        rgba[..., 0] = 0.42
        rgba[..., 1] = 0.02
        rgba[..., 2] = 0.03
        rgba[..., 3] = np.clip(m * 2.5, 0, 0.92)
        put(4 + k, rgba)
    # scorch
    rgba = np.zeros((S, S, 4))
    nz = periodic_noise(6, 41, S)
    rgba[..., :3] = 0.04
    rgba[..., 3] = np.clip((1 - d / 60) * (0.7 + nz * 0.6), 0, 0.85)
    put(6, rgba)
    # glass crack star
    rgba = np.zeros((S, S, 4))
    star = np.zeros((S, S), bool)
    for a0 in np.linspace(0, 2 * np.pi, 9)[:-1] + 0.2:
        da = np.abs(((ang - a0 + np.pi) % (2 * np.pi)) - np.pi)
        star |= (da < 0.03) & (d < 60)
    circ = np.abs(d - 22) < 1.2
    rgba[star | circ, :3] = 0.9
    rgba[star | circ, 3] = 0.8
    put(7, rgba)
    Image.fromarray((np.clip(atlas, 0, 1) * 255).astype(np.uint8), 'RGBA').save(os.path.join(OUT, 'decals.png'), optimize=True)
    print('decals atlas')


def build_sprites():
    """4x1 atlas of 128px soft particle sprites: smoke puff, spark streak, flash star, dust."""
    S = 128
    atlas = np.zeros((S, S * 4, 4), np.float32)
    y, x = np.mgrid[0:S, 0:S]
    d = np.sqrt((x - S / 2) ** 2 + (y - S / 2) ** 2) / (S / 2)
    nz = periodic_noise(10, 50, S)
    smoke = np.clip(1 - d, 0, 1) ** 1.2 * (0.55 + nz * 0.7)
    atlas[:, 0:S, :3] = 1
    atlas[:, 0:S, 3] = np.clip(smoke, 0, 1)
    spark = np.clip(1 - np.abs(y - S / 2) / 6, 0, 1) * np.clip(1 - np.abs(x - S / 2) / (S / 2), 0, 1) ** 0.6
    atlas[:, S:2 * S, :3] = 1
    atlas[:, S:2 * S, 3] = spark
    ang = np.arctan2(y - S / 2, x - S / 2)
    star = np.clip(1 - d * (1.2 + 0.8 * np.abs(np.sin(ang * 3))), 0, 1) ** 1.5 + np.clip(1 - d * 3, 0, 1)
    atlas[:, 2 * S:3 * S, :3] = 1
    atlas[:, 2 * S:3 * S, 3] = np.clip(star, 0, 1)
    nz2 = periodic_noise(4, 51, S)
    dust = np.clip(1 - d, 0, 1) ** 0.8 * (0.3 + nz2 * 0.9)
    atlas[:, 3 * S:4 * S, :3] = 1
    atlas[:, 3 * S:4 * S, 3] = np.clip(dust, 0, 1)
    Image.fromarray((np.clip(atlas, 0, 1) * 255).astype(np.uint8), 'RGBA').save(os.path.join(OUT, 'sprites.png'), optimize=True)
    print('sprites atlas')


if __name__ == '__main__':
    import sys
    build_voxel_textures()
    if '--voxels-only' not in sys.argv:
        build_decals()
        build_sprites()
