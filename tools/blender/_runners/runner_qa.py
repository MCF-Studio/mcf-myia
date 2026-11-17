"""blender_qa : contrôle qualité d'un .glb (qa_check de blender-agent-skills, profil game par défaut).

Les collisions (-col) ne sont pas contrôlées (invisibles en jeu). Avertissements acceptés (déplacés dans
`accepted`) : sommets doublés et UV qui se chevauchent (textures répétées), « pas au sol » pour un objet tenu en main.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common  # noqa: E402
import bpy  # noqa: E402

import qa_check  # noqa: E402  (tools/blender/_vendor)

RULE = ("règle : ce qui est plaqué sur une surface en est décollé d'au moins 5 mm ou y entre ; deux pièces qui "
        "s'aboutent n'ont pas de bord commun, l'une entre dans l'autre")
ACCEPTED = ("duplicate verts", "UV overlap")


def _weld(meshes):
    """L'import glTF sépare les sommets à chaque arête vive (une boîte = six faces isolées) : sans soudure, une pièce
    en l'air passerait pour six morceaux qui se touchent. On soude les sommets confondus (1e-5 m) avant le contrôle."""
    import bmesh
    for o in meshes:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
        bm.to_mesh(o.data)
        bm.free()
        o.data.update()


def handle(req):
    _common.open_input(req, req["file"])
    meshes = _common.visible_meshes()
    if not meshes:
        raise _common.UserError("aucun maillage visible dans ce fichier (seulement des collisions ?)")
    _weld(meshes)
    res = qa_check.run(objects=[o.name for o in meshes], profile=req["profile"])
    warnings, accepted = [], []
    for w in res["warnings"]:
        if any(a in w for a in ACCEPTED) or (req.get("held") and "not resting on ground" in w):
            accepted.append(w)
        else:
            warnings.append(w)
    errors = [e + (f" — {RULE}" if e.startswith("z-fighting") else "") for e in res["errors"]]
    cols = [o.name for o in bpy.context.scene.objects if _common.is_collision(o)]
    if not cols:
        warnings.append("aucune collision (-col) dans ce fichier")
    per = res["objects"]
    return {"pass": res["pass"], "profile": req["profile"], "errors": errors[:30], "warnings": warnings[:30],
            "accepted": accepted[:10], "zfighting": res["zfighting"][:20],
            "zfighting_points": res.get("zfighting_points", [])[:20], "floating": res["floating"][:20],
            "back_to_back": res["back_to_back"][:20], "ground_z": res["ground_z"],
            "tris": sum(m.get("tris", 0) for m in per.values()), "objects": len(per), "collisions": len(cols)}, []


_common.main(handle)
