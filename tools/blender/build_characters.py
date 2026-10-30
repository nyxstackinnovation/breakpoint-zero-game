"""Human soldier characters for Breakpoint Zero.

Builds a skinned, rigged human (body from a Skin-modifier base mesh, separately modelled head with
eyes/brows/ears/lips, hair + headgear variants, gripping gloved hands, boots, plate carrier, belt,
knee pads, armband), rifle + launcher on a Weapon bone, and procedurally authored animations:
Idle, Walk, Run, Back, StrafeL, StrafeR, Jump, DeathBack, DeathFront, DeathHead.

Exports:
  client/assets/models/human_soldier.glb  (character + animations)
  client/assets/models/fp_arms.glb        (first-person arms in rifle space + EyeFP marker)
"""
import bpy
import bmesh
import math
import os
import random
from mathutils import Vector, Matrix, Quaternion, Euler

from bpz_common import (log, log_exc, clear_scene, link, material, material_with_image, make_image, box, cylinder,
                        sphere, join, smooth, apply_modifiers, box_uv, export_glb, save_blend, new_object, OUT_MODELS)
import build_weapons as W

FPS = 30

# ------------------------------------------------------------------ skeleton (Blender space: Z up, faces -Y, left = +X)

def mirror(p):
    return (-p[0], p[1], p[2])


BONES = []  # (name, head, tail, parent, connect)


def add_bone(name, head, tail, parent=None, connect=False):
    BONES.append((name, Vector(head), Vector(tail), parent, connect))


add_bone('Root', (0, 0, 0), (0, 0.3, 0))
add_bone('Hips', (0, 0.01, 0.95), (0, 0.01, 1.07), 'Root')
add_bone('Spine', (0, 0.01, 1.07), (0, 0.005, 1.21), 'Hips', True)
add_bone('Chest', (0, 0.005, 1.21), (0, 0.0, 1.34), 'Spine', True)
add_bone('UpperChest', (0, 0.0, 1.34), (0, 0.005, 1.47), 'Chest', True)
add_bone('Neck', (0, 0.005, 1.47), (0, 0.0, 1.58), 'UpperChest', True)
add_bone('Head', (0, 0.0, 1.58), (0, 0.0, 1.80), 'Neck', True)
for s, sx in (('L', 1), ('R', -1)):
    def P(x, y, z):
        return (x * sx, y, z)
    add_bone(f'Shoulder.{s}', P(0.03, 0.01, 1.43), P(0.19, 0.012, 1.42), 'UpperChest')
    add_bone(f'UpperArm.{s}', P(0.19, 0.012, 1.42), P(0.385, 0.02, 1.245), f'Shoulder.{s}', True)
    add_bone(f'LowerArm.{s}', P(0.385, 0.02, 1.245), P(0.545, 0.03, 1.085), f'UpperArm.{s}', True)
    add_bone(f'Hand.{s}', P(0.545, 0.03, 1.085), P(0.6, 0.035, 1.03), f'LowerArm.{s}', True)
    add_bone(f'UpperLeg.{s}', P(0.095, 0.01, 0.92), P(0.103, -0.005, 0.5), 'Hips')
    add_bone(f'LowerLeg.{s}', P(0.103, -0.005, 0.5), P(0.113, 0.015, 0.09), f'UpperLeg.{s}', True)
    add_bone(f'Foot.{s}', P(0.113, 0.015, 0.09), P(0.12, -0.12, 0.025), f'LowerLeg.{s}', True)

BONE_RADIUS = {
    'Hips': 0.15, 'Spine': 0.14, 'Chest': 0.155, 'UpperChest': 0.16, 'Neck': 0.06, 'Head': 0.1,
    'Shoulder': 0.075, 'UpperArm': 0.055, 'LowerArm': 0.045, 'Hand': 0.04, 'UpperLeg': 0.085, 'LowerLeg': 0.06, 'Foot': 0.05,
}
DEFORM = [b[0] for b in BONES if b[0] not in ('Root',)]


def bone_radius(name):
    return BONE_RADIUS[name.split('.')[0]]


def build_armature():
    arm_data = bpy.data.armatures.new('SoldierRig')
    arm = bpy.data.objects.new('Soldier', arm_data)
    link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones
    for name, head, tail, parent, connect in BONES:
        b = eb.new(name)
        b.head = head
        b.tail = tail
        b.roll = 0
        if parent:
            b.parent = eb[parent]
            b.use_connect = connect
    # weapon bone: oriented like the rifle frame, set later by matrix
    wb = eb.new('Weapon')
    wb.head = (-0.12, -0.32, 1.31)
    wb.tail = (-0.12, -0.12, 1.31)
    wb.parent = eb['UpperChest']
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm


def set_weapon_rest(arm, mat):
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    wb = arm.data.edit_bones['Weapon']
    wb.matrix = mat
    wb.length = 0.2
    bpy.ops.object.mode_set(mode='OBJECT')


# ------------------------------------------------------------------ pose solver

class Rig:
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
        self.local = {}
        for n in self.order:
            p = self.parent[n]
            self.local[n] = (self.rest[p].inverted() @ self.rest[n]) if p else self.rest[n].copy()
        self.restrot = {n: self.rest[n].to_3x3().to_4x4() for n in self.order}
        self.restq = {n: self.rest[n].to_quaternion() for n in self.order}

    def head_of(self, name, parentB):
        return (parentB @ self.local[name]).translation.copy()

    def place(self, name, head, acc):
        return Matrix.Translation(head) @ acc.to_matrix().to_4x4() @ self.restrot[name]

    def basis(self, poses):
        out = {}
        for n in self.order:
            B = poses[n]
            p = self.parent[n]
            if p:
                out[n] = self.local[n].inverted() @ (poses[p].inverted() @ B)
            else:
                out[n] = self.rest[n].inverted() @ B
        return out


def qe(x=0.0, y=0.0, z=0.0):
    return Euler((x, y, z), 'XYZ').to_quaternion()


def ydir(B):
    return Vector((B[0][1], B[1][1], B[2][1])).normalized()


# hand canonical frames (rest): g = index->pinky stacking, f = fingers, p = palm normal
HAND_GRIP_CENTER = Vector((0.0, 0.075, 0.024))  # (g, f, p) coordinates of the held cylinder axis


def hand_rest_frame(rig, side):
    B = rig.rest[f'Hand.{side}']
    f = ydir(B)
    inward = Vector((-1, 0, 0)) if side == 'L' else Vector((1, 0, 0))
    p = (inward - f * inward.dot(f)).normalized()
    g = f.cross(p).normalized()
    if g.y < 0:
        g = -g
    sign = 1.0 if f.dot(g.cross(p)) > 0 else -1.0
    return g, f, p, sign


def frame_matrix(g, f, p):
    m = Matrix.Identity(3)
    for i in range(3):
        m[i][0] = g[i]
        m[i][1] = f[i]
        m[i][2] = p[i]
    return m


class Poser:
    """Builds full-body poses from high level parameters."""

    def __init__(self, rig):
        self.rig = rig
        self.hand = {s: hand_rest_frame(rig, s) for s in ('L', 'R')}
        self.L_ref = None  # rifle frame relative to UpperChest

    def solve(self, P):
        rig = self.rig
        poses, acc = {}, {}
        root_q = qe(*P.get('root_rot', (0, 0, 0)))
        root_loc = Vector(P.get('root_loc', (0, 0, 0)))
        Mroot = Matrix.Translation(root_loc) @ root_q.to_matrix().to_4x4()
        poses['Root'] = rig.place('Root', root_loc, root_q)
        acc['Root'] = root_q
        to_world = lambda v: (Mroot @ Vector(v))

        def fk(name, euler=None, offset=None):
            p = rig.parent[name]
            head = rig.head_of(name, poses[p])
            if offset is not None:
                head += root_q @ Vector(offset)
            a = acc[p] @ qe(*euler) if euler else acc[p]
            acc[name] = a
            poses[name] = rig.place(name, head, a)

        def aim(name, target):
            p = rig.parent[name]
            head = rig.head_of(name, poses[p])
            B0 = rig.place(name, head, acc[p])
            q = ydir(B0).rotation_difference((target - head).normalized())
            acc[name] = q @ acc[p]
            poses[name] = rig.place(name, head, acc[name])

        def two_bone(up, lo, target, pole):
            p = rig.parent[up]
            a = rig.head_of(up, poses[p])
            la = (rig.rest[up].translation - rig.rest[lo].translation).length
            end = {'LowerArm': 'Hand', 'LowerLeg': 'Foot'}[lo.split('.')[0]] + '.' + lo.split('.')[1]
            lb = (rig.rest[lo].translation - rig.rest[end].translation).length
            to = target - a
            d = min(max(to.length, 0.05), la + lb - 1e-4)
            dirv = to.normalized()
            cos_a = (la * la + d * d - lb * lb) / (2 * la * d)
            ang = math.acos(max(-1.0, min(1.0, cos_a)))
            perp = (pole - dirv * pole.dot(dirv))
            if perp.length < 1e-6:
                perp = Vector((0, -1, 0))
            perp.normalize()
            elbow = a + dirv * math.cos(ang) * la + perp * math.sin(ang) * la
            aim(up, elbow)
            aim(lo, a + dirv * d)

        fk('Hips', P.get('hips_rot'), P.get('hips_off', (0, 0, 0)))
        sp = P.get('spine', {})
        for n in ('Spine', 'Chest', 'UpperChest', 'Neck', 'Head'):
            fk(n, sp.get(n))
        for s in ('L', 'R'):
            fk(f'Shoulder.{s}', P.get('shoulder', {}).get(s))
        # weapon
        Bw = None
        if self.L_ref is not None:
            Bw = poses['UpperChest'] @ self.L_ref
            if 'weapon_off' in P:
                Bw = Bw @ P['weapon_off']
        if 'weapon' in P:
            Bw = P['weapon']
        if Bw is None:
            Bw = rig.place('Weapon', rig.head_of('Weapon', poses['UpperChest']), acc['UpperChest'])
        poses['Weapon'] = Bw
        acc['Weapon'] = Bw.to_quaternion() @ rig.restq['Weapon'].inverted()
        # arms
        arms = P.get('arms', 'rifle')
        for s in ('L', 'R'):
            if arms == 'rifle':
                left_axis = Vector((Bw[0][0], Bw[1][0], Bw[2][0])).normalized()
                F = -Vector((Bw[0][1], Bw[1][1], Bw[2][1])).normalized()
                U = Vector((Bw[0][2], Bw[1][2], Bw[2][2])).normalized()
                Rt = -left_axis
                if s == 'R':
                    center = Bw.translation.copy()
                    g_t = (-U * 0.946 - F * 0.326).normalized()
                    p_t = -Rt
                    pole = (Rt * 0.9 + Vector((0, 0, -1)) + Vector((0, 0.35, 0))).normalized()
                else:
                    center = Bw @ Vector(W.SUPPORT_POINT)
                    g_t = -F
                    p_t = U
                    pole = (-Rt * 0.6 + Vector((0, 0, -1)) + Vector((0, 0.1, 0))).normalized()
            else:
                spec = arms[s]
                center = to_world(spec['hand'])
                g_t = (root_q @ Vector(spec.get('g', (0, 1, 0)))).normalized()
                p_t = (root_q @ Vector(spec.get('p', (-1 if s == 'L' else 1, 0, 0)))).normalized()
                pole = (root_q @ Vector(spec.get('pole', (0.3 if s == 'L' else -0.3, 0.3, -1)))).normalized()
            g0, f0, p0, sign = self.hand[s]
            p_t = (p_t - g_t * p_t.dot(g_t)).normalized()
            f_t = (g_t.cross(p_t) * sign).normalized()
            c = HAND_GRIP_CENTER
            wrist = center - (g_t * c.x + f_t * c.y + p_t * c.z)
            two_bone(f'UpperArm.{s}', f'LowerArm.{s}', wrist, pole)
            hn = f'Hand.{s}'
            head = rig.head_of(hn, poses[f'LowerArm.{s}'])
            Rd = frame_matrix(g_t, f_t, p_t) @ frame_matrix(g0, f0, p0).inverted()
            qd = Rd.to_quaternion()
            acc[hn] = qd
            poses[hn] = rig.place(hn, head, qd)
        # legs
        legs = P.get('legs', {})
        for s, sx in (('L', 1), ('R', -1)):
            spec = legs.get(s, {})
            ankle = to_world(spec.get('ankle', (0.12 * sx, 0.0, 0.09)))
            toe = to_world(spec.get('toe', (0.13 * sx, -0.14, 0.03)))
            pole = (root_q @ Vector(spec.get('pole', (0.1 * sx, -1, 0)))).normalized()
            two_bone(f'UpperLeg.{s}', f'LowerLeg.{s}', ankle, pole)
            aim(f'Foot.{s}', toe)
        return poses


# ------------------------------------------------------------------ meshes

def camo_image():
    try:
        import numpy as np
        rng = np.random.default_rng(7)
        N = 256

        def layer(cells, seed):
            r = np.random.default_rng(seed).random((cells, cells))
            k = N // cells
            up = np.kron(r, np.ones((k, k)))
            for _ in range(3):
                up = (up + np.roll(up, k // 2, 0) + np.roll(up, -k // 2, 0) + np.roll(up, k // 2, 1) + np.roll(up, -k // 2, 1)) / 5
            return (up - up.min()) / (up.max() - up.min() + 1e-9)

        n = layer(8, 1) * 0.55 + layer(16, 2) * 0.3 + layer(32, 3) * 0.15
        tone = np.select([n < 0.38, n < 0.52, n < 0.66], [0.62, 0.78, 0.9], 1.0)
        grain = rng.random((N, N)) * 0.06
        v = np.clip(tone - grain, 0, 1)
        weave = 0.97 + 0.03 * ((np.add.outer(np.arange(N), np.arange(N)) % 2))
        v = v * weave
        rgba = np.stack([v, v * 0.98, v * 0.94, np.ones_like(v)], -1).astype(np.float32)
        return make_image('CamoTex', N, rgba.ravel())
    except Exception:
        log_exc('camo_image (numpy unavailable?)')
        return None


def build_body(mats):
    """Skin-modifier base mesh -> subdivided organic body."""
    verts, edges, radius = [], [], []

    def V(p, r):
        verts.append(p)
        radius.append(r)
        return len(verts) - 1

    pel = V((0, 0.01, 0.93), 0.14)
    waist = V((0, 0.012, 1.06), 0.128)
    chest = V((0, 0.0, 1.22), 0.15)
    upch = V((0, 0.0, 1.36), 0.158)
    nb = V((0, 0.012, 1.47), 0.064)
    nt = V((0, 0.012, 1.60), 0.056)
    edges += [(pel, waist), (waist, chest), (chest, upch), (upch, nb), (nb, nt)]
    for sx in (1, -1):
        cl = V((0.09 * sx, 0.01, 1.43), 0.07)
        sh = V((0.19 * sx, 0.012, 1.42), 0.064)
        bi = V((0.29 * sx, 0.016, 1.33), 0.05)
        el = V((0.385 * sx, 0.02, 1.245), 0.041)
        fa = V((0.455 * sx, 0.025, 1.17), 0.043)
        wr = V((0.545 * sx, 0.03, 1.085), 0.031)
        edges += [(upch, cl), (cl, sh), (sh, bi), (bi, el), (el, fa), (fa, wr)]
        hp = V((0.09 * sx, 0.01, 0.88), 0.095)
        th = V((0.098 * sx, 0.004, 0.70), 0.081)
        kn = V((0.103 * sx, -0.005, 0.50), 0.057)
        ca = V((0.108 * sx, 0.012, 0.33), 0.06)
        an = V((0.113 * sx, 0.015, 0.11), 0.041)
        edges += [(pel, hp), (hp, th), (th, kn), (kn, ca), (ca, an)]
    me = bpy.data.meshes.new('BodyBase')
    me.from_pydata(verts, edges, [])
    me.update()
    ob = new_object('Body', me)
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
    # anatomical shaping
    for v in ob.data.vertices:
        x, y, z = v.co
        if 0.84 < z < 1.5 and abs(x) < 0.22:
            k = 1.0 if z < 1.44 else max(0.0, 1 - (z - 1.44) / 0.06)
            yc = 0.008
            v.co.y = yc + (y - yc) * (1 - 0.28 * k)
            if 1.24 < z < 1.42 and y < -0.02 and abs(x) < 0.15:
                v.co.y -= 0.012 * math.sin((z - 1.24) / 0.18 * math.pi)
            if 0.84 < z < 0.97 and y > 0.03:
                v.co.y += 0.018 * math.sin((z - 0.84) / 0.13 * math.pi)
        if 1.36 < z < 1.48 and 0.12 < abs(x) < 0.24:
            v.co.z += 0.012  # trapezius / deltoid slope
    smooth(ob, 180)
    box_uv(ob, 4.0)
    for m in (mats['Shirt'], mats['Pants'], mats['Skin']):
        ob.data.materials.append(m)
    return ob


def build_head(mats, Hhead):
    """Sculpted-by-code head in world space at the Head bone."""
    base = Vector(Hhead)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=30, radius=1.0)
    g = lambda d2, s: math.exp(-d2 / s)
    for v in bm.verts:
        u, w, h = v.co.x, -v.co.y, v.co.z  # u: left/right, w: front(+), h: up
        x, y, z = u * 0.074, -w * 0.096, h * 0.115
        if h < -0.15:
            t = min(1.0, (-0.15 - h) / 0.85)
            x *= 1 - 0.24 * t
            if w > 0:
                y -= 0.012 * t * w
        if w < 0 and h > -0.2:
            y += 0.006 * (-w)
        if w > 0.5:
            nose = 0.024 * g(u * u, 0.012) * g((h + 0.04) ** 2, 0.02) * (h < 0.12)
            tip = 0.01 * g(u * u, 0.006) * g((h + 0.17) ** 2, 0.004)
            y -= nose + tip
            brow = 0.007 * g((h - 0.26) ** 2, 0.006) * g(u * u, 0.25)
            y -= brow
            for ex in (-0.4, 0.4):
                y += 0.009 * g((u - ex) ** 2, 0.02) * g((h - 0.15) ** 2, 0.008)
            cheek = 0.004 * (g((abs(u) - 0.55) ** 2, 0.03) * g(h * h, 0.02))
            x += cheek * (1 if u > 0 else -1)
            y += 0.003 * g(u * u, 0.03) * g((h + 0.36) ** 2, 0.0015)
            y -= 0.004 * g(u * u, 0.05) * g((h + 0.42) ** 2, 0.003)
            y -= 0.006 * g(u * u, 0.05) * g((h + 0.62) ** 2, 0.01)
        v.co = Vector((x, y, z))
    me = bpy.data.meshes.new('Head')
    bm.to_mesh(me)
    bm.free()
    ob = new_object('Head', me)
    me.materials.append(mats['Skin'])
    me.materials.append(mats['Lips'])
    for poly in me.polygons:
        c = poly.center
        if c.y < -0.07 and abs(c.x) < 0.024 and -0.05 < c.z < -0.035:
            poly.material_index = 1
    ob.location = base + Vector((0, -0.005, 0.105))
    smooth(ob, 180)
    parts = [ob]
    hc = ob.location.copy()
    for sx in (1, -1):
        eye = sphere(f'eye{sx}', 0.0115, hc + Vector((0.032 * sx, -0.0705, 0.017)), mat=mats['EyeWhite'], segs=16, rings=12)
        iris = cylinder(f'iris{sx}', 0.0062, 0.0062, 0.002, hc + Vector((0.032 * sx, -0.0815, 0.017)), (math.radians(90), 0, 0), mat=mats['Iris'], segs=14)
        pupil = cylinder(f'pupil{sx}', 0.003, 0.003, 0.002, hc + Vector((0.032 * sx, -0.0823, 0.017)), (math.radians(90), 0, 0), mat=mats['Pupil'], segs=10)
        brow = box(f'brow{sx}', (0.03, 0.008, 0.006), hc + Vector((0.034 * sx, -0.081, 0.036)), (0, 0.12 * sx, 0), mat=mats['Hair'], bevel=0.002)
        ear = sphere(f'ear{sx}', 1.0, hc + Vector((0.074 * sx, 0.006, 0.0)), (0.011, 0.024, 0.033), mat=mats['Skin'], segs=12, rings=10)
        parts += [eye, iris, pupil, brow, ear]
    head = join(parts, 'Head')
    smooth(head, 50)
    return head, hc


def shell(name, hc, scale, keep, mat, noise=0.0, seed=1):
    """Head-shaped shell (hair, beard, beanie...) keeping vertices where keep(u, w, h) is true."""
    rnd = random.Random(seed)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=36, v_segments=26, radius=1.0)
    kill = [v for v in bm.verts if not keep(v.co.x, -v.co.y, v.co.z)]
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    for v in bm.verts:
        n = 1 + noise * (rnd.random() - 0.5)
        v.co = Vector((v.co.x * 0.074 * scale[0] * n, v.co.y * 0.096 * scale[1] * n, v.co.z * 0.115 * scale[2] * n))
    bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.004)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = new_object(name, me)
    me.materials.append(mat)
    ob.location = hc
    smooth(ob, 180)
    return ob


def hairline(u, w, h):
    if w > 0.2:
        return h > 0.42 - 0.1 * abs(u)
    if w > -0.3:
        return h > 0.12 or (abs(u) > 0.85 and h > -0.05 and w < 0.1)
    return h > -0.38


def build_headgear(mats, hc):
    out = []
    out.append(shell('Var_HairShort', hc, (1.1, 1.12, 1.07), hairline, mats['Hair'], noise=0.012, seed=2))
    out.append(shell('Var_HairBuzz', hc, (1.06, 1.09, 1.035), hairline, mats['Hair'], noise=0.0, seed=3))
    out.append(shell('Var_Beard', hc, (1.07, 1.06, 1.04),
                     lambda u, w, h: w > 0.05 and -0.95 < h < -0.12 and not (abs(u) < 0.32 and -0.46 < h < -0.3) and abs(u) < 0.95,
                     mats['Hair'], noise=0.015, seed=4))
    # helmet
    helmet = shell('Var_Helmet', hc + Vector((0, 0.006, 0.012)), (1.33, 1.24, 1.2), lambda u, w, h: h > (0.08 if w > 0.3 else -0.1), mats['HelmetMat'], noise=0.0)
    parts = [helmet]
    parts.append(box('nvgmount', (0.035, 0.02, 0.03), hc + Vector((0, -0.112, 0.08)), mat=mats['Metal'], bevel=0.004))
    for sx in (1, -1):
        parts.append(box(f'rail{sx}', (0.012, 0.09, 0.016), hc + Vector((0.098 * sx, -0.005, 0.03)), mat=mats['Webbing'], bevel=0.002))
    parts.append(box('helmetband', (0.17, 0.2, 0.012), hc + Vector((0, 0.0, 0.055)), mat=mats['TeamAccent'], bevel=0.004))
    h2 = join(parts, 'Var_Helmet')
    smooth(h2, 45)
    out.append(h2)
    # cap
    cap = shell('cap_crown', hc + Vector((0, 0, 0.01)), (1.12, 1.1, 1.08), lambda u, w, h: h > 0.18, mats['CapMat'])
    brim = box('cap_brim', (0.15, 0.09, 0.008), hc + Vector((0, -0.125, 0.045)), (math.radians(-8), 0, 0), mat=mats['CapMat'], bevel=0.003)
    capj = join([cap, brim], 'Var_Cap')
    smooth(capj, 45)
    out.append(capj)
    # beanie
    out.append(shell('Var_Beanie', hc + Vector((0, 0.004, 0.012)), (1.12, 1.1, 1.12), lambda u, w, h: h > (0.25 if w > 0.3 else 0.05), mats['BeanieMat'], noise=0.02))
    # headset
    hs = []
    for sx in (1, -1):
        hs.append(cylinder(f'cup{sx}', 0.034, 0.034, 0.03, hc + Vector((0.087 * sx, 0.004, 0.0)), (0, math.radians(90), 0), mat=mats['Metal'], segs=16, bevel=0.004))
    hs.append(cylinder('mic', 0.003, 0.003, 0.08, hc + Vector((0.07, -0.06, -0.04)), (math.radians(80), 0, math.radians(30)), mat=mats['Metal'], segs=6))
    hsj = join(hs, 'Var_Headset')
    smooth(hsj, 45)
    out.append(hsj)
    return out


def build_hand(mats, rig, side):
    g, f, p, sign = hand_rest_frame(rig, side)
    B = rig.rest[f'Hand.{side}']
    wrist = B.translation
    M = frame_matrix(g, f, p)
    parts = []

    def put(ob, local_pos, local_dir=None):
        ob.location = wrist + M @ Vector(local_pos)
        if local_dir is not None:
            d = (M @ Vector(local_dir)).normalized()
            ob.rotation_mode = 'QUATERNION'
            ob.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d)
        return ob

    Mrot = frame_matrix(g, f, g.cross(f).normalized())  # proper rotation for symmetric parts
    palm = box('palm', (0.08, 0.085, 0.03), (0, 0, 0), mat=mats['Gloves'], bevel=0.01)
    palm.data.transform(Mrot.to_4x4())
    palm.location = wrist + M @ Vector((0, 0.05, 0.0))
    parts.append(palm)
    knuck = box('knuckle', (0.07, 0.025, 0.012), (0, 0, 0), mat=mats['Webbing'], bevel=0.004)
    knuck.data.transform(Mrot.to_4x4())
    knuck.location = wrist + M @ Vector((0, 0.07, -0.017))
    parts.append(knuck)
    for i, gx in enumerate((-0.029, -0.0095, 0.0095, 0.028)):
        scale = 0.82 if i == 3 else 1.0
        pos = Vector((gx, 0.09, 0.004))
        d = Vector((0, 1, 0))
        for j, (ln, ang) in enumerate(((0.038, 55), (0.026, 75), (0.021, 60))):
            ln *= scale
            a = math.radians(ang)
            d = Vector((0, d.y * math.cos(a) - d.z * math.sin(a), d.y * math.sin(a) + d.z * math.cos(a))).normalized() if j else Vector((0, math.cos(a * 0.6), math.sin(a * 0.6)))
            seg = cylinder(f'f{i}{j}', 0.0093, 0.0088, ln + 0.008, (0, 0, 0), mat=mats['Gloves'], segs=8)
            put(seg, pos + d * (ln / 2), d)
            parts.append(seg)
            pos = pos + d * ln
    tpos = Vector((-0.035, 0.025, 0.012))
    td = Vector((-0.15, 0.55, 0.8)).normalized()
    for j, ln in enumerate((0.034, 0.028)):
        seg = cylinder(f't{j}', 0.0105, 0.0095, ln + 0.008, (0, 0, 0), mat=mats['Gloves'], segs=8)
        put(seg, tpos + td * (ln / 2), td)
        parts.append(seg)
        tpos = tpos + td * ln
        td = Vector((td.x + 0.35, td.y + 0.2, td.z - 0.1)).normalized()
    cuff = cylinder('cuff', 0.036, 0.034, 0.05, (0, 0, 0), mat=mats['Gloves'], segs=14)
    put(cuff, (0, -0.005, 0), (0, 1, 0))
    parts.append(cuff)
    hand = join(parts, f'Hand_{side}')
    smooth(hand, 50)
    return hand


def build_boots(mats, side):
    sx = 1 if side == 'L' else -1
    ax, ay = 0.113 * sx, 0.015
    sole = box('sole', (0.11, 0.29, 0.03), (ax + 0.004 * sx, ay - 0.05, 0.015), mat=mats['Rubber'], bevel=0.008)
    foot = box('foot', (0.1, 0.25, 0.08), (ax + 0.004 * sx, ay - 0.045, 0.06), mat=mats['Boots'], bevel=0.025)
    toe = box('toecap', (0.095, 0.06, 0.06), (ax + 0.005 * sx, ay - 0.15, 0.05), mat=mats['Boots'], bevel=0.02)
    footj = join([sole, foot, toe], f'BootFoot_{side}')
    smooth(footj, 40)
    shaft = cylinder('shaft', 0.05, 0.045, 0.16, (ax, ay + 0.005, 0.15), mat=mats['Boots'], segs=16, bevel=0.004)
    lace = box('laces', (0.04, 0.012, 0.12), (ax, ay - 0.045, 0.13), mat=mats['Webbing'], bevel=0.003)
    shaftj = join([shaft, lace], f'BootShaft_{side}')
    smooth(shaftj, 40)
    return footj, shaftj


def build_gear(mats):
    gear = {}
    vest = [box('front', (0.31, 0.055, 0.32), (0, -0.115, 1.25), mat=mats['Vest'], bevel=0.02),
            box('back', (0.31, 0.05, 0.34), (0, 0.13, 1.25), mat=mats['Vest'], bevel=0.02)]
    for sx in (1, -1):
        vest.append(box(f'cumm{sx}', (0.035, 0.22, 0.17), (0.16 * sx, 0.01, 1.17), mat=mats['Vest'], bevel=0.012))
        vest.append(box(f'strap{sx}', (0.07, 0.28, 0.025), (0.1 * sx, 0.005, 1.46), (math.radians(0), 0, 0), mat=mats['Webbing'], bevel=0.008))
    for i, px in enumerate((-0.085, 0.0, 0.085)):
        vest.append(box(f'magp{i}', (0.072, 0.045, 0.11), (px, -0.155, 1.16), mat=mats['Vest'], bevel=0.008))
        vest.append(box(f'magflap{i}', (0.074, 0.05, 0.025), (px, -0.157, 1.22), mat=mats['Webbing'], bevel=0.006))
    vest.append(box('admin', (0.14, 0.03, 0.08), (0, -0.15, 1.32), mat=mats['Webbing'], bevel=0.006))
    vest.append(box('patch', (0.07, 0.008, 0.045), (0.07, -0.168, 1.33), mat=mats['TeamAccent'], bevel=0.002))
    vest.append(box('radio', (0.06, 0.05, 0.13), (0.17, 0.06, 1.25), mat=mats['Webbing'], bevel=0.008))
    vest.append(cylinder('antenna', 0.004, 0.003, 0.22, (0.18, 0.08, 1.42), mat=mats['Metal'], segs=6))
    gear['Vest'] = join(vest, 'Vest')
    belt = [cylinder('belt', 0.165, 0.16, 0.05, (0, 0.012, 0.97), mat=mats['Webbing'], segs=24)]
    belt[0].scale = (1.0, 0.78, 1.0)
    belt.append(box('buckle', (0.05, 0.012, 0.04), (0, -0.115, 0.97), mat=mats['Metal'], bevel=0.003))
    for i, ang in enumerate((-2.2, -1.0, 1.0, 2.2, 3.14)):
        x, y = math.sin(ang) * 0.165, -math.cos(ang) * 0.13
        belt.append(box(f'bpouch{i}', (0.06, 0.04, 0.07), (x, y + 0.012, 0.95), (0, 0, -ang), mat=mats['Vest'], bevel=0.006))
    gear['Belt'] = join(belt, 'Belt')
    collar = cylinder('collar', 0.078, 0.07, 0.05, (0, 0.01, 1.475), mat=mats['Shirt'], segs=20, bevel=0.006)
    gear['Collar'] = collar
    holster = [box('holster', (0.05, 0.09, 0.17), (-0.17, 0.0, 0.78), mat=mats['Webbing'], bevel=0.01),
               box('pistolgrip', (0.03, 0.04, 0.05), (-0.17, 0.0, 0.88), mat=mats['Rubber'], bevel=0.006),
               box('legstrap', (0.12, 0.13, 0.025), (-0.12, 0.004, 0.74), mat=mats['Webbing'], bevel=0.004)]
    gear['Holster'] = join(holster, 'Holster')
    for s, sx in (('L', 1), ('R', -1)):
        kp = box(f'kneepad{s}', (0.09, 0.04, 0.1), (0.104 * sx, -0.06, 0.5), mat=mats['Rubber'], bevel=0.02)
        gear[f'KneePad_{s}'] = kp
    band = cylinder('armband', 0.058, 0.056, 0.05, (0.3, 0.016, 1.325), (0, math.radians(-45), 0), mat=mats['TeamAccent'], segs=16)
    gear['Armband'] = band
    for ob in gear.values():
        smooth(ob, 40)
    return gear


# ------------------------------------------------------------------ skinning

def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
    return (a + ab * t - p).length


def skin_auto(ob, arm, bones, power=5, top=3):
    rest = {b.name: (b.head_local.copy(), b.tail_local.copy()) for b in arm.data.bones}
    groups = {n: ob.vertex_groups.get(n) or ob.vertex_groups.new(name=n) for n in bones}
    mw = ob.matrix_world
    dominant = []
    for v in ob.data.vertices:
        p = mw @ v.co
        ws = []
        for n in bones:
            a, b = rest[n]
            d = seg_dist(p, a, b) / bone_radius(n)
            ws.append((1.0 / (d ** power + 1e-6), n))
        ws.sort(reverse=True)
        ws = ws[:top]
        tot = sum(w for w, _ in ws)
        for w, n in ws:
            if w / tot > 0.01:
                groups[n].add([v.index], w / tot, 'REPLACE')
        dominant.append(ws[0][1])
    attach(ob, arm)
    return dominant


def skin_rigid(ob, arm, bone):
    vg = ob.vertex_groups.new(name=bone)
    vg.add([v.index for v in ob.data.vertices], 1.0, 'REPLACE')
    attach(ob, arm)


def attach(ob, arm):
    ob.parent = arm
    mod = ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm


# ------------------------------------------------------------------ animations

def smoothstep(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def lerpv(a, b, t):
    return tuple(lerp(x, y, t) for x, y in zip(a, b))


TORSO_TWIST = {'Spine': (0, 0, -0.1), 'Chest': (0, 0, -0.12), 'UpperChest': (0.04, 0, -0.13), 'Neck': (0, 0, 0.14), 'Head': (0, 0, 0.21)}


def spine_with(extra=None, lean=0.0, breathe=0.0, bob_roll=0.0):
    out = {}
    for n, (x, y, z) in TORSO_TWIST.items():
        dx = 0.0
        if n in ('Spine', 'Chest'):
            dx = lean * 0.5
        if n == 'UpperChest':
            dx = breathe
        if n in ('Neck', 'Head'):
            dx = -lean * 0.5
        out[n] = (x + dx, y + (bob_roll if n == 'Spine' else 0), z)
    if extra:
        for n, e in extra.items():
            b = out.get(n, (0, 0, 0))
            out[n] = (b[0] + e[0], b[1] + e[1], b[2] + e[2])
    return out


def gait(phase, *, stride, lift, duty, width=0.115, lateral=False, direction=1.0, bob=0.025, lean=0.0, hip_drop=0.0, knee_fwd=1.0):
    legs = {}
    for s, sx, off in (('L', 1, 0.0), ('R', -1, 0.5)):
        ph = (phase + off) % 1.0
        if ph < duty:
            t = ph / duty
            o = stride / 2 - stride * t
            h = 0.0
            heel = 0.0
            toe_down = 0.025 * smoothstep((t - 0.7) / 0.3)
        else:
            t = (ph - duty) / (1 - duty)
            o = -stride / 2 + stride * smoothstep(t)
            h = lift * math.sin(math.pi * t)
            toe_down = 0.02 * math.sin(math.pi * t)
            heel = 0.0
        o *= direction
        if lateral:
            ax, ay = (width * sx - o, 0.0)
            ank = (ax, ay, 0.09 + h)
            toe = (ax + 0.01 * sx, ay - 0.14, 0.03 + h - toe_down)
        else:
            ank = (width * sx, -o, 0.09 + h + toe_down * 0.5)
            toe = (width * sx + 0.012 * sx, -o - 0.14, 0.03 + h - toe_down)
        legs[s] = {'ankle': ank, 'toe': toe, 'pole': (0.12 * sx, -1.0 * knee_fwd, 0.0)}
    b = -bob * math.cos(4 * math.pi * phase)
    sway = 0.012 * math.sin(2 * math.pi * phase)
    return legs, b, sway


def clip_params(name, t, n):
    """Return pose params for clip `name` at frame t of n."""
    ph = t / n
    if name == 'Idle':
        br = 0.018 * math.sin(2 * math.pi * ph)
        shift = 0.008 * math.sin(2 * math.pi * ph)
        return dict(
            hips_off=(shift, 0, -0.035 + 0.004 * math.sin(4 * math.pi * ph)), hips_rot=(0, 0, -0.18),
            spine=spine_with({'Spine': (0, 0, 0.06), 'Chest': (0, 0, 0.06)}, breathe=br),
            legs={'L': {'ankle': (0.13, -0.09, 0.09), 'toe': (0.17, -0.22, 0.03), 'pole': (0.25, -1, 0)},
                  'R': {'ankle': (-0.14, 0.07, 0.09), 'toe': (-0.21, -0.05, 0.03), 'pole': (-0.35, -1, 0)}},
            weapon_off=Matrix.Translation((0, 0, 0.004 * math.sin(2 * math.pi * ph))))
    if name == 'Walk':
        legs, b, sway = gait(ph, stride=0.8, lift=0.11, duty=0.6, bob=0.022)
        return dict(hips_off=(sway, 0, -0.025 + b), hips_rot=(0, 0.02 * math.sin(2 * math.pi * ph), 0.06 * math.sin(2 * math.pi * ph)),
                    spine=spine_with(lean=0.06, bob_roll=-0.02 * math.sin(2 * math.pi * ph)), legs=legs)
    if name == 'Run':
        legs, b, sway = gait(ph, stride=1.1, lift=0.28, duty=0.36, bob=0.045, knee_fwd=1.0)
        for s in legs.values():
            s['ankle'] = (s['ankle'][0], s['ankle'][1] + 0.08, s['ankle'][2])
        return dict(hips_off=(sway * 0.6, -0.02, -0.05 + b), hips_rot=(0.14, 0, 0.12 * math.sin(2 * math.pi * ph)),
                    spine=spine_with({'Spine': (0, 0, -0.06 * math.sin(2 * math.pi * ph))}, lean=0.1), legs=legs)
    if name == 'Back':
        legs, b, sway = gait(ph, stride=0.8, lift=0.13, duty=0.48, bob=0.03, direction=-1.0)
        return dict(hips_off=(sway, 0.02, -0.035 + b), hips_rot=(-0.04, 0, 0.05 * math.sin(2 * math.pi * ph)),
                    spine=spine_with(lean=-0.04), legs=legs)
    if name in ('StrafeL', 'StrafeR'):
        d = 1.0 if name == 'StrafeL' else -1.0
        legs, b, sway = gait(ph, stride=0.8, lift=0.16, duty=0.42, bob=0.03, lateral=True, direction=d)
        return dict(hips_off=(0, 0, -0.04 + b), hips_rot=(0.04, -0.06 * d, -0.15 * d),
                    spine=spine_with({'Spine': (0, 0, 0.1 * d), 'Chest': (0, 0, 0.05 * d)}), legs=legs)
    if name == 'Jump':
        k = 0.02 * math.sin(2 * math.pi * ph)
        return dict(hips_off=(0, 0, 0.0), hips_rot=(0.12, 0, 0),
                    spine=spine_with(lean=0.06),
                    legs={'L': {'ankle': (0.12, 0.02, 0.34 + k), 'toe': (0.13, -0.11, 0.26 + k), 'pole': (0.1, -1, 0)},
                          'R': {'ankle': (-0.12, 0.12, 0.42 - k), 'toe': (-0.13, 0.0, 0.36 - k), 'pole': (-0.1, -1, 0.3)}})
    return None


STAND_LEGS = {'L': {'ankle': (0.13, -0.09, 0.09), 'toe': (0.17, -0.22, 0.03), 'pole': (0.25, -1, 0)},
              'R': {'ankle': (-0.14, 0.07, 0.09), 'toe': (-0.21, -0.05, 0.03), 'pole': (-0.35, -1, 0)}}


def death_keys(name):
    """Key poses (time seconds, params) for death clips. Arms are free (the weapon is dropped)."""
    rifle_hands = {'L': {'hand': (-0.02, -0.52, 1.36), 'g': (0, 1, 0), 'p': (0, 0, 1), 'pole': (0.5, 0.2, -1)},
                   'R': {'hand': (-0.12, -0.3, 1.27), 'g': (0, 0.33, -0.95), 'p': (1, 0, 0), 'pole': (-0.8, 0.3, -1)}}
    if name == 'DeathBack':
        return [
            (0.0, dict(hips_off=(0, 0, -0.035), hips_rot=(0, 0, -0.18), spine=spine_with(), legs=STAND_LEGS, arms=rifle_hands)),
            (0.22, dict(hips_off=(0, 0.05, -0.16), hips_rot=(-0.3, 0, -0.1), spine=spine_with({'Spine': (-0.25, 0, 0), 'Chest': (-0.25, 0, 0), 'Neck': (-0.3, 0, 0), 'Head': (-0.35, 0, 0)}),
                        legs={'L': {'ankle': (0.13, -0.12, 0.09), 'toe': (0.17, -0.25, 0.03), 'pole': (0.3, -1, 0)}, 'R': {'ankle': (-0.14, 0.02, 0.09), 'toe': (-0.2, -0.1, 0.03), 'pole': (-0.3, -1, 0)}},
                        arms={'L': {'hand': (0.5, 0.05, 1.62), 'g': (0, 1, 0), 'p': (0, 0, -1), 'pole': (0.4, 0.5, -0.6)}, 'R': {'hand': (-0.52, 0.0, 1.58), 'g': (0, 1, 0), 'p': (0, 0, -1), 'pole': (-0.4, 0.5, -0.6)}})),
            (0.62, dict(root_rot=(-1.46, 0, 0.06), root_loc=(0, 0.28, 0.12), hips_off=(0, 0, -0.05), hips_rot=(0.1, 0, 0), spine=spine_with({'Neck': (0.1, 0, 0.3), 'Head': (0.1, 0, 0.2)}),
                        legs={'L': {'ankle': (0.18, -0.1, 0.16), 'toe': (0.22, -0.18, 0.02), 'pole': (0.4, -1, 0.3)}, 'R': {'ankle': (-0.16, -0.05, 0.1), 'toe': (-0.22, -0.16, 0.05), 'pole': (-0.3, -1, 0.2)}},
                        arms={'L': {'hand': (0.62, 0.12, 1.45), 'g': (0, 0, 1), 'p': (0, 1, 0), 'pole': (0.2, 1, 0)}, 'R': {'hand': (-0.6, 0.1, 1.5), 'g': (0, 0, 1), 'p': (0, 1, 0), 'pole': (-0.2, 1, 0)}})),
            (0.8, dict(root_rot=(-1.56, 0, 0.06), root_loc=(0, 0.3, 0.13), hips_off=(0, 0, -0.05), hips_rot=(0.05, 0, 0), spine=spine_with({'Neck': (0.15, 0, 0.35), 'Head': (0.15, 0, 0.25)}),
                       legs={'L': {'ankle': (0.18, -0.06, 0.12), 'toe': (0.24, -0.14, 0.02), 'pole': (0.5, -1, 0.3)}, 'R': {'ankle': (-0.17, -0.03, 0.09), 'toe': (-0.24, -0.14, 0.04), 'pole': (-0.5, -1, 0.2)}},
                       arms={'L': {'hand': (0.6, 0.15, 1.38), 'g': (0, 0, 1), 'p': (0, 1, 0), 'pole': (0.2, 1, 0)}, 'R': {'hand': (-0.62, 0.15, 1.42), 'g': (0, 0, 1), 'p': (0, 1, 0), 'pole': (-0.2, 1, 0)}})),
            (1.3, dict(root_rot=(-1.52, 0, 0.06), root_loc=(0, 0.3, 0.12), hips_off=(0, 0, -0.05), hips_rot=(0.05, 0, 0), spine=spine_with({'Neck': (0.1, 0, 0.5), 'Head': (0.1, 0, 0.35)}),
                       legs={'L': {'ankle': (0.2, -0.04, 0.1), 'toe': (0.27, -0.12, 0.03), 'pole': (0.6, -1, 0.3)}, 'R': {'ankle': (-0.18, -0.02, 0.09), 'toe': (-0.26, -0.12, 0.04), 'pole': (-0.6, -1, 0.2)}},
                       arms={'L': {'hand': (0.58, 0.16, 1.32), 'g': (0, 0, 1), 'p': (0, 1, 0), 'pole': (0.2, 1, 0)}, 'R': {'hand': (-0.6, 0.16, 1.36), 'g': (0, 0, 1), 'p': (0, 1, 0), 'pole': (-0.2, 1, 0)}})),
        ]
    if name == 'DeathFront':
        return [
            (0.0, dict(hips_off=(0, 0, -0.035), hips_rot=(0, 0, -0.18), spine=spine_with(), legs=STAND_LEGS, arms=rifle_hands)),
            (0.3, dict(hips_off=(0, -0.08, -0.32), hips_rot=(0.45, 0, 0), spine=spine_with({'Spine': (0.3, 0, 0), 'Chest': (0.25, 0, 0), 'Head': (0.3, 0, 0)}),
                       legs={'L': {'ankle': (0.13, 0.05, 0.1), 'toe': (0.16, -0.08, 0.03), 'pole': (0.2, -1, 0)}, 'R': {'ankle': (-0.13, 0.12, 0.1), 'toe': (-0.16, 0.0, 0.03), 'pole': (-0.2, -1, 0)}},
                       arms={'L': {'hand': (0.3, -0.25, 0.95), 'g': (0, 1, 0), 'p': (-1, 0, 0)}, 'R': {'hand': (-0.3, -0.25, 0.95), 'g': (0, 1, 0), 'p': (1, 0, 0)}})),
            (0.65, dict(root_rot=(1.42, 0, -0.08), root_loc=(0, -0.42, 0.16), hips_off=(0, 0, -0.05), hips_rot=(-0.05, 0, 0), spine=spine_with({'Neck': (-0.2, 0, -0.4), 'Head': (-0.2, 0, -0.3)}),
                        legs={'L': {'ankle': (0.15, 0.12, 0.2), 'toe': (0.17, 0.2, 0.1), 'pole': (0.3, -1, 0)}, 'R': {'ankle': (-0.14, 0.06, 0.12), 'toe': (-0.16, 0.12, 0.02), 'pole': (-0.3, -1, 0)}},
                        arms={'L': {'hand': (0.4, -0.2, 1.5), 'g': (0, 0, 1), 'p': (0, -1, 0)}, 'R': {'hand': (-0.38, -0.15, 1.2), 'g': (0, 0, 1), 'p': (0, -1, 0)}})),
            (0.82, dict(root_rot=(1.52, 0, -0.08), root_loc=(0, -0.45, 0.17), hips_off=(0, 0, -0.05), spine=spine_with({'Neck': (-0.2, 0, -0.5), 'Head': (-0.2, 0, -0.35)}),
                        legs={'L': {'ankle': (0.16, 0.14, 0.16), 'toe': (0.18, 0.24, 0.08), 'pole': (0.3, -1, 0)}, 'R': {'ankle': (-0.15, 0.08, 0.1), 'toe': (-0.17, 0.16, 0.02), 'pole': (-0.3, -1, 0)}},
                        arms={'L': {'hand': (0.42, -0.18, 1.45), 'g': (0, 0, 1), 'p': (0, -1, 0)}, 'R': {'hand': (-0.4, -0.12, 1.15), 'g': (0, 0, 1), 'p': (0, -1, 0)}})),
            (1.3, dict(root_rot=(1.5, 0, -0.08), root_loc=(0, -0.45, 0.165), hips_off=(0, 0, -0.05), spine=spine_with({'Neck': (-0.2, 0, -0.6), 'Head': (-0.2, 0, -0.4)}),
                       legs={'L': {'ankle': (0.17, 0.15, 0.14), 'toe': (0.19, 0.25, 0.07), 'pole': (0.3, -1, 0)}, 'R': {'ankle': (-0.16, 0.1, 0.1), 'toe': (-0.18, 0.18, 0.02), 'pole': (-0.3, -1, 0)}},
                       arms={'L': {'hand': (0.44, -0.16, 1.42), 'g': (0, 0, 1), 'p': (0, -1, 0)}, 'R': {'hand': (-0.42, -0.1, 1.12), 'g': (0, 0, 1), 'p': (0, -1, 0)}})),
        ]
    if name == 'DeathHead':
        return [
            (0.0, dict(hips_off=(0, 0, -0.035), hips_rot=(0, 0, -0.18), spine=spine_with(), legs=STAND_LEGS, arms=rifle_hands)),
            (0.12, dict(hips_off=(0, 0.03, -0.05), hips_rot=(-0.1, 0, -0.18), spine=spine_with({'UpperChest': (-0.2, 0, 0), 'Neck': (-0.55, 0, 0.1), 'Head': (-0.6, 0, 0.1)}), legs=STAND_LEGS,
                        arms={'L': {'hand': (0.42, -0.2, 1.42), 'g': (0, 1, 0), 'p': (-1, 0, 0)}, 'R': {'hand': (-0.42, -0.15, 1.38), 'g': (0, 1, 0), 'p': (1, 0, 0)}})),
            (0.5, dict(hips_off=(0, 0.06, -0.5), hips_rot=(0.15, 0.05, -0.1), spine=spine_with({'Spine': (0.2, 0, 0), 'Chest': (0.2, 0, 0), 'Neck': (0.3, 0, 0), 'Head': (0.35, 0.2, 0)}),
                       legs={'L': {'ankle': (0.15, 0.25, 0.1), 'toe': (0.17, 0.32, 0.02), 'pole': (0.2, -1, 0)}, 'R': {'ankle': (-0.15, 0.28, 0.1), 'toe': (-0.17, 0.36, 0.02), 'pole': (-0.2, -1, 0)}},
                       arms={'L': {'hand': (0.25, 0.0, 0.62), 'g': (0, 1, 0), 'p': (-1, 0, 0)}, 'R': {'hand': (-0.25, 0.0, 0.62), 'g': (0, 1, 0), 'p': (1, 0, 0)}})),
            (0.9, dict(root_rot=(0.15, -1.38, 0.2), root_loc=(-0.25, 0.15, 0.2), hips_off=(0, 0.06, -0.4), hips_rot=(0.2, 0, 0), spine=spine_with({'Spine': (0.25, 0, 0), 'Chest': (0.15, 0, 0), 'Neck': (0.2, 0.3, 0), 'Head': (0.2, 0.3, 0)}),
                       legs={'L': {'ankle': (0.16, 0.25, 0.25), 'toe': (0.18, 0.3, 0.14), 'pole': (0.3, -1, 0.3)}, 'R': {'ankle': (-0.14, 0.3, 0.2), 'toe': (-0.16, 0.36, 0.1), 'pole': (-0.2, -1, 0.2)}},
                       arms={'L': {'hand': (0.3, -0.3, 0.9), 'g': (0, 1, 0), 'p': (-1, 0, 0)}, 'R': {'hand': (-0.5, 0.0, 1.05), 'g': (0, 0, 1), 'p': (1, 0, 0)}})),
            (1.5, dict(root_rot=(0.15, -1.46, 0.2), root_loc=(-0.27, 0.15, 0.2), hips_off=(0, 0.06, -0.4), hips_rot=(0.2, 0, 0), spine=spine_with({'Spine': (0.25, 0, 0), 'Chest': (0.15, 0, 0), 'Neck': (0.25, 0.45, 0), 'Head': (0.2, 0.4, 0)}),
                       legs={'L': {'ankle': (0.17, 0.27, 0.24), 'toe': (0.19, 0.33, 0.13), 'pole': (0.3, -1, 0.3)}, 'R': {'ankle': (-0.14, 0.32, 0.2), 'toe': (-0.16, 0.38, 0.1), 'pole': (-0.2, -1, 0.2)}},
                       arms={'L': {'hand': (0.32, -0.32, 0.86), 'g': (0, 1, 0), 'p': (-1, 0, 0)}, 'R': {'hand': (-0.52, 0.0, 1.0), 'g': (0, 0, 1), 'p': (1, 0, 0)}})),
        ]
    return []


def blend_params(a, b, t):
    """Interpolate two param dicts (positions linearly, eulers via quaternion slerp)."""
    def E(d, k, default=(0, 0, 0)):
        return d.get(k, default)
    out = {}
    for k in ('root_loc', 'hips_off'):
        out[k] = lerpv(E(a, k), E(b, k), t)
    for k in ('root_rot', 'hips_rot'):
        out[k] = tuple(qe(*E(a, k)).slerp(qe(*E(b, k)), t).to_euler('XYZ'))
    sp = {}
    for n in ('Spine', 'Chest', 'UpperChest', 'Neck', 'Head'):
        ea, eb = a.get('spine', {}).get(n, (0, 0, 0)), b.get('spine', {}).get(n, (0, 0, 0))
        sp[n] = tuple(qe(*ea).slerp(qe(*eb), t).to_euler('XYZ'))
    out['spine'] = sp
    legs = {}
    for s in ('L', 'R'):
        la, lb = a['legs'][s], b['legs'][s]
        legs[s] = {k: lerpv(la[k], lb[k], t) for k in ('ankle', 'toe', 'pole')}
    out['legs'] = legs
    arms = {}
    for s in ('L', 'R'):
        aa, ab = a['arms'][s], b['arms'][s]
        arms[s] = {k: lerpv(aa.get(k, (0, 1, 0) if k == 'g' else (0.3, 0.3, -1)), ab.get(k, (0, 1, 0) if k == 'g' else (0.3, 0.3, -1)), t) for k in ('hand', 'g', 'pole')}
        pa = aa.get('p', (-1 if s == 'L' else 1, 0, 0))
        pb = ab.get('p', (-1 if s == 'L' else 1, 0, 0))
        arms[s]['p'] = lerpv(pa, pb, t)
    out['arms'] = arms
    return out


def death_params(name, time_s):
    keys = death_keys(name)
    for i in range(len(keys) - 1):
        t0, p0 = keys[i]
        t1, p1 = keys[i + 1]
        if time_s <= t1:
            u = (time_s - t0) / (t1 - t0)
            # the fall to the ground accelerates (ease-in); everything else eases in/out
            fall = {'DeathBack': 1, 'DeathFront': 1, 'DeathHead': 2}.get(name, 1)
            u = u * u if i == fall else smoothstep(u)
            return blend_params(p0, p1, u)
    return blend_params(keys[-2][1], keys[-1][1], 1.0)


def keyframe_clip(arm, rig, poser, name, frames, param_fn):
    old = bpy.data.actions.get(name)
    if old is not None:
        bpy.data.actions.remove(old, do_unlink=True)
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = act
    prev = {}
    for f in range(frames + 1):
        P = param_fn(f, frames)
        poses = poser.solve(P)
        basis = rig.basis(poses)
        for n, Bm in basis.items():
            pb = arm.pose.bones[n]
            pb.rotation_mode = 'QUATERNION'
            q = Bm.to_quaternion()
            if n in prev and prev[n].dot(q) < 0:
                q.negate()
            prev[n] = q
            pb.rotation_quaternion = q
            pb.keyframe_insert('rotation_quaternion', frame=f)
            if n in ('Root', 'Hips', 'Weapon'):
                pb.location = Bm.translation
                pb.keyframe_insert('location', frame=f)
    log(f'  clip {name}: {frames + 1} frames')
    return act


# ------------------------------------------------------------------ main build

def build_all():
    clear_scene()
    scene = bpy.context.scene
    scene.render.fps = FPS
    camo = camo_image()
    mk = lambda n, c, **k: material_with_image(n, c, camo, **k) if camo is not None else material(n, c, **k)
    mats = {
        'Skin': material('Skin', 0xc68c64, rough=0.55),
        'Lips': material('Lips', 0xa8605a, rough=0.5),
        'EyeWhite': material('EyeWhite', 0xf2efe8, rough=0.2),
        'Iris': material('Iris', 0x4a3220, rough=0.2),
        'Pupil': material('Pupil', 0x080808, rough=0.1),
        'Hair': material('Hair', 0x2a1d14, rough=0.8),
        'Shirt': mk('Shirt', 0x7b7f62, rough=0.9),
        'Pants': mk('Pants', 0x6d6a52, rough=0.9),
        'Boots': material('Boots', 0x3a2c20, rough=0.75),
        'Rubber': material('BootSole', 0x161514, rough=0.95),
        'Gloves': material('Gloves', 0x2b2925, rough=0.85),
        'Vest': material('Vest', 0x8c7a5a, rough=0.85),
        'Webbing': material('Webbing', 0x4a4436, rough=0.9),
        'TeamAccent': material('TeamAccent', 0xff3b5c, rough=0.5),
        'HelmetMat': material('HelmetMat', 0x7d7259, rough=0.7),
        'CapMat': material('CapMat', 0x353a40, rough=0.85),
        'BeanieMat': material('BeanieMat', 0x3d3a36, rough=0.95),
        'Metal': material('GearMetal', 0x2b2d30, rough=0.4, metal=0.6),
    }
    arm = build_armature()
    rig = Rig(arm)
    poser = Poser(rig)

    # reference aim pose (torso bladed, rifle shouldered) -> rifle frame relative to UpperChest
    ref = clip_params('Idle', 0, 60)
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
    set_weapon_rest(arm, W_rest)
    rig = Rig(arm)
    poser.rig = rig
    log('rig ready, bones:', len(rig.order))

    # meshes
    body = build_body(mats)
    dominant = skin_auto(body, arm, DEFORM)
    for poly in body.data.polygons:
        doms = [dominant[i] for i in poly.vertices]
        d = max(set(doms), key=doms.count)
        z = poly.center.z
        if d in ('Neck', 'Head') or z > 1.5:
            poly.material_index = 2
        elif d.startswith('UpperLeg') or d.startswith('LowerLeg') or d.startswith('Foot') or (d == 'Hips' and z < 0.975):
            poly.material_index = 1
        else:
            poly.material_index = 0
    head, hc = build_head(mats, rig.rest['Head'].translation)
    skin_rigid(head, arm, 'Head')
    for ob in build_headgear(mats, hc):
        skin_rigid(ob, arm, 'Head')
    hands = {}
    for s in ('L', 'R'):
        h = build_hand(mats, rig, s)
        skin_rigid(h, arm, f'Hand.{s}')
        hands[s] = h
        bf, bs = build_boots(mats, s)
        skin_rigid(bf, arm, f'Foot.{s}')
        skin_rigid(bs, arm, f'LowerLeg.{s}')
    gear = build_gear(mats)
    skin_auto(gear['Vest'], arm, ['Spine', 'Chest', 'UpperChest'], power=4, top=2)
    skin_rigid(gear['Belt'], arm, 'Hips')
    skin_auto(gear['Collar'], arm, ['UpperChest', 'Neck'], power=4, top=2)
    skin_rigid(gear['Holster'], arm, 'UpperLeg.R')
    skin_rigid(gear['KneePad_L'], arm, 'LowerLeg.L')
    skin_rigid(gear['KneePad_R'], arm, 'LowerLeg.R')
    skin_rigid(gear['Armband'], arm, 'UpperArm.L')
    log('meshes built')

    # weapons on the Weapon bone
    rifle = W.build_rifle(1, with_mag=True, name='Rifle3P')
    launcher = W.build_launcher(1, with_warhead=True, name='Launcher3P')
    for ob in (rifle, launcher):
        ob.parent = arm
        ob.parent_type = 'BONE'
        ob.parent_bone = 'Weapon'
        ob.matrix_world = W_rest
    log('weapons attached')

    # first-person arms: evaluate the aim pose, keep the arm region, move into rifle space
    try:
        build_fp_arms(arm, rig, poser, body, hands, gear['Armband'], head, mats)
    except Exception:
        log_exc('fp arms')

    # animations
    clips = [('Idle', 60), ('Walk', 30), ('Run', 20), ('Back', 26), ('StrafeL', 22), ('StrafeR', 22), ('Jump', 20)]
    for name, n in clips:
        keyframe_clip(arm, rig, poser, name, n, lambda f, N, name=name: clip_params(name, f, N))
    for name, secs in (('DeathBack', 1.3), ('DeathFront', 1.3), ('DeathHead', 1.5)):
        n = int(secs * FPS)
        keyframe_clip(arm, rig, poser, name, n, lambda f, N, name=name: death_params(name, f / FPS))
    arm.animation_data.action = bpy.data.actions['Idle']
    scene.frame_set(0)

    objs = [arm] + [o for o in bpy.data.objects if o.parent == arm]
    export_glb(os.path.join(OUT_MODELS, 'human_soldier.glb'), objs, animations=True)
    save_blend('human_soldier.blend')


def build_fp_arms(arm, rig, poser, body, hands, armband, head, mats):
    P = clip_params('Idle', 0, 60)
    poses = poser.solve(P)
    basis = rig.basis(poses)
    for n, Bm in basis.items():
        pb = arm.pose.bones[n]
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = Bm.to_quaternion()
        pb.location = Bm.translation if n in ('Root', 'Hips', 'Weapon') else Vector()
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    Wm = poses['Weapon']
    Winv = Wm.inverted()
    keep_bones = {f'{b}.{s}' for b in ('UpperArm', 'LowerArm', 'Hand') for s in ('L', 'R')}
    parts = []
    for src, filt in ((body, True), (hands['L'], False), (hands['R'], False), (armband, False)):
        ev = src.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
        bm = bmesh.new()
        bm.from_mesh(me)
        if filt:
            groups = {g.index: g.name for g in src.vertex_groups}
            keep = set()
            for v in src.data.vertices:
                best, bw = None, 0
                for ge in v.groups:
                    if ge.weight > bw:
                        best, bw = groups[ge.group], ge.weight
                if best in keep_bones:
                    keep.add(v.index)
            bm.verts.ensure_lookup_table()
            kill = [f for f in bm.faces if any(v.index not in keep for v in f.verts)]
            bmesh.ops.delete(bm, geom=kill, context='FACES')
            loose = [v for v in bm.verts if not v.link_faces]
            bmesh.ops.delete(bm, geom=loose, context='VERTS')
        bm.transform(Winv @ src.matrix_world)
        bm.to_mesh(me)
        bm.free()
        ob = new_object('fp_part', me)
        parts.append(ob)
    arms = join(parts, 'ArmsFP')
    smooth(arms, 180)
    # eye position: between the eyes, measured from the head mesh centre in world rest space then posed
    eye = bpy.data.objects.new('EyeFP', None)
    link(eye)
    head_pose = poses['Head']
    head_rest = rig.rest['Head']
    eye_rest = Vector((0.0, -0.08, 1.705))
    eye_posed = head_pose @ (head_rest.inverted() @ eye_rest)
    eye.location = Winv @ eye_posed
    export_glb(os.path.join(OUT_MODELS, 'fp_arms.glb'), [arms, eye])
    log('fp arms exported; eye in rifle space:', tuple(round(c, 3) for c in eye.location))
    bpy.data.objects.remove(arms, do_unlink=True)
    bpy.data.objects.remove(eye, do_unlink=True)
    for pb in arm.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()
    bpy.context.view_layer.update()


if __name__ == '__main__':
    build_all()
