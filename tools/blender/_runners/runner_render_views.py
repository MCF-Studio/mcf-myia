"""blender_render_views : quatre vues PNG (avant, trois-quarts, arrière, dessus) en Workbench, sans fenêtre.

Adapté de review_shots.py (blender-agent-skills 1.3.1, licence MIT, Copyright (c) 2026 EL4CTEO :
tools/blender/_vendor/LICENSE-blender-agent-skills.txt) : vues séparées aux noms fixes, couleurs des matériaux et
textures, mesures de silhouette.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common  # noqa: E402
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

RES = 1024
VIEWS = (("avant", (0, -1, 0.15)), ("trois_quarts", (1, -1, 0.6)), ("arriere", (0, 1, 0.15)), ("dessus", (0, -0.001, 1)))


def _material_colors():
    """Workbench affiche diffuse_color : on y recopie la couleur de base du BSDF (les textures restent affichées)."""
    for m in bpy.data.materials:
        if not m.use_nodes or not m.node_tree:
            continue
        b = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if b is not None and not b.inputs["Base Color"].is_linked:
            m.diffuse_color = tuple(b.inputs["Base Color"].default_value)


def handle(req):
    _common.open_input(req, req["file"])
    obs = _common.visible_meshes()
    if not obs:
        raise _common.UserError("aucun maillage visible à rendre")
    _material_colors()
    sc = bpy.context.scene
    for o in sc.objects:
        o.hide_render = o not in obs
    r, sh = sc.render, sc.display.shading
    r.engine = "BLENDER_WORKBENCH"
    r.resolution_x = r.resolution_y = RES
    r.resolution_percentage = 100
    r.film_transparent = False
    r.image_settings.file_format = "PNG"
    sh.light = "STUDIO"
    sh.color_type = "TEXTURE"
    sh.show_cavity = True
    sh.show_object_outline = True

    lo, hi = _common.world_bounds(obs)
    lo, hi = Vector(lo), Vector(hi)
    center, radius = (lo + hi) / 2, max((hi - lo).length / 2, 1e-3)
    cam_data = bpy.data.cameras.new("MyIA_Cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("MyIA_Cam", cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    fov = 2 * math.atan(cam_data.sensor_width / (2 * cam_data.lens))
    dist = radius / math.sin(fov / 2) * 1.05
    cam_data.clip_end = dist * 4
    cam_data.clip_start = dist / 1000
    out_dir = os.path.join(req["work"], "out")
    os.makedirs(out_dir, exist_ok=True)
    files = []
    for label, d in VIEWS:
        d = Vector(d).normalized()
        cam.location = center + d * dist
        cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
        name = f"{req['stem']}_{label}.png"
        r.filepath = os.path.join(out_dir, name)
        bpy.ops.render.render(write_still=True)
        files.append(name)
    return {"files": files, "resolution": RES,
            "silhouette": {"largeur_x": hi.x - lo.x, "profondeur_y": hi.y - lo.y, "hauteur_z": hi.z - lo.z},
            "objects": len(obs)}, []


_common.main(handle)
