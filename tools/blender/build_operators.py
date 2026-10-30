"""The five Breakpoint Zero operators, modelled after the reference sheets in client/assets/character/.

  Viper  - female, black tank crop top, scarf, dark plate carrier, elbow pads, cargo pants, combat boots, ponytail
  Ranger - male, olive field jacket (sleeves rolled) over a grey hoodie and white tee, dog tags, dark cargo
           jeans, grey/orange sneakers, backpack, tousled hair, stubble, earpiece
  Nova   - female, white cropped jacket with red stripes, black crop top, black cargo pants with red straps,
           white/red sneakers, backpack, ponytail
  Ghost  - male, black hoodie, coyote plate carrier, dark trousers, tan boots, full beard, over-ear headset
  Blaze  - male, black/red jacket over a grey hoodie and white tee, black chest rig, sunglasses, black cargo
           pants, red/black sneakers, backpack, tousled hair, stubble

All five share one skeleton and one set of animations (the rig, poser and clips from build_characters.py).
For speed in the browser every operator is merged into ONE skinned mesh whose colours are baked into vertex
colours, plus a tiny shoulder patch that the game tints with the player's colour: 2 draw calls per player
instead of ~40.

Exports:
  client/assets/models/operators.glb  (skeleton, 5 operator meshes, Rifle3P, Launcher3P, animations)
  client/assets/models/fp_arms.glb    (first-person gloved hands in rifle space + EyeFP marker)
"""
import bpy
import bmesh
import math
import os
import random
from mathutils import Vector, Matrix, Quaternion

from bpz_common import (log, log_exc, clear_scene, link, material, box, cylinder, sphere, join, smooth,
                        apply_modifiers, export_glb, save_blend, new_object, OUT_MODELS)
import build_characters as C
import build_weapons as W

# ------------------------------------------------------------------ operator definitions (sRGB colours)

OPERATORS = [
    dict(name='Viper', fem=True, face=0, skin=0x9a6d5e, hair=0x2b1d15, lips=0xa8645e, iris=0x5a3a22,
         hairstyle='ponytail', facial=None, eyes=None, headset='earpiece',
         top=0x1d1d20, arms='skin', crop=1.13, pants=0x2f2d2a, pants_hi=1.03, belt=0x5b4632,
         jacket=None, hoodie=None, hood=None, scarf=0x34322e, vest=dict(color=0x3b3329, strap=0x2a2622, fem=True),
         pack=None, elbow=0x1f1e1d, wraps=0x2a2826, knee=0x22211f, gloves=0x1c1b1a, fingerless=True,
         feet=dict(kind='boots', upper=0x2e271f, sole=0x8c867c, lace=0x1c1a18), tags=False,
         thigh=0x3b3329, accent=None),
    dict(name='Ranger', fem=False, face=1, skin=0x8b5c4f, hair=0x2e2018, lips=0x9a5e52, iris=0x4a3020,
         hairstyle='tousled', facial='stubble', eyes=None, headset='earpiece',
         top=0xcdc9c1, arms='top', crop=None, pants=0x2e3036, pants_hi=1.05, belt=0x3d342a,
         jacket=dict(color=0x5b5d3e, sleeve=0.47, open=0.075, bottom=0.99, cuff=0xc8c4bb, panels=None),
         hoodie=None, hood=0xb7b4ae, scarf=None, vest=None,
         pack=dict(color=0x3e3f2c, strap=0x26261f, accent=0xe2622a), elbow=None, wraps=None, knee=0x26251f,
         gloves=0x22201d, fingerless=True,
         feet=dict(kind='sneakers', upper=0xd2d1cc, sole=0xe9e7e2, accent=0xe2622a), tags=True,
         thigh=0x3e3f2c, accent=0xe2622a),
    dict(name='Nova', fem=True, face=2, skin=0xa87262, hair=0x2a1b13, lips=0xb2625e, iris=0x5a3c24,
         hairstyle='ponytail', facial=None, eyes=None, headset='earpiece',
         top=0x1c1c1f, arms='skin', crop=1.15, pants=0x242427, pants_hi=1.03, belt=0x2b2a28,
         jacket=dict(color=0xdcd9d3, sleeve=0.535, open=0.1, bottom=1.25, cuff=0x2a2a2c, panels='stripes',
                     stripe=0xc8313a),
         hoodie=None, hood=0xc9c6c0, scarf=None, vest=None,
         pack=dict(color=0x1f1f22, strap=0x1a1a1c, accent=0xc8313a), elbow=None, wraps=None, knee=0x1e1e20,
         gloves=0x1c1c1d, fingerless=True,
         feet=dict(kind='sneakers', upper=0xe6e4e0, sole=0xf2f0ec, accent=0xc8313a), tags=False,
         thigh=0xc8313a, accent=0xc8313a),
    dict(name='Ghost', fem=False, face=3, skin=0x9a6759, hair=0x221812, lips=0x93584c, iris=0x3e2a1a,
         hairstyle='short', facial='beard', eyes=None, headset='overear',
         top=0x222327, arms='top', crop=None, pants=0x2c2d30, pants_hi=1.05, belt=0x6b5a40,
         jacket=None, hoodie=dict(color=0x222327, sleeve=0.535), hood=0x222327, scarf=None,
         vest=dict(color=0x6f5b3f, strap=0x574833, fem=False, radio=True),
         pack=None, elbow=None, wraps=None, knee=0x2a2826, gloves=0x1d1c1b, fingerless=False,
         feet=dict(kind='boots', upper=0x9a7f5c, sole=0x5a4c3c, lace=0x6b5a44), tags=False,
         thigh=0x6f5b3f, accent=None),
    dict(name='Blaze', fem=False, face=4, skin=0x7c4e41, hair=0x241913, lips=0x9a5c50, iris=0x3e2a1c,
         hairstyle='tousled', facial='stubble', eyes='shades', headset='earpiece',
         top=0xd6d3cc, arms='top', crop=None, pants=0x1f1f22, pants_hi=1.05, belt=0x232224,
         jacket=dict(color=0x1e1e21, sleeve=0.47, open=0.075, bottom=0.99, cuff=0xbab7b1, panels='yoke',
                     red=0xb3262d),
         hoodie=None, hood=0xbab7b1, scarf=None,
         vest=dict(color=0x1f1f21, strap=0xb3262d, rig=True),
         pack=dict(color=0x1f1f21, strap=0x1a1a1b, accent=0xb3262d), elbow=None, wraps=None, knee=0x1f1f21,
         gloves=0x1d1d1e, fingerless=True,
         feet=dict(kind='sneakers', upper=0x1e1e21, sole=0xeeece8, accent=0xc22a30), tags=True,
         thigh=0xb3262d, accent=0xb3262d),
]

# fabric grain strength per material role (vertex colour noise)
DECIMATE = 0.8
GRAIN = {'skin': 0.035, 'hair': 0.16, 'cloth': 0.11, 'gear': 0.09, 'shoe': 0.07, 'metal': 0.05, 'eye': 0.0}


def mat(tag, part, color, role='cloth', rough=0.8, metal=0.0):
    m = material(f'{tag}_{part}', color, rough=rough, metal=metal)
    m['grain'] = GRAIN.get(role, 0.08)
    m['role'] = role
    return m


# ------------------------------------------------------------------ helpers

def face_dominant(dominant, f):
    doms = [dominant[v.index] for v in f.verts]
    return max(set(doms), key=doms.count)


def is_arm(d):
    return d.startswith('UpperArm') or d.startswith('LowerArm') or d.startswith('Hand')


def is_leg(d):
    return d.startswith('UpperLeg') or d.startswith('LowerLeg') or d.startswith('Foot')


def is_torso(d):
    return d in ('Hips', 'Spine', 'Chest', 'UpperChest') or d.startswith('Shoulder')


def place_along(a, b, t):
    return Vector(a).lerp(Vector(b), t)


def orient_z(ob, direction):
    ob.rotation_mode = 'QUATERNION'
    ob.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(Vector(direction).normalized())
    return ob


ARM = {  # rest positions (left side, mirror x for right)
    'sh': Vector((0.19, 0.012, 1.42)), 'el': Vector((0.385, 0.02, 1.245)), 'wr': Vector((0.545, 0.03, 1.085)),
}


def arm_pt(key, sx):
    p = ARM[key]
    return Vector((p.x * sx, p.y, p.z))


def lower_arm_ring(name, t, r1, r2, depth, m, sx):
    a, b = arm_pt('el', sx), arm_pt('wr', sx)
    ob = cylinder(name, r1, r2, depth, place_along(a, b, t), mat=m, segs=16, bevel=0.004)
    return orient_z(ob, b - a)


# ------------------------------------------------------------------ body / head

def build_body(spec, mats):
    """Skin-modifier base mesh; female figures get narrower shoulders and waist, wider hips and a bust."""
    fem = spec['fem']
    verts, edges, radius = [], [], []

    def V(p, r):
        verts.append(p)
        radius.append(r)
        return len(verts) - 1

    R = (dict(pel=0.136, waist=0.108, chest=0.133, upch=0.14, nb=0.068, nt=0.061, cl=0.064, sh=0.055, bi=0.042,
              el=0.036, fa=0.037, wr=0.028, hpx=0.096, hp=0.1, th=0.082, kn=0.054, ca=0.055, an=0.037)
         if fem else
         dict(pel=0.14, waist=0.128, chest=0.15, upch=0.158, nb=0.08, nt=0.07, cl=0.072, sh=0.064, bi=0.05,
              el=0.041, fa=0.043, wr=0.031, hpx=0.09, hp=0.095, th=0.081, kn=0.057, ca=0.06, an=0.041))
    pel = V((0, 0.01, 0.93), R['pel'])
    waist = V((0, 0.012, 1.06), R['waist'])
    chest = V((0, 0.0, 1.22), R['chest'])
    upch = V((0, 0.0, 1.36), R['upch'])
    nb = V((0, 0.012, 1.47), R['nb'])
    nt = V((0, 0.012, 1.60), R['nt'])
    edges += [(pel, waist), (waist, chest), (chest, upch), (upch, nb), (nb, nt)]
    for sx in (1, -1):
        cl = V((0.09 * sx, 0.01, 1.43), R['cl'])
        sh = V((0.19 * sx, 0.012, 1.42), R['sh'])
        bi = V((0.29 * sx, 0.016, 1.33), R['bi'])
        el = V((0.385 * sx, 0.02, 1.245), R['el'])
        fa = V((0.455 * sx, 0.025, 1.17), R['fa'])
        wr = V((0.545 * sx, 0.03, 1.085), R['wr'])
        edges += [(upch, cl), (cl, sh), (sh, bi), (bi, el), (el, fa), (fa, wr)]
        hp = V((R['hpx'] * sx, 0.01, 0.88), R['hp'])
        th = V((0.098 * sx, 0.004, 0.70), R['th'])
        kn = V((0.103 * sx, -0.005, 0.50), R['kn'])
        ca = V((0.108 * sx, 0.012, 0.33), R['ca'])
        an = V((0.113 * sx, 0.015, 0.11), R['an'])
        edges += [(pel, hp), (hp, th), (th, kn), (kn, ca), (ca, an)]
    me = bpy.data.meshes.new('BodyBase')
    me.from_pydata(verts, edges, [])
    me.update()
    ob = new_object(f"{spec['name']}_Body", me)
    mod = ob.modifiers.new('Skin', 'SKIN')
    if len(me.skin_vertices) == 0:
        me.skin_vertices.new()
    sv = me.skin_vertices[0].data
    for i, r in enumerate(radius):
        sv[i].radius = (r, r)
        sv[i].use_root = (i == pel)
    try:
        mod.use_smooth_shade = True
        mod.branch_smoothing = 0.5
    except Exception:
        pass
    sub = ob.modifiers.new('Sub', 'SUBSURF')
    sub.levels = 2
    sub.render_levels = 2
    apply_modifiers(ob)
    g = lambda d2, s: math.exp(-d2 / s)
    for v in ob.data.vertices:
        x, y, z = v.co
        if 0.84 < z < 1.5 and abs(x) < 0.22:
            k = 1.0 if z < 1.44 else max(0.0, 1 - (z - 1.44) / 0.06)
            yc = 0.008
            v.co.y = yc + (y - yc) * (1 - 0.28 * k)
            if not fem and 1.24 < z < 1.42 and y < -0.02 and abs(x) < 0.15:
                v.co.y -= 0.012 * math.sin((z - 1.24) / 0.18 * math.pi)
            if 0.84 < z < 0.97 and y > 0.03:
                v.co.y += (0.026 if fem else 0.018) * math.sin((z - 0.84) / 0.13 * math.pi)
        if fem and y < -0.01 and 1.18 < z < 1.4:
            for sx in (1, -1):
                v.co.y -= 0.034 * g((x - 0.072 * sx) ** 2 + (z - 1.285) ** 2, 0.0032)
        if 1.36 < z < 1.48 and 0.12 < abs(x) < 0.24:
            v.co.z += 0.012
    smooth(ob, 180)
    for m in mats:
        ob.data.materials.append(m)
    return ob


def build_head(spec, M, Hhead):
    fem = spec['fem']
    base = Vector(Hhead)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=30, radius=1.0)
    g = lambda d2, s: math.exp(-d2 / s)
    sxw = 0.069 if fem else 0.074
    for v in bm.verts:
        u, w, h = v.co.x, -v.co.y, v.co.z
        x, y, z = u * sxw, -w * (0.092 if fem else 0.096), h * (0.11 if fem else 0.115)
        if h < -0.15:
            t = min(1.0, (-0.15 - h) / 0.85)
            x *= 1 - (0.3 if fem else 0.24) * t
            if w > 0:
                y -= 0.012 * t * w
        if w < 0 and h > -0.2:
            y += 0.006 * (-w)
        if w > 0.5:
            ns = 0.75 if fem else 1.0
            nose = 0.024 * ns * g(u * u, 0.012) * g((h + 0.04) ** 2, 0.02) * (h < 0.12)
            tip = 0.01 * ns * g(u * u, 0.006) * g((h + 0.17) ** 2, 0.004)
            y -= nose + tip
            y -= (0.004 if fem else 0.007) * g((h - 0.26) ** 2, 0.006) * g(u * u, 0.25)
            for ex in (-0.4, 0.4):
                y += 0.009 * g((u - ex) ** 2, 0.02) * g((h - 0.15) ** 2, 0.008)
            cheek = (0.006 if fem else 0.004) * (g((abs(u) - 0.55) ** 2, 0.03) * g(h * h, 0.02))
            x += cheek * (1 if u > 0 else -1)
            y += 0.003 * g(u * u, 0.03) * g((h + 0.36) ** 2, 0.0015)
            y -= (0.006 if fem else 0.004) * g(u * u, 0.05) * g((h + 0.42) ** 2, 0.003)
            y -= 0.006 * g(u * u, 0.05) * g((h + 0.62) ** 2, 0.01)
        v.co = Vector((x, y, z))
    me = bpy.data.meshes.new('Head')
    bm.to_mesh(me)
    bm.free()
    ob = new_object(f"{spec['name']}_Head", me)
    me.materials.append(M['skin'])
    me.materials.append(M['lips'])
    photo = spec.get('face') is not None
    if photo:
        me.materials.append(M['face'])
    for poly in me.polygons:
        c = poly.center
        if photo:
            # front of the head carries the face photographed from the reference sheet (faces.png)
            if c.y < -0.012:
                poly.material_index = 2
        elif c.y < -0.066 and abs(c.x) < (0.021 if fem else 0.022) and -0.05 < c.z < -0.036:
            poly.material_index = 1
    ob.location = base + Vector((0, -0.005, 0.105))
    smooth(ob, 180)
    parts = [ob]
    hc = ob.location.copy()
    for sx in (1, -1):
        if photo:
            parts.append(sphere(f'ear{sx}', 1.0, hc + Vector(((0.069 if fem else 0.074) * sx, 0.006, 0.0)), (0.011, 0.023, 0.031), mat=M['skin'], segs=12, rings=10))
            continue
        ex = 0.03 if fem else 0.032
        parts.append(sphere(f'eye{sx}', 0.0122, hc + Vector((ex * sx, -0.068 if fem else -0.0705, 0.017)), mat=M['eyewhite'], segs=16, rings=12))
        parts.append(cylinder(f'iris{sx}', 0.0072, 0.0072, 0.002, hc + Vector((ex * sx, -0.0795 if fem else -0.0815, 0.017)), (math.radians(90), 0, 0), mat=M['iris'], segs=14))
        parts.append(cylinder(f'pupil{sx}', 0.003, 0.003, 0.002, hc + Vector((ex * sx, -0.0803 if fem else -0.0823, 0.017)), (math.radians(90), 0, 0), mat=M['pupil'], segs=10))
        parts.append(box(f'brow{sx}', (0.03, 0.007, 0.004 if fem else 0.006), hc + Vector((0.034 * sx, -0.078 if fem else -0.081, 0.036)), (0, 0.14 * sx, 0), mat=M['hair'], bevel=0.002))
        parts.append(sphere(f'ear{sx}', 1.0, hc + Vector(((0.069 if fem else 0.074) * sx, 0.006, 0.0)), (0.011, 0.023, 0.031), mat=M['skin'], segs=12, rings=10))
    head = join(parts, f"{spec['name']}_Head")
    smooth(head, 50)
    return head, hc


def shell(name, hc, scale, keep, m, noise=0.0, seed=1, fem=False, thickness=0.004):
    rnd = random.Random(seed)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=36, v_segments=26, radius=1.0)
    kill = [v for v in bm.verts if not keep(v.co.x, -v.co.y, v.co.z)]
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    sx, sy, sz = (0.069, 0.092, 0.11) if fem else (0.074, 0.096, 0.115)
    for v in bm.verts:
        n = 1 + noise * (rnd.random() - 0.5)
        v.co = Vector((v.co.x * sx * scale[0] * n, v.co.y * sy * scale[1] * n, v.co.z * sz * scale[2] * n))
    bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=thickness)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = new_object(name, me)
    me.materials.append(m)
    ob.location = hc
    smooth(ob, 180)
    return ob


def beard_keep(u, w, h):
    return w > 0.05 and -0.95 < h < -0.1 and not (abs(u) < 0.3 and -0.46 < h < -0.3) and abs(u) < 0.95


def build_hair(spec, M, hc):
    fem = spec['fem']
    style = spec['hairstyle']
    tag = spec['name']
    parts = []
    if style == 'ponytail':
        parts.append(shell(f'{tag}_hairshell', hc, (1.1, 1.12, 1.08),
                           lambda u, w, h: (h > 0.36 - 0.08 * abs(u)) if w > 0.25 else (h > 0.05 or (abs(u) > 0.8 and h > -0.2 and w < 0.15) or (w < -0.3 and h > -0.45)),
                           M['hair'], noise=0.012, seed=5, fem=True))
        # tie + tail sweeping down the back
        tie = hc + Vector((0, 0.085, 0.055))
        parts.append(cylinder(f'{tag}_tie', 0.02, 0.02, 0.02, tie, mat=M['hair_tie'], segs=12))
        orient_z(parts[-1], (0, 1, 0.3))
        pts = [tie + Vector(d) for d in ((0, 0.012, 0.0), (0, 0.05, -0.04), (0, 0.07, -0.12), (0, 0.065, -0.21), (0, 0.05, -0.29))]
        rads = (0.03, 0.034, 0.03, 0.022, 0.012)
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            seg = cylinder(f'{tag}_tail{i}', rads[i], rads[i + 1], (b - a).length + 0.02, (a + b) / 2, mat=M['hair'], segs=12)
            orient_z(seg, b - a)
            parts.append(seg)
        # side-swept bangs
        bang = sphere(f'{tag}_bangs', 1.0, hc + Vector((0.022, -0.074, 0.07)), (0.045, 0.018, 0.022), mat=M['hair'], segs=12, rings=8)
        bang.rotation_euler = (0.35, 0.0, -0.35)
        parts.append(bang)
    elif style == 'tousled':
        parts.append(shell(f'{tag}_hairshell', hc + Vector((0, 0, 0.006)), (1.14, 1.15, 1.1), C.hairline, M['hair'], noise=0.035, seed=7))
        rnd = random.Random(11 + len(tag))
        for i in range(7):
            a = rnd.uniform(-2.2, 2.2)
            r = rnd.uniform(0.015, 0.05)
            p = hc + Vector((math.sin(a) * r * 1.1, -math.cos(a) * r - 0.025, 0.103 + rnd.uniform(-0.006, 0.004)))
            t = sphere(f'{tag}_tuft{i}', 1.0, p, (0.03, 0.05, 0.012), mat=M['hair'], segs=10, rings=8)
            t.rotation_euler = (rnd.uniform(-0.35, 0.1), rnd.uniform(-0.25, 0.25), a)
            parts.append(t)
        fr = sphere(f'{tag}_fringe', 1.0, hc + Vector((0.01, -0.082, 0.085)), (0.05, 0.02, 0.022), mat=M['hair'], segs=12, rings=8)
        fr.rotation_euler = (0.5, 0, 0.2)
        parts.append(fr)
    else:  # short
        parts.append(shell(f'{tag}_hairshell', hc, (1.09, 1.11, 1.06), C.hairline, M['hair'], noise=0.01, seed=2))
    if spec.get('face') is not None:
        pass  # beard / stubble are part of the face photo
    elif spec['facial'] == 'beard':
        parts.append(shell(f'{tag}_beard', hc, (1.07, 1.06, 1.04), beard_keep, M['hair'], noise=0.02, seed=4))
        parts.append(shell(f'{tag}_moustache', hc, (1.06, 1.05, 1.03), lambda u, w, h: w > 0.6 and abs(u) < 0.36 and -0.36 < h < -0.27, M['hair'], noise=0.0, seed=6))
    elif spec['facial'] == 'stubble':
        parts.append(shell(f'{tag}_stubble', hc, (1.02, 1.02, 1.015), lambda u, w, h: beard_keep(u, w, h) or (w > 0.6 and abs(u) < 0.36 and -0.36 < h < -0.27), M['stubble'], noise=0.0, seed=4, thickness=0.0015))
    return parts


def build_face_gear(spec, M, hc):
    parts = []
    fem = spec['fem']
    if spec['eyes'] == 'shades':
        for sx in (1, -1):
            parts.append(box(f'lens{sx}', (0.036, 0.006, 0.024), hc + Vector((0.032 * sx, -0.09, 0.017)), (0, 0, 0.12 * sx), mat=M['shades'], bevel=0.004))
            parts.append(box(f'temple{sx}', (0.004, 0.085, 0.006), hc + Vector((0.071 * sx, -0.045, 0.024)), mat=M['metal'], bevel=0.001))
        parts.append(box('bridge', (0.016, 0.004, 0.005), hc + Vector((0, -0.094, 0.026)), mat=M['metal']))
    ex = 0.069 if fem else 0.074
    if spec['headset'] == 'earpiece':
        parts.append(cylinder('earpiece', 0.015, 0.013, 0.014, hc + Vector((-ex - 0.006, 0.004, 0.0)), (0, math.radians(90), 0), mat=M['metal'], segs=12))
        a = hc + Vector((-ex - 0.004, -0.004, -0.012))
        b = hc + Vector((-0.025, -0.085, -0.05))
        boom = cylinder('mic', 0.0025, 0.0025, (b - a).length, (a + b) / 2, mat=M['metal'], segs=6)
        parts.append(orient_z(boom, b - a))
        parts.append(sphere('micball', 0.006, b, mat=M['metal'], segs=8, rings=6))
    elif spec['headset'] == 'overear':
        for sx in (1, -1):
            parts.append(cylinder(f'cup{sx}', 0.04, 0.04, 0.034, hc + Vector(((ex + 0.016) * sx, 0.006, 0.0)), (0, math.radians(90), 0), mat=M['metal'], segs=18, bevel=0.006))
            parts.append(cylinder(f'pad{sx}', 0.032, 0.032, 0.012, hc + Vector(((ex + 0.002) * sx, 0.006, 0.0)), (0, math.radians(90), 0), mat=M['rubber'], segs=16))
        # headband arc over the crown
        n = 9
        for i in range(n):
            a0 = math.pi * i / n
            a1 = math.pi * (i + 1) / n
            r = ex + 0.024
            p0 = hc + Vector((math.cos(a0) * r, 0.006, math.sin(a0) * 0.135))
            p1 = hc + Vector((math.cos(a1) * r, 0.006, math.sin(a1) * 0.135))
            seg = box(f'band{i}', (0.026, 0.012, (p1 - p0).length + 0.004), (p0 + p1) / 2, mat=M['metal'], bevel=0.003)
            orient_z(seg, p1 - p0)
            parts.append(seg)
        a = hc + Vector((-(ex + 0.02), -0.015, -0.02))
        b = hc + Vector((-0.03, -0.09, -0.055))
        boom = cylinder('mic', 0.003, 0.003, (b - a).length, (a + b) / 2, mat=M['metal'], segs=6)
        parts.append(orient_z(boom, b - a))
        parts.append(sphere('micball', 0.008, b, mat=M['rubber'], segs=8, rings=6))
    return parts


# ------------------------------------------------------------------ clothing

def paint_body(body, dominant, spec, M):
    """Base layer: skin / top / pants by body region."""
    idx = {m.name: i for i, m in enumerate(body.data.materials)}
    crop = spec['crop']
    for poly in body.data.polygons:
        doms = [dominant[i] for i in poly.vertices]
        d = max(set(doms), key=doms.count)
        c = poly.center
        if d in ('Neck', 'Head') or c.z > 1.5:
            name = M['skin'].name
        elif is_leg(d) or (d == 'Hips' and c.z < spec['pants_hi']):
            name = M['pants'].name
        elif is_arm(d):
            name = M['skin'].name if spec['arms'] == 'skin' else M['top'].name
            if spec['arms'] == 'top' and abs(c.x) > 0.5:
                name = M['skin'].name  # forearm below the sleeve
        elif d.startswith('Shoulder'):
            name = M['top'].name if (spec['arms'] != 'skin' or abs(c.x) < 0.13) else M['skin'].name
        else:
            name = M['top'].name
            if crop and c.z < crop:
                name = M['skin'].name
        poly.material_index = idx[name]


def garment(src, dominant, name, keep, offset, m, thickness=0.005, paint=None):
    """Copy the body faces selected by keep(center, dominant_bone, normal), push them out along the normals and
    give them thickness. The copy keeps the body's vertex groups and armature, so it deforms with it."""
    ob = src.copy()
    ob.data = src.data.copy()
    ob.name = name
    link(ob)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.faces.ensure_lookup_table()
    bm.verts.ensure_lookup_table()
    kill = []
    for f in bm.faces:
        d = face_dominant(dominant, f)
        if not keep(f.calc_center_median(), d, f.normal):
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * offset
    mats = [m] + ([p[0] for p in paint] if paint else [])
    if paint:
        for f in bm.faces:
            f.material_index = 0
            c, n = f.calc_center_median(), f.normal
            for i, (pm, rule) in enumerate(paint):
                if rule(c, n):
                    f.material_index = i + 1
    else:
        for f in bm.faces:
            f.material_index = 0
    res = bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=thickness)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.materials.clear()
    for mm in mats:
        ob.data.materials.append(mm)
    smooth(ob, 180)
    return ob


def arm_outward(c, sx):
    """Unit direction from the arm axis to point c, and the arm's 'top/outer' direction (A-pose)."""
    a, b = arm_pt('sh', sx), arm_pt('wr', sx)
    ax = (b - a).normalized()
    t = (c - a).dot(ax)
    r = c - (a + ax * t)
    if r.length < 1e-6:
        return 0.0
    outer = Vector((0.68 * sx, 0, 0.73)).normalized()
    return r.normalized().dot(outer)


def build_clothes(spec, M, body, dominant, covers):
    """covers collects predicates for body faces hidden under a garment (deleted later to save triangles)."""
    out = []
    fem = spec['fem']
    lo_pants = 0.15 if spec['feet']['kind'] == 'sneakers' else 0.2
    # cargo trousers: baggy layer over the legs
    keep_p = lambda c, d, n: (is_leg(d) or (d == 'Hips' and c.z < spec['pants_hi'])) and c.z > lo_pants
    out.append(garment(body, dominant, f"{spec['name']}_pants", keep_p, 0.011, M['pants'], thickness=0.004))
    covers.append(lambda c, d, n: keep_p(c, d, n) and c.z > lo_pants + 0.03 and c.z < spec['pants_hi'] - 0.03)
    J = spec['jacket']
    if J:
        open_w, sl, bottom = J['open'], J['sleeve'], J['bottom']

        def keep_j(c, d, n):
            if is_arm(d):
                return abs(c.x) < sl
            if d in ('Neck', 'Head') or c.z > 1.49:
                return False
            if is_leg(d) or c.z < bottom:
                return False
            if c.y < -0.02 and abs(c.x) < open_w and c.z < 1.46:
                return False  # open front
            return True
        paint = None
        if J.get('panels') == 'stripes':
            paint = [(M['jacket_red'], lambda c, n: abs(c.x) > 0.17 and arm_outward(c, 1 if c.x > 0 else -1) > 0.82)]
        elif J.get('panels') == 'yoke':
            paint = [(M['jacket_red'], lambda c, n: (abs(c.x) > 0.19 and abs(c.x) < 0.4) or (c.z > 1.37 and abs(c.x) < 0.2 and c.y > -0.04))]
        out.append(garment(body, dominant, f"{spec['name']}_jacket", keep_j, 0.017, M['jacket'], thickness=0.006, paint=paint))
        covers.append(lambda c, d, n: keep_j(c, d, n) and (abs(c.x) < sl - 0.03 if is_arm(d) else (c.z > bottom + 0.03 and c.z < 1.44 and not (c.y < -0.02 and abs(c.x) < open_w + 0.03))))
        # rolled cuffs / cuff bands where the sleeve ends
        for sx in (1, -1):
            t = (sl - 0.385) / (0.545 - 0.385)
            out.append(lower_arm_ring(f'cuff{sx}', max(0.05, min(0.95, t)), 0.054 if not fem else 0.047, 0.052 if not fem else 0.045, 0.03, M['cuff'], sx))
        # collar
        col = cylinder('jcollar', 0.098 if not fem else 0.088, 0.088 if not fem else 0.079, 0.05, (0, 0.016, 1.475), mat=M['jacket'], segs=20, bevel=0.006)
        out.append(col)
    H = spec['hoodie']
    if H:
        keep_h = lambda c, d, n: (abs(c.x) < H['sleeve']) if is_arm(d) else (not (d in ('Neck', 'Head') or c.z > 1.49) and not is_leg(d) and c.z > 0.97)
        out.append(garment(body, dominant, f"{spec['name']}_hoodie", keep_h, 0.012, M['hoodie'], thickness=0.005))
        covers.append(lambda c, d, n: keep_h(c, d, n) and (abs(c.x) < H['sleeve'] - 0.03 if is_arm(d) else (1.0 < c.z < 1.44)))
        out.append(box('pocket', (0.17, 0.016, 0.085), (0, -0.099, 1.04), mat=M['hoodie'], bevel=0.008))
        for sx in (1, -1):
            out.append(cylinder(f'string{sx}', 0.0025, 0.0025, 0.12, (0.03 * sx, -0.12, 1.39), mat=M['cuff'], segs=6))
    if spec['hood']:
        out.append(sphere('hood', 1.0, (0, 0.085, 1.475), (0.12, 0.068, 0.07), mat=M['hood'], segs=20, rings=12))
        out.append(cylinder('hoodring', 0.092 if not fem else 0.083, 0.082 if not fem else 0.075, 0.06, (0, 0.012, 1.495), mat=M['hood'], segs=20, bevel=0.01))
    if spec['scarf']:
        out.append(cylinder('scarf', 0.083, 0.072, 0.075, (0, 0.012, 1.49), mat=M['scarf'], segs=20, bevel=0.012))
        out.append(sphere('scarfknot', 1.0, (0, -0.068, 1.445), (0.065, 0.035, 0.05), mat=M['scarf'], segs=14, rings=10))
    # jogger cuffs over sneakers
    if spec['feet']['kind'] == 'sneakers':
        for sx in (1, -1):
            r = cylinder(f'ankle{sx}', 0.052, 0.05, 0.04, (0.111 * sx, 0.014, 0.17), mat=M['pants'], segs=16, bevel=0.006)
            out.append(r)
    return out


def build_vest(spec, M):
    V = spec['vest']
    if not V:
        return []
    fem = V.get('fem', False)
    parts = []
    if V.get('rig'):
        # chest rig: low panel with pouches and X straps
        parts.append(box('rigpanel', (0.27, 0.045, 0.14), (0, -0.128, 1.19), mat=M['vest'], bevel=0.012))
        for i, px in enumerate((-0.085, 0.0, 0.085)):
            parts.append(box(f'rp{i}', (0.07, 0.04, 0.1), (px, -0.158, 1.18), mat=M['vest'], bevel=0.008))
            parts.append(box(f'rf{i}', (0.072, 0.045, 0.022), (px, -0.16, 1.235), mat=M['vest_strap'], bevel=0.005))
        for sx in (1, -1):
            s = box(f'rstrap{sx}', (0.035, 0.012, 0.36), (0.075 * sx, -0.135, 1.36), (0, -0.33 * sx, 0), mat=M['vest_strap'], bevel=0.003)
            parts.append(s)
            parts.append(box(f'rover{sx}', (0.035, 0.25, 0.012), (0.1 * sx, 0.01, 1.468), mat=M['vest_strap'], bevel=0.003))
        return parts
    fy = -0.15 if fem else -0.118
    fz = 1.27 if fem else 1.25
    w = 0.26 if fem else 0.31
    parts.append(box('front', (w, 0.05, 0.28 if fem else 0.32), (0, fy, fz), mat=M['vest'], bevel=0.02))
    parts.append(box('back', (w, 0.05, 0.32), (0, 0.13 if not fem else 0.125, 1.26), mat=M['vest'], bevel=0.02))
    for sx in (1, -1):
        parts.append(box(f'cumm{sx}', (0.035, 0.22, 0.16), ((0.145 if fem else 0.16) * sx, 0.0, 1.17), mat=M['vest'], bevel=0.012))
        parts.append(box(f'strap{sx}', (0.065, 0.28, 0.025), ((0.09 if fem else 0.1) * sx, 0.0, 1.462), mat=M['vest_strap'], bevel=0.008))
    for i, px in enumerate((-0.085, 0.0, 0.085)):
        parts.append(box(f'magp{i}', (0.07, 0.045, 0.11), (px, fy - 0.04, fz - 0.09), mat=M['vest'], bevel=0.008))
        parts.append(box(f'magflap{i}', (0.072, 0.05, 0.024), (px, fy - 0.042, fz - 0.03), mat=M['vest_strap'], bevel=0.006))
    parts.append(box('admin', (0.13, 0.03, 0.07), (0, fy - 0.035, fz + 0.07), mat=M['vest_strap'], bevel=0.006))
    if V.get('radio'):
        parts.append(box('radio', (0.06, 0.05, 0.13), (0.17, 0.06, 1.25), mat=M['vest_strap'], bevel=0.008))
        parts.append(cylinder('antenna', 0.004, 0.003, 0.22, (0.18, 0.08, 1.42), mat=M['metal'], segs=6))
    # back panel pouch
    parts.append(box('backpouch', (0.2, 0.05, 0.2), (0, 0.17 if not fem else 0.165, 1.27), mat=M['vest_strap'], bevel=0.012))
    return parts


def build_pack(spec, M):
    P = spec['pack']
    if not P:
        return []
    fem = spec['fem']
    by = 0.2 if not fem else 0.19
    parts = [box('pack', (0.26, 0.12, 0.31), (0, by, 1.26), mat=M['pack'], bevel=0.025),
             box('packtop', (0.24, 0.12, 0.05), (0, by - 0.004, 1.43), mat=M['pack_strap'], bevel=0.015),
             box('packpocket', (0.2, 0.05, 0.14), (0, by + 0.075, 1.2), mat=M['pack'], bevel=0.015)]
    for sx in (1, -1):
        parts.append(box(f'packside{sx}', (0.04, 0.09, 0.16), (0.145 * sx, by, 1.22), mat=M['pack_strap'], bevel=0.01))
        fy = -0.138 if not fem else -0.128
        parts.append(box(f'pstrapf{sx}', (0.045, 0.014, 0.27), (0.095 * sx, fy, 1.31), (0, 0.06 * sx, 0), mat=M['pack_strap'], bevel=0.004))
        parts.append(box(f'pstrapo{sx}', (0.045, 0.26, 0.014), (0.1 * sx, 0.03, 1.47), mat=M['pack_strap'], bevel=0.004))
        parts.append(box(f'paccent{sx}', (0.012, 0.016, 0.07), (0.115 * sx, fy - 0.006, 1.28), mat=M['accent'], bevel=0.002))
    parts.append(box('sternum', (0.15, 0.014, 0.02), (0, -0.144 if not fem else -0.152, 1.3), mat=M['pack_strap'], bevel=0.003))
    return parts


def build_lower_gear(spec, M):
    fem = spec['fem']
    parts = []
    belt = cylinder('belt', 0.165 if not fem else 0.158, 0.16 if not fem else 0.153, 0.05, (0, 0.012, 0.99 if fem else 0.97), mat=M['belt'], segs=24)
    belt.scale = (1.0, 0.8, 1.0)
    parts.append(belt)
    parts.append(box('buckle', (0.05, 0.012, 0.04), (0, -0.125 if not fem else -0.122, 0.99 if fem else 0.97), mat=M['metal'], bevel=0.003))
    for i, ang in enumerate((-2.1, 2.1, 2.9)):
        x, y = math.sin(ang) * 0.17, -math.cos(ang) * 0.135
        parts.append(box(f'bpouch{i}', (0.06, 0.042, 0.07), (x, y + 0.012, 0.95), (0, 0, -ang), mat=M['thigh'], bevel=0.006))
    # thigh: drop pouch on the right, strap(s)
    parts.append(box('thighpouch', (0.05, 0.1, 0.13), (-0.185, 0.0, 0.78), mat=M['thigh'], bevel=0.012))
    parts.append(cylinder('legstrap', 0.1, 0.098, 0.024, (-0.1, 0.004, 0.75), mat=M['thigh'], segs=20))
    if spec['accent']:
        parts.append(cylinder('legstrap2', 0.097, 0.095, 0.022, (0.1, 0.004, 0.66), mat=M['accent'], segs=20))
    for s, sx in (('L', 1), ('R', -1)):
        parts.append(box(f'kneepad{s}', (0.095, 0.045, 0.11), (0.104 * sx, -0.084, 0.5), mat=M['knee'], bevel=0.022))
    return parts


def build_arm_gear(spec, M):
    parts = []
    for sx in (1, -1):
        if spec['elbow']:
            p = arm_pt('el', sx) + Vector((0.0, 0.03, 0.0))
            e = sphere(f'elbow{sx}', 1.0, p, (0.05, 0.04, 0.05), mat=M['elbow'], segs=14, rings=10)
            parts.append(e)
        if spec['wraps']:
            parts.append(lower_arm_ring(f'wrap{sx}', 0.55, 0.041, 0.036, 0.07, M['wraps'], sx))
    if spec['tags']:
        for i, (x, z) in enumerate(((0.012, 1.315), (-0.01, 1.305))):
            parts.append(box(f'tag{i}', (0.018, 0.004, 0.03), (x, -0.116, z), mat=M['metal'], bevel=0.003))
        for sx in (1, -1):
            a, b = Vector((0.05 * sx, -0.07, 1.45)), Vector((0.0, -0.114, 1.33))
            ch = cylinder(f'chain{sx}', 0.0015, 0.0015, (b - a).length, (a + b) / 2, mat=M['metal'], segs=4)
            parts.append(orient_z(ch, b - a))
    return parts


def build_feet(spec, M, side):
    F = spec['feet']
    sx = 1 if side == 'L' else -1
    ax, ay = 0.113 * sx, 0.015
    if F['kind'] == 'boots':
        sole = box('sole', (0.11, 0.29, 0.034), (ax + 0.004 * sx, ay - 0.05, 0.017), mat=M['sole'], bevel=0.008)
        foot = box('foot', (0.1, 0.25, 0.08), (ax + 0.004 * sx, ay - 0.045, 0.065), mat=M['shoe'], bevel=0.025)
        toe = box('toecap', (0.095, 0.06, 0.06), (ax + 0.005 * sx, ay - 0.15, 0.055), mat=M['shoe'], bevel=0.02)
        footj = join([sole, foot, toe], f'Foot_{side}')
        shaft = cylinder('shaft', 0.052, 0.047, 0.17, (ax, ay + 0.005, 0.16), mat=M['shoe'], segs=16, bevel=0.004)
        lace = box('laces', (0.04, 0.012, 0.13), (ax, ay - 0.047, 0.14), mat=M['lace'], bevel=0.003)
        shaftj = join([shaft, lace], f'Shaft_{side}')
    else:
        sole = box('sole', (0.108, 0.285, 0.042), (ax + 0.004 * sx, ay - 0.05, 0.021), mat=M['sole'], bevel=0.012)
        foot = box('upper', (0.097, 0.25, 0.07), (ax + 0.004 * sx, ay - 0.045, 0.07), mat=M['shoe'], bevel=0.03)
        toe = box('toe', (0.09, 0.07, 0.05), (ax + 0.005 * sx, ay - 0.145, 0.06), mat=M['shoe'], bevel=0.022)
        stripe = box('stripe', (0.1, 0.12, 0.022), (ax + 0.004 * sx, ay - 0.03, 0.075), (0.35, 0, 0), mat=M['shoe_accent'], bevel=0.006)
        heel = box('heel', (0.09, 0.04, 0.05), (ax + 0.004 * sx, ay + 0.08, 0.075), mat=M['shoe_accent'], bevel=0.012)
        footj = join([sole, foot, toe, stripe, heel], f'Foot_{side}')
        collar = cylinder('collar', 0.05, 0.047, 0.07, (ax, ay + 0.005, 0.125), mat=M['shoe'], segs=16, bevel=0.006)
        tongue = box('tongue', (0.045, 0.014, 0.08), (ax, ay - 0.045, 0.12), mat=M['shoe_accent'], bevel=0.004)
        shaftj = join([collar, tongue], f'Shaft_{side}')
    smooth(footj, 40)
    smooth(shaftj, 40)
    return footj, shaftj


def build_patch(spec, M):
    """Shoulder patch on the left upper arm, tinted with the player's colour in game."""
    fem = spec['fem']
    p = ARM['sh'].lerp(ARM['el'], 0.32)
    n = Vector((0.667, 0, 0.745)).normalized()
    layer = 0.017 if (spec['jacket'] or spec['hoodie']) else 0.0
    r = (0.043 if fem else 0.05) + layer + 0.004
    ob = box('patch', (0.006, 0.05, 0.046), p + n * r, mat=M['team'], bevel=0.002)
    ob.rotation_euler = (0, -math.atan2(n.z, n.x), 0)
    return ob


# ------------------------------------------------------------------ baking / joining

def _hash(ix, iy, iz):
    h = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)
    h = (h ^ (h >> 13)) * 1274126177
    return ((h ^ (h >> 16)) & 0xffff) / 65535.0


def vnoise(p):
    a = _hash(int(math.floor(p.x * 140)), int(math.floor(p.y * 140)), int(math.floor(p.z * 140)))
    b = _hash(int(math.floor(p.x * 18)) + 7, int(math.floor(p.y * 18)) + 3, int(math.floor(p.z * 18)) + 11)
    return a * 0.55 + b * 0.45


def principled_color(m):
    try:
        for n in m.node_tree.nodes:
            if n.type == 'BSDF_PRINCIPLED':
                c = n.inputs['Base Color'].default_value
                return (c[0], c[1], c[2])
    except Exception:
        pass
    c = m.diffuse_color
    return (c[0], c[1], c[2])


def vertex_color_material(name, rough=0.75, metal=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = [n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED']
    bsdf = bsdf[0] if bsdf else nt.nodes.new('ShaderNodeBsdfPrincipled')
    attr = nt.nodes.new('ShaderNodeVertexColor')
    try:
        attr.layer_name = 'Col'
    except Exception:
        pass
    nt.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    return m


def bake_vertex_colors(ob, keep_names=(), out_mat=None):
    """Material colours (+ fabric grain) -> 'Col' corner colours; collapse to one material (plus kept ones)."""
    me = ob.data
    info = []
    for m in me.materials:
        info.append((principled_color(m), float(m.get('grain', 0.08)) if m else 0.08, m.name if m else ''))
    attr = me.color_attributes.get('Col') or me.color_attributes.new(name='Col', type='BYTE_COLOR', domain='CORNER')
    data = attr.data
    verts = me.vertices
    loops = me.loops
    new_index = []
    kept = []
    for m in me.materials:
        if m and m.name in keep_names:
            if m not in kept:
                kept.append(m)
    for poly in me.polygons:
        c, amp, nm = info[poly.material_index]
        for li in poly.loop_indices:
            co = verts[loops[li].vertex_index].co
            f = 1.0 + amp * (vnoise(co) * 2.0 - 1.0)
            data[li].color = (c[0] * f, c[1] * f, c[2] * f, 1.0)
        new_index.append(1 + kept.index(me.materials[poly.material_index]) if nm in keep_names else 0)
    me.materials.clear()
    me.materials.append(out_mat)
    for m in kept:
        me.materials.append(m)
    for poly, i in zip(me.polygons, new_index):
        poly.material_index = i
    try:
        me.color_attributes.active_color = attr
        me.color_attributes.render_color_index = me.color_attributes.find('Col')
    except Exception:
        pass
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    return ob


# faces.png: 3 x 2 cells of 341 x 512 px in a 1024 atlas (built by tools/textures/face_atlas.py from the
# face close-ups on the reference sheets); cell 5 is plain white for everything that is not a face
FACE_ATLAS = 1024
FACE_CELL = (341, 512)
FACE_REGION = (-0.075, 0.075, -0.125, 0.105)   # head-local x0, x1, z0, z1 that one cell covers


# detail tiles in cell 5 (pixels, top-left origin): x0, y0, tile w, tile h, metres per tile
DETAIL = {'cloth': (682, 512, 170, 128, 0.11), 'gear': (682, 768, 170, 112, 0.085)}
DETAIL['shoe'] = DETAIL['gear']
WHITE_PX = (852, 1008)


def face_uvs(ob, face_polys, cell, hc, roles=None):
    me = ob.data
    uv = me.uv_layers.new(name='UVMap')
    cw, ch = FACE_CELL
    x0, x1, z0, z1 = FACE_REGION

    def to_uv(col, row, fu, fv):  # fv: 0 = top of the cell
        u = (col * cw + fu * cw) / FACE_ATLAS
        v_img = (row * ch + fv * ch) / FACE_ATLAS
        return (u, 1.0 - v_img)

    white = (WHITE_PX[0] / FACE_ATLAS, 1.0 - WHITE_PX[1] / FACE_ATLAS)
    col, row = (cell % 3, cell // 3) if cell is not None else (2, 1)
    verts, loops = me.vertices, me.loops
    for poly in me.polygons:
        face = poly.index in face_polys
        if not face:
            d = DETAIL.get(roles[poly.index]) if roles else None
            if not d:
                for li in poly.loop_indices:
                    uv.data[li].uv = white
                continue
            # box projection along the polygon's dominant axis; the tile is stored 2 x 2 so a polygon
            # never has to wrap around inside it
            n = poly.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            a, b = [(1, 2), (0, 2), (0, 1)][ax]
            tx, ty, tw, th, size = d
            pts = [verts[loops[li].vertex_index].co for li in poly.loop_indices]
            ra = [p[a] / size for p in pts]
            rb = [p[b] / size for p in pts]
            oa, ob_ = math.floor(min(ra)), math.floor(min(rb))
            for li, ua, ub in zip(poly.loop_indices, ra, rb):
                la = min(1.98, ua - oa)
                lb = min(1.98, ub - ob_)
                uv.data[li].uv = ((tx + la * tw) / FACE_ATLAS, 1.0 - (ty + lb * th) / FACE_ATLAS)
            continue
        for li in poly.loop_indices:
            co = verts[loops[li].vertex_index].co - hc
            fu = min(1.0, max(0.0, (co.x - x0) / (x1 - x0)))
            fv = min(1.0, max(0.0, (z1 - co.z) / (z1 - z0)))
            uv.data[li].uv = to_uv(col, row, fu, fv)


def shade_neck(ob, roles):
    """The jaw shades the neck: darken bare neck skin toward the chin so the head doesn't float on a
    bright cylinder."""
    me = ob.data
    col = me.color_attributes['Col'].data
    verts, loops = me.vertices, me.loops
    for poly in me.polygons:
        if roles[poly.index] != 'skin':
            continue
        c = poly.center
        if not (1.42 < c.z < 1.64 and abs(c.x) < 0.11):
            continue
        for li in poly.loop_indices:
            z = verts[loops[li].vertex_index].co.z
            t = min(1.0, max(0.0, (z - 1.45) / 0.15))
            f = 1.0 - 0.3 * t * t * (3 - 2 * t)
            r, g, b, _ = col[li].color
            col[li].color = (r * f, g * f * 0.97, b * f * 0.95, 1.0)


AO_STRENGTH = 0.7
AO_DISTANCE = 0.08
_POSER = None


def pose_idle(arm, rig):
    poses = _POSER.solve(C.clip_params('Idle', 0, 60))
    for n, Bm in rig.basis(poses).items():
        pb = arm.pose.bones[n]
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = Bm.to_quaternion()
        pb.location = Bm.translation if n in ('Root', 'Hips', 'Weapon') else Vector()
    bpy.context.view_layer.update()


def rest_pose(arm):
    for pb in arm.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()
    bpy.context.view_layer.update()


def bake_ao(ob, arm, rig):
    """Bake ambient occlusion (in the idle pose) into the vertex colours: shading under pouches, straps,
    collars, between fingers... baked once here instead of computed every frame in the browser."""
    if _POSER is None:
        return
    scene = bpy.context.scene
    me = ob.data
    ao = me.color_attributes.new(name='AO', type='BYTE_COLOR', domain='CORNER')
    prev_engine = scene.render.engine
    hidden = []
    try:
        scene.render.engine = 'CYCLES'
        scene.cycles.samples = 32
        try:
            scene.cycles.device = 'CPU'
        except Exception:
            pass
        if scene.world is None:
            scene.world = bpy.data.worlds.new('World')
        scene.world.light_settings.distance = AO_DISTANCE
        scene.render.bake.target = 'VERTEX_COLORS'
        # the other operators stand in the same spot: keep them out of the bake
        for o in scene.objects:
            if o is not ob and o.type == 'MESH' and not o.hide_render:
                o.hide_render = True
                hidden.append(o)
        me.color_attributes.active_color = ao
        pose_idle(arm, rig)
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        with bpy.context.temp_override(active_object=ob, object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
            bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
        col = me.color_attributes['Col'].data
        ad = me.color_attributes['AO'].data
        total = 0.0
        for i in range(len(col)):
            a = ad[i].color[0]
            total += a
            f = 1.0 - AO_STRENGTH * (1.0 - a)
            c = col[i].color
            col[i].color = (c[0] * f, c[1] * f, c[2] * f, 1.0)
        log(f'  AO baked, mean {total / max(1, len(col)):.2f}')
    except Exception:
        log_exc('AO bake')
    finally:
        for o in hidden:
            o.hide_render = False
        rest_pose(arm)
        scene.render.engine = prev_engine
        if 'AO' in me.color_attributes:
            me.color_attributes.remove(me.color_attributes['AO'])
        try:
            me.color_attributes.active_color = me.color_attributes['Col']
            me.color_attributes.render_color_index = me.color_attributes.find('Col')
        except Exception:
            pass


def join_objects(objs, name):
    """Operator join keeps vertex groups and armature modifiers (bmesh join would scramble the groups)."""
    main = objs[0]
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    with bpy.context.temp_override(active_object=main, object=main, selected_objects=objs, selected_editable_objects=objs):
        bpy.ops.object.join()
    main.name = name
    main.data.name = name
    return main


def decimate(ob, ratio):
    try:
        dec = ob.modifiers.new('Decimate', 'DECIMATE')
        dec.ratio = ratio
        with bpy.context.temp_override(object=ob, active_object=ob):
            bpy.ops.object.modifier_move_to_index(modifier='Decimate', index=0)
            bpy.ops.object.modifier_apply(modifier='Decimate')
    except Exception:
        log_exc(f'decimate {ob.name}')
        if 'Decimate' in ob.modifiers:
            ob.modifiers.remove(ob.modifiers['Decimate'])


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


# ------------------------------------------------------------------ main build

def setup_rig():
    arm = C.build_armature()
    rig = C.Rig(arm)
    poser = C.Poser(rig)
    ref = C.clip_params('Idle', 0, 60)
    poses = poser.solve(dict(ref, arms={'L': {'hand': (0.3, -0.1, 1.0)}, 'R': {'hand': (-0.3, -0.1, 1.0)}}))
    Uc = poses['UpperChest']
    shoulder_r = poses['UpperArm.R'].translation
    butt = shoulder_r + Vector((0.05, -0.075, -0.035))
    F = Vector((0.03, -1, 0)).normalized()
    U = Vector((0, 0, 1))
    left = U.cross(F).normalized()
    U = F.cross(left).normalized()
    grip = butt + F * W.BUTT_POINT[1] - U * W.BUTT_POINT[2]
    Wm = Matrix.Identity(4)
    for i in range(3):
        Wm[i][0] = left[i]
        Wm[i][1] = -F[i]
        Wm[i][2] = U[i]
        Wm[i][3] = grip[i]
    poser.L_ref = Uc.inverted() @ Wm
    W_rest = rig.rest['UpperChest'] @ poser.L_ref
    C.set_weapon_rest(arm, W_rest)
    rig = C.Rig(arm)
    poser.rig = rig
    return arm, rig, poser, W_rest


def operator_materials(spec):
    t = spec['name']
    J, H, V, P, F = spec['jacket'], spec['hoodie'], spec['vest'], spec['pack'], spec['feet']
    stub = spec['skin']
    # stubble = hair colour mixed into skin
    sr = [((spec['hair'] >> s) & 255) * 0.3 + ((stub >> s) & 255) * 0.7 for s in (16, 8, 0)]
    stubble = (int(sr[0]) << 16) | (int(sr[1]) << 8) | int(sr[2])
    M = {
        'skin': mat(t, 'Skin', spec['skin'], 'skin', 0.55),
        'lips': mat(t, 'Lips', spec['lips'], 'skin', 0.5),
        'eyewhite': mat(t, 'EyeWhite', 0xf0ede6, 'eye', 0.2),
        'face': mat(t, 'FaceTex', 0xffffff, 'eye', 0.55),
        'iris': mat(t, 'Iris', spec['iris'], 'eye', 0.2),
        'pupil': mat(t, 'Pupil', 0x080808, 'eye', 0.1),
        'hair': mat(t, 'Hair', spec['hair'], 'hair', 0.8),
        'hair_tie': mat(t, 'HairTie', 0x111111, 'gear', 0.6),
        'stubble': mat(t, 'Stubble', stubble, 'hair', 0.8),
        'top': mat(t, 'Top', spec['top'], 'cloth', 0.85),
        'pants': mat(t, 'Pants', spec['pants'], 'cloth', 0.9),
        'belt': mat(t, 'Belt', spec['belt'], 'gear', 0.8),
        'metal': mat(t, 'Metal', 0x2b2d30, 'metal', 0.4, 0.5),
        'rubber': mat(t, 'Rubber', 0x18181a, 'gear', 0.9),
        'shades': mat(t, 'Shades', 0x0c0d10, 'metal', 0.1, 0.3),
        'knee': mat(t, 'Knee', spec['knee'], 'gear', 0.7),
        'thigh': mat(t, 'Thigh', spec['thigh'], 'gear', 0.8),
        'accent': mat(t, 'Accent', spec['accent'] or spec['thigh'], 'gear', 0.7),
        'team': material('TeamAccent', 0xff3b5c, rough=0.5),
        'shoe': mat(t, 'Shoe', F['upper'], 'shoe', 0.7),
        'sole': mat(t, 'Sole', F['sole'], 'shoe', 0.9),
        'lace': mat(t, 'Lace', F.get('lace', 0x222222), 'gear', 0.9),
        'shoe_accent': mat(t, 'ShoeAccent', F.get('accent', F['upper']), 'shoe', 0.6),
        'gloves': mat(t, 'Gloves', spec['gloves'], 'gear', 0.85),
        'webbing': mat(t, 'Webbing', 0x2d2b27, 'gear', 0.9),
    }
    if J:
        M['jacket'] = mat(t, 'Jacket', J['color'], 'cloth', 0.85)
        M['cuff'] = mat(t, 'Cuff', J['cuff'], 'cloth', 0.85)
        if J.get('panels'):
            M['jacket_red'] = mat(t, 'JacketPanel', J.get('stripe', J.get('red', 0xb3262d)), 'cloth', 0.8)
    if H:
        M['hoodie'] = mat(t, 'Hoodie', H['color'], 'cloth', 0.9)
        M.setdefault('cuff', mat(t, 'Cuff', 0xb5b3ae, 'cloth', 0.85))
    if spec['hood']:
        M['hood'] = mat(t, 'Hood', spec['hood'], 'cloth', 0.9)
    if spec['scarf']:
        M['scarf'] = mat(t, 'Scarf', spec['scarf'], 'cloth', 0.95)
    if V:
        M['vest'] = mat(t, 'Vest', V['color'], 'gear', 0.85)
        M['vest_strap'] = mat(t, 'VestStrap', V['strap'], 'gear', 0.85)
    if P:
        M['pack'] = mat(t, 'Pack', P['color'], 'gear', 0.85)
        M['pack_strap'] = mat(t, 'PackStrap', P['strap'], 'gear', 0.85)
        M['accent'] = mat(t, 'Accent2', P['accent'], 'gear', 0.7)
    if spec['elbow']:
        M['elbow'] = mat(t, 'Elbow', spec['elbow'], 'gear', 0.7)
    if spec['wraps']:
        M['wraps'] = mat(t, 'Wraps', spec['wraps'], 'cloth', 0.9)
    return M


def build_operator(spec, arm, rig, op_mat):
    tag = spec['name']
    M = operator_materials(spec)
    body = build_body(spec, [M['skin'], M['top'], M['pants']])
    dominant = C.skin_auto(body, arm, C.DEFORM)
    paint_body(body, dominant, spec, M)
    parts = [body]
    covers = []
    clothes = build_clothes(spec, M, body, dominant, covers)
    # drop body faces hidden under garments
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bm.verts.ensure_lookup_table()
    hidden = [f for f in bm.faces if any(cv(f.calc_center_median(), face_dominant(dominant, f), f.normal) for cv in covers)]
    bmesh.ops.delete(bm, geom=hidden, context='FACES')
    bm.to_mesh(body.data)
    bm.free()
    for g in clothes:
        if g.name.startswith(f'{tag}_'):
            parts.append(g)  # garments already carry the body's skinning
        elif g.name.startswith(('cuff', 'wrap')):
            C.skin_auto(g, arm, ['LowerArm.L', 'LowerArm.R', 'Hand.L', 'Hand.R'], power=6, top=2)
            parts.append(g)
        elif g.name.startswith('ankle'):
            C.skin_rigid(g, arm, 'LowerLeg.L' if g.location.x > 0 else 'LowerLeg.R')
            parts.append(g)
        else:
            C.skin_auto(g, arm, ['Spine', 'Chest', 'UpperChest', 'Neck', 'Hips'], power=4, top=2)
            parts.append(g)
    head, hc = build_head(spec, M, rig.rest['Head'].translation)
    C.skin_rigid(head, arm, 'Head')
    parts.append(head)
    for h in build_hair(spec, M, hc) + build_face_gear(spec, M, hc):
        C.skin_rigid(h, arm, 'Head')
        parts.append(h)
    for g in build_vest(spec, M) + build_pack(spec, M):
        C.skin_auto(g, arm, ['Spine', 'Chest', 'UpperChest'], power=4, top=2)
        parts.append(g)
    for g in build_lower_gear(spec, M):
        n = g.name
        if n.startswith('kneepad'):
            C.skin_rigid(g, arm, 'LowerLeg.L' if g.location.x > 0 else 'LowerLeg.R')
        elif n.startswith(('thighpouch', 'legstrap')):
            C.skin_rigid(g, arm, 'UpperLeg.L' if g.location.x > 0 else 'UpperLeg.R')
        else:
            C.skin_rigid(g, arm, 'Hips')
        parts.append(g)
    for g in build_arm_gear(spec, M):
        if g.name.startswith(('tag', 'chain')):
            C.skin_rigid(g, arm, 'UpperChest')
        else:
            C.skin_auto(g, arm, ['UpperArm.L', 'LowerArm.L', 'UpperArm.R', 'LowerArm.R'], power=6, top=2)
        parts.append(g)
    patch = build_patch(spec, M)
    C.skin_rigid(patch, arm, 'UpperArm.L')
    parts.append(patch)
    gm = {'Gloves': M['gloves'], 'Webbing': M['webbing']}
    for s in ('L', 'R'):
        h = C.build_hand(gm, rig, s)
        if spec['fingerless']:
            wrist = rig.rest[f'Hand.{s}'].translation
            si = len(h.data.materials)
            h.data.materials.append(M['skin'])
            for poly in h.data.polygons:
                if (poly.center - wrist).length > 0.112:
                    poly.material_index = si
        C.skin_rigid(h, arm, f'Hand.{s}')
        parts.append(h)
        ft, sh = build_feet(spec, M, s)
        C.skin_rigid(ft, arm, f'Foot.{s}')
        C.skin_rigid(sh, arm, f'LowerLeg.{s}')
        parts += [ft, sh]
    # thin out the big smooth surfaces (body + garments); small details keep full resolution
    before = sum(tri_count(o) for o in parts)
    for o in parts:
        if o is body or o.name.startswith(f'{tag}_') and o.name.split('_')[-1] in ('pants', 'jacket', 'hoodie'):
            decimate(o, DECIMATE)
        elif any(k in o.name for k in ('hairshell', 'beard', 'stubble', 'moustache')):
            decimate(o, 0.7)
    ob = join_objects(parts, f'Op_{tag}')
    log(f'  {tag}: {before} -> {tri_count(ob)} tris')
    mats = ob.data.materials
    face_polys = {p.index for p in ob.data.polygons if mats[p.material_index] and mats[p.material_index].name.endswith('_FaceTex')}
    roles = [(mats[p.material_index].get('role', '') if mats[p.material_index] else '') for p in ob.data.polygons]
    bake_vertex_colors(ob, keep_names=('TeamAccent',), out_mat=op_mat)
    shade_neck(ob, roles)
    bake_ao(ob, arm, rig)
    face_uvs(ob, face_polys, spec.get('face'), ob.matrix_world.inverted() @ hc, roles)
    log(f'  operator {tag}: {tri_count(ob)} tris, {len(ob.data.vertices)} verts, {len(face_polys)} face polys')
    return ob


def bake_weapon(ob, gun_mat):
    for m in ob.data.materials:
        if m is not None and 'grain' not in m:
            m['grain'] = 0.04
    return bake_vertex_colors(ob, out_mat=gun_mat)


def build_fp_hands(arm, rig, poser, W_rest):
    """First-person gloves: the two hands in the aim pose, moved into rifle space."""
    P = C.clip_params('Idle', 0, 60)
    poses = poser.solve(P)
    basis = rig.basis(poses)
    for n, Bm in basis.items():
        pb = arm.pose.bones[n]
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = Bm.to_quaternion()
        pb.location = Bm.translation if n in ('Root', 'Hips', 'Weapon') else Vector()
    bpy.context.view_layer.update()
    mats = {'Gloves': material('Gloves', 0x22211f, rough=0.85), 'Webbing': material('Webbing', 0x3a362e, rough=0.9)}
    hands = []
    for s in ('L', 'R'):
        h = C.build_hand(mats, rig, s)
        C.skin_rigid(h, arm, f'Hand.{s}')
        hands.append(h)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    Winv = poses['Weapon'].inverted()
    parts = []
    for src in hands:
        ev = src.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
        me.transform(Winv @ src.matrix_world)
        parts.append(new_object('fp_part', me))
    for h in hands:
        bpy.data.objects.remove(h, do_unlink=True)
    armsfp = join(parts, 'ArmsFP')
    smooth(armsfp, 50)
    eye = bpy.data.objects.new('EyeFP', None)
    link(eye)
    head_pose = poses['Head']
    eye_posed = head_pose @ (rig.rest['Head'].inverted() @ Vector((0.0, -0.08, 1.705)))
    eye.location = Winv @ eye_posed
    export_glb(os.path.join(OUT_MODELS, 'fp_arms.glb'), [armsfp, eye])
    bpy.data.objects.remove(armsfp, do_unlink=True)
    bpy.data.objects.remove(eye, do_unlink=True)
    for pb in arm.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()
    bpy.context.view_layer.update()


def build_all():
    clear_scene()
    scene = bpy.context.scene
    scene.render.fps = C.FPS
    global _POSER
    arm, rig, poser, W_rest = setup_rig()
    _POSER = poser
    log('rig ready')
    try:
        build_fp_hands(arm, rig, poser, W_rest)
        log('fp hands exported')
    except Exception:
        log_exc('fp hands')
    op_mat = vertex_color_material('Operator', rough=0.78)
    gun_mat = vertex_color_material('Gun', rough=0.5, metal=0.35)
    only = [s.strip() for s in os.environ.get('BPZ_OPERATORS', '').split(',') if s.strip()]
    ops = []
    for spec in OPERATORS:
        if only and spec['name'] not in only:
            continue
        try:
            ops.append(build_operator(spec, arm, rig, op_mat))
        except Exception:
            log_exc(f"operator {spec['name']}")
    rifle = bake_weapon(W.build_rifle(1, with_mag=True, name='Rifle3P'), gun_mat)
    launcher = bake_weapon(W.build_launcher(1, with_warhead=True, name='Launcher3P'), gun_mat)
    for ob in (rifle, launcher):
        ob.parent = arm
        ob.parent_type = 'BONE'
        ob.parent_bone = 'Weapon'
        ob.matrix_world = W_rest
    log('weapons attached')
    clips = [('Idle', 60), ('Walk', 30), ('Run', 20), ('Back', 26), ('StrafeL', 22), ('StrafeR', 22), ('Jump', 20)]
    for name, n in clips:
        C.keyframe_clip(arm, rig, poser, name, n, lambda f, N, name=name: C.clip_params(name, f, N))
    for name, secs in (('DeathBack', 1.3), ('DeathFront', 1.3), ('DeathHead', 1.5)):
        n = int(secs * C.FPS)
        C.keyframe_clip(arm, rig, poser, name, n, lambda f, N, name=name: C.death_params(name, f / C.FPS))
    arm.animation_data.action = bpy.data.actions['Idle']
    scene.frame_set(0)
    objs = [arm] + [o for o in bpy.data.objects if o.parent == arm]
    export_glb(os.path.join(OUT_MODELS, 'operators.glb'), objs, animations=True)
    save_blend('operators.blend')
