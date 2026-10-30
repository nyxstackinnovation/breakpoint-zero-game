"""Build client/assets/textures/faces.png: the five operator faces cut from the reference sheets in
client/assets/character/, aligned so the eyes and mouth land where tools/blender/build_operators.py
puts them on the head mesh, and feathered into each face's skin tone.

    python tools/textures/face_atlas.py        (needs numpy and Pillow)

Prints the skin tones; build_operators.py uses the same values for the rest of the body.
"""
import os
import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
SHEETS = os.path.join(ROOT, 'client', 'assets', 'character')
OUT = os.path.join(ROOT, 'client', 'assets', 'textures', 'faces.png')
# face close-up panel on each sheet (left, top, right, bottom)
PANELS = {'Viper': ('Tactical Operative Character Reference Sheet.png', (918, 10, 1214, 366)),
          'Ranger': ('Tactical Operative Character Showcase.png', (1014, 10, 1281, 358)),
          'Nova': ('Tactical Operator Character Reference Sheet.png', (1016, 12, 1280, 360)),
          'Ghost': ('Tactical Soldier Asset Showcase.png', (1030, 22, 1275, 365)),
          'Blaze': ('Urban Special-Ops Character Showcase.png', (1014, 10, 1280, 355))}
# eye centres (viewer-left, viewer-right) and mouth centre, in pixels inside each panel
A = {'Viper': ((107,186),(192,186),(150,274)), 'Ranger': ((106,163),(172,162),(145,245)),
     'Nova': ((106,175),(175,175),(137,265)), 'Ghost': ((102,156),(170,156),(137,244)),
     'Blaze': ((102,171),(172,170),(142,250))}
ORDER = ['Viper','Ranger','Nova','Ghost','Blaze']
EX = {'Viper':0.03,'Nova':0.03,'Ranger':0.032,'Ghost':0.032,'Blaze':0.032}
EYE_Z, MOUTH_Z = 0.017, -0.043
X0, X1, Z0, Z1 = -0.075, 0.075, -0.125, 0.105      # head-local region a cell covers
CW, CH = 341, 512
atlas = np.ones((1024, 1024, 3), np.float32)
skins = {}
for i, n in enumerate(ORDER):
    sheet, box = PANELS[n]
    im = np.asarray(Image.open(os.path.join(SHEETS, sheet)).convert('RGB').crop(box)).astype(np.float32) / 255
    (lx, ly), (rx, ry), (mx, my) = A[n]
    cx, cy, dx = (lx + rx) / 2, (ly + ry) / 2, rx - lx
    ex = EX[n]
    # cell pixel -> head-local (x, z) -> photo pixel
    u = (np.arange(CW) + 0.5) / CW
    v = (np.arange(CH) + 0.5) / CH            # 0 = top row of the cell
    X = X0 + u * (X1 - X0)
    Z = Z1 - v * (Z1 - Z0)
    XX, ZZ = np.meshgrid(X, Z)
    PX = cx + XX / ex * dx / 2
    PY = cy + (EYE_Z - ZZ) * (my - cy) / (EYE_Z - MOUTH_Z)
    h, w = im.shape[:2]
    x0 = np.clip(np.floor(PX).astype(int), 0, w - 2); y0 = np.clip(np.floor(PY).astype(int), 0, h - 2)
    fx = np.clip(PX - x0, 0, 1)[..., None]; fy = np.clip(PY - y0, 0, 1)[..., None]
    smp = (im[y0, x0] * (1 - fx) * (1 - fy) + im[y0, x0 + 1] * fx * (1 - fy) + im[y0 + 1, x0] * (1 - fx) * fy + im[y0 + 1, x0 + 1] * fx * fy)
    # soft face mask (ellipse), fading to the face's mid skin tone
    e = np.sqrt((XX / 0.057) ** 2 + ((ZZ + 0.01) / 0.086) ** 2)
    core = smp[(e < 0.75) & (np.abs(XX) > 0.012)]
    lum = core @ np.array([0.3, 0.59, 0.11])
    lo, hi = np.percentile(lum, [45, 85])
    skin = np.median(core[(lum >= lo) & (lum <= hi)], axis=0)
    skins[n] = skin
    m = np.clip((1.0 - e) / 0.2, 0, 1)[..., None]
    m = m * m * (3 - 2 * m)
    cell = smp * m + skin * (1 - m)
    r, c = divmod(i, 3)
    atlas[r * CH:(r + 1) * CH, c * CW:(c + 1) * CW] = cell
# cell 5: seamless detail tiles multiplied over the vertex colours (box-projected UVs, see build_operators.py)
#   fabric weave  x 682..1022, y 512..767  (170 x 128 tile repeated 2 x 2)
#   gear / leather x 682..1022, y 768..991 (170 x 112 tile repeated 2 x 2)
#   plain white   y 992..1023              (skin, hair, metal)
rng = np.random.default_rng(7)


def periodic_noise(h, w, sigma):
    """White noise blurred in the frequency domain, so it tiles without seams; scaled to -1..1."""
    n = rng.standard_normal((h, w))
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    g = np.exp(-(fx ** 2 + fy ** 2) * (2 * np.pi * sigma) ** 2 / 2)
    out = np.real(np.fft.ifft2(np.fft.fft2(n) * g))
    return out / (np.abs(out).max() + 1e-6)


def fabric_tile(h=128, w=170):
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    twill = np.sin(2 * np.pi * (28 * x / w + 21 * y / h))           # fine diagonal weave
    cross = np.sin(2 * np.pi * (56 * x / w)) * np.sin(2 * np.pi * (42 * y / h))
    v = 0.93 + 0.022 * twill + 0.012 * cross + 0.035 * periodic_noise(h, w, 6) + 0.015 * periodic_noise(h, w, 1)
    return v


def gear_tile(h=112, w=170):
    v = 0.92 + 0.05 * periodic_noise(h, w, 3) + 0.03 * periodic_noise(h, w, 0.8) - 0.02 * np.abs(periodic_noise(h, w, 10))
    return v


def put(tile, x, y):
    big = np.tile(tile, (2, 2))
    hh, ww = big.shape
    atlas[y:y + hh, x:x + ww] = np.clip(big, 0, 1)[..., None]
    atlas[y:y + hh, x + ww:x + ww + 1] = np.clip(big[:, :1], 0, 1)[..., None]


put(fabric_tile(), 2 * CW, CH)
put(gear_tile(), 2 * CW, CH + 256)
atlas[CH + 480:, 2 * CW:] = 1.0
out = (np.clip(atlas, 0, 1) * 255 + 0.5).astype(np.uint8)
Image.fromarray(out).save(OUT, optimize=True)
print('wrote', OUT)
for n in ORDER:
    s = skins[n]; print(n, '0x%02x%02x%02x' % tuple(int(c * 255 + 0.5) for c in s))
