"""Build every Blender-made asset for Breakpoint Zero.

From a terminal:
    blender --background --python tools/blender/run_all.py
Or inside Blender's Python console:
    import runpy; runpy.run_path(r"<project>/tools/blender/run_all.py", run_name="__main__")

Outputs go to client/assets/models/ (GLB) and tools/blender/source/ (.blend files).
A log is written to tools/blender/build_log.txt.
"""
import importlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bpz_common
importlib.reload(bpz_common)
bpz_common.reset_log()

STEPS = [('build_weapons', 'weapons'), ('build_props', 'props'), ('build_operators', 'operators')]
# the older generic soldier builder is kept for reference: BPZ_ONLY=characters
if os.environ.get('BPZ_ONLY', '') == 'characters':
    STEPS.append(('build_characters', 'characters'))
only = os.environ.get('BPZ_ONLY', '')

for mod_name, label in STEPS:
    if only and label not in only.split(','):
        continue
    try:
        bpz_common.log(f'=== {label} ===')
        mod = importlib.import_module(mod_name)
        mod = importlib.reload(mod)
        mod.build_all()
        bpz_common.log(f'=== {label} done ===')
    except Exception:
        bpz_common.log_exc(label)

bpz_common.log('ALL DONE')
