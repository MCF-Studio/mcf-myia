"""Schéma de la spec de `blender_build` : validation stricte, sans bpy.

Partagé par `tools/blender/blender_build/tool.py` (avant de lancer Blender) et par `runner_build.py` (qui revalide la
requête dans Blender). L'agent n'écrit que ces données : aucune chaîne n'est jamais évaluée, chaque champ est connu,
typé et borné. Une erreur cite le chemin JSON fautif (`parts[12].size`) et ce qui était attendu.

Unités : mètres et degrés, Z en haut, face avant vers -Y (= +Z dans Godot).
"""
import math
import re

NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")      # jamais un tiret en tête (allure d'option)
PROP_KEY = re.compile(r"^[a-z][a-z0-9_]{0,31}$")

MAX_PRIMITIVES = 2000          # pièces après dépliage des mirror / array
MAX_TRIS = 200_000             # plafond dur (le budget de la spec est un avertissement)
DEFAULT_BUDGET = 5000          # objet de décor
MAX_DIM = 200.0                # mètres, pour toute coordonnée ou dimension
MAX_DEPTH = 8
MAX_ARRAY = 100
MAX_MATERIALS = 64
MAX_COLLISIONS = 64
MAX_HINGES = 32
MAX_PROPS = 16
MAX_MESH_VERTS = 5000
MAX_MESH_FACES = 10_000
MAX_PROFILE = 64
MAX_ERRORS = 10
SATURATED = 0.9                # composante de couleur au-delà de laquelle on signale (hors émissif)
SEG = (3, 64)

# Couleurs réalistes (linéaires) de mcf_kit.COL : jamais saturées à fond.
COL = {
    "Red": (0.45, 0.04, 0.03), "White": (0.8, 0.8, 0.78), "Yellow": (0.75, 0.5, 0.03),
    "Orange": (0.8, 0.18, 0.02), "Green": (0.05, 0.16, 0.06), "DarkGreen": (0.025, 0.07, 0.035),
    "Blue": (0.03, 0.08, 0.25), "Grey": (0.25, 0.26, 0.27), "Anthracite": (0.06, 0.065, 0.07),
    "Black": (0.03, 0.03, 0.03), "Brown": (0.12, 0.06, 0.03),
}

# Palette de mcf_kit.MAT, MAT_PAINT et MAT_PLASTIC, exprimée dans le format des matériaux de la spec.
KIT = {
    "Concrete": {"polyhaven": "brushed_concrete"},
    "ConcreteDirty": {"polyhaven": "dirty_concrete"},
    "ConcreteBlock": {"polyhaven": "concrete_block_wall"},
    "Galvanized": {"polyhaven": "corrugated_iron", "normal_strength": 0.08},
    "RustyMetal": {"polyhaven": "rust_coarse_01"},
    "DarkMetal": {"polyhaven": "metal_plate_02"},
    "Wood": {"polyhaven": "brown_planks_03"},
    "WoodDark": {"polyhaven": "weathered_planks"},
    "WoodRough": {"polyhaven": "rough_wood"},
    "Stone": {"polyhaven": "rustic_stone_wall"},
    "StoneDry": {"polyhaven": "stone_wall"},
    "Plaster": {"polyhaven": "plastered_wall_02", "tint": [0.74, 0.71, 0.66]},
    "Brick": {"polyhaven": "red_brick"},
    "Rubber": {"flat": [0.03, 0.03, 0.03], "rough": 0.9},
    "PlasticBlack": {"flat": [0.025, 0.025, 0.025], "rough": 0.55},
    "Glass": {"flat": [0.6, 0.7, 0.75], "rough": 0.05, "metal": 0.0, "alpha": 0.3},
}
for _c, _rgb in COL.items():
    KIT[f"Painted_{_c}"] = {"polyhaven": "white_stucco", "tint": list(_rgb), "normal_strength": 0.5}
    KIT[f"Plastic_{_c}"] = {"flat": list(_rgb), "rough": 0.45}

PRIMITIVES = ("box", "boxz", "obox", "cyl", "cyl_between", "torus", "prism", "lathe", "tube", "heightfield", "mesh")
GROUPS = ("mirror", "array", "group", "hinged")
HEIGHT_FUNCS = ("flat", "waves", "mound", "hole")
PLACEMENTS = ("ground", "building", "held")
GROUND_Z = {"ground": 0.0, "building": 0.01}


class SpecError(ValueError):
    """Spec refusée : `errors` = [« chemin : attendu »] (10 au plus)."""

    user_facing = True          # message destiné à l'agent : pas de trace Python

    def __init__(self, errors):
        self.errors = errors[:MAX_ERRORS]
        more = f" (+{len(errors) - MAX_ERRORS} autres)" if len(errors) > MAX_ERRORS else ""
        super().__init__("spec invalide, rien n'est construit : " + " ; ".join(self.errors) + more)


class _Stop(Exception):
    pass


class _V:
    def __init__(self):
        self.errors, self.warnings = [], []

    def err(self, path, msg):
        self.errors.append(f"{path} : {msg}")
        if len(self.errors) > 3 * MAX_ERRORS:
            raise _Stop()

    # --- types de base -------------------------------------------------------------------------------------------
    def obj(self, path, v, allowed, required=()):
        if not isinstance(v, dict):
            self.err(path, "objet JSON attendu")
            return None
        for k in v:
            if k not in allowed:
                self.err(f"{path}.{k}", f"champ inconnu (attendus : {', '.join(allowed)})")
        for k in required:
            if k not in v:
                self.err(f"{path}.{k}", "champ requis manquant")
        return v

    def num(self, path, v, lo, hi, default=None, integer=False):
        if v is None:
            if default is None:
                self.err(path, "nombre requis")
            return default
        ok_type = isinstance(v, int) if integer else isinstance(v, (int, float))
        if isinstance(v, bool) or not ok_type or (isinstance(v, float) and not math.isfinite(v)):
            self.err(path, "entier attendu" if integer else "nombre attendu")
            return default
        if not lo <= v <= hi:
            self.err(path, f"valeur entre {lo} et {hi} attendue (reçu {v})")
            return default
        return int(v) if integer else float(v)

    def vec(self, path, v, n, lo=-MAX_DIM, hi=MAX_DIM, default=None):
        if v is None:
            if default is None:
                self.err(path, f"liste de {n} nombres requise")
            return list(default) if default is not None else None
        if not isinstance(v, list) or len(v) != n:
            self.err(path, f"liste de {n} nombres attendue")
            return list(default) if default is not None else [0.0] * n
        return [self.num(f"{path}[{i}]", x, lo, hi, 0.0) for i, x in enumerate(v)]

    def points(self, path, v, dim, lo_n, hi_n, lo=-MAX_DIM, hi=MAX_DIM):
        if not isinstance(v, list) or not lo_n <= len(v) <= hi_n:
            self.err(path, f"liste de {lo_n} à {hi_n} points de {dim} nombres attendue")
            return [[0.0] * dim for _ in range(lo_n)]
        return [self.vec(f"{path}[{i}]", p, dim, lo, hi) for i, p in enumerate(v)]

    def enum(self, path, v, choices, default=None):
        if v is None and default is not None:
            return default
        if v not in choices:
            self.err(path, f"une valeur parmi {', '.join(map(str, choices))} attendue")
            return default if default is not None else choices[0]
        return v

    def boolean(self, path, v, default):
        if v is None:
            return default
        if not isinstance(v, bool):
            self.err(path, "true ou false attendu")
            return default
        return v

    def name(self, path, v):
        if not isinstance(v, str) or not NAME.match(v):
            self.err(path, "nom de 1 à 64 caractères parmi A-Z a-z 0-9 _ - attendu")
            return "x"
        return v

    def color(self, path, v, user_defined=True, emissive=False):
        c = self.vec(path, v, 3, 0.0, 1.0)
        if user_defined and not emissive and c and max(c) > SATURATED:
            self.warnings.append(f"{path} : composante {max(c)} > {SATURATED} : couleur saturée, peu réaliste "
                                 "(préférer une couleur de mcf_kit ou un matériau Poly Haven)")
        return c


# --- matériaux ---------------------------------------------------------------------------------------------------
_MAT_FIELDS = {
    "kit": ("kit",),
    "polyhaven": ("polyhaven", "tint", "metal", "normal_strength", "use_diff"),
    "flat": ("flat", "rough", "metal", "alpha"),
    "emissive": ("emissive", "strength"),
}


def _material(v, path, m, slugs, user_defined=True):
    kinds = [k for k in _MAT_FIELDS if isinstance(m, dict) and k in m]
    if len(kinds) != 1:
        v.err(path, "un matériau a exactement un de ces champs : kit, polyhaven, flat, emissive")
        return {"flat": [0.5, 0.5, 0.5], "rough": 0.6, "metal": 0.0}
    kind = kinds[0]
    v.obj(path, m, _MAT_FIELDS[kind])
    if kind == "kit":
        name = v.enum(f"{path}.kit", m["kit"], sorted(KIT), "Concrete")
        out = _material(v, path, KIT[name], slugs, user_defined=False)
        out["kit"] = name
        return out
    if kind == "polyhaven":
        slug = m["polyhaven"]
        if not isinstance(slug, str) or not re.match(r"^[a-z0-9_]{1,80}$", slug):
            v.err(f"{path}.polyhaven", "slug Poly Haven attendu (minuscules, chiffres, _)")
            slug = "x"
        elif slugs is not None and slug not in slugs:
            v.err(f"{path}.polyhaven", f"« {slug} » absent de la bibliothèque (chercher avec polyhaven_find)")
        out = {"polyhaven": slug}
        if "tint" in m:
            out["tint"] = v.color(f"{path}.tint", m["tint"], user_defined)
        if "metal" in m:
            out["metal"] = v.num(f"{path}.metal", m["metal"], 0.0, 1.0, 0.0)
        out["normal_strength"] = v.num(f"{path}.normal_strength", m.get("normal_strength"), 0.0, 4.0, 1.0)
        out["use_diff"] = v.boolean(f"{path}.use_diff", m.get("use_diff"), True)
        return out
    if kind == "flat":
        out = {"flat": v.color(f"{path}.flat", m["flat"], user_defined),
               "rough": v.num(f"{path}.rough", m.get("rough"), 0.0, 1.0, 0.6),
               "metal": v.num(f"{path}.metal", m.get("metal"), 0.0, 1.0, 0.0)}
        if "alpha" in m:
            out["alpha"] = v.num(f"{path}.alpha", m["alpha"], 0.0, 1.0, 1.0)
        return out
    return {"emissive": v.color(f"{path}.emissive", m["emissive"], user_defined, emissive=True),
            "strength": v.num(f"{path}.strength", m.get("strength"), 0.0, 50.0, 5.0)}


def material_key(m):
    """Clé de contenu : deux matériaux identiques n'en font qu'un (déduplication par contenu)."""
    return repr(sorted((k, v) for k, v in m.items() if k != "kit"))


# --- pièces ------------------------------------------------------------------------------------------------------
_COMMON = ("shape", "mat", "loc", "rot")
_SHAPE_FIELDS = {
    "box": _COMMON + ("size", "bevel", "uvscale"),
    "boxz": _COMMON + ("size", "bevel", "uvscale"),
    "obox": ("shape", "mat", "loc", "axes", "half"),
    "cyl": _COMMON + ("r", "h", "r2", "seg", "caps", "bevel", "uvscale"),
    "cyl_between": ("shape", "mat", "a", "b", "r", "r2", "seg", "caps"),
    "torus": _COMMON + ("R", "r", "seg", "rseg", "arc"),
    "prism": _COMMON + ("profile", "length", "bevel", "uvscale"),
    "lathe": ("shape", "mat", "loc", "profile", "seg", "phase"),
    "tube": ("shape", "mat", "points", "r", "seg", "sub"),
    "heightfield": ("shape", "mat", "loc", "size", "seg", "bottom", "layers"),
    "mesh": _COMMON + ("verts", "faces", "bevel", "uvscale"),
}
_SHAPE_REQUIRED = {
    "box": ("size",), "boxz": ("size",), "obox": ("axes", "half"), "cyl": ("r", "h"),
    "cyl_between": ("a", "b", "r"), "torus": ("R", "r"), "prism": ("profile", "length"), "lathe": ("profile",),
    "tube": ("points", "r"), "heightfield": ("size", "layers"), "mesh": ("verts", "faces"),
}
_SIZE = (0.0005, MAX_DIM)
_RADIUS = (0.0005, MAX_DIM / 2)


def _cyl_tris(seg, caps):
    return 2 * seg + (2 * (seg - 2) if caps else 0)


def _shape(v, path, p, mats):
    shape = p["shape"]
    if shape not in PRIMITIVES:
        v.err(f"{path}.shape", f"forme inconnue (formes : {', '.join(PRIMITIVES)})")
        return None, 0
    v.obj(path, p, _SHAPE_FIELDS[shape], ("mat",) + _SHAPE_REQUIRED[shape])
    out = {"shape": shape}
    mat = p.get("mat")
    if not isinstance(mat, str) or mat not in mats:
        v.err(f"{path}.mat", "nom d'un matériau déclaré dans « materials » attendu")
    out["mat"] = mat
    fields = _SHAPE_FIELDS[shape]
    if "loc" in fields:
        out["loc"] = v.vec(f"{path}.loc", p.get("loc"), 3, default=(0, 0, 0))
    if "rot" in fields:
        out["rot"] = v.vec(f"{path}.rot", p.get("rot"), 3, -720.0, 720.0, default=(0, 0, 0))
    bevel_mul = 1
    if "bevel" in fields:
        out["bevel"] = v.num(f"{path}.bevel", p.get("bevel"), 0.0, 0.5, 0.0)
        bevel_mul = 4 if out["bevel"] else 1
    if "uvscale" in fields:
        out["uvscale"] = v.num(f"{path}.uvscale", p.get("uvscale"), 0.01, 100.0, 1.0)

    if shape in ("box", "boxz"):
        out["size"] = v.vec(f"{path}.size", p.get("size"), 3, *_SIZE)
        tris = 12
    elif shape == "obox":
        axes = p.get("axes")
        if not isinstance(axes, list) or len(axes) != 3:
            v.err(f"{path}.axes", "trois vecteurs (axes de la boîte) attendus")
            axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
        out["axes"] = [v.vec(f"{path}.axes[{i}]", a, 3, -1.0e3, 1.0e3) for i, a in enumerate(axes)]
        for i, a in enumerate(out["axes"]):
            if math.sqrt(sum(x * x for x in a)) < 1e-6:
                v.err(f"{path}.axes[{i}]", "vecteur non nul attendu")
        out["half"] = v.vec(f"{path}.half", p.get("half"), 3, 0.00025, MAX_DIM / 2)
        tris = 12
    elif shape in ("cyl", "cyl_between"):
        out["r"] = v.num(f"{path}.r", p.get("r"), *_RADIUS)
        if "r2" in p:
            out["r2"] = v.num(f"{path}.r2", p["r2"], 0.0, MAX_DIM / 2, 0.0)
        out["seg"] = v.num(f"{path}.seg", p.get("seg"), *SEG, 12 if shape == "cyl" else 8, integer=True)
        out["caps"] = v.boolean(f"{path}.caps", p.get("caps"), True)
        if shape == "cyl":
            out["h"] = v.num(f"{path}.h", p.get("h"), *_SIZE)
        else:
            out["a"] = v.vec(f"{path}.a", p.get("a"), 3)
            out["b"] = v.vec(f"{path}.b", p.get("b"), 3)
            if out["a"] and out["b"] and math.dist(out["a"], out["b"]) < 0.0005:
                v.err(f"{path}.b", "b doit être distinct de a (0,5 mm au moins)")
        tris = _cyl_tris(out["seg"] or 3, out["caps"])
    elif shape == "torus":
        out["R"] = v.num(f"{path}.R", p.get("R"), *_RADIUS)
        out["r"] = v.num(f"{path}.r", p.get("r"), *_RADIUS)
        out["seg"] = v.num(f"{path}.seg", p.get("seg"), *SEG, 16, integer=True)
        out["rseg"] = v.num(f"{path}.rseg", p.get("rseg"), *SEG, 6, integer=True)
        out["arc"] = v.num(f"{path}.arc", p.get("arc"), 1.0, 360.0, 360.0)
        tris = 2 * (out["seg"] or 3) * (out["rseg"] or 3)
    elif shape == "prism":
        out["profile"] = v.points(f"{path}.profile", p.get("profile"), 2, 3, MAX_PROFILE)
        out["length"] = v.num(f"{path}.length", p.get("length"), *_SIZE)
        n = len(out["profile"])
        tris = 2 * (n - 2) + 2 * n
    elif shape == "lathe":
        out["profile"] = v.points(f"{path}.profile", p.get("profile"), 2, 3, MAX_PROFILE)
        for i, (r_, _z) in enumerate(out["profile"]):
            if r_ is not None and r_ < 0:
                v.err(f"{path}.profile[{i}][0]", "rayon positif ou nul attendu")
        out["seg"] = v.num(f"{path}.seg", p.get("seg"), *SEG, 16, integer=True)
        out["phase"] = v.num(f"{path}.phase", p.get("phase"), -360.0, 360.0, 0.0)
        tris = 2 * (out["seg"] or 3) * len(out["profile"])
    elif shape == "tube":
        out["points"] = v.points(f"{path}.points", p.get("points"), 3, 2, MAX_PROFILE)
        out["r"] = v.num(f"{path}.r", p.get("r"), *_RADIUS)
        out["seg"] = v.num(f"{path}.seg", p.get("seg"), *SEG, 6, integer=True)
        out["sub"] = v.num(f"{path}.sub", p.get("sub"), 1, 16, 4, integer=True)
        pts = out["points"]
        for i in range(len(pts) - 1):
            if pts[i] and pts[i + 1] and math.dist(pts[i], pts[i + 1]) < 0.0005:
                v.err(f"{path}.points[{i + 1}]", "deux points consécutifs confondus")
        seg, steps = out["seg"] or 3, (len(pts) - 1) * (out["sub"] or 1)
        tris = 2 * seg * steps + 2 * (seg - 2)
    elif shape == "heightfield":
        out["size"] = v.vec(f"{path}.size", p.get("size"), 2, *_SIZE)
        out["seg"] = v.num(f"{path}.seg", p.get("seg"), 1, 64, 12, integer=True)
        out["bottom"] = v.num(f"{path}.bottom", p.get("bottom"), -MAX_DIM, MAX_DIM, 0.0)
        out["layers"] = _layers(v, f"{path}.layers", p.get("layers"))
        n = out["seg"] or 1
        tris = 4 * n * n + 8 * n
    else:  # mesh
        out["verts"] = v.points(f"{path}.verts", p.get("verts"), 3, 3, MAX_MESH_VERTS)
        out["faces"], tris = _faces(v, f"{path}.faces", p.get("faces"), len(out["verts"]))
    return out, tris * bevel_mul


def _faces(v, path, faces, nverts):
    if not isinstance(faces, list) or not 1 <= len(faces) <= MAX_MESH_FACES:
        v.err(path, f"liste de 1 à {MAX_MESH_FACES} faces attendue")
        return [], 0
    out, tris = [], 0
    for i, f in enumerate(faces):
        if (not isinstance(f, list) or not 3 <= len(f) <= MAX_PROFILE
                or any(isinstance(x, bool) or not isinstance(x, int) for x in f)):
            v.err(f"{path}[{i}]", f"liste de 3 à {MAX_PROFILE} indices de sommets attendue")
            continue
        if any(not 0 <= x < nverts for x in f):
            v.err(f"{path}[{i}]", f"indice hors de 0..{nverts - 1}")
            continue
        if len(set(f)) != len(f):
            v.err(f"{path}[{i}]", "sommet répété dans la face")
            continue
        out.append(list(f))
        tris += len(f) - 2
    return out, tris


_LAYER_FIELDS = {
    "flat": ("fn", "z"),
    "waves": ("fn", "amp", "fx", "fy", "phase"),
    "mound": ("fn", "amp", "center", "radius"),
    "hole": ("fn", "depth", "center", "radius"),
}


def _layers(v, path, layers):
    if not isinstance(layers, list) or not 1 <= len(layers) <= 16:
        v.err(path, "liste de 1 à 16 couches (flat, waves, mound, hole) attendue")
        return [{"fn": "flat", "z": 0.0}]
    out = []
    for i, ly in enumerate(layers):
        lp = f"{path}[{i}]"
        if not isinstance(ly, dict) or ly.get("fn") not in HEIGHT_FUNCS:
            v.err(f"{lp}.fn", f"une fonction parmi {', '.join(HEIGHT_FUNCS)} attendue")
            continue
        fn = ly["fn"]
        v.obj(lp, ly, _LAYER_FIELDS[fn], _LAYER_FIELDS[fn][1:2])
        o = {"fn": fn}
        if fn == "flat":
            o["z"] = v.num(f"{lp}.z", ly.get("z"), -MAX_DIM, MAX_DIM, 0.0)
        elif fn == "waves":
            o["amp"] = v.num(f"{lp}.amp", ly.get("amp"), 0.0, 10.0, 0.0)
            o["fx"] = v.num(f"{lp}.fx", ly.get("fx"), 0.0, 100.0, 1.0)
            o["fy"] = v.num(f"{lp}.fy", ly.get("fy"), 0.0, 100.0, 1.0)
            o["phase"] = v.num(f"{lp}.phase", ly.get("phase"), -360.0, 360.0, 0.0)
        else:
            key = "amp" if fn == "mound" else "depth"
            o[key] = v.num(f"{lp}.{key}", ly.get(key), 0.0, 50.0, 0.0)
            o["center"] = v.vec(f"{lp}.center", ly.get("center"), 2, default=(0, 0))
            o["radius"] = v.num(f"{lp}.radius", ly.get("radius"), 0.001, MAX_DIM, 1.0)
        out.append(o)
    return out


class _Count:
    def __init__(self):
        self.primitives = 0
        self.tris = 0
        self.hinges = []


def _nodes(v, path, nodes, mats, count, depth, mult, top):
    if not isinstance(nodes, list) or not nodes:
        v.err(path, "liste non vide de pièces attendue")
        return []
    if depth > MAX_DEPTH:
        v.err(path, f"regroupements imbriqués sur plus de {MAX_DEPTH} niveaux")
        return []
    out = []
    for i, n in enumerate(nodes):
        p = f"{path}[{i}]"
        if not isinstance(n, dict):
            v.err(p, "objet JSON attendu")
            continue
        kinds = [k for k in ("shape",) + GROUPS if k in n]
        if len(kinds) != 1:
            v.err(p, "une pièce a exactement un de ces champs : shape (forme), mirror, array, group, hinged")
            continue
        kind = kinds[0]
        if kind == "shape":
            s, tris = _shape(v, p, n, mats)
            if s:
                out.append(s)
                count.primitives += mult
                count.tris += tris * mult
            continue
        v.obj(p, n, (kind, "parts"), ("parts",))
        g = n[kind]
        if kind == "mirror":
            node = {"mirror": v.enum(f"{p}.mirror", g, ("x", "y"), "x")}
            sub_mult = 2
        elif kind == "array":
            v.obj(f"{p}.array", g, ("count", "step"), ("count", "step"))
            g = g if isinstance(g, dict) else {}
            c = v.num(f"{p}.array.count", g.get("count"), 2, MAX_ARRAY, 2, integer=True)
            node = {"array": {"count": c, "step": v.vec(f"{p}.array.step", g.get("step"), 3)}}
            sub_mult = c
        elif kind == "group":
            v.obj(f"{p}.group", g, ("loc", "rot"))
            g = g if isinstance(g, dict) else {}
            node = {"group": {"loc": v.vec(f"{p}.group.loc", g.get("loc"), 3, default=(0, 0, 0)),
                              "rot": v.vec(f"{p}.group.rot", g.get("rot"), 3, -720.0, 720.0, default=(0, 0, 0))}}
            sub_mult = 1
        else:  # hinged
            if not top:
                v.err(f"{p}.hinged", "une pièce animée (hinged) se place au premier niveau de « parts »")
            v.obj(f"{p}.hinged", g, ("name", "pivot", "axis", "angle", "collision", "handle"), ("name", "pivot"))
            g = g if isinstance(g, dict) else {}
            h = {"name": v.name(f"{p}.hinged.name", g.get("name")),
                 "pivot": v.vec(f"{p}.hinged.pivot", g.get("pivot"), 3),
                 "axis": v.enum(f"{p}.hinged.axis", g.get("axis"), ("X", "Y", "Z"), "Z"),
                 "angle": v.num(f"{p}.hinged.angle", g.get("angle"), -180.0, 180.0, 90.0)}
            if "collision" in g:
                c = g["collision"]
                v.obj(f"{p}.hinged.collision", c, ("size", "loc"), ("size", "loc"))
                c = c if isinstance(c, dict) else {}
                h["collision"] = {"size": v.vec(f"{p}.hinged.collision.size", c.get("size"), 3, *_SIZE),
                                  "loc": v.vec(f"{p}.hinged.collision.loc", c.get("loc"), 3)}
            if "handle" in g:
                h["handle"] = v.vec(f"{p}.hinged.handle", g["handle"], 3)
            if h["name"] in count.hinges:
                v.err(f"{p}.hinged.name", f"« {h['name']} » déjà pris par une autre pièce animée")
            count.hinges.append(h["name"])
            node = {"hinged": h}
            sub_mult = 1
        node["parts"] = _nodes(v, f"{p}.parts", n.get("parts"), mats, count, depth + 1, mult * sub_mult, False)
        out.append(node)
    return out


def _collisions(v, path, cols):
    if cols is None:
        return []
    if not isinstance(cols, list) or len(cols) > MAX_COLLISIONS:
        v.err(path, f"liste de {MAX_COLLISIONS} collisions au plus attendue")
        return []
    out, names = [], set()
    for i, c in enumerate(cols):
        p = f"{path}[{i}]"
        if not isinstance(c, dict) or c.get("shape") not in ("box", "cyl"):
            v.err(f"{p}.shape", "box ou cyl attendu")
            continue
        if c["shape"] == "box":
            v.obj(p, c, ("shape", "name", "size", "loc", "rot"), ("size", "loc"))
            o = {"shape": "box", "size": v.vec(f"{p}.size", c.get("size"), 3, *_SIZE)}
        else:
            v.obj(p, c, ("shape", "name", "r", "h", "loc", "rot", "seg"), ("r", "h", "loc"))
            o = {"shape": "cyl", "r": v.num(f"{p}.r", c.get("r"), *_RADIUS), "h": v.num(f"{p}.h", c.get("h"), *_SIZE),
                 "seg": v.num(f"{p}.seg", c.get("seg"), 3, 32, 8, integer=True)}
        o["loc"] = v.vec(f"{p}.loc", c.get("loc"), 3)
        o["rot"] = v.vec(f"{p}.rot", c.get("rot"), 3, -720.0, 720.0, default=(0, 0, 0))
        o["name"] = v.name(f"{p}.name", c["name"]) if "name" in c else ""
        if o["name"] in names:
            v.err(f"{p}.name", "deux collisions portent le même nom" if o["name"] else
                  "une seule collision peut rester sans nom : nommer les autres")
        names.add(o["name"])
        out.append(o)
    return out


def _props(v, path, props):
    if props is None:
        return {}
    if not isinstance(props, dict) or len(props) > MAX_PROPS:
        v.err(path, f"objet de {MAX_PROPS} propriétés au plus attendu")
        return {}
    out = {}
    for k, val in props.items():
        if not PROP_KEY.match(k):
            v.err(f"{path}.{k}", "nom de propriété en minuscules (a-z, 0-9, _), 32 caractères au plus")
        elif isinstance(val, bool) or (isinstance(val, int) and abs(val) < 2 ** 31):
            out[k] = val
        elif isinstance(val, float) and math.isfinite(val):
            out[k] = val
        elif isinstance(val, str) and len(val) <= 64 and val.isprintable():
            out[k] = val
        else:
            v.err(f"{path}.{k}", "booléen, nombre ou texte court (64 caractères) attendu")
    return out


TOP_FIELDS = ("name", "placement", "budget_tris", "props", "materials", "parts", "collisions")


def validate(spec, slugs=None):
    """(spec normalisée, avertissements). `slugs` : matériaux Poly Haven présents (None = non vérifié).

    Lève SpecError si quelque chose ne va pas : rien n'est alors construit."""
    v = _V()
    out: dict = {}
    try:
        if not isinstance(spec, dict):
            raise SpecError(["(racine) : objet JSON attendu"])
        v.obj("(racine)", spec, TOP_FIELDS, ("name", "materials", "parts"))
        out = {"name": v.name("name", spec.get("name")),
               "placement": v.enum("placement", spec.get("placement"), PLACEMENTS, "ground"),
               "budget_tris": v.num("budget_tris", spec.get("budget_tris"), 100, MAX_TRIS, DEFAULT_BUDGET, integer=True),
               "props": _props(v, "props", spec.get("props"))}
        mats = spec.get("materials")
        out["materials"] = {}
        if not isinstance(mats, dict) or not 1 <= len(mats) <= MAX_MATERIALS:
            v.err("materials", f"objet {{nom: matériau}} de 1 à {MAX_MATERIALS} entrées attendu")
            mats = {}
        for k, m in mats.items():
            out["materials"][v.name(f"materials.{k}", k)] = _material(v, f"materials.{k}", m, slugs)
        count = _Count()
        out["parts"] = _nodes(v, "parts", spec.get("parts"), out["materials"], count, 1, 1, True)
        out["collisions"] = _collisions(v, "collisions", spec.get("collisions"))
        if count.primitives > MAX_PRIMITIVES:
            v.err("parts", f"{count.primitives} pièces une fois mirror/array dépliés : {MAX_PRIMITIVES} au plus")
        if count.tris > MAX_TRIS:
            v.err("parts", f"environ {count.tris} triangles : plafond {MAX_TRIS}")
        if len(count.hinges) > MAX_HINGES:
            v.err("parts", f"{MAX_HINGES} pièces animées au plus")
    except _Stop:
        pass
    if v.errors:
        raise SpecError(v.errors)
    if not out["collisions"] and not any("collision" in h for h in _hinges(out["parts"])):
        v.warnings.append("aucune collision (-col) : le joueur traversera l'objet ; ajouter « collisions »")
    used = _used_materials(out["parts"])
    unused = sorted(set(out["materials"]) - used)
    if unused:
        v.warnings.append(f"matériaux déclarés mais jamais utilisés : {', '.join(unused)}")
    return out, v.warnings


def _hinges(nodes):
    return [n["hinged"] for n in nodes if "hinged" in n]


def _used_materials(nodes):
    used = set()
    for n in nodes:
        if "shape" in n:
            used.add(n["mat"])
        else:
            used |= _used_materials(n["parts"])
    return used


def polyhaven_slugs(spec):
    """Slugs Poly Haven utilisés par une spec NORMALISÉE (kit compris)."""
    return sorted({m["polyhaven"] for m in spec["materials"].values() if "polyhaven" in m})


def catalog():
    """Ce que connaît blender_build : formes, regroupements, matériaux du kit (pour blender_info)."""
    return {"primitives": list(PRIMITIVES), "groups": list(GROUPS), "heightfield_functions": list(HEIGHT_FUNCS),
            "materials": sorted(KIT), "placements": list(PLACEMENTS)}
