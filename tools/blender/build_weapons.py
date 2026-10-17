"""Weapons: detailed assault rifle, magazine, rocket launcher, warhead and rocket projectile.

Conventions (Blender space): forward = -Y, up = +Z, origin = centre of the pistol grip.
The rifle's handguard support point sits at (0, -0.24, 0.085); the launcher's forward grip bar
is placed at the same point, so the same hand poses fit both weapons.
"""
import math
from mathutils import Vector
from bpz_common import (material, box, cylinder, sphere, join, smooth, export_glb, log, clear_scene,
                        OUT_MODELS, save_blend)
import os

SUPPORT_POINT = (0.0, -0.24, 0.085)
BUTT_POINT = (0.0, 0.31, 0.085)


def mats():
    return {
        'metal': material('GunMetal', 0x2c2f35, rough=0.38, metal=0.75),
        'dark': material('GunDark', 0x17191c, rough=0.55, metal=0.5),
        'polymer': material('Polymer', 0x2a2c30, rough=0.8),
        'tan': material('GunTan', 0xa08560, rough=0.75),
        'rubber': material('Rubber', 0x141414, rough=0.95),
        'lens': material('Lens', 0x3a6f8f, rough=0.05, metal=0.3, alpha=0.45),
        'dot': material('RedDot', 0xff2a1a, rough=0.3, emission=0xff2a1a),
        'olive': material('LauncherOlive', 0x4b5636, rough=0.65, metal=0.1),
        'oliveDark': material('LauncherOliveDark', 0x343c25, rough=0.8),
        'red': material('WarheadBand', 0xa8201c, rough=0.6),
        'brass': material('Brass', 0xc8a04a, rough=0.3, metal=0.9),
    }


def X(a):
    return (math.radians(a), 0, 0)


def build_rifle(lod=0, with_mag=True, name='Rifle'):
    M = mats()
    hi = lod == 0
    bv = 0.004 if hi else 0.0
    parts = []
    parts.append(box('lower', (0.044, 0.20, 0.055), (0, -0.02, 0.045), mat=M['metal'], bevel=bv))
    parts.append(box('magwell', (0.047, 0.075, 0.05), (0, -0.078, 0.008), mat=M['metal'], bevel=bv))
    parts.append(box('upper', (0.049, 0.25, 0.05), (0, -0.03, 0.098), mat=M['metal'], bevel=bv))
    parts.append(box('rail', (0.027, 0.27, 0.012), (0, -0.04, 0.129), mat=M['dark']))
    if hi:
        for i in range(20):
            parts.append(box(f'tooth{i}', (0.032, 0.006, 0.006), (0, 0.085 - i * 0.0128, 0.137), mat=M['dark']))
        parts.append(box('port', (0.003, 0.055, 0.022), (-0.0256, -0.035, 0.096), mat=M['dark']))
        parts.append(cylinder('fwdassist', 0.008, 0.008, 0.022, (-0.028, 0.04, 0.106), (0, math.radians(90), 0), mat=M['metal'], segs=10))
        parts.append(box('boltrelease', (0.004, 0.025, 0.012), (0.0235, 0.0, 0.05), mat=M['dark']))
        parts.append(box('magrelease', (0.004, 0.01, 0.01), (-0.0235, -0.045, 0.04), mat=M['dark']))
    parts.append(box('charging', (0.054, 0.022, 0.012), (0, 0.098, 0.116), mat=M['dark'], bevel=0.002 if hi else 0))
    # handguard (octagonal, tan) with dark M-LOK slot inserts
    hg = cylinder('handguard', 0.033, 0.033, 0.33, (0, -0.315, 0.09), X(90), mat=M['tan'], segs=8, bevel=0.003 if hi else 0)
    hg.rotation_euler = (math.radians(90), math.radians(22.5), 0)
    parts.append(hg)
    if hi:
        for side in (-1, 1):
            for i in range(5):
                parts.append(box(f'slot{side}{i}', (0.004, 0.032, 0.009), (side * 0.0305, -0.2 - i * 0.052, 0.09), mat=M['dark']))
        for i in range(5):
            parts.append(box(f'slotb{i}', (0.009, 0.032, 0.004), (0, -0.2 - i * 0.052, 0.0595), mat=M['dark']))
        parts.append(box('hgrail', (0.022, 0.32, 0.01), (0, -0.315, 0.126), mat=M['dark']))
    parts.append(cylinder('barrel', 0.0095, 0.0095, 0.2, (0, -0.57, 0.09), X(90), mat=M['metal'], segs=14 if hi else 8))
    parts.append(box('gasblock', (0.021, 0.026, 0.026), (0, -0.5, 0.09), mat=M['dark'], bevel=0.002 if hi else 0))
    parts.append(box('fsight', (0.007, 0.007, 0.05), (0, -0.5, 0.125), mat=M['dark']))
    parts.append(cylinder('brake', 0.0145, 0.0145, 0.058, (0, -0.695, 0.09), X(90), mat=M['dark'], segs=14 if hi else 8, bevel=0.002 if hi else 0))
    if hi:
        for i in range(3):
            parts.append(box(f'brakeslot{i}', (0.031, 0.007, 0.008), (0, -0.682 - i * 0.014, 0.097), mat=M['rubber']))
    # grip and trigger group
    parts.append(box('grip', (0.032, 0.046, 0.11), (0, 0.012, -0.006), X(-19), mat=M['polymer'], bevel=0.008 if hi else 0))
    if hi:
        for i in range(3):
            parts.append(box(f'groove{i}', (0.034, 0.006, 0.008), (0, -0.01 + i * 0.004, 0.02 - i * 0.03), X(-19), mat=M['rubber']))
    parts.append(box('tguard', (0.009, 0.075, 0.006), (0, -0.04, -0.003), mat=M['dark']))
    parts.append(box('tguardf', (0.009, 0.006, 0.04), (0, -0.077, 0.015), mat=M['dark']))
    parts.append(box('trigger', (0.005, 0.007, 0.024), (0, -0.04, 0.014), X(12), mat=M['metal']))
    # stock
    parts.append(cylinder('buffer', 0.0165, 0.0165, 0.18, (0, 0.165, 0.085), X(90), mat=M['dark'], segs=14 if hi else 8))
    parts.append(box('stock', (0.044, 0.15, 0.072), (0, 0.235, 0.072), mat=M['tan'], bevel=0.012 if hi else 0))
    parts.append(box('cheek', (0.04, 0.1, 0.022), (0, 0.225, 0.112), mat=M['tan'], bevel=0.008 if hi else 0))
    parts.append(box('buttpad', (0.047, 0.022, 0.108), (0, 0.31, 0.07), mat=M['rubber'], bevel=0.006 if hi else 0))
    # optic: holographic sight
    parts.append(box('opt_base', (0.036, 0.075, 0.014), (0, -0.035, 0.142), mat=M['dark'], bevel=0.002 if hi else 0))
    parts.append(box('opt_body', (0.04, 0.05, 0.022), (0, -0.015, 0.16), mat=M['dark'], bevel=0.004 if hi else 0))
    parts.append(box('opt_hoodL', (0.006, 0.05, 0.05), (0.02, -0.06, 0.178), mat=M['dark'], bevel=0.002 if hi else 0))
    parts.append(box('opt_hoodR', (0.006, 0.05, 0.05), (-0.02, -0.06, 0.178), mat=M['dark'], bevel=0.002 if hi else 0))
    parts.append(box('opt_hoodT', (0.046, 0.05, 0.006), (0, -0.06, 0.205), mat=M['dark'], bevel=0.002 if hi else 0))
    parts.append(box('opt_lens', (0.034, 0.002, 0.042), (0, -0.07, 0.179), mat=M['lens']))
    if hi:
        parts.append(sphere('opt_dot', 0.0016, (0, -0.0705, 0.181), mat=M['dot'], segs=8, rings=6))
        parts.append(box('rsight', (0.024, 0.012, 0.024), (0, 0.085, 0.147), mat=M['dark'], bevel=0.002))
        parts.append(cylinder('sling', 0.006, 0.006, 0.02, (0.024, 0.28, 0.04), (0, math.radians(90), 0), mat=M['metal'], segs=8))
    if with_mag:
        mag = build_magazine(lod, 'magtmp')
        mag.location = (0, -0.078, -0.017)
        parts.append(mag)
    ob = join(parts, name)
    smooth(ob, 40)
    return ob


def build_magazine(lod=0, name='Magazine'):
    M = mats()
    parts = []
    hi = lod == 0
    for i in range(6):
        a = math.radians(4 + i * 4.2)
        parts.append(box(f'mag{i}', (0.026, 0.068, 0.036), (0, -0.003 - i * 0.0052, -0.016 - i * 0.034), (a, 0, 0), mat=M['polymer'], bevel=0.003 if hi else 0))
    parts.append(box('magbase', (0.03, 0.078, 0.012), (0, -0.036, -0.215), X(25), mat=M['dark'], bevel=0.003 if hi else 0))
    if hi:
        parts.append(box('round', (0.012, 0.05, 0.008), (0, -0.002, 0.004), mat=M['brass']))
    ob = join(parts, name)
    smooth(ob, 40)
    return ob


def build_launcher(lod=0, with_warhead=False, name='Launcher'):
    M = mats()
    hi = lod == 0
    seg = 20 if hi else 10
    tz = 0.2
    parts = []
    parts.append(cylinder('tube', 0.056, 0.056, 1.0, (0, -0.05, tz), X(90), mat=M['olive'], segs=seg))
    parts.append(cylinder('front', 0.066, 0.066, 0.08, (0, -0.53, tz), X(90), mat=M['oliveDark'], segs=seg, bevel=0.004 if hi else 0))
    parts.append(cylinder('rear', 0.085, 0.064, 0.13, (0, 0.5, tz), X(90), mat=M['oliveDark'], segs=seg))
    if hi:
        for i in range(3):
            parts.append(cylinder(f'ring{i}', 0.06, 0.06, 0.018, (0, -0.32 + i * 0.3, tz), X(90), mat=M['oliveDark'], segs=seg))
        parts.append(box('rail', (0.022, 0.2, 0.012), (0, -0.05, tz + 0.06), mat=M['dark']))
    # pistol grip at the origin, trigger housing above
    parts.append(box('grip', (0.034, 0.048, 0.115), (0, 0.012, -0.004), X(-15), mat=M['polymer'], bevel=0.008 if hi else 0))
    parts.append(box('housing', (0.05, 0.12, 0.09), (0, -0.01, 0.1), mat=M['oliveDark'], bevel=0.008 if hi else 0))
    parts.append(box('tguard', (0.009, 0.07, 0.006), (0, -0.045, -0.002), mat=M['dark']))
    parts.append(box('trigger', (0.006, 0.008, 0.024), (0, -0.045, 0.015), mat=M['metal']))
    # forward grip bar at the shared support point
    sx, sy, sz = SUPPORT_POINT
    parts.append(cylinder('fbar', 0.016, 0.016, 0.12, (sx, sy, sz), X(90), mat=M['polymer'], segs=12 if hi else 6))
    parts.append(box('fbracket', (0.03, 0.04, tz - sz), (sx, sy - 0.05, (tz + sz) / 2), mat=M['oliveDark']))
    # shoulder pad and optic
    parts.append(box('pad', (0.05, 0.22, 0.03), (0, 0.24, tz - 0.07), mat=M['rubber'], bevel=0.008 if hi else 0))
    parts.append(box('optic', (0.045, 0.16, 0.055), (0.085, -0.12, tz + 0.03), mat=M['dark'], bevel=0.006 if hi else 0))
    parts.append(box('opticmount', (0.04, 0.04, 0.02), (0.05, -0.12, tz + 0.02), mat=M['dark']))
    if hi:
        parts.append(cylinder('opticlens', 0.02, 0.02, 0.004, (0.085, -0.201, tz + 0.03), X(90), mat=M['lens'], segs=12))
        parts.append(box('sight', (0.008, 0.02, 0.03), (0, -0.45, tz + 0.07), mat=M['dark']))
    if with_warhead:
        parts.append(build_warhead(lod, 'whtmp'))
    ob = join(parts, name)
    smooth(ob, 40)
    return ob


def build_warhead(lod=0, name='Warhead'):
    M = mats()
    seg = 18 if lod == 0 else 8
    tz = 0.2
    parts = [
        cylinder('wbody', 0.05, 0.05, 0.14, (0, -0.62, tz), X(90), mat=M['oliveDark'], segs=seg),
        cylinder('wband', 0.051, 0.051, 0.02, (0, -0.58, tz), X(90), mat=M['red'], segs=seg),
        cylinder('wnose', 0.05, 0.012, 0.2, (0, -0.79, tz), X(90), mat=M['oliveDark'], segs=seg),
        cylinder('wtip', 0.012, 0.004, 0.03, (0, -0.905, tz), X(90), mat=M['metal'], segs=8),
    ]
    ob = join(parts, name)
    smooth(ob, 40)
    return ob


def build_rocket(name='Rocket'):
    M = mats()
    parts = [
        cylinder('rbody', 0.045, 0.045, 0.34, (0, 0, 0), X(90), mat=M['oliveDark'], segs=14),
        cylinder('rband', 0.046, 0.046, 0.02, (0, -0.1, 0), X(90), mat=M['red'], segs=14),
        cylinder('rnose', 0.045, 0.01, 0.18, (0, -0.26, 0), X(90), mat=M['oliveDark'], segs=14),
        cylinder('rnozzle', 0.03, 0.038, 0.05, (0, 0.19, 0), X(90), mat=M['dark'], segs=12),
    ]
    for i in range(4):
        a = i * math.pi / 2
        f = box(f'fin{i}', (0.004, 0.09, 0.07), (math.cos(a) * 0.06, 0.13, math.sin(a) * 0.06), (0, -a, 0), mat=M['dark'])
        parts.append(f)
    ob = join(parts, name)
    smooth(ob, 40)
    return ob


def build_all():
    clear_scene()
    rifle = build_rifle(0, with_mag=False, name='RifleFP')
    mag = build_magazine(0, 'MagazineFP')
    mag.location = (0, -0.078, -0.017)
    launcher = build_launcher(0, with_warhead=False, name='LauncherFP')
    warhead = build_warhead(0, 'WarheadFP')
    rocket = build_rocket('Rocket')
    rocket.location = (0.6, 0, 0)
    out = os.path.join(OUT_MODELS, 'weapons.glb')
    export_glb(out, [rifle, mag, launcher, warhead, rocket])
    save_blend('weapons.blend')
    return out


if __name__ == '__main__':
    build_all()
