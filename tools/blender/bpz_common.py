"""Shared helpers for the Breakpoint Zero Blender asset scripts (Blender 4.2+ / 5.x)."""
import bpy
import bmesh
import math
import os
import time
import traceback
from mathutils import Vector, Matrix, Quaternion, Euler

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT_MODELS = os.path.join(ROOT, 'client', 'assets', 'models')
SOURCE_DIR = os.path.join(ROOT, 'tools', 'blender', 'source')
LOG_PATH = os.path.join(HERE, 'build_log.txt')
os.makedirs(OUT_MODELS, exist_ok=True)
os.makedirs(SOURCE_DIR, exist_ok=True)

_t0 = time.time()


def log(*args):
    msg = ' '.join(str(a) for a in args)
    line = f'[{time.time() - _t0:7.2f}s] {msg}'
    print(line)
    with open(LOG_PATH, 'a', encoding='utf-8') as f:
        f.write(line + '\n')


def log_exc(where):
    log(f'ERROR in {where}:\n' + traceback.format_exc())


def reset_log():
    with open(LOG_PATH, 'w', encoding='utf-8') as f:
        f.write(f'Breakpoint Zero Blender build - Blender {bpy.app.version_string}\n')


def clear_scene():
    _mat_cache.clear()
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.actions, bpy.data.images, bpy.data.curves):
        for block in list(coll):
            if block.users == 0 or coll is bpy.data.actions:
                try:
                    coll.remove(block)
                except Exception:
                    pass
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


# ------------------------------------------------------------------ materials

_mat_cache = {}


def material(name, color, rough=0.7, metal=0.0, emission=None, alpha=1.0):
    key = name
    if key in _mat_cache:
        try:
            if _mat_cache[key].name in bpy.data.materials:
                return _mat_cache[key]
        except ReferenceError:
            pass
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = None
    for n in nt.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            bsdf = n
    if bsdf is None:
        bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
        out = nt.nodes.get('Material Output') or nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    c = srgb_to_linear(color)
    bsdf.inputs['Base Color'].default_value = (c[0], c[1], c[2], 1.0)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if emission is not None:
        e = srgb_to_linear(emission)
        for key2 in ('Emission Color', 'Emission'):
            if key2 in bsdf.inputs:
                bsdf.inputs[key2].default_value = (e[0], e[1], e[2], 1.0)
                break
        if 'Emission Strength' in bsdf.inputs:
            bsdf.inputs['Emission Strength'].default_value = 1.0
    if alpha < 1.0:
        bsdf.inputs['Alpha'].default_value = alpha
        try:
            m.blend_method = 'BLEND'
        except Exception:
            pass
    m.diffuse_color = (c[0], c[1], c[2], 1.0)
    _mat_cache[key] = m
    return m


def material_with_image(name, color, image, rough=0.8, metal=0.0):
    m = material(name, color, rough, metal)
    nt = m.node_tree
    bsdf = [n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'][0]
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = image
    mix = nt.nodes.new('ShaderNodeMix') if hasattr(bpy.types, 'ShaderNodeMix') else None
    # multiply texture by the base tint so the tint survives glTF export as baseColorFactor
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    c = srgb_to_linear(color)
    bsdf.inputs['Base Color'].default_value = (c[0], c[1], c[2], 1.0)
    return m


def srgb_to_linear(hex_or_tuple):
    if isinstance(hex_or_tuple, int):
        r = ((hex_or_tuple >> 16) & 255) / 255.0
        g = ((hex_or_tuple >> 8) & 255) / 255.0
        b = (hex_or_tuple & 255) / 255.0
    else:
        r, g, b = hex_or_tuple[:3]
    f = lambda v: v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return (f(r), f(g), f(b))


def make_image(name, size, pixels_rgba_flat):
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, size, size, alpha=False)
    img.pixels.foreach_set(pixels_rgba_flat)
    try:
        img.pack()
    except Exception:
        pass
    return img


# ------------------------------------------------------------------ mesh building

def new_object(name, me):
    ob = bpy.data.objects.new(name, me)
    link(ob)
    return ob


def bm_to_object(bm, name, mat=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = new_object(name, me)
    if mat is not None:
        me.materials.append(mat)
    return ob


def apply_modifiers(ob):
    """Bake the evaluated (modified) mesh into the object without using operators."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return ob


def box(name, size, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, bevel=0.0, segments=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    ob = bm_to_object(bm, name, mat)
    ob.location = loc
    ob.rotation_euler = rot
    if bevel > 0:
        m = ob.modifiers.new('Bevel', 'BEVEL')
        m.width = bevel
        m.segments = segments
        m.limit_method = 'ANGLE'
        apply_modifiers(ob)
    return ob


def cylinder(name, r1, r2, depth, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, segs=16, bevel=0.0, cap=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=segs, radius1=r1, radius2=r2, depth=depth)
    ob = bm_to_object(bm, name, mat)
    ob.location = loc
    ob.rotation_euler = rot
    if bevel > 0:
        m = ob.modifiers.new('Bevel', 'BEVEL')
        m.width = bevel
        m.segments = 2
        m.limit_method = 'ANGLE'
        apply_modifiers(ob)
    return ob


def sphere(name, r, loc=(0, 0, 0), scale=(1, 1, 1), mat=None, segs=24, rings=16):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=r)
    ob = bm_to_object(bm, name, mat)
    ob.location = loc
    ob.scale = scale
    return ob


def smooth(ob, angle=60):
    me = ob.data
    for p in me.polygons:
        p.use_smooth = True
    try:
        me.set_sharp_from_angle(angle=math.radians(angle))
    except Exception:
        try:
            me.use_auto_smooth = True
            me.auto_smooth_angle = math.radians(angle)
        except Exception:
            pass
    return ob


def bake_transform(ob):
    """Apply object transform into mesh data (no operators)."""
    mw = ob.matrix_basis.copy()
    ob.data.transform(mw)
    ob.matrix_basis = Matrix.Identity(4)
    return ob


def join(objs, name):
    """Join meshes (materials preserved) without operators."""
    bm = bmesh.new()
    mats = []
    for ob in objs:
        bake_transform(ob)
        me = ob.data
        idx_map = {}
        for i, m in enumerate(me.materials):
            if m is None:
                continue
            if m not in mats:
                mats.append(m)
            idx_map[i] = mats.index(m)
        tmp = bmesh.new()
        tmp.from_mesh(me)
        for f in tmp.faces:
            f.material_index = idx_map.get(f.material_index, 0)
        me2 = bpy.data.meshes.new('tmpjoin')
        tmp.to_mesh(me2)
        tmp.free()
        bm.from_mesh(me2)
        bpy.data.meshes.remove(me2)
    for ob in objs:
        bpy.data.objects.remove(ob, do_unlink=True)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    ob = new_object(name, me)
    return ob


def box_uv(ob, scale=1.0):
    """Cube-projection UVs, good enough for tiling fabric / grime textures."""
    me = ob.data
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    uv = me.uv_layers.active.data
    for poly in me.polygons:
        n = poly.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for li in poly.loop_indices:
            v = me.vertices[me.loops[li].vertex_index].co
            if ax == 0:
                u, w = v.y, v.z
            elif ax == 1:
                u, w = v.x, v.z
            else:
                u, w = v.x, v.y
            uv[li].uv = (u * scale, w * scale)


def export_glb(path, objects, animations=False):
    for ob in bpy.context.scene.objects:
        ob.select_set(False)
    for ob in objects:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    kwargs = dict(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                  export_animations=animations, export_skins=True)
    if animations:
        kwargs.update(export_animation_mode='ACTIONS', export_force_sampling=True, export_frame_step=1, export_anim_single_armature=True)
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError as e:
        log('gltf export: retrying with minimal options:', e)
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_animations=animations)
    log('exported', path, f'{os.path.getsize(path) / 1024:.0f} KB')


def save_blend(name):
    path = os.path.join(SOURCE_DIR, name)
    try:
        bpy.ops.wm.save_as_mainfile(filepath=path, copy=True)
        log('saved', path)
    except Exception:
        log_exc('save_blend')
