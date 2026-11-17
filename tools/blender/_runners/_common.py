"""Code commun des runners, exécuté DANS Blender (lancé par tools/blender_runtime.py).

Contrat : `blender -b --factory-startup --disable-autoexec --python runner_<outil>.py -- <request.json> <result.json>`.
Le runner relit la requête, fait son travail dans le dossier temporaire de l'appel (`request["work"]`) et écrit
`{"ok": true, "data": ..., "warnings": [...]}` ou `{"ok": false, "error": "..."}` dans result.json. Blender n'écrit
nulle part ailleurs : c'est tool.py qui copie les fichiers produits vers le dossier de sortie contrôlé.
"""
import json
import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(os.path.dirname(HERE), "_vendor")
for _p in (HERE, VENDOR):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import bpy  # noqa: E402

import blendscan  # noqa: E402

MIN_VERSION = (5, 2, 0)
MAX_BLEND_BYTES = 2 * 1024 ** 3        # .blend décompressé


class UserError(Exception):
    """Erreur attendue, message clair en français (sans trace Python dans la réponse)."""


def _round(v, n=4):
    if isinstance(v, float):
        return round(v, n)
    if isinstance(v, (list, tuple)):
        return [_round(x, n) for x in v]
    if isinstance(v, dict):
        return {k: _round(x, n) for k, x in v.items()}
    return v


def main(handler):
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(args) != 2:
        print("runner : arguments attendus : <request.json> <result.json>", file=sys.stderr)
        sys.exit(2)
    req_path, res_path = args
    try:
        if tuple(bpy.app.version) < MIN_VERSION:
            raise UserError(f"Blender {bpy.app.version_string} : il faut Blender 5.2 LTS ou plus récent "
                            "(entrée « blender » de tools/apps.json)")
        with open(req_path, encoding="utf-8") as f:
            req = json.load(f)
        if not isinstance(req, dict) or not os.path.isdir(req.get("work", "")):
            raise UserError("requête invalide")
        data, warnings = handler(req)
        out = {"ok": True, "data": _round(data), "warnings": [str(w) for w in warnings][:50]}
    except Exception as exc:  # noqa: BLE001 - toute erreur devient un résultat lisible
        if isinstance(exc, UserError) or getattr(exc, "user_facing", False):
            out = {"ok": False, "error": str(exc)}
        else:
            out = {"ok": False, "error": f"{type(exc).__name__} : {exc}", "trace": traceback.format_exc()[-3000:]}
    with open(res_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)


# ----------------------------------------------------------------------------- fichiers d'entrée
def _norm(p):
    return os.path.normcase(os.path.realpath(p))


def _inside(path, base):
    p, b = _norm(path), _norm(base)
    return p == b or p.startswith(b.rstrip("\\/") + os.sep)


def _allowed(path, req):
    if path.startswith(("\\\\", "//")):
        return False
    if any(_inside(path, d) for d in req.get("denied", [])):
        return False
    return any(_inside(path, d) for d in req.get("read_roots", []))


def _blend_bytes(path):
    with open(path, "rb") as f:
        head = f.read(4)
        f.seek(0)
        if head != blendscan.ZSTD_MAGIC:
            return f.read(MAX_BLEND_BYTES + 1)
        import zstandard
        with zstandard.ZstdDecompressor().stream_reader(f, read_across_frames=True) as r:
            data = r.read(MAX_BLEND_BYTES + 1)
    if len(data) > MAX_BLEND_BYTES:
        raise UserError("fichier .blend trop volumineux une fois décompressé")
    return data


def check_external_files(req, what="ce fichier"):
    """Fichiers externes référencés (images, bibliothèques…) : locaux et dans les dossiers autorisés en lecture.
    Appelé avant que quoi que ce soit ne lise leurs pixels (rendu, export)."""
    bad = []
    for p in bpy.utils.blend_paths(absolute=True, packed=False, local=False):
        if p and not _allowed(p, req):
            bad.append(p)
    if bad:
        raise UserError(f"{what} référence des fichiers hors des dossiers autorisés en lecture ou sur le réseau "
                        f"({', '.join(bad[:3])}{'…' if len(bad) > 3 else ''}) : refusé")


def open_input(req, path):
    """Ouvre un .blend (après analyse de ses blocs) ou importe un .glb dans une scène vide."""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".blend":
        try:
            issues = blendscan.scan(_blend_bytes(path))
        except blendscan.BlendError as exc:
            raise UserError(str(exc)) from None
        if issues:
            raise UserError("ce .blend charge des fichiers externes à l'ouverture, refusé : " + " ; ".join(issues[:5]))
        bpy.ops.wm.open_mainfile(filepath=path, load_ui=False, use_scripts=False)
        if bpy.data.libraries:
            raise UserError("ce .blend contient des bibliothèques liées : refusé")
        check_external_files(req, "ce .blend")
    elif ext == ".glb":
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=path)
    else:
        raise UserError("fichier .blend ou .glb attendu")


# ----------------------------------------------------------------------------- mesures
def is_collision(o):
    return o.name.endswith("-col") or "-col." in o.name


def mesh_tris(o):
    dg = bpy.context.evaluated_depsgraph_get()
    eo = o.evaluated_get(dg)
    me = eo.to_mesh()
    try:
        me.calc_loop_triangles()
        return len(me.loop_triangles)
    finally:
        eo.to_mesh_clear()


def world_bounds(objs):
    """(min, max) monde des objets maillages, ou None."""
    from mathutils import Vector
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    if not pts:
        return None
    return ([min(p[i] for p in pts) for i in range(3)], [max(p[i] for p in pts) for i in range(3)])


def lowest_z(objs):
    """Plus bas sommet (monde) des maillages, modificateurs appliqués."""
    dg = bpy.context.evaluated_depsgraph_get()
    z = None
    for o in objs:
        eo = o.evaluated_get(dg)
        me = eo.to_mesh()
        try:
            mw = o.matrix_world
            for v in me.vertices:
                w = (mw @ v.co).z
                z = w if z is None else min(z, w)
        finally:
            eo.to_mesh_clear()
    return z


def visible_meshes():
    return [o for o in bpy.context.scene.objects if o.type == "MESH" and not is_collision(o)]
