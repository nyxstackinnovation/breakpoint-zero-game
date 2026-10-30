"""First-person hands and forearms for Breakpoint Zero (Blender 5.x).

Builds two anatomically proportioned arms (forearm, wrist, palm with thenar/hypothenar pads, back-of-hand
tendons, knuckles, three-jointed fingers, opposable thumb, fingernails) as one organic mesh per arm,
dresses them in black tactical fingerless gloves (leather palm and finger sleeves, stretch-fabric back,
moulded knuckle guard, velcro wrist strap), rigs them with a real hand skeleton and solves the grip
against the actual rifle / launcher geometry so fingers wrap the weapon without passing through it.

Animations (glTF clips): Idle, Aim, Fire, Reload (left hand swaps the magazine via the 'mag' bone),
LauncherIdle. Output: client/assets/models/fp_hands.glb (+ previews in tools/blender/preview/).

Conventions (Blender space, same as build_weapons.py): forward = -Y, up = +Z, origin = pistol grip.
Hand-local frame used while modelling: wrist at the origin, +Y toward the fingers, +Z back of the hand,
and for the right hand the thumb on -X (the left hand is the mirror image).

Run inside Blender (Scripting tab, Python console):
    import runpy; runpy.run_path(r"<project>/tools/blender/build_fp_hands.py", run_name="__main__")
"""
import math
import os
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector, Quaternion
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import importlib
import bpz_common
importlib.reload(bpz_common)
from bpz_common import log, log_exc, clear_scene, link, apply_modifiers, export_glb, OUT_MODELS, SOURCE_DIR
import build_weapons as W
importlib.reload(W)

TEX_DIR = os.path.join(HERE, 'textures')
PREVIEW_DIR = os.path.join(HERE, 'preview')
os.makedirs(PREVIEW_DIR, exist_ok=True)
FPS = 30
FINGERS = ('index', 'middle', 'ring', 'pinky')

# ------------------------------------------------------------------ anatomy (right hand, metres)
# radial coordinate r: + toward the thumb side.  Actual x = SX * r with SX = -1 for the right hand.
MCP = {'index': (0.028, 0.093, -0.003), 'middle': (0.0095, 0.097, -0.002), 'ring': (-0.0095, 0.093, -0.003), 'pinky': (-0.027, 0.084, -0.005)}
FAN = {'index': 6.0, 'middle': 0.0, 'ring': -5.0, 'pinky': -11.0}            # spread, degrees toward the thumb
LENS = {'index': (0.040, 0.024, 0.021), 'middle': (0.045, 0.028, 0.022), 'ring': (0.042, 0.027, 0.021), 'pinky': (0.032, 0.020, 0.019)}
RADS = {'index': (0.0103, 0.0093, 0.0084, 0.0077), 'middle': (0.0106, 0.0096, 0.0087, 0.0079),
        'ring': (0.0100, 0.0090, 0.0081, 0.0074), 'pinky': (0.0089, 0.0081, 0.0073, 0.0067)}
REST_CURL = (8.0, 12.0, 8.0)                                                  # relaxed open hand
THUMB_CMC = (0.022, 0.016, -0.012)
THUMB_DIRS = [(0.62, 0.64, -0.46), (0.42, 0.86, -0.30), (0.30, 0.94, -0.18)]  # metacarpal, proximal, distal
THUMB_LENS = (0.044, 0.031, 0.027)
THUMB_RADS = (0.0150, 0.0118, 0.0110, 0.0099)
FOREARM_LEN = 0.30

SKIN, NAIL, LEATHER, FABRIC, RUBBER, VELCRO = range(6)


def V(*a):
    return Vector(a)


def hand_point(r, y, z, sx):
    return Vector((sx * r, y, z))


def rot_axis(v, axis, deg):
    return (Quaternion(axis.normalized(), math.radians(deg)) @ v)


# ------------------------------------------------------------------ joint layout in hand-local space

def layout(sx):
    """Joint positions and per-segment frames (dir, dorsal) for one hand in hand-local space."""
    J = {}
    dorsal0 = V(0, 0, 1)
    for f in FINGERS:
        r, y, z = MCP[f]
        p = hand_point(r, y, z, sx)
        d = rot_axis(V(0, 1, 0), V(0, 0, 1), -sx * FAN[f])        # fan around +Z (toward the thumb side)
        up = dorsal0.copy()
        pts, frames = [p.copy()], []
        for j in range(3):
            lat = d.cross(up).normalized()
            d = rot_axis(d, lat, -REST_CURL[j])                     # flex toward the palm
            up = rot_axis(up, lat, -REST_CURL[j])
            frames.append((d.copy(), up.copy()))
            p = p + d * LENS[f][j]
            pts.append(p.copy())
        J[f] = {'pts': pts, 'frames': frames, 'rads': RADS[f]}
    r, y, z = THUMB_CMC
    p = hand_point(r, y, z, sx)
    pts, frames = [p.copy()], []
    for j in range(3):
        dr = THUMB_DIRS[j]
        d = Vector((sx * dr[0], dr[1], dr[2])).normalized()
        # thumb is pronated: its nail faces outward and up, roughly perpendicular to the fingers' nails
        wantup = Vector((sx * 0.62, -0.05, 0.78))
        up = (wantup - d * wantup.dot(d)).normalized()
        frames.append((d, up))
        p = p + d * THUMB_LENS[j]
        pts.append(p.copy())
    J['thumb'] = {'pts': pts, 'frames': frames, 'rads': THUMB_RADS}
    J['wrist'] = V(0, 0, 0)
    J['elbow'] = V(0, -FOREARM_LEN, -0.004)
    return J


# ------------------------------------------------------------------ lofting

def superellipse_ring(c, lat, up, a, bt, bb, n=24, ex=2.4):
    out = []
    for i in range(n):
        th = 2 * math.pi * i / n
        co, si = math.cos(th), math.sin(th)
        x = a * math.copysign(abs(co) ** (2 / ex), co)
        b = bt if si > 0 else bb
        y = b * math.copysign(abs(si) ** (2 / ex), si)
        out.append(c + lat * x + up * y)
    return out


def loft(bm, rings, cap=True):
    """Closed tube through rings (lists of Vectors with equal counts)."""
    vs = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    for a, b in zip(vs[:-1], vs[1:]):
        for i in range(n):
            bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    if cap:
        for ring, rev in ((vs[0], True), (vs[-1], False)):
            c = bm.verts.new(sum((v.co for v in ring), Vector()) / n)
            for i in range(n):
                q = (ring[i], ring[(i + 1) % n], c)
                bm.faces.new(q[::-1] if rev else q)


def finger_rings(pts, frames, rads, tipcap=True, thumb=False):
    rings = []
    d0, u0 = frames[0]
    start = pts[0] - d0 * (0.012 if not thumb else 0.004)
    lat0 = d0.cross(u0).normalized()
    rings.append(superellipse_ring(start, lat0, u0, rads[0] * 1.02, rads[0] * 0.82, rads[0] * 0.92))
    K = 7
    for j in range(3):
        d, u = frames[j]
        lat = d.cross(u).normalized()
        a0, a1 = rads[j], rads[j + 1]
        last = j == 2
        for k in range(1 if j == 0 else 1, K + 1):
            t = k / K
            if last and t > 0.62 and tipcap:
                break
            c = pts[j].lerp(pts[j + 1], t)
            a = a0 + (a1 - a0) * t
            joint = math.cos(t * math.pi) ** 2                      # 1 at the joints
            mid = math.sin(t * math.pi)
            aa = a * (1 + 0.055 * joint)
            bt = a * (0.80 + 0.07 * joint * (1 if j < 2 or t < 0.5 else 0))
            bb = a * (0.88 + 0.12 * mid - 0.05 * joint)              # finger pads, creases at the joints
            if thumb and j == 0:
                aa *= 1.08
                bb *= 1.12
            rings.append(superellipse_ring(c, lat, u, aa, bt, bb))
    # rounded fingertip with a padded underside
    d, u = frames[2]
    lat = d.cross(u).normalized()
    t0 = 0.62
    base = pts[2].lerp(pts[3], t0)
    rem = (pts[3] - base).length
    a = rads[2] + (rads[3] - rads[2]) * t0
    for k in range(1, 7):
        s = k / 6
        c = base + d * (rem * s)
        f = math.sqrt(max(0.0, 1 - s * s)) if s < 1 else 0.0
        f = max(f, 0.12)
        c = c - u * (a * 0.15 * s)                                  # tip curves slightly palmward
        rings.append(superellipse_ring(c, lat, u, a * f * 1.0, a * f * 0.72, a * f * 1.05))
    return rings


def build_skin_parts(sx, J):
    bm = bmesh.new()
    X, Y, Z = V(1, 0, 0), V(0, 1, 0), V(0, 0, 1)
    lat = V(sx, 0, 0)                     # + toward the thumb
    # forearm
    fa = [(-0.300, 0.041, 0.036, 0.034, 0.000), (-0.260, 0.043, 0.036, 0.033, 0.003), (-0.200, 0.042, 0.033, 0.030, 0.004),
          (-0.140, 0.038, 0.028, 0.026, 0.003), (-0.090, 0.0345, 0.0235, 0.022, 0.001), (-0.045, 0.0318, 0.0195, 0.0195, 0.0),
          (-0.012, 0.0308, 0.0175, 0.0185, 0.0), (0.004, 0.0312, 0.0168, 0.0180, 0.0)]
    rings = []
    for y, a, bt, bb, rc in fa:
        rings.append(superellipse_ring(V(sx * rc, y, 0.0), lat, Z, a, bt, bb, n=28, ex=2.2))
    loft(bm, rings)
    # palm
    pa = [(-0.015, 0.0315, 0.0175, 0.0195, 0.0), (0.000, 0.0322, 0.0160, 0.0182, 0.0), (0.020, 0.0372, 0.0142, 0.0176, 0.0),
          (0.045, 0.0402, 0.0130, 0.0152, 0.001), (0.068, 0.0422, 0.0122, 0.0132, 0.001), (0.084, 0.0420, 0.0114, 0.0116, 0.001),
          (0.094, 0.0385, 0.0098, 0.0092, 0.0)]
    rings = []
    for y, a, bt, bb, rc in pa:
        ring = superellipse_ring(V(sx * rc, y, 0.001), lat, Z, a, bt, bb, n=28, ex=2.8)
        if y > 0.06:
            k = (y - 0.06) / 0.034
            for p in ring:
                u = (p.x * sx) / 0.042                               # radial position -1..1
                if u < 0:
                    p.y -= 0.009 * k * (u * u)                       # knuckle line slopes down to the pinky
        rings.append(ring)
    loft(bm, rings)
    # hypothenar pad (little-finger side of the palm)
    c = hand_point(-0.024, 0.032, -0.007, sx)
    rings = []
    for k, (dy, s) in enumerate(((-0.026, 0.35), (-0.016, 0.8), (0.0, 1.0), (0.016, 0.8), (0.026, 0.3))):
        rings.append(superellipse_ring(c + V(0, dy, 0), lat, Z, 0.0115 * s, 0.009 * s, 0.0105 * s, n=16))
    loft(bm, rings)
    # fingers and thumb
    for f in FINGERS:
        loft(bm, finger_rings(J[f]['pts'], J[f]['frames'], J[f]['rads']))
    T = J['thumb']
    loft(bm, finger_rings([T['pts'][0] - T['frames'][0][0] * 0.012] + T['pts'][1:], T['frames'], T['rads'], thumb=True))
    # thenar eminence: the muscle mass at the base of the thumb
    d, u = T['frames'][0]
    l2 = d.cross(u).normalized()
    base = T['pts'][0] - d * 0.008
    rings = []
    for s, a in ((0.0, 0.006), (0.15, 0.0135), (0.4, 0.0168), (0.65, 0.0150), (0.9, 0.009), (1.0, 0.004)):
        c = base + d * (0.05 * s) + V(-sx * 0.004, 0, -0.002)
        rings.append(superellipse_ring(c, l2, u, a, a * 0.85, a * 1.1, n=16))
    loft(bm, rings)
    # knuckle heads and back-of-hand tendons
    for f in FINGERS:
        p = J[f]['pts'][0]
        d = J[f]['frames'][0][0]
        c = p + V(0, 0, 0.0055) - d * 0.003
        rings = [superellipse_ring(c + d * o, d.cross(Z).normalized(), Z, w, w * 0.8, w * 0.8, n=12)
                 for o, w in ((-0.008, 0.002), (-0.004, 0.0062), (0.0, 0.0072), (0.004, 0.006), (0.007, 0.002))]
        loft(bm, rings)
        w0 = hand_point(MCP[f][0] * 0.35, 0.004, 0.0125, sx)
        w1 = p + V(0, 0, 0.0085) - d * 0.008
        dd = (w1 - w0).normalized()
        l3 = dd.cross(Z).normalized()
        rings = []
        for s in (0.0, 0.08, 0.5, 0.92, 1.0):
            r = 0.0019 * (math.sin(s * math.pi) ** 0.5 if 0 < s < 1 else 0.3)
            rings.append(superellipse_ring(w0.lerp(w1, s), l3, Z, r * 1.4, r, r, n=8))
        loft(bm, rings)
    # ulnar styloid (wrist bone bump) and radial wrist bone
    for r, y, z, s in ((-0.026, -0.010, 0.006, 0.0062), (0.025, -0.006, 0.002, 0.005)):
        c = hand_point(r, y, z, sx)
        rings = [superellipse_ring(c + V(0, o, 0), lat, Z, s * w, s * w, s * w, n=12) for o, w in ((-0.006, 0.3), (-0.003, 0.85), (0.0, 1.0), (0.003, 0.85), (0.006, 0.3))]
        loft(bm, rings)
    me = bpy.data.meshes.new('hand_parts')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('hand_parts', me)
    link(ob)
    return ob


def remesh_organic(ob, voxel=0.0011, target_faces=11000):
    m = ob.modifiers.new('Remesh', 'REMESH')
    m.mode = 'VOXEL'
    m.voxel_size = voxel
    m.adaptivity = 0.0
    try:
        m.use_smooth_shade = True
    except Exception:
        pass
    apply_modifiers(ob)
    n0 = len(ob.data.polygons)
    s = ob.modifiers.new('Smooth', 'SMOOTH')
    s.factor = 0.6
    s.iterations = 5
    apply_modifiers(ob)
    d = ob.modifiers.new('Decimate', 'DECIMATE')
    d.ratio = min(1.0, target_faces / max(1, n0))
    apply_modifiers(ob)
    for p in ob.data.polygons:
        p.use_smooth = True
    log(f'  remesh: {n0} voxel faces -> {len(ob.data.polygons)}')
    return ob


# ------------------------------------------------------------------ skinning (bone-segment distance)

def bone_segments(J, side):
    """name -> list of (head, tail) segments in hand-local space; the hand uses one segment per metacarpal."""
    S = {}
    S[f'{side}_forearm'] = [(J['elbow'], J['wrist'] + V(0, -0.004, 0))]
    S[f'{side}_hand'] = []
    for f in FINGERS:
        p0 = J[f]['pts'][0]
        S[f'{side}_hand'].append((V(p0.x * 0.45, 0.0, 0.0), p0 - J[f]['frames'][0][0] * 0.004))
    for f in FINGERS:
        pts = J[f]['pts']
        for j in range(3):
            S[f'{side}_{f}_{j + 1}'] = [(pts[j], pts[j + 1])]
    pts = J['thumb']['pts']
    for j in range(3):
        S[f'{side}_thumb_{j + 1}'] = [(pts[j], pts[j + 1])]
    return S


def seg_dist(P, a, b):
    a = np.array(a, dtype=np.float64)
    b = np.array(b, dtype=np.float64)
    ab = b - a
    t = np.clip(((P - a) @ ab) / max(1e-12, ab @ ab), 0.0, 1.0)
    c = a + t[:, None] * ab
    return np.linalg.norm(P - c, axis=1), ((P - a) @ ab) / max(1e-12, ab @ ab)


def compute_weights(P, segs, power=5.0, band=0.006):
    names = list(segs.keys())
    D = np.zeros((len(P), len(names)))
    T = np.zeros((len(P), len(names)))
    for k, n in enumerate(names):
        best = None
        for a, b in segs[n]:
            d, t = seg_dist(P, a, b)
            if best is None:
                best, bt = d, t
            else:
                m = d < best
                best = np.where(m, d, best)
                bt = np.where(m, t, bt)
        D[:, k] = best
        T[:, k] = bt
    dmin = D.min(axis=1, keepdims=True)
    Wt = np.where(D <= dmin + band, 1.0 / np.power(D + 1e-4, power), 0.0)
    # keep the three strongest influences
    idx = np.argsort(-Wt, axis=1)[:, 3:]
    np.put_along_axis(Wt, idx, 0.0, axis=1)
    Wt /= Wt.sum(axis=1, keepdims=True)
    return names, Wt, D, T


def smooth_weights(me, Wt, iters=2):
    nv = len(me.vertices)
    ei = np.zeros(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get('vertices', ei)
    ei = ei.reshape(-1, 2)
    for _ in range(iters):
        acc = Wt.copy()
        cnt = np.ones(nv)
        np.add.at(acc, ei[:, 0], Wt[ei[:, 1]])
        np.add.at(acc, ei[:, 1], Wt[ei[:, 0]])
        np.add.at(cnt, ei[:, 0], 1)
        np.add.at(cnt, ei[:, 1], 1)
        Wt = 0.5 * Wt + 0.5 * acc / cnt[:, None]
    idx = np.argsort(-Wt, axis=1)[:, 4:]
    np.put_along_axis(Wt, idx, 0.0, axis=1)
    Wt /= Wt.sum(axis=1, keepdims=True)
    return Wt


# ------------------------------------------------------------------ gloves

def glove_mask(names, Wt, T, P, side, me=None):
    """Glove coverage as a smooth field (weights x per-bone coverage), so the cut lines are clean."""
    def step(x, e0, e1):
        s = np.clip((x - e0) / (e1 - e0), 0, 1)
        return s * s * (3 - 2 * s)
    cov = np.zeros(len(P))
    for k, n in enumerate(names):
        if n.endswith('_forearm'):
            c = step(P[:, 1], -0.036, -0.028)
        elif n.endswith('_hand') or n.endswith('thumb_1'):
            c = np.ones(len(P))
        elif n.endswith('pinky_1'):
            c = 1 - step(T[:, k], 0.38, 0.46)
        elif n.endswith('_1'):
            c = 1 - step(T[:, k], 0.46, 0.54)
        elif n.endswith('thumb_2'):
            c = 1 - step(T[:, k], 0.34, 0.42)
        else:
            c = np.zeros(len(P))
        cov += Wt[:, k] * c
    cov = np.minimum(cov, step(P[:, 1], -0.032, -0.026))   # the cuff is a straight line round the forearm
    if me is not None:
        ei = np.zeros(len(me.edges) * 2, dtype=np.int64)
        me.edges.foreach_get('vertices', ei)
        ei = ei.reshape(-1, 2)
        for _ in range(4):
            acc = cov.copy()
            cnt = np.ones(len(cov))
            np.add.at(acc, ei[:, 0], cov[ei[:, 1]])
            np.add.at(acc, ei[:, 1], cov[ei[:, 0]])
            np.add.at(cnt, ei[:, 0], 1)
            np.add.at(cnt, ei[:, 1], 1)
            cov = acc / cnt
    return cov


def graph_distance_to_edge(me, inside):
    """Approximate surface distance (m) from each inside vertex to the nearest outside vertex."""
    nv = len(me.vertices)
    co = np.zeros(nv * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    ei = np.zeros(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get('vertices', ei)
    ei = ei.reshape(-1, 2)
    L = np.linalg.norm(co[ei[:, 0]] - co[ei[:, 1]], axis=1)
    dist = np.where(inside, 1e9, 0.0)
    for _ in range(40):
        a = dist[ei[:, 1]] + L
        b = dist[ei[:, 0]] + L
        nd = dist.copy()
        np.minimum.at(nd, ei[:, 0], a)
        np.minimum.at(nd, ei[:, 1], b)
        nd = np.where(inside, nd, 0.0)
        if np.allclose(nd, dist):
            break
        dist = nd
    return dist


def iso_cut(me, cov, level=0.5):
    """Split the mesh along the coverage iso-line so the glove edge is a clean curve, not a zig-zag."""
    bm = bmesh.new()
    bm.from_mesh(me)
    lay = bm.verts.layers.float.new('cov')
    bm.verts.ensure_lookup_table()
    for v in bm.verts:
        v[lay] = float(cov[v.index])
    cross = [e for e in bm.edges if (e.verts[0][lay] - level) * (e.verts[1][lay] - level) < 0]
    iso = set()
    for e in cross:
        a, b = e.verts
        if (a[lay] - level) * (b[lay] - level) >= 0:   # an earlier snap already put an end on the line
            continue
        fac = (level - a[lay]) / (b[lay] - a[lay])
        if fac < 0.04 or fac > 0.96:
            near = a if fac < 0.5 else b
            near[lay] = level
            iso.add(near)
            continue
        _, nv = bmesh.utils.edge_split(e, a, fac)
        nv[lay] = level
        iso.add(nv)
    for f in list(bm.faces):
        vs = [v for v in f.verts if v in iso]
        if len(vs) == 2 and not any(e for e in vs[0].link_edges if e.other_vert(vs[0]) is vs[1]):
            try:
                bmesh.utils.face_split(f, vs[0], vs[1])
            except Exception:
                pass
    bm.verts.index_update()
    newcov = np.array([v[lay] for v in bm.verts])
    bm.verts.layers.float.remove(lay)
    bm.to_mesh(me)
    bm.free()
    me.update()
    return newcov


def add_glove(ob, names, Wt, T, side, sx, J):
    me = ob.data
    nv = len(me.vertices)
    P = np.zeros(nv * 3)
    me.vertices.foreach_get('co', P)
    P = P.reshape(-1, 3)
    cov = iso_cut(me, glove_mask(names, Wt, T, P, side, me))
    nv = len(me.vertices)
    P = np.zeros(nv * 3)
    me.vertices.foreach_get('co', P)
    P = P.reshape(-1, 3)
    g = cov >= 0.5 - 1e-4
    edge_d = graph_distance_to_edge(me, cov > 0.5 + 1e-4)
    # The glove is the same surface pushed out a little: faces inside the coverage line take the glove
    # materials and their vertices are lifted along the normal, ramping from 0 at the cut over ~2.5 mm, so the
    # glove edge is a clean rolled line with no separate shell to z-fight or poke through.
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    bm.normal_update()
    nrm = [v.normal.copy() for v in bm.verts]
    for v in bm.verts:
        i = v.index
        if not g[i]:
            continue
        p, n = Vector(P[i]), nrm[i]
        off = 0.0021 if (p.y > 0.05 and n.z > 0.3) else 0.0016       # padded back of the hand
        v.co = v.co + n * off * min(1.0, edge_d[i] / 0.0025)
    for f in bm.faces:
        if all(g[v.index] for v in f.verts):
            c = f.calc_center_median()
            n = f.normal
            f.material_index = FABRIC if (n.z > 0.35 and -0.01 < c.y < 0.09) else LEATHER
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    me.update()


def rounded_box(bm, center, xa, ya, za, sx_, sy_, sz_, bevel, mat):
    before = set(bm.faces)
    ret = bmesh.ops.create_cube(bm, size=1.0)
    vs = ret['verts']
    M = Matrix((xa * sx_, ya * sy_, za * sz_)).transposed()
    for v in vs:
        v.co = center + M @ v.co
    try:
        bmesh.ops.bevel(bm, geom=list({e for v in vs for e in v.link_edges}) + vs, offset=bevel, segments=3, profile=0.5, affect='EDGES')
    except Exception:
        pass
    faces = set(bm.faces) - before
    for f in faces:
        f.material_index = mat
    return faces


def add_gear(sx, J):
    """Knuckle guard, back plate and velcro strap as an extra bmesh (hand-local)."""
    bm = bmesh.new()
    Z = V(0, 0, 1)
    for f in FINGERS:
        p = J[f]['pts'][0]
        d = J[f]['frames'][0][0]
        lat = d.cross(Z).normalized()
        w = J[f]['rads'][0]
        c = p + Z * (w * 0.8 + 0.0058) - d * 0.001
        rounded_box(bm, c, lat, d, Z, w * 1.7, 0.017, 0.0062, 0.0024, RUBBER)
    # moulded bridge behind the knuckles, arched across the hand
    faces = rounded_box(bm, V(sx * 0.001, 0.071, 0.0145), V(1, 0, 0), V(0, 1, 0), Z, 0.064, 0.016, 0.0042, 0.0018, RUBBER)
    for v in {v for f in faces for v in f.verts}:
        v.co.z -= 3.0 * (v.co.x ** 2)
    # velcro strap around the wrist + tab
    for y0, y1, dz in ((-0.037, -0.010, 0.0),):   # wide strap: also covers the glove's cuff line
        rings = []
        for y, grow in ((y0, 0.0012), (y0 + 0.003, 0.0034), (y1 - 0.003, 0.0034), (y1, 0.0012)):
            a = 0.0318 + grow
            rings.append(superellipse_ring(V(0, y, dz), V(sx, 0, 0), Z, a, 0.0184 + grow, 0.0192 + grow, n=28, ex=2.2))
        before = set(bm.faces)
        loft(bm, rings)
        for fc in set(bm.faces) - before:
            fc.material_index = VELCRO
    rounded_box(bm, V(-sx * 0.012, -0.019, 0.0225), V(1, 0, 0), V(0, 1, 0), Z, 0.026, 0.017, 0.003, 0.0012, VELCRO)
    return bm


def add_nails(bm, J, skin_bvh):
    for f in list(FINGERS) + ['thumb']:
        pts, frames, rads = J[f]['pts'], J[f]['frames'], J[f]['rads']
        d, u = frames[2]
        lat = d.cross(u).normalized()
        L = (pts[3] - pts[2]).length
        a = rads[2] * (0.78 if f != 'thumb' else 0.82)
        n0 = len(bm.verts)
        grid = []
        NX, NY = 6, 5
        for iy in range(NY):
            row = []
            s = 0.40 + 0.52 * iy / (NY - 1)
            for ix in range(NX):
                q = -1 + 2 * ix / (NX - 1)
                taper = 1.0 - 0.18 * max(0.0, s - 0.85) / 0.15 if s > 0.85 else 1.0
                p = pts[2] + d * (L * s) + lat * (q * a * taper)
                hit = skin_bvh.ray_cast(p + u * 0.02, -u, 0.04)
                if hit[0] is not None:
                    loc, n = hit[0], hit[1]
                    if n.dot(u) < 0:
                        n = -n
                    p = loc + n * 0.00045 + n * 0.0003 * (1 - q * q)
                row.append(bm.verts.new(p))
            grid.append(row)
        for iy in range(NY - 1):
            for ix in range(NX - 1):
                fc = bm.faces.new((grid[iy][ix], grid[iy][ix + 1], grid[iy + 1][ix + 1], grid[iy + 1][ix]))
                fc.material_index = NAIL


# ------------------------------------------------------------------ materials

def tex_image(name, colorspace='sRGB'):
    path = os.path.join(TEX_DIR, name)
    img = bpy.data.images.load(path, check_existing=True)
    try:
        img.colorspace_settings.name = colorspace
    except Exception:
        pass
    try:
        img.pack()
    except Exception:
        pass
    return img


def pbr_material(name, color, rough, albedo=None, normal=None, mr=None, normal_strength=1.0, metal=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    c = bpz_common.srgb_to_linear(color)
    bsdf.inputs['Base Color'].default_value = (c[0], c[1], c[2], 1.0)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if albedo:
        t = nt.nodes.new('ShaderNodeTexImage')
        img = tex_image(albedo)
        if color != 0xffffff:
            img = bpz_common.tinted_image(img, color, name + '_albedo')   # glTF drops the factor once a map is linked
        t.image = img
        nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
    if normal:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = tex_image(normal, 'Non-Color')
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.inputs['Strength'].default_value = normal_strength
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if mr:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = tex_image(mr, 'Non-Color')
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(t.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs[1], bsdf.inputs['Roughness'])
        nt.links.new(sep.outputs[2], bsdf.inputs['Metallic'])
    m.diffuse_color = (c[0], c[1], c[2], 1.0)
    return m


def make_materials():
    return [
        pbr_material('FP_Skin', 0xc0927a, 0.52, 'skin_albedo.jpg', 'skin_normal.png', normal_strength=0.6),
        pbr_material('FP_Nail', 0xe2b4a6, 0.32),
        pbr_material('FP_GloveLeather', 0xffffff, 0.7, 'leather_albedo.jpg', 'leather_normal.png', 'leather_mr.png', normal_strength=0.9),
        pbr_material('FP_GloveFabric', 0xffffff, 0.85, 'fabric_albedo.jpg', 'fabric_normal.png', normal_strength=0.8),
        pbr_material('FP_GloveRubber', 0x232323, 0.45, None, 'leather_normal.png', normal_strength=0.25),
        pbr_material('FP_Velcro', 0xffffff, 0.9, 'velcro_albedo.jpg', 'velcro_normal.png', normal_strength=0.8),
    ]


UV_SCALE = {SKIN: 25.0, NAIL: 60.0, LEATHER: 30.0, FABRIC: 45.0, RUBBER: 40.0, VELCRO: 40.0}


def box_uv_by_material(me):
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    uv = me.uv_layers.active.data
    for poly in me.polygons:
        s = UV_SCALE.get(poly.material_index, 25.0)
        n = poly.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for li in poly.loop_indices:
            v = me.vertices[me.loops[li].vertex_index].co
            if ax == 0:
                a, b = v.y, v.z
            elif ax == 1:
                a, b = v.x, v.z
            else:
                a, b = v.x, v.y
            uv[li].uv = (a * s, b * s)


def paint_skin_colors(me, names, Wt, T, P):
    """Vertex tint: warmer knuckles and fingertips, lighter palm (multiplied with the skin map)."""
    nv = len(me.vertices)
    col = np.tile(np.array([0.95, 0.91, 0.89]), (nv, 1))
    nrm = np.zeros(nv * 3)
    me.vertices.foreach_get('normal', nrm)
    nrm = nrm.reshape(-1, 3)
    dom = np.argmax(Wt, axis=1)
    for k, n in enumerate(names):
        m = dom == k
        if n.endswith('_3'):
            tip = np.clip((T[:, k] - 0.55) / 0.45, 0, 1) * m
            col = col * (1 - tip[:, None] * 0.55) + np.array([1.0, 0.80, 0.77]) * tip[:, None] * 0.55
        if n.endswith('_1') or n.endswith('_2'):
            j = np.clip(1 - np.abs(T[:, k] - 1.0) / 0.25, 0, 1) * m * (nrm[:, 2] > 0.2)
            col = col * (1 - j[:, None] * 0.45) + np.array([0.98, 0.78, 0.74]) * j[:, None] * 0.45
    palm = np.clip(-nrm[:, 2], 0, 1) * (P[:, 1] > -0.03)
    col = col * (1 - palm[:, None] * 0.5) + np.array([1.0, 0.94, 0.90]) * palm[:, None] * 0.5
    try:
        attr = me.color_attributes.new('Col', 'BYTE_COLOR', 'POINT')
    except Exception:
        attr = me.vertex_colors.new(name='Col')
        return
    data = np.concatenate([col, np.ones((nv, 1))], axis=1).astype(np.float32).ravel()
    attr.data.foreach_set('color', data)
    try:
        me.color_attributes.active_color = attr
        me.color_attributes.render_color_index = 0
    except Exception:
        pass


# ------------------------------------------------------------------ one complete arm

def build_arm(side, mats):
    """Returns (object, joints, segment map, sample cache) in hand-local space for 'R' or 'L'."""
    sx = -1 if side == 'R' else 1
    J = layout(sx)
    t0 = time.time()
    ob = build_skin_parts(sx, J)
    remesh_organic(ob)
    ob.name = f'{side}_Arm'
    me = ob.data
    nv = len(me.vertices)
    P = np.zeros(nv * 3)
    me.vertices.foreach_get('co', P)
    P = P.reshape(-1, 3)
    segs = bone_segments(J, side)
    names, Wt, D, T = compute_weights(P, segs)
    Wt = smooth_weights(me, Wt)
    for m in mats:
        me.materials.append(m)
    for poly in me.polygons:
        poly.material_index = SKIN
    paint_skin_colors(me, names, Wt, T, P)
    # write weights before the glove so duplicated / extruded verts inherit them
    groups = {n: ob.vertex_groups.new(name=n) for n in names}
    for k, n in enumerate(names):
        idx = np.nonzero(Wt[:, k] > 1e-3)[0]
        for i in idx:
            groups[n].add([int(i)], float(Wt[i, k]), 'REPLACE')
    add_glove(ob, names, Wt, T, side, sx, J)
    # nails, knuckle guard and strap
    bm = bmesh.new()
    bm.from_mesh(me)
    skin_bvh = BVHTree.FromBMesh(bm)
    gear = add_gear(sx, J)
    add_nails(gear, J, skin_bvh)
    gme = bpy.data.meshes.new('gear')
    gear.to_mesh(gme)
    gear.free()
    gob = bpy.data.objects.new('gear', gme)
    link(gob)
    gP = np.array([v.co[:] for v in gme.vertices])
    gnames, gW, _, gT = compute_weights(gP, segs, power=6.0, band=0.004)
    # gear rides rigidly: guard/strap on the hand (and forearm), nails on the fingertip bones
    gg = {n: gob.vertex_groups.new(name=n) for n in names}
    mats_of_vert = np.zeros(len(gme.vertices), dtype=np.int64)
    for poly in gme.polygons:
        for vi in poly.vertices:
            mats_of_vert[vi] = poly.material_index
    for i in range(len(gme.vertices)):
        if mats_of_vert[i] == NAIL:
            k = int(np.argmax(gW[i]))
            gg[gnames[k]].add([i], 1.0, 'REPLACE')
        elif mats_of_vert[i] == RUBBER:
            gg[f'{side}_hand'].add([i], 1.0, 'REPLACE')
        else:
            for k in np.nonzero(gW[i] > 1e-3)[0]:
                gg[gnames[k]].add([i], float(gW[i, k]), 'REPLACE')
    bm.free()
    for m in mats:
        gme.materials.append(m)
    # join gear into the arm (vertex groups and materials match by name / datablock)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    gob.select_set(True)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = f'{side}_Arm'
    log(f'  arm {side}: {len(ob.data.vertices)} verts, {sum(len(p.vertices) - 2 for p in ob.data.polygons)} tris, {time.time() - t0:.1f}s')
    return ob, J, segs


# ------------------------------------------------------------------ armature

ARM_BONES = ['forearm', 'hand'] + [f'{f}_{j}' for f in FINGERS for j in (1, 2, 3)] + [f'thumb_{j}' for j in (1, 2, 3)]


def joint_frames(J):
    """bone -> (head, tail, dorsal) in hand-local space."""
    out = {'forearm': (J['elbow'], J['wrist'], V(0, 0, 1)),
           'hand': (J['wrist'], J['middle']['pts'][0], V(0, 0, 1))}
    for f in list(FINGERS) + ['thumb']:
        pts, frames = J[f]['pts'], J[f]['frames']
        for j in range(3):
            out[f'{f}_{j + 1}'] = (pts[j], pts[j + 1], frames[j][1])
    return out


def build_armature(arms):
    """arms: {'R': (Wmat, J), 'L': (Wmat, J)} with Wmat hand-local -> armature space."""
    ad = bpy.data.armatures.new('FPRig')
    arm = bpy.data.objects.new('FPRig', ad)
    link(arm)
    bpy.context.view_layer.objects.active = arm
    for o in bpy.context.scene.objects:
        o.select_set(False)
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = ad.edit_bones
    root = eb.new('root')
    root.head = (0, 0, 0)
    root.tail = (0, 0, 0.05)
    mag = eb.new('mag')
    mag.head = (0, -0.078, -0.017)
    mag.tail = (0, -0.078, -0.067)
    mag.parent = root
    for side, (Wm, J) in arms.items():
        fr = joint_frames(J)
        R3 = Wm.to_3x3()
        for b in ARM_BONES:
            h, t, up = fr[b]
            e = eb.new(f'{side}_{b}')
            e.head = Wm @ h
            e.tail = Wm @ t
            e.align_roll(R3 @ up)
        for b in ARM_BONES:
            e = eb[f'{side}_{b}']
            if b == 'forearm':
                e.parent = root
            elif b == 'hand':
                e.parent = eb[f'{side}_forearm']
            elif b.endswith('_1'):
                e.parent = eb[f'{side}_hand']
            else:
                f, j = b.rsplit('_', 1)
                e.parent = eb[f'{side}_{f}_{int(j) - 1}']
                e.use_connect = True
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    return arm


class Poser:
    """Forward kinematics on our own matrices so the grip solver never needs a depsgraph update."""

    def __init__(self, arm):
        self.arm = arm
        self.rest = {b.name: b.matrix_local.copy() for b in arm.data.bones}
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in arm.data.bones}
        self.order = []
        def visit(b):
            self.order.append(b.name)
            for c in b.children:
                visit(c)
        for b in arm.data.bones:
            if b.parent is None:
                visit(b)
        self.basis = {n: Matrix.Identity(4) for n in self.order}

    def reset(self):
        for n in self.order:
            self.basis[n] = Matrix.Identity(4)

    def world(self):
        M = {}
        for n in self.order:
            p = self.parent[n]
            if p is None:
                M[n] = self.rest[n] @ self.basis[n]
            else:
                M[n] = M[p] @ (self.rest[p].inverted() @ self.rest[n]) @ self.basis[n]
        return M

    def set_world(self, n, Mw, M=None):
        """Choose the basis of bone n so its armature-space matrix becomes Mw (parents already posed)."""
        M = M or self.world()
        p = self.parent[n]
        if p is None:
            self.basis[n] = self.rest[n].inverted() @ Mw
        else:
            self.basis[n] = (self.rest[p].inverted() @ self.rest[n]).inverted() @ M[p].inverted() @ Mw

    def apply(self):
        for n in self.order:
            pb = self.arm.pose.bones[n]
            loc, rot, _ = self.basis[n].decompose()
            pb.rotation_quaternion = rot
            pb.location = loc

    def key(self, frame, prev):
        for n in self.order:
            pb = self.arm.pose.bones[n]
            loc, rot, _ = self.basis[n].decompose()
            if n in prev and prev[n].dot(rot) < 0:
                rot.negate()
            prev[n] = rot.copy()
            pb.rotation_quaternion = rot
            pb.location = loc
            pb.keyframe_insert('rotation_quaternion', frame=frame)
            pb.keyframe_insert('location', frame=frame)


# ------------------------------------------------------------------ colliders and grip solving

def collider_from(objs, name, voxel=0.0018):
    parts = []
    for o in objs:
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), depsgraph=dg)
        me.transform(o.matrix_world)
        parts.append(me)
    bm = bmesh.new()
    for me in parts:
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    link(ob)
    m = ob.modifiers.new('Remesh', 'REMESH')
    m.mode = 'VOXEL'
    m.voxel_size = voxel
    apply_modifiers(ob)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    bvh = BVHTree.FromBMesh(bm)
    bm.free()
    ob.hide_render = True
    ob.hide_set(True)
    return bvh, ob


def signed_dist(bvh, p):
    loc, n, _, d = bvh.find_nearest(p)
    if loc is None:
        return 1.0
    return d if (p - loc).dot(n) >= 0 else -d


class Samples:
    """Surface points per bone in the bone's rest space (from the final arm mesh)."""

    def __init__(self, ob, poser, side):
        me = ob.data
        gi = {g.index: g.name for g in ob.vertex_groups}
        self.pts = {}
        Mw = ob.matrix_world
        for v in me.vertices:
            best, bw = None, 0.0
            for g in v.groups:
                if g.weight > bw:
                    best, bw = gi[g.group], g.weight
            if best is None or bw < 0.55 or not best.startswith(side + '_'):
                continue
            self.pts.setdefault(best, []).append(Mw @ v.co)
        for n, lst in self.pts.items():
            inv = poser.rest[n].inverted()
            step = max(1, len(lst) // 140)
            self.pts[n] = [inv @ p for p in lst[::step]]
        hb = f'{side}_hand'
        self.palm = [q for q in self.pts.get(hb, []) if q.z < -0.005]

    def palm_dist(self, bvh, M, side):
        Mb = M[f'{side}_hand']
        best = 1.0
        for q in self.palm:
            d = signed_dist(bvh, Mb @ q)
            if d < best:
                best = d
        return best

    def min_dist(self, bvh, M, bones):
        best = 1.0
        for b in bones:
            Mb = M[b]
            for q in self.pts.get(b, ()):
                d = signed_dist(bvh, Mb @ q)
                if d < best:
                    best = d
        return best


def flex_basis(deg, splay=0.0):
    """Finger joint rotation: flexion about the bone's local X (negative = toward the palm)."""
    q = Quaternion((1, 0, 0), math.radians(-deg))
    if splay:
        q = Quaternion((0, 0, 1), math.radians(splay)) @ q
    return q.to_matrix().to_4x4()


def place_arm(poser, side, Wt, elbow, rest_W):
    """Pose forearm + hand so the hand-local frame lands on Wt (armature space)."""
    M = poser.world()
    fa, hd = f'{side}_forearm', f'{side}_hand'
    L = (poser.rest[fa].to_translation() - (rest_W.to_translation())).length
    wrist = Wt.to_translation()
    d = (wrist - elbow).normalized()
    dorsal = Wt.to_3x3() @ V(0, 0, 1)
    z = (dorsal - d * dorsal.dot(d)).normalized()
    x = d.cross(z)
    Mf = Matrix((x, d, z)).transposed().to_4x4()
    Mf.translation = wrist - d * L
    poser.set_world(fa, Mf, M)
    M = poser.world()
    C = rest_W.inverted() @ poser.rest[hd]
    poser.set_world(hd, Wt @ C, M)


def solve_grip(poser, samples, bvh, side, Wt, elbow, rest_W, plan, margin=0.0012, settle=True, log_name=''):
    """Bring the palm onto the weapon, then curl each finger until it touches (never through) it."""
    place_arm(poser, side, Wt, elbow, rest_W)
    for f in list(FINGERS) + ['thumb']:
        for j in (1, 2, 3):
            poser.basis[f'{side}_{f}_{j}'] = Matrix.Identity(4)
    hand_bones = [f'{side}_hand']
    # slide the whole hand along the palm normal until the palm rests on the weapon
    normal = -(Wt.to_3x3() @ V(0, 0, 1))
    Wcur = Wt.copy()
    if settle:
        lo, hi = -0.03, 0.03
        for _ in range(18):
            mid = (lo + hi) / 2
            Wtry = Wt.copy()
            Wtry.translation = Wt.translation + normal * mid
            place_arm(poser, side, Wtry, elbow, rest_W)
            d = samples.palm_dist(bvh, poser.world(), side)
            if d > margin:
                lo = mid
            else:
                hi = mid
        Wcur = Wt.copy()
        Wcur.translation = Wt.translation + normal * lo
        place_arm(poser, side, Wcur, elbow, rest_W)
    report = {}
    for f, spec in plan.items():
        names = [f'{side}_{f}_{j}' for j in (1, 2, 3)]
        if spec.get('fixed'):
            for j, a in enumerate(spec['fixed']):
                poser.basis[names[j]] = flex_basis(a, spec.get('splay', 0.0) if j == 0 else 0.0)
            report[f] = spec['fixed']
            continue
        ratios = spec.get('ratio', (0.85, 1.0, 0.7))
        maxes = spec.get('max', (85.0, 100.0, 75.0))
        base = spec.get('base', (0.0, 0.0, 0.0))
        splay = spec.get('splay', 0.0)
        ang = list(base)

        def setang():
            for j in range(3):
                poser.basis[names[j]] = flex_basis(ang[j], splay if j == 0 else 0.0)

        if not spec.get('base'):
            ang = [-12.0, -6.0, 0.0]
        setang()
        start = samples.min_dist(bvh, poser.world(), names)
        limit = min(margin, start - 0.0004)
        # stage 1: all joints together, stage 2: middle + tip, stage 3: tip only
        for stage, joints in enumerate(((0, 1, 2), (1, 2), (2,))):
            step = 2.0
            while True:
                trial = ang[:]
                for j in joints:
                    trial[j] = min(maxes[j], trial[j] + step * ratios[j] / max(ratios))
                if trial == ang:
                    break
                old = ang[:]
                ang = trial
                setang()
                d = samples.min_dist(bvh, poser.world(), names[min(joints):])
                if d < limit:
                    ang = old
                    setang()
                    if step > 0.5:
                        step /= 2
                        continue
                    break
        report[f] = [round(a, 1) for a in ang]
    M = poser.world()
    worst = []
    for n in poser.order:
        if n.startswith(side + '_'):
            d = samples.min_dist(bvh, M, [n])
            if d < -0.0005:
                worst.append(f'{n[2:]}:{d * 1000:.0f}')
    log(f'  grip {log_name}{side}: {report}  intersecting(mm): {worst or "none"}')
    return report


# ------------------------------------------------------------------ main

def frame_from(origin, distal, dorsal):
    y = Vector(distal).normalized()
    z = Vector(dorsal)
    z = (z - y * z.dot(y)).normalized()
    x = y.cross(z)
    M = Matrix((x, y, z)).transposed().to_4x4()
    M.translation = Vector(origin)
    return M


def mirror_x(ob):
    me = ob.data
    me.transform(Matrix.Scale(-1, 4, (1, 0, 0)))
    me.flip_normals()
    me.update()


# weapon-space targets (Blender axes)
def place_frame(local_pt, world_pt, x_axis, z_axis):
    """Hand frame with the given lateral (x) and dorsal (z) axes whose hand-local point lands on world_pt."""
    z = Vector(z_axis).normalized()
    x = Vector(x_axis)
    x = (x - z * x.dot(z)).normalized()
    y = z.cross(x)
    M = Matrix((x, y, z)).transposed().to_4x4()
    M.translation = Vector(world_pt) - M.to_3x3() @ Vector(local_pt)
    return M


# Pistol grip: box tilted 19 deg, axis (0, .326, .946), front (0, -.946, .326). The fingers' flexion plane is
# set perpendicular to the grip so they wrap around it; the thumb side (-x for the right hand) points up the
# grip, the back of the hand faces right (-X) and the middle knuckle sits at the grip's front-right edge.
GRIP_AXIS = Vector((0.0, 0.326, 0.946))
GRIP_FRONT = Vector((0.0, -0.946, 0.326))
_grip_mid = Vector((0, 0.012, -0.006)) + GRIP_AXIS * -0.019 + GRIP_FRONT * 0.012 + Vector((-0.024, 0, 0))
RIFLE = {
    'R': dict(W=place_frame((-0.0095, 0.097, -0.002), _grip_mid, -GRIP_AXIS, (-1.0, 0.0, 0.0)), elbow=Vector((-0.10, 0.32, -0.22))),
}
# Support hand under the handguard (axis Y): palm up-right against it, fingers wrap up the right side,
# thumb (+x for the left hand) runs forward along the left side.
_under = Vector((0.30, 0.0, -0.95)).normalized()
RIFLE['L'] = dict(W=place_frame((0, 0.05, -0.013), Vector((0, -0.215, 0.09)) + _under * 0.034, (0, -1, 0), _under), elbow=Vector((0.24, -0.02, -0.20)))
TRIGGER = Vector((0.0, -0.046, 0.012))
VIEW_BASE = (0.10, -0.13, -0.29)   # rifle grip position in the first-person camera (viewmodel.js rifleBase)


def support_frame(center, radius, distal=None, dorsal=None, back=0.05):
    return place_frame((0, 0.05, -0.013), Vector(center) + _under * (radius + 0.001), (0, -1, 0), _under)


LAUNCHER = {
    'R': RIFLE['R'],
    'L': dict(W=support_frame((0, -0.24, 0.085), 0.016), elbow=Vector((0.22, 0.02, -0.25))),
}
THUMB_TARGETS = {
    'rifleR': Vector((0.019, -0.004, 0.012)),     # wrapped over the top, down the left side of the pistol grip
    'rifleL': Vector((0.034, -0.262, 0.088)),     # forward along the left side of the handguard
    'launcherL': Vector((0.018, -0.285, 0.088)),  # along the left of the grip bar
    'magL': Vector((0.016, -0.075, -0.035)),      # up toward the magazine release
}


def grip_plans(launcher=False):
    R = {
        'index': {'trigger': True},
        'middle': {'ratio': (0.9, 1.0, 0.75), 'max': (95, 105, 80), 'splay': 2.0},
        'ring': {'ratio': (0.9, 1.0, 0.75), 'max': (95, 105, 80)},
        'pinky': {'ratio': (0.9, 1.0, 0.75), 'max': (95, 105, 80), 'splay': -3.0},
        'thumb': {'ratio': (0.6, 1.0, 0.8), 'max': (40, 60, 55), 'base': (8, 0, 0)},
    }
    L = {
        'index': {'ratio': (0.8, 1.0, 0.7), 'max': (80, 100, 75), 'splay': 3.0},
        'middle': {'ratio': (0.8, 1.0, 0.7), 'max': (85, 100, 75)},
        'ring': {'ratio': (0.8, 1.0, 0.7), 'max': (85, 100, 75)},
        'pinky': {'ratio': (0.8, 1.0, 0.7), 'max': (85, 100, 75), 'splay': -4.0},
        'thumb': {'ratio': (0.6, 1.0, 0.8), 'max': (35, 50, 50), 'base': (0, 0, 0)},
    }
    return R, L


def solve_trigger(poser, samples, bvh, side, squeeze=0.0):
    """Index finger: pad on the trigger face (squeeze > 0 pulls it). Searches knuckle splay too."""
    names = [f'{side}_index_{j}' for j in (1, 2, 3)]
    b = poser.arm.data.bones[names[2]]
    pad_local = Vector((0.0, b.length * 0.45, -0.0075))
    best = (1e9, 0, 0, 0)
    for sp in range(-24, 25, 6):
        for mcp in range(-10, 72, 4):
            for pip in range(0, 104, 6):
                poser.basis[names[0]] = flex_basis(mcp, sp)
                poser.basis[names[1]] = flex_basis(pip)
                poser.basis[names[2]] = flex_basis(pip * 0.55)
                M = poser.world()
                dist = (M[names[2]] @ pad_local - TRIGGER).length
                if dist > best[0]:
                    continue
                clear = samples.min_dist(bvh, M, names)
                score = dist + max(0.0, -clear - 0.0015) * 3
                if score < best[0]:
                    best = (score, mcp, pip, sp)
    _, mcp, pip, sp = best
    a = (mcp + squeeze * 6, pip + squeeze * 18, pip * 0.55 + squeeze * 12)
    poser.basis[names[0]] = flex_basis(a[0], sp)
    poser.basis[names[1]] = flex_basis(a[1])
    poser.basis[names[2]] = flex_basis(a[2])
    log(f'  trigger finger: mcp {a[0]:.0f} pip {a[1]:.0f} dip {a[2]:.0f} splay {sp}, pad-to-trigger {best[0] * 1000:.1f} mm')
    return a


def solve_reach(poser, samples, bvh, side, finger, target, label=''):
    """Thumb (or any finger) placement: put the pad on `target` by searching base abduction/flexion and
    curl, rejecting poses that push the digit into the weapon."""
    names = [f'{side}_{finger}_{j}' for j in (1, 2, 3)]
    b3 = poser.arm.data.bones[names[2]]
    r = J_RADS_TIP.get(finger, 0.009)
    pad_local = Vector((0.0, b3.length * 0.55, -r * 0.85))
    best = (1e9, None)
    for a1 in range(-50, 56, 6):
        for z1 in range(-64, 65, 8):
            for a2 in range(0, 61, 10):
                ang = (a1, a2, a2 * 0.8)
                poser.basis[names[0]] = (Quaternion((0, 0, 1), math.radians(z1)) @ Quaternion((1, 0, 0), math.radians(-a1))).to_matrix().to_4x4()
                poser.basis[names[1]] = flex_basis(ang[1])
                poser.basis[names[2]] = flex_basis(ang[2])
                M = poser.world()
                pad = M[names[2]] @ pad_local
                dist = (pad - target).length
                if dist > best[0]:
                    continue
                clear = samples.min_dist(bvh, M, names)
                score = dist + max(0.0, -clear - 0.001) * 4
                if score < best[0]:
                    best = (score, (a1, z1, a2))
    a1, z1, a2 = best[1]
    poser.basis[names[0]] = (Quaternion((0, 0, 1), math.radians(z1)) @ Quaternion((1, 0, 0), math.radians(-a1))).to_matrix().to_4x4()
    poser.basis[names[1]] = flex_basis(a2)
    poser.basis[names[2]] = flex_basis(a2 * 0.8)
    clear = samples.min_dist(bvh, poser.world(), names)
    log(f'  reach {label}{side} {finger}: flex {a1} abduct {z1} curl {a2} -> {best[0] * 1000:.1f} mm from target, clearance {clear * 1000:.1f} mm')


J_RADS_TIP = {'thumb': THUMB_RADS[3], 'index': RADS['index'][3], 'middle': RADS['middle'][3], 'ring': RADS['ring'][3], 'pinky': RADS['pinky'][3]}


def snapshot(poser):
    return {n: m.copy() for n, m in poser.basis.items()}


def restore(poser, snap):
    for n, m in snap.items():
        poser.basis[n] = m.copy()


def blend_snap(a, b, t):
    out = {}
    for n in a:
        la, ra, _ = a[n].decompose()
        lb, rb, _ = b[n].decompose()
        if ra.dot(rb) < 0:
            rb = -rb
        M = ra.slerp(rb, t).to_matrix().to_4x4()
        M.translation = la.lerp(lb, t)
        out[n] = M
    return out


def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def new_action(arm, name):
    old = bpy.data.actions.get(name)
    if old:
        bpy.data.actions.remove(old, do_unlink=True)
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = act
    return act


def stash(arm, act):
    try:
        tr = arm.animation_data.nla_tracks.new()
        tr.name = act.name
        st = tr.strips.new(act.name, 0, act)
        st.name = act.name
        tr.mute = True
    except Exception:
        log_exc('nla stash ' + act.name)


def mag_matrix(offset=(0, 0, 0), tilt=0.0, poser=None):
    M = Matrix.Rotation(math.radians(tilt), 4, 'X')
    M.translation = Vector((0, -0.078, -0.017)) + Vector(offset)
    rest = poser.rest['mag']
    return M @ (Matrix.Translation(-Vector((0, -0.078, -0.017))) @ rest)


def build_all():
    t_start = time.time()
    clear_scene()
    scene = bpy.context.scene
    scene.render.fps = FPS
    mats = make_materials()
    # weapons (colliders + preview props; not exported here)
    rifle = W.build_rifle(0, with_mag=False, name='RifleRef')
    magazine = W.build_magazine(0, 'MagRef')
    magazine.location = (0, -0.078, -0.017)
    launcher = W.build_launcher(0, with_warhead=False, name='LauncherRef')
    launcher.hide_set(True)
    launcher.hide_render = True
    bpy.context.view_layer.update()
    rifle_bvh, _ = collider_from([rifle, magazine], 'RifleCollider')
    # the trigger hand curls round the pistol grip itself (fingers sit below the magwell once wrapped)
    gripbox = bpz_common.box('GripBox', (0.033, 0.047, 0.11), (0, 0.012, -0.006), (math.radians(-19), 0, 0))
    grip_bvh, _ = collider_from([gripbox], 'GripCollider', voxel=0.0012)
    gripbox.hide_set(True)
    gripbox.hide_render = True
    launcher_bvh, _ = collider_from([launcher], 'LauncherCollider')
    log('colliders ready')

    built = {}
    for side in ('R', 'L'):
        # the left arm is modelled as a right arm and mirrored, so both share the same anatomy
        ob, J, segs = build_arm('R', mats)
        if side == 'L':
            mirror_x(ob)
            for g in ob.vertex_groups:
                g.name = 'L_' + g.name[2:]
            J = layout(1)
        ob.name = f'{side}_Arm'
        built[side] = (ob, J)
    rest = {s: RIFLE[s]['W'] for s in ('R', 'L')}
    for side, (ob, J) in built.items():
        ob.data.transform(rest[side])
        ob.data.update()
    arm = build_armature({s: (rest[s], built[s][1]) for s in ('R', 'L')})
    for side, (ob, J) in built.items():
        # UVs in hand-local space would be nicer, but box projection in rig space keeps texel density uniform
        box_uv_by_material(ob.data)
        ob.parent = arm
        mod = ob.modifiers.new('Armature', 'ARMATURE')
        mod.object = arm
    log('rig built')

    poser = Poser(arm)
    samples = {s: Samples(built[s][0], poser, s) for s in ('R', 'L')}

    # ---- rifle grip
    planR, planL = grip_plans()
    poser.reset()
    noThumb = lambda plan: {k: v for k, v in plan.items() if k not in ('index', 'thumb')}
    noThumbL = lambda plan: {k: v for k, v in plan.items() if k != 'thumb'}
    solve_grip(poser, samples['R'], grip_bvh, 'R', RIFLE['R']['W'], RIFLE['R']['elbow'], rest['R'], noThumb(planR), log_name='rifle ')
    solve_reach(poser, samples['R'], grip_bvh, 'R', 'thumb', THUMB_TARGETS['rifleR'], 'rifle ')
    trig = solve_trigger(poser, samples['R'], grip_bvh, 'R')
    solve_grip(poser, samples['L'], rifle_bvh, 'L', RIFLE['L']['W'], RIFLE['L']['elbow'], rest['L'], noThumbL(planL), log_name='rifle ')
    solve_reach(poser, samples['L'], rifle_bvh, 'L', 'thumb', THUMB_TARGETS['rifleL'], 'rifle ')
    idle = snapshot(poser)

    # aim: tighter grip, support hand a little further forward and higher on the handguard
    W_aimL = RIFLE['L']['W'].copy()
    W_aimL.translation += Vector((-0.004, -0.018, 0.004))
    solve_grip(poser, samples['L'], rifle_bvh, 'L', W_aimL, RIFLE['L']['elbow'] + Vector((0, -0.05, 0.04)), rest['L'], noThumbL(planL), log_name='aim ')
    solve_reach(poser, samples['L'], rifle_bvh, 'L', 'thumb', THUMB_TARGETS['rifleL'] + Vector((0, -0.018, 0.004)), 'aim ')
    aim = snapshot(poser)
    restore(poser, idle)

    # fire: trigger squeeze
    solve_trigger(poser, samples['R'], grip_bvh, 'R', squeeze=1.0)
    fire_pull = snapshot(poser)
    restore(poser, idle)

    # reload: left hand takes the magazine out and seats a fresh one
    mag_bvh = None
    W_magL = place_frame((0, 0.05, -0.013), (0.018, -0.088, -0.085), (0, 0, 1), (1, 0, 0))   # palm on the left face, thumb up
    magcol, _ = collider_from([magazine], 'MagCollider')
    solve_grip(poser, samples['L'], magcol, 'L', W_magL, Vector((0.25, 0.12, -0.30)), rest['L'], noThumbL(planL), log_name='magazine ')
    solve_reach(poser, samples['L'], magcol, 'L', 'thumb', THUMB_TARGETS['magL'], 'magazine ')
    grab = snapshot(poser)
    restore(poser, idle)

    # ---- launcher grip
    solve_grip(poser, samples['R'], launcher_bvh, 'R', LAUNCHER['R']['W'], LAUNCHER['R']['elbow'], rest['R'], noThumb(planR), log_name='launcher ')
    solve_reach(poser, samples['R'], launcher_bvh, 'R', 'thumb', THUMB_TARGETS['rifleR'], 'launcher ')
    solve_trigger(poser, samples['R'], launcher_bvh, 'R')
    solve_grip(poser, samples['L'], launcher_bvh, 'L', LAUNCHER['L']['W'], LAUNCHER['L']['elbow'], rest['L'], noThumbL(planL), log_name='launcher ')
    solve_reach(poser, samples['L'], launcher_bvh, 'L', 'thumb', THUMB_TARGETS['launcherL'], 'launcher ')
    launcher_idle = snapshot(poser)
    restore(poser, idle)
    log('poses solved')

    # ---- keyframe clips
    clips = []

    def keyed(name, frames, fn):
        act = new_action(arm, name)
        prev = {}
        for f in range(frames + 1):
            snap, magM = fn(f, frames)
            restore(poser, snap)
            if magM is not None:
                poser.basis['mag'] = poser.rest['mag'].inverted() @ magM
            else:
                poser.basis['mag'] = Matrix.Identity(4)
            poser.key(f, prev)
        clips.append(act)
        log(f'  clip {name}: {frames + 1} frames')

    def breathe(f, n):
        s = math.sin(2 * math.pi * f / n)
        snap = {k: m.copy() for k, m in idle.items()}
        for side in ('R', 'L'):
            for fi in FINGERS:
                b = f'{side}_{fi}_2'
                snap[b] = snap[b] @ flex_basis(0.8 * s)
        return snap, None

    keyed('Idle', 60, breathe)
    keyed('Aim', 2, lambda f, n: (aim, None))

    def fire(f, n):
        t = f / n
        k = math.sin(min(1.0, t / 0.35) * math.pi / 2) if t < 0.35 else 1 - ease((t - 0.35) / 0.65)
        return blend_snap(idle, fire_pull, k), None

    keyed('Fire', 6, fire)

    # magazine path keys (seconds, offset, tilt) and hand timing over 1.7 s
    DUR = 1.7
    n_reload = int(DUR * FPS)
    W_away = frame_from((0.10, 0.05, -0.42), (-0.4, -0.3, 0.85), (0.85, 0.3, 0.4))

    def hand_at(Wm, elbow, base_snap):
        restore(poser, base_snap)
        place_arm(poser, 'L', Wm, elbow, rest['L'])
        return snapshot(poser)

    E_mag = Vector((0.25, 0.12, -0.30))
    away = hand_at(W_away, Vector((0.30, 0.2, -0.45)), grab)
    W_low = W_magL.copy()
    W_low.translation += Vector((0.0, 0.0, -0.045))
    low = hand_at(W_low, E_mag, grab)
    restore(poser, grab)
    attach = poser.world()['L_hand'].inverted() @ poser.rest['mag']   # magazine held in the left hand

    def carried(s):
        restore(poser, s)
        return poser.world()['L_hand'] @ attach

    def reload(f, n):
        t = f / FPS
        magM = None
        if t < 0.22:                    # reach to the magazine
            s = blend_snap(idle, grab, ease(t / 0.22))
        elif t < 0.30:                  # grip, press release
            s = grab
        elif t < 0.70:                  # pull it out and drop the hand away
            s = blend_snap(grab, away, ease((t - 0.30) / 0.40))
            magM = carried(s)
        elif t < 0.82:                  # out of view: fetch a fresh one
            s = away
            magM = carried(s)
        elif t < 1.12:                  # bring the new magazine up under the well
            s = blend_snap(away, low, ease((t - 0.82) / 0.30))
            magM = carried(s)
        elif t < 1.24:                  # seat it
            s = blend_snap(low, grab, ease((t - 1.12) / 0.12))
            magM = carried(s)
        elif t < 1.32:                  # slap it home
            k = math.sin((t - 1.24) / 0.08 * math.pi)
            Ws = W_magL.copy()
            Ws.translation += Vector((0, 0, 0.012 * k))
            s = hand_at(Ws, E_mag, grab)
        else:                           # back to the handguard
            s = blend_snap(grab, idle, ease((t - 1.32) / 0.38))
        return s, magM

    keyed('Reload', n_reload, reload)
    keyed('LauncherIdle', 2, lambda f, n: (launcher_idle, None))
    for act in clips:
        stash(arm, act)
    arm.animation_data.action = bpy.data.actions['Idle']
    scene.frame_set(0)
    log('clips keyed')

    # ---- export
    objs = [arm] + [built[s][0] for s in ('R', 'L')]
    path = os.path.join(OUT_MODELS, 'fp_hands.glb')
    export_hands(path, objs)

    # ---- previews
    try:
        render_previews(arm, rifle, magazine, launcher, built)
    except Exception:
        log_exc('previews')
    try:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SOURCE_DIR, 'fp_hands.blend'), copy=True)
    except Exception:
        log_exc('save blend')
    log(f'fp hands done in {time.time() - t_start:.0f}s')


def export_hands(path, objects):
    for ob in bpy.context.scene.objects:
        ob.select_set(False)
    for ob in objects:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    core = dict(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_animations=True)
    tries = [
        dict(export_apply=False, export_skins=True, export_animation_mode='ACTIONS', export_force_sampling=True,
             export_frame_step=1, export_anim_single_armature=True, export_vertex_color='ACTIVE'),
        dict(export_apply=False, export_skins=True, export_animation_mode='ACTIONS', export_force_sampling=True, export_colors=True),
        dict(export_skins=True, export_animation_mode='ACTIONS'),
        {},
    ]
    for e in tries:
        try:
            bpy.ops.export_scene.gltf(**core, **e)
            log('gltf export options:', sorted(e.keys()))
            break
        except TypeError as err:
            log('gltf export option fallback:', err)
    log('exported', path, f'{os.path.getsize(path) / 1024:.0f} KB')


def render_previews(arm, rifle, magazine, launcher, built):
    scene = bpy.context.scene
    for eng in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT', 'BLENDER_WORKBENCH'):
        try:
            scene.render.engine = eng
            break
        except Exception:
            continue
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.film_transparent = False
    world = scene.world or bpy.data.worlds.new('World')
    scene.world = world
    try:
        world.use_nodes = True
        bg = world.node_tree.nodes.get('Background')
        bg.inputs[0].default_value = (0.35, 0.33, 0.30, 1)
        bg.inputs[1].default_value = 0.9
    except Exception:
        pass
    sun_d = bpy.data.lights.new('PreviewSun', 'SUN')
    sun_d.energy = 3.5
    sun = bpy.data.objects.new('PreviewSun', sun_d)
    link(sun)
    sun.rotation_euler = (math.radians(50), math.radians(-20), math.radians(160))
    cam_d = bpy.data.cameras.new('FPCam')
    cam_d.sensor_fit = 'VERTICAL'
    cam_d.angle_y = math.radians(58)
    cam_d.clip_start = 0.01
    cam = bpy.data.objects.new('FPCam', cam_d)
    link(cam)
    scene.camera = cam
    # viewmodel camera: three.js holder at (0.14, -0.195, -0.41) yaw 0.045, frame turned 180 deg about Y;
    # in Blender weapon space the eye sits behind / above / left of the grip.
    def three_to_blender(v):
        return Vector((v[0], -v[2], v[1]))
    H = Matrix.Translation(VIEW_BASE) @ Matrix.Rotation(0.045, 4, 'Y') @ Matrix.Rotation(math.pi, 4, 'Y')
    Hi = H.inverted()
    eye_gl = Hi @ Vector((0, 0, 0))
    fwd_gl = (Hi.to_3x3() @ Vector((0, 0, -1))).normalized()
    up_gl = (Hi.to_3x3() @ Vector((0, 1, 0))).normalized()
    eye, fwd, up = three_to_blender(eye_gl), three_to_blender(fwd_gl), three_to_blender(up_gl)

    def look(pos, f, u):
        z = -f.normalized()
        x = u.cross(z).normalized()
        y = z.cross(x)
        M = Matrix((x, y, z)).transposed().to_4x4()
        M.translation = pos
        cam.matrix_world = M

    # anatomy reference: the right hand in its rest pose, weapon hidden
    for o in (rifle, magazine):
        o.hide_render = True
    built['L'][0].hide_render = True
    arm.data.pose_position = 'REST'
    Wr = RIFLE['R']['W']
    c = Wr @ V(0, 0.045, 0)
    ax = Wr.to_3x3()
    for name, d, u in (('ref_back', ax @ V(0, 0, 1), ax @ V(0, 1, 0)), ('ref_palm', ax @ V(0, 0, -1), ax @ V(0, 1, 0)),
                       ('ref_thumb', ax @ V(1, 0, 0), ax @ V(0, 1, 0)), ('ref_pinky', ax @ V(-1, 0, 0), ax @ V(0, 1, 0))):
        look(c + d * 0.24, -d, u)
        scene.render.filepath = os.path.join(PREVIEW_DIR, name + '.png')
        bpy.ops.render.render(write_still=True)
        log('  preview', name)
    arm.data.pose_position = 'POSE'
    for o in (rifle, magazine):
        o.hide_render = False
    built['L'][0].hide_render = False

    shots = []
    look(eye, fwd, up)
    shots.append(('fp_idle', 'Idle', 0, True))
    shots.append(('fp_reload', 'Reload', 12, True))
    shots.append(('fp_reload2', 'Reload', 33, True))
    for name, act, frame, fp in shots:
        arm.animation_data.action = bpy.data.actions[act]
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        scene.render.filepath = os.path.join(PREVIEW_DIR, name + '.png')
        bpy.ops.render.render(write_still=True)
        log('  preview', name)
    # close-ups of the right and left hand on the weapon
    arm.animation_data.action = bpy.data.actions['Idle']
    scene.frame_set(0)
    for name, pos, target in (('close_right', Vector((-0.20, 0.10, 0.06)), Vector((-0.02, 0.0, 0.0))),
                              ('close_left', Vector((0.22, -0.05, 0.22)), Vector((0.02, -0.2, 0.09))),
                              ('close_under', Vector((0.05, -0.12, -0.20)), Vector((0.0, -0.1, 0.02)))):
        look(pos, target - pos, Vector((0, 0, 1)))
        scene.render.filepath = os.path.join(PREVIEW_DIR, name + '.png')
        bpy.ops.render.render(write_still=True)
        log('  preview', name)
    # launcher grip
    rifle.hide_render = True
    magazine.hide_render = True
    launcher.hide_render = False
    arm.animation_data.action = bpy.data.actions['LauncherIdle']
    scene.frame_set(0)
    look(eye + Vector((0.06, 0.05, 0.12)), fwd, up)
    scene.render.filepath = os.path.join(PREVIEW_DIR, 'fp_launcher.png')
    bpy.ops.render.render(write_still=True)
    launcher.hide_render = True
    rifle.hide_render = False
    magazine.hide_render = False


if __name__ == '__main__':
    bpz_common.reset_log()
    try:
        build_all()
    except Exception:
        log_exc('build_fp_hands')
    log('ALL DONE')
