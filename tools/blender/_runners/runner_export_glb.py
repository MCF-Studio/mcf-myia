"""blender_export_glb : exporte un .blend en .glb pour Godot (Y en haut, modificateurs appliqués, suffixe -col gardé),
puis rouvre le .glb dans une scène vide et compare objets et triangles.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common  # noqa: E402
import bpy  # noqa: E402

SUFFIX = re.compile(r"\.\d{3}$")


def _snapshot():
    """{nom: triangles} des maillages (modificateurs appliqués), + noms des vides."""
    meshes = {o.name: _common.mesh_tris(o) for o in bpy.context.scene.objects if o.type == "MESH"}
    empties = sorted(o.name for o in bpy.context.scene.objects if o.type == "EMPTY")
    return meshes, empties


def _clean_names():
    """« X-col.001 » ne serait pas reconnu par Godot : suffixes .001 retirés quand le nom est libre."""
    renamed = 0
    for o in list(bpy.context.scene.objects):
        want = SUFFIX.sub("", o.name)
        if want != o.name and bpy.data.objects.get(want) is None:
            o.name = want
            renamed += 1
    return renamed


def handle(req):
    _common.open_input(req, req["file"])
    renamed = _clean_names()
    for o in bpy.context.scene.objects:
        o.hide_set(False)
    before_m, before_e = _snapshot()
    if not before_m:
        raise _common.UserError("aucun maillage à exporter")
    out = os.path.join(req["work"], "out", f"{req['stem']}.glb")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=False, use_visible=False,
                              export_extras=True, export_yup=True, export_apply=True,
                              export_image_format="AUTO", export_animations=False)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=out)
    after_m, after_e = _snapshot()
    gaps = []
    for n in sorted(set(before_m) - set(after_m))[:10]:
        gaps.append(f"maillage absent du .glb : {n}")
    for n in sorted(set(after_m) - set(before_m))[:10]:
        gaps.append(f"maillage en plus dans le .glb : {n}")
    for n in sorted(set(before_m) & set(after_m)):
        if before_m[n] != after_m[n]:
            gaps.append(f"{n} : {before_m[n]} triangles dans le .blend, {after_m[n]} dans le .glb")
    missing_e = sorted(set(before_e) - set(after_e))
    if missing_e:
        gaps.append(f"vides absents du .glb : {', '.join(missing_e[:10])}")
    tris = sum(t for n, t in after_m.items() if not n.endswith("-col"))
    return {"file": os.path.basename(out), "size_bytes": os.path.getsize(out), "tris": tris,
            "objects": len(after_m) + len(after_e), "collisions": sum(1 for n in after_m if n.endswith("-col")),
            "renamed": renamed, "gaps": gaps[:30], "ok": not gaps}, []


_common.main(handle)
