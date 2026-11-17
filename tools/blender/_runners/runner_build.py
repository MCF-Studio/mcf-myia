"""blender_build : construit un objet depuis une spec JSON (revalidée ici), l'enregistre en .blend et l'exporte en .glb
optimisé (mcf_kit : fusion des pièces statiques, faces cachées supprimées, noms propres pour Godot).

Tout est écrit dans le dossier temporaire de l'appel ; tool.py copie ensuite <name>.glb et <name>.blend.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common  # noqa: E402
import bpy  # noqa: E402
import spec_schema  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import mcf_kit as kit  # noqa: E402  (tools/blender/_vendor)

TEX_RES = 1024
GROUND_TOL = 0.002


def _prepare_textures(textures, work):
    """Copies 1k (JPEG) des textures 2k de la bibliothèque, dans le dossier de l'appel : kit.TEXTURES."""
    os.makedirs(os.path.join(work, "tex"), exist_ok=True)
    for slug, maps in textures.items():
        kit.TEXTURES[slug] = {}
        for key, src in maps.items():
            if key not in ("diff", "nor", "arm") or not os.path.isfile(src):
                continue
            img = bpy.data.images.load(src, check_existing=False)
            if max(img.size) > TEX_RES:
                img.scale(TEX_RES, TEX_RES)
            dst = os.path.join(work, "tex", f"{slug}_{key}_1k.jpg")
            img.filepath_raw = dst
            img.file_format = "JPEG"
            img.save()
            bpy.data.images.remove(img)
            kit.TEXTURES[slug][key] = dst


def _material(name, m):
    if "polyhaven" in m:
        return kit.mat_pbr(f"M_{m.get('kit', name)}", m["polyhaven"], tint=m.get("tint"), metal=m.get("metal"),
                           normal_strength=m["normal_strength"], use_diff=m["use_diff"])
    if "flat" in m:
        return kit.mat_flat(f"M_{m.get('kit', name)}", m["flat"], m["rough"], m["metal"], m.get("alpha"))
    return kit.mat_emissive(f"M_{name}", m["emissive"], m["strength"])


def _height(layers, x, y):
    h = 0.0
    for ly in layers:
        fn = ly["fn"]
        if fn == "flat":
            h += ly["z"]
        elif fn == "waves":
            h += ly["amp"] * math.sin(ly["fx"] * x + math.radians(ly["phase"])) * math.cos(ly["fy"] * y)
        else:
            cx, cy = ly["center"]
            g = math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / ly["radius"] ** 2)
            h += ly["amp"] * g if fn == "mound" else -ly["depth"] * g
    return h


def _heightfield(p, s, mat):
    """Solide en relief (bac à sable de fam_p4_refaits) : dessus = somme des couches, fond plat, bords fermés."""
    n = s["seg"] + 1
    sx, sy = s["size"]
    ox, oy, oz = s["loc"]
    xs = [-sx / 2 + sx * i / (n - 1) for i in range(n)]
    ys = [-sy / 2 + sy * j / (n - 1) for j in range(n)]
    verts = [(ox + x, oy + y, oz + _height(s["layers"], x, y)) for y in ys for x in xs]
    verts += [(ox + x, oy + y, oz + s["bottom"]) for y in ys for x in xs]
    top = lambda i, j: j * n + i            # noqa: E731
    bot = lambda i, j: n * n + j * n + i    # noqa: E731
    faces = [(top(i, j), top(i + 1, j), top(i + 1, j + 1), top(i, j + 1)) for j in range(n - 1) for i in range(n - 1)]
    border = [(i, 0) for i in range(n - 1)] + [(n - 1, j) for j in range(n - 1)] \
        + [(i, n - 1) for i in range(n - 1, 0, -1)] + [(0, j) for j in range(n - 1, 0, -1)]
    for k in range(len(border)):
        a, b = border[k], border[(k + 1) % len(border)]
        faces.append((top(*a), bot(*a), bot(*b), top(*b)))
    faces += [(bot(i, j), bot(i, j + 1), bot(i + 1, j + 1), bot(i + 1, j)) for j in range(n - 1) for i in range(n - 1)]
    p.mesh(verts, faces, mat=mat)


def _primitive(p, s, mats):
    mat = mats[s["mat"]]
    sh = s["shape"]
    if sh in ("box", "boxz"):
        getattr(p, sh)(s["size"], s["loc"], s["rot"], mat=mat, bevel=s["bevel"], uvscale=s["uvscale"])
    elif sh == "obox":
        kit.obox(p, s["loc"], s["axes"], s["half"], mat)
    elif sh == "cyl":
        p.cyl(s["r"], s["h"], s["loc"], s["rot"], mat=mat, seg=s["seg"], r2=s.get("r2"), bevel=s["bevel"],
              caps=s["caps"], uvscale=s["uvscale"])
    elif sh == "cyl_between":
        p.cyl_between(s["a"], s["b"], s["r"], mat=mat, seg=s["seg"], caps=s["caps"], r2=s.get("r2"))
    elif sh == "torus":
        p.torus(s["R"], s["r"], s["loc"], s["rot"], mat=mat, seg=s["seg"], rseg=s["rseg"], arc=s["arc"])
    elif sh == "prism":
        p.prism(s["profile"], s["length"], s["loc"], s["rot"], mat=mat, bevel=s["bevel"], uvscale=s["uvscale"])
    elif sh == "lathe":
        kit.lathe(p, s["profile"], s["seg"], mat, phase=math.radians(s["phase"]), loc=s["loc"])
    elif sh == "tube":
        kit.tube(p, s["points"], s["r"], mat, seg=s["seg"], sub=s["sub"])
    elif sh == "heightfield":
        _heightfield(p, s, mat)
    else:
        p.mesh(s["verts"], s["faces"], s["loc"], s["rot"], mat=mat, bevel=s["bevel"], uvscale=s["uvscale"])


def _walk(p, nodes, M, mats):
    for n in nodes:
        if "shape" in n:
            p.M = M
            _primitive(p, n, mats)
        elif "mirror" in n:
            axis = 0 if n["mirror"] == "x" else 1
            S = Matrix.Diagonal([-1.0 if i == axis else 1.0 for i in range(3)] + [1.0])
            _walk(p, n["parts"], M, mats)
            _walk(p, n["parts"], M @ S, mats)
        elif "array" in n:
            step = Vector(n["array"]["step"])
            for k in range(n["array"]["count"]):
                _walk(p, n["parts"], M @ Matrix.Translation(step * k), mats)
        elif "group" in n:
            g = n["group"]
            _walk(p, n["parts"], M @ Matrix.Translation(g["loc"]) @ kit._rotm(g["rot"]), mats)
    p.M = Matrix.Identity(4)


def _faces(p):
    return len(p.bm.faces)


def handle(req):
    spec, warnings = spec_schema.validate(req["spec"], slugs=set(req["textures"]))
    name, work = spec["name"], req["work"]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    kit.reset_scene()
    _prepare_textures(req["textures"], work)
    mats = {k: _material(k, m) for k, m in spec["materials"].items()}

    r = kit.root(name, **spec["props"])
    main = kit.Part()
    _walk(main, [n for n in spec["parts"] if "hinged" not in n], Matrix.Identity(4), mats)
    if _faces(main):
        main.build(name + "_Mesh").parent = r
    for n in spec["parts"]:
        if "hinged" not in n:
            continue
        h = n["hinged"]
        hp = kit.Part()
        _walk(hp, n["parts"], Matrix.Identity(4), mats)
        col = (h["collision"]["size"], h["collision"]["loc"]) if "collision" in h else None
        kit.hinged(r, hp, f"{name}_{h['name']}", h["pivot"], h["axis"], h["angle"], col, h.get("handle"))
    for c in spec["collisions"]:
        cname = f"{name}_{c['name']}" if c["name"] else name
        if c["shape"] == "box":
            kit.col_box(cname, c["size"], c["loc"], c["rot"], parent=r)
        else:
            kit.col_cyl(cname, c["r"], c["h"], c["loc"], c["rot"], parent=r, seg=c["seg"])

    meshes = [o for o in kit.hierarchy(r) if o.type == "MESH" and not _common.is_collision(o)]
    if not meshes:
        raise _common.UserError("la spec ne produit aucune face visible")
    lo, hi = _common.world_bounds(meshes)
    dims = [hi[i] - lo[i] for i in range(3)]
    if max(dims) > spec_schema.MAX_DIM or max(map(abs, lo + hi)) > spec_schema.MAX_DIM:
        raise _common.UserError(f"objet de {max(dims):.1f} m une fois assemblé : {spec_schema.MAX_DIM:.0f} m au plus")
    source_tris = kit.tri_count(r)
    if source_tris > spec_schema.MAX_TRIS:
        raise _common.UserError(f"{source_tris} triangles : plafond {spec_schema.MAX_TRIS}, rien n'est livré")

    bpy.ops.file.pack_all()
    blend = os.path.join(work, "out", f"{name}.blend")
    glb = os.path.join(work, "out", f"{name}.glb")
    os.makedirs(os.path.dirname(blend), exist_ok=True)
    kit.save_blend(blend)
    tris = kit.export(r, glb)

    if tris > spec["budget_tris"]:
        warnings.append(f"{tris} triangles dans le .glb : au-delà du budget de {spec['budget_tris']} "
                        "(réduire seg, sub, bevel, ou relever budget_tris)")
    low = _common.lowest_z(meshes)
    want = spec_schema.GROUND_Z.get(spec["placement"])
    if want is not None and low is not None and abs(low - want) > GROUND_TOL:
        warnings.append(f"bas de l'objet à z = {low:.4f} m, attendu {want} m "
                        f"({'bâtiment' if spec['placement'] == 'building' else 'objet posé au sol'})")
    stats = kit.OPT_STATS[-1] if kit.OPT_STATS else None
    return {"name": name, "files": {"glb": os.path.basename(glb), "blend": os.path.basename(blend)},
            "tris": tris, "tris_source": source_tris, "hidden_faces_removed": stats[2] if stats else 0,
            "objects": len(kit.hierarchy(r)), "materials": sorted(m.name for m in set(mats.values())),
            "dimensions": dims, "lowest_z": low}, warnings


_common.main(handle)
