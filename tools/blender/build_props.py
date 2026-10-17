"""Street furniture and set dressing for the maps. Every prop has its origin at the centre of its
base and faces -Y. Exported as separate named objects in client/assets/models/props.glb."""
import math
import os
import random
import bmesh
import bpy
from mathutils import Vector
from bpz_common import (material, box, cylinder, sphere, join, smooth, export_glb, log, clear_scene, new_object,
                        OUT_MODELS, save_blend)


def M():
    return {
        'concrete': material('Concrete', 0xb9b4aa, rough=0.95),
        'concreteDark': material('ConcreteDark', 0x8f8a80, rough=0.95),
        'wood': material('WoodPlank', 0x9a6b43, rough=0.85),
        'woodDark': material('WoodDark', 0x6e4a2c, rough=0.9),
        'metal': material('MetalGrey', 0x5d6168, rough=0.45, metal=0.7),
        'metalDark': material('MetalDark', 0x2e3135, rough=0.5, metal=0.6),
        'green': material('MetalGreen', 0x2f5a3c, rough=0.6, metal=0.3),
        'orange': material('SafetyOrange', 0xff6a1a, rough=0.6),
        'white': material('PaintWhite', 0xeeeeee, rough=0.6),
        'red': material('PaintRed', 0xc4231d, rough=0.5, metal=0.2),
        'yellow': material('PaintYellow', 0xf2c230, rough=0.6),
        'glow': material('LampGlow', 0xfff1c4, rough=0.3, emission=0xfff1c4),
        'leaf': material('Leaf', 0x3f8f3a, rough=0.9),
        'leaf2': material('Leaf2', 0x2f7a33, rough=0.9),
        'soil': material('Soil', 0x4a3424, rough=1.0),
        'canvas': material('Canvas', 0xb8a47a, rough=1.0),
        'drum': material('DrumPaint', 0x2f5f9f, rough=0.55, metal=0.4),
        'umbrella': material('UmbrellaFabric', 0xff6f91, rough=0.8),
        'umbrella2': material('UmbrellaFabric2', 0xffffff, rough=0.8),
        'rubber': material('PropRubber', 0x1a1a1a, rough=0.95),
        'glass': material('PropGlass', 0x88b6d0, rough=0.1, alpha=0.5),
    }


def blob(name, r, loc, mat, seed=1, detail=2):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=detail, radius=r)
    rnd = random.Random(seed)
    for v in bm.verts:
        v.co *= 0.85 + rnd.random() * 0.3
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = new_object(name, me)
    me.materials.append(mat)
    ob.location = loc
    return ob


def street_lamp(m):
    p = [cylinder('base', 0.16, 0.13, 0.3, (0, 0, 0.15), mat=m['metalDark'], segs=12, bevel=0.01),
         cylinder('pole', 0.07, 0.05, 4.0, (0, 0, 2.3), mat=m['metalDark'], segs=12),
         cylinder('arm', 0.035, 0.035, 1.0, (0, -0.45, 4.25), (math.radians(90), 0, 0), mat=m['metalDark'], segs=8),
         box('head', (0.28, 0.5, 0.1), (0, -0.95, 4.2), mat=m['metalDark'], bevel=0.03),
         box('lens', (0.22, 0.42, 0.02), (0, -0.95, 4.14), mat=m['glow'])]
    return join(p, 'StreetLamp')


def bench(m):
    p = []
    for i in range(4):
        p.append(box(f'seat{i}', (1.6, 0.09, 0.035), (0, -0.16 + i * 0.105, 0.45), mat=m['wood'], bevel=0.008))
    for i in range(2):
        p.append(box(f'back{i}', (1.6, 0.03, 0.09), (0, 0.22, 0.6 + i * 0.13), (math.radians(-12), 0, 0), mat=m['wood'], bevel=0.008))
    for sx in (-0.65, 0.65):
        p.append(box(f'leg{sx}', (0.06, 0.45, 0.06), (sx, 0.0, 0.42), mat=m['metalDark'], bevel=0.01))
        p.append(box(f'legf{sx}', (0.05, 0.05, 0.42), (sx, -0.18, 0.21), mat=m['metalDark']))
        p.append(box(f'legb{sx}', (0.05, 0.05, 0.75), (sx, 0.2, 0.37), (math.radians(-12), 0, 0), mat=m['metalDark']))
    return join(p, 'Bench')


def trash_bin(m):
    p = [cylinder('bin', 0.25, 0.22, 0.85, (0, 0, 0.425), mat=m['green'], segs=20, bevel=0.01),
         cylinder('lid', 0.27, 0.27, 0.06, (0, 0, 0.88), mat=m['metalDark'], segs=20, bevel=0.01),
         cylinder('ring', 0.255, 0.255, 0.04, (0, 0, 0.6), mat=m['metalDark'], segs=20)]
    return join(p, 'TrashBin')


def cone(m):
    p = [box('base', (0.42, 0.42, 0.04), (0, 0, 0.02), mat=m['orange'], bevel=0.01),
         cylinder('cone', 0.17, 0.035, 0.68, (0, 0, 0.38), mat=m['orange'], segs=16),
         cylinder('stripe1', 0.13, 0.11, 0.08, (0, 0, 0.42), mat=m['white'], segs=16),
         cylinder('stripe2', 0.09, 0.075, 0.06, (0, 0, 0.58), mat=m['white'], segs=16)]
    return join(p, 'TrafficCone')


def barrier(m):
    bm = bmesh.new()
    prof = [(-0.3, 0), (0.3, 0), (0.3, 0.08), (0.12, 0.25), (0.09, 0.8), (-0.09, 0.8), (-0.12, 0.25), (-0.3, 0.08)]
    L = 2.0
    vs0 = [bm.verts.new((-L / 2, y, z)) for y, z in prof]
    vs1 = [bm.verts.new((L / 2, y, z)) for y, z in prof]
    n = len(prof)
    for i in range(n):
        bm.faces.new((vs0[i], vs0[(i + 1) % n], vs1[(i + 1) % n], vs1[i]))
    bm.faces.new(vs0[::-1])
    bm.faces.new(vs1)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new('Barrier')
    bm.to_mesh(me)
    bm.free()
    ob = new_object('b', me)
    me.materials.append(m['concrete'])
    stripe = box('stripe', (L, 0.01, 0.1), (0, -0.098, 0.6), mat=m['yellow'])
    return join([ob, stripe], 'Barrier')


def hydrant(m):
    p = [cylinder('body', 0.12, 0.11, 0.55, (0, 0, 0.3), mat=m['red'], segs=16),
         sphere('cap', 0.12, (0, 0, 0.58), (1, 1, 0.7), mat=m['red'], segs=16, rings=10),
         cylinder('top', 0.03, 0.03, 0.06, (0, 0, 0.69), mat=m['red'], segs=8),
         cylinder('base', 0.16, 0.16, 0.06, (0, 0, 0.03), mat=m['red'], segs=16)]
    for a in (0, math.pi):
        p.append(cylinder(f'noz{a}', 0.045, 0.045, 0.14, (math.cos(a) * 0.13, 0, 0.42), (0, math.radians(90), 0), mat=m['metal'], segs=10))
    return join(p, 'Hydrant')


def planter(m):
    p = [box('pot', (0.9, 0.9, 0.55), (0, 0, 0.275), mat=m['concreteDark'], bevel=0.03),
         box('soil', (0.8, 0.8, 0.05), (0, 0, 0.53), mat=m['soil'])]
    rnd = random.Random(3)
    for i in range(6):
        p.append(blob(f'bush{i}', 0.28 + rnd.random() * 0.1, (rnd.uniform(-0.2, 0.2), rnd.uniform(-0.2, 0.2), 0.75 + rnd.random() * 0.2), m['leaf'] if i % 2 else m['leaf2'], seed=i))
    return join(p, 'Planter')


def ac_unit(m):
    p = [box('case', (1.0, 0.6, 0.8), (0, 0, 0.42), mat=m['white'], bevel=0.02),
         box('feet', (0.9, 0.5, 0.04), (0, 0, 0.02), mat=m['metalDark']),
         cylinder('fan', 0.27, 0.27, 0.02, (0, 0, 0.83), mat=m['metalDark'], segs=24)]
    for i in range(9):
        p.append(box(f'grille{i}', (0.012, 0.02, 0.6), (-0.4 + i * 0.1, -0.305, 0.42), mat=m['metalDark']))
    return join(p, 'ACUnit')


def water_tank(m):
    p = [cylinder('tank', 0.9, 0.9, 1.6, (0, 0, 2.3), mat=m['woodDark'], segs=24),
         cylinder('roof', 0.95, 0.05, 0.5, (0, 0, 3.35), mat=m['metalDark'], segs=24)]
    for i in range(3):
        p.append(cylinder(f'band{i}', 0.92, 0.92, 0.05, (0, 0, 1.7 + i * 0.6), mat=m['metalDark'], segs=24))
    for a in range(4):
        ang = a * math.pi / 2 + math.pi / 4
        p.append(box(f'leg{a}', (0.1, 0.1, 1.5), (math.cos(ang) * 0.7, math.sin(ang) * 0.7, 0.75), mat=m['metalDark']))
    p.append(box('deck', (1.7, 1.7, 0.06), (0, 0, 1.5), mat=m['metal']))
    return join(p, 'WaterTank')


def sat_dish(m):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=10, radius=0.5)
    kill = [v for v in bm.verts if v.co.z > -0.25]
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    me = bpy.data.meshes.new('dish')
    bm.to_mesh(me)
    bm.free()
    dish = new_object('dish', me)
    me.materials.append(m['white'])
    dish.location = (0, -0.1, 1.5)
    dish.rotation_euler = (math.radians(-60), 0, 0)
    p = [dish, cylinder('post', 0.04, 0.04, 1.3, (0, 0, 0.65), mat=m['metalDark'], segs=8),
         cylinder('feed', 0.015, 0.015, 0.5, (0, -0.3, 1.55), (math.radians(30), 0, 0), mat=m['metalDark'], segs=6),
         box('base', (0.4, 0.4, 0.05), (0, 0, 0.025), mat=m['metalDark'])]
    return join(p, 'SatDish')


def oil_drum(m):
    p = [cylinder('drum', 0.29, 0.29, 0.88, (0, 0, 0.44), mat=m['drum'], segs=20)]
    for z in (0.3, 0.58):
        p.append(cylinder(f'rib{z}', 0.3, 0.3, 0.03, (0, 0, z), mat=m['drum'], segs=20))
    p.append(cylinder('lid', 0.27, 0.27, 0.01, (0, 0, 0.885), mat=m['metalDark'], segs=20))
    return join(p, 'OilDrum')


def sandbags(m):
    p = []
    rnd = random.Random(5)
    for row in range(3):
        n = 4 - (row % 2)
        for i in range(n):
            x = -0.6 + i * 0.4 + (0.2 if row % 2 else 0)
            b = box(f'sb{row}{i}', (0.42, 0.3, 0.16), (x, rnd.uniform(-0.02, 0.02), 0.08 + row * 0.15), (0, 0, rnd.uniform(-0.08, 0.08)), mat=m['canvas'], bevel=0.06, segments=3)
            p.append(b)
    return join(p, 'Sandbags')


def pallet(m):
    p = []
    for i in range(7):
        p.append(box(f'top{i}', (1.2, 0.1, 0.022), (0, -0.48 + i * 0.16, 0.13), mat=m['wood']))
    for x in (-0.55, 0, 0.55):
        p.append(box(f'block{x}', (0.1, 1.0, 0.1), (x, 0, 0.065), mat=m['woodDark']))
    return join(p, 'Pallet')


def crate(m):
    p = [box('core', (0.96, 0.96, 0.96), (0, 0, 0.48), mat=m['wood'])]
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.append(box(f'post{sx}{sy}', (0.08, 0.08, 1.0), (0.46 * sx, 0.46 * sy, 0.5), mat=m['woodDark'], bevel=0.01))
    for z in (0.04, 0.96):
        for sy in (-1, 1):
            p.append(box(f'rx{z}{sy}', (1.0, 0.08, 0.08), (0, 0.46 * sy, z), mat=m['woodDark'], bevel=0.01))
            p.append(box(f'ry{z}{sy}', (0.08, 1.0, 0.08), (0.46 * sy, 0, z), mat=m['woodDark'], bevel=0.01))
    p.append(box('diag', (1.3, 0.04, 0.08), (0, -0.49, 0.5), (0, math.radians(45), 0), mat=m['woodDark']))
    return join(p, 'Crate')


def cafe_set(m):
    p = [cylinder('ttop', 0.42, 0.42, 0.03, (0, 0, 0.74), mat=m['white'], segs=24),
         cylinder('tleg', 0.03, 0.03, 0.72, (0, 0, 0.37), mat=m['metalDark'], segs=8),
         cylinder('tbase', 0.22, 0.22, 0.02, (0, 0, 0.01), mat=m['metalDark'], segs=16),
         cylinder('upole', 0.02, 0.02, 2.3, (0, 0, 1.15), mat=m['white'], segs=8),
         cylinder('umb', 1.25, 0.02, 0.45, (0, 0, 2.15), mat=m['umbrella'], segs=8),
         cylinder('umbtrim', 1.26, 1.26, 0.06, (0, 0, 1.95), mat=m['umbrella2'], segs=8)]
    for i, a in enumerate((0.3, 3.4)):
        cx, cy = math.cos(a) * 0.7, math.sin(a) * 0.7
        p.append(box(f'cseat{i}', (0.42, 0.42, 0.04), (cx, cy, 0.45), (0, 0, a), mat=m['wood'], bevel=0.01))
        bx, by = math.cos(a) * 0.9, math.sin(a) * 0.9
        p.append(box(f'cback{i}', (0.42, 0.04, 0.42), (bx, by, 0.7), (0, 0, a + math.pi / 2), mat=m['wood'], bevel=0.01))
        for lx in (-0.17, 0.17):
            for ly in (-0.17, 0.17):
                ca, sa = math.cos(a), math.sin(a)
                p.append(cylinder(f'cleg{i}{lx}{ly}', 0.015, 0.015, 0.45, (cx + lx * ca - ly * sa, cy + lx * sa + ly * ca, 0.225), mat=m['metalDark'], segs=6))
    return join(p, 'CafeSet')


def bollard(m):
    p = [cylinder('b', 0.1, 0.1, 0.9, (0, 0, 0.45), mat=m['metalDark'], segs=14, bevel=0.01),
         cylinder('band', 0.102, 0.102, 0.08, (0, 0, 0.75), mat=m['yellow'], segs=14)]
    return join(p, 'Bollard')


def road_sign(m):
    p = [cylinder('pole', 0.035, 0.035, 2.6, (0, 0, 1.3), mat=m['metal'], segs=8),
         cylinder('plate', 0.32, 0.32, 0.02, (0, -0.04, 2.35), (math.radians(90), 0, 0), mat=m['red'], segs=8),
         cylinder('rim', 0.34, 0.34, 0.012, (0, -0.03, 2.35), (math.radians(90), 0, 0), mat=m['white'], segs=8)]
    return join(p, 'RoadSign')


def antenna(m):
    p = [cylinder('mast', 0.03, 0.02, 3.0, (0, 0, 1.5), mat=m['metal'], segs=8),
         box('base', (0.4, 0.4, 0.06), (0, 0, 0.03), mat=m['metalDark'])]
    for i in range(4):
        p.append(cylinder(f'el{i}', 0.008, 0.008, 0.9 - i * 0.15, (0, 0, 2.0 + i * 0.3), (0, math.radians(90), 0), mat=m['metal'], segs=6))
    return join(p, 'Antenna')


def vent(m):
    p = [cylinder('pipe', 0.18, 0.18, 0.9, (0, 0, 0.45), mat=m['metal'], segs=16),
         cylinder('hood', 0.28, 0.2, 0.18, (0, 0, 0.98), mat=m['metal'], segs=16),
         box('base', (0.5, 0.5, 0.05), (0, 0, 0.025), mat=m['metalDark'])]
    return join(p, 'Vent')


def mooring(m):
    p = [cylinder('post', 0.16, 0.18, 0.5, (0, 0, 0.25), mat=m['metalDark'], segs=16),
         cylinder('cap', 0.22, 0.22, 0.08, (0, 0, 0.52), mat=m['metalDark'], segs=16),
         cylinder('rope', 0.19, 0.19, 0.06, (0, 0, 0.3), mat=m['canvas'], segs=16)]
    return join(p, 'Mooring')


def news_box(m):
    p = [box('body', (0.45, 0.4, 0.9), (0, 0, 0.55), mat=m['yellow'], bevel=0.02),
         box('window', (0.36, 0.02, 0.25), (0, -0.2, 0.75), mat=m['glass']),
         box('legs', (0.4, 0.35, 0.1), (0, 0, 0.05), mat=m['metalDark'])]
    return join(p, 'NewsBox')


def tire_stack(m):
    p = []
    for i in range(3):
        p.append(cylinder(f't{i}', 0.32, 0.32, 0.22, (0, 0, 0.11 + i * 0.22), mat=m['rubber'], segs=18, bevel=0.03))
    return join(p, 'TireStack')


BUILDERS = [street_lamp, bench, trash_bin, cone, barrier, hydrant, planter, ac_unit, water_tank, sat_dish, oil_drum,
            sandbags, pallet, crate, cafe_set, bollard, road_sign, antenna, vent, mooring, news_box, tire_stack]


def build_all():
    clear_scene()
    m = M()
    objs = []
    for fn in BUILDERS:
        try:
            ob = fn(m)
            smooth(ob, 40)
            objs.append(ob)
        except Exception:
            from bpz_common import log_exc
            log_exc(f'prop {fn.__name__}')
    out = os.path.join(OUT_MODELS, 'props.glb')
    export_glb(out, objs)
    save_blend('props.blend')
    log('props:', ', '.join(o.name for o in objs))


if __name__ == '__main__':
    build_all()
