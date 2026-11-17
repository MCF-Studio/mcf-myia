# Copie adaptée de mcf_kit.py et de _lathe / _tube / _obox (fam_p4_refaits.py) du dépôt MCF-RP
# (art/props_source/scripts/), avec l'accord d'Aroun (MCF Studio), sous la licence de MyIA.
#
# Adaptations pour MyIA :
# - plus aucun chemin du poste : les textures (1k déjà réduites) sont fournies par le runner dans TEXTURES ;
# - matériaux dédupliqués par contenu en mémoire (le registre material_registry.json n'est ni lu ni écrit) ;
# - Part.M : transformation héritée des regroupements (mirror, array, group) ; un miroir retourne les faces ;
# - export() et save_blend() prennent un chemin complet (le dossier temporaire de l'appel), rien d'autre n'est écrit ;
# - mat_image / gen_image retirés (ils écrivaient des fichiers générés dans le projet) ;
# - faces cachées : points témoins sur toute la face (_face_samples), l'original retirait des faces visibles.
"""Boîte à outils de modélisation d'assets MCF (Blender 5.2), exécutée par runner_build.py.

Conventions : 1 unité = 1 m, face avant vers -Y, origine au sol ; collisions = objets suffixés « -col » ;
export glTF binaire (.glb) avec extras.
"""
import math
import re as _re

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector
from mathutils.bvhtree import BVHTree as _BVH

TEXTURES = {}          # slug -> {"diff": chemin, "nor": chemin, "arm": chemin} (images 1k préparées par le runner)
_MATS = {}             # clé de contenu -> matériau


# ----------------------------------------------------------------------------- scène
def reset_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.cameras, bpy.data.lights):
        for b in list(block):
            block.remove(b)
    _MATS.clear()


# ----------------------------------------------------------------------------- matériaux
def _img(path, noncolor=False):
    img = bpy.data.images.load(path, check_existing=True)
    if noncolor:
        img.colorspace_settings.name = 'Non-Color'
    return img


def _gltf_output_group():
    g = bpy.data.node_groups.get("glTF Material Output")
    if g is None:
        g = bpy.data.node_groups.new("glTF Material Output", 'ShaderNodeTree')
        g.interface.new_socket("Occlusion", in_out='INPUT', socket_type='NodeSocketFloat')
    return g


def _bsdf(mat):
    return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")


def _rk(v):
    return None if v is None else (round(v, 4) if isinstance(v, (int, float)) else [round(x, 4) for x in v])


def _cached(key, name):
    """Une texture + des réglages identiques = UN matériau ; un même nom pour deux contenus reçoit un suffixe."""
    k = repr(key)
    if k in _MATS:
        return _MATS[k], None
    base, n = name, 2
    while bpy.data.materials.get(name) is not None:
        name = f"{base}_{n}"
        n += 1
    return None, (k, name)


def mat_pbr(name, slug, tint=None, metal=None, normal_strength=1.0, use_diff=True):
    """Matériau PBR Poly Haven (textures de TEXTURES[slug]). tint = couleur multipliée (variantes de peinture)."""
    m, new = _cached(["pbr", slug, _rk(tint), _rk(metal), _rk(normal_strength), use_diff], name)
    if m:
        return m
    tex = TEXTURES.get(slug, {})
    m = bpy.data.materials.new(new[1])
    m.use_nodes = True
    nt = m.node_tree
    b = _bsdf(m)
    x = -900
    if use_diff and "diff" in tex:
        n = nt.nodes.new("ShaderNodeTexImage"); n.image = _img(tex["diff"]); n.location = (x, 300)
        col_out = n.outputs["Color"]
        if tint is not None:
            mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
            mix.inputs[0].default_value = 1.0
            mix.inputs[7].default_value = (*tint, 1.0)
            mix.location = (-500, 300)
            nt.links.new(col_out, mix.inputs[6])
            col_out = mix.outputs[2]
        nt.links.new(col_out, b.inputs["Base Color"])
    elif tint is not None:
        b.inputs["Base Color"].default_value = (*tint, 1.0)
    if "arm" in tex:
        n = nt.nodes.new("ShaderNodeTexImage"); n.image = _img(tex["arm"], True); n.location = (x, 0)
        sep = nt.nodes.new("ShaderNodeSeparateColor"); sep.location = (-500, 0)
        nt.links.new(n.outputs["Color"], sep.inputs[0])
        nt.links.new(sep.outputs[1], b.inputs["Roughness"])
        if metal is None:
            nt.links.new(sep.outputs[2], b.inputs["Metallic"])
        else:
            b.inputs["Metallic"].default_value = metal
        g = nt.nodes.new("ShaderNodeGroup"); g.node_tree = _gltf_output_group(); g.location = (300, -300)
        nt.links.new(sep.outputs[0], g.inputs[0])
    elif metal is not None:
        b.inputs["Metallic"].default_value = metal
    if "nor" in tex:
        n = nt.nodes.new("ShaderNodeTexImage"); n.image = _img(tex["nor"], True); n.location = (x, -300)
        nm = nt.nodes.new("ShaderNodeNormalMap"); nm.location = (-400, -300)
        nm.inputs["Strength"].default_value = normal_strength
        nt.links.new(n.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    m["source"] = f"polyhaven/{slug}"
    _MATS[new[0]] = m
    return m


def mat_flat(name, color, rough=0.6, metal=0.0, alpha=None):
    """Matériau sans texture (plastique, verre, peinture unie très légère)."""
    m, new = _cached(["flat", _rk(color), _rk(rough), _rk(metal), _rk(alpha)], name)
    if m:
        return m
    m = bpy.data.materials.new(new[1]); m.use_nodes = True
    b = _bsdf(m)
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if alpha is not None:
        b.inputs["Alpha"].default_value = alpha
        m.surface_render_method = 'BLENDED'
    _MATS[new[0]] = m
    return m


def mat_emissive(name, color, strength=5.0):
    m, new = _cached(["emissive", _rk(color), _rk(strength)], name)
    if m:
        return m
    m = bpy.data.materials.new(new[1]); m.use_nodes = True
    b = _bsdf(m)
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Emission Color"].default_value = (*color, 1.0)
    b.inputs["Emission Strength"].default_value = strength
    _MATS[new[0]] = m
    return m


# ----------------------------------------------------------------------------- géométrie
def _rotm(rot):
    return Euler([math.radians(a) for a in rot], 'XYZ').to_matrix().to_4x4()


class Part:
    """Accumule de la géométrie (coordonnées de l'asset) dans un bmesh, avec index de matériau.

    M : transformation appliquée à tout ce qui est ajouté (regroupements de la spec)."""
    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []
        self.fdata = []  # par face, dans l'ordre : (index matériau, échelle uv, uv explicites ou None)
        self.M = Matrix.Identity(4)

    def _mi(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def _tmp(self):
        """Les primitives sont construites dans un bmesh temporaire puis fusionnées (bevel isolé)."""
        self._t = bmesh.new()
        return self._t

    def _finish(self, geom, mat, mtx, bevel, uvscale):
        t = self._t
        mtx = self.M @ mtx
        bmesh.ops.transform(t, matrix=mtx, verts=t.verts[:])
        if mtx.determinant() < 0:                     # miroir : les faces regarderaient vers l'intérieur
            bmesh.ops.reverse_faces(t, faces=t.faces[:])
        if bevel and bevel > 0:
            bmesh.ops.bevel(t, geom=t.edges[:], offset=bevel, segments=1, affect='EDGES',
                            profile=0.5, clamp_overlap=True)
        me = bpy.data.meshes.new("_tmp")
        t.to_mesh(me); t.free()
        bm = self.bm
        n0 = len(bm.faces)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
        mi = self._mi(mat)
        n1 = len(bm.faces)
        self.fdata += [(mi, uvscale, None)] * (n1 - n0)
        return range(n0, n1)

    def box(self, size, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, bevel=0.0, uvscale=1.0):
        """Boîte de dimensions size, loc = centre."""
        r = bmesh.ops.create_cube(self._tmp(), size=1.0)
        S = Matrix.Diagonal((*size, 1.0))
        mtx = Matrix.Translation(loc) @ _rotm(rot) @ S
        return self._finish(r["verts"], mat, mtx, bevel, uvscale)

    def boxz(self, size, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, bevel=0.0, uvscale=1.0):
        """Boîte dont loc = centre de la face inférieure (posée)."""
        r = bmesh.ops.create_cube(self._tmp(), size=1.0)
        bmesh.ops.translate(self._t, verts=r["verts"], vec=(0, 0, 0.5))
        S = Matrix.Diagonal((*size, 1.0))
        mtx = Matrix.Translation(loc) @ _rotm(rot) @ S
        return self._finish(r["verts"], mat, mtx, bevel, uvscale)

    def cyl(self, r, h, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, seg=12, r2=None, bevel=0.0, caps=True, uvscale=1.0):
        """Cylindre / cône le long de Z local, loc = centre de la base."""
        res = bmesh.ops.create_cone(self._tmp(), cap_ends=caps, cap_tris=False, segments=seg,
                                    radius1=r, radius2=(r if r2 is None else r2), depth=h)
        bmesh.ops.translate(self._t, verts=res["verts"], vec=(0, 0, h / 2))
        mtx = Matrix.Translation(loc) @ _rotm(rot)
        return self._finish(res["verts"], mat, mtx, bevel, uvscale)

    def cyl_between(self, a, b, r, mat=None, seg=8, caps=True, r2=None):
        a = Vector(a); b = Vector(b); d = b - a; h = d.length
        res = bmesh.ops.create_cone(self._tmp(), cap_ends=caps, cap_tris=False, segments=seg,
                                    radius1=r, radius2=(r if r2 is None else r2), depth=h)
        bmesh.ops.translate(self._t, verts=res["verts"], vec=(0, 0, h / 2))
        q = Vector((0, 0, 1)).rotation_difference(d.normalized())
        mtx = Matrix.Translation(a) @ q.to_matrix().to_4x4()
        return self._finish(res["verts"], mat, mtx, 0, 1.0)

    def torus(self, R, r, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, seg=16, rseg=6, arc=360.0):
        """Tore (ou arc de tore) dans le plan XY local."""
        t = self._tmp()
        rings = []
        n = seg if arc >= 360 else seg + 1
        for i in range(n):
            a = math.radians(arc) * i / seg
            c = Vector((math.cos(a) * R, math.sin(a) * R, 0))
            radial = Vector((math.cos(a), math.sin(a), 0))
            rings.append([t.verts.new(c + radial * (math.cos(p) * r) + Vector((0, 0, math.sin(p) * r)))
                          for p in [2 * math.pi * j / rseg for j in range(rseg)]])
        rng = range(len(rings)) if arc >= 360 else range(len(rings) - 1)
        for i in rng:
            A = rings[i]; B = rings[(i + 1) % len(rings)]
            for j in range(rseg):
                t.faces.new((A[j], B[j], B[(j + 1) % rseg], A[(j + 1) % rseg]))
        return self._finish(None, mat, Matrix.Translation(loc) @ _rotm(rot), 0, 1.0)

    def prism(self, profile_yz, length, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, bevel=0.0, uvscale=1.0):
        """Extrusion le long de X (de 0 à length) d'un profil fermé [(y,z),...] (sens trigo vu de +X)."""
        t = self._tmp()
        v0 = [t.verts.new((0, y, z)) for y, z in profile_yz]
        v1 = [t.verts.new((length, y, z)) for y, z in profile_yz]
        n = len(v0)
        t.faces.new(list(reversed(v0)))
        t.faces.new(v1)
        for i in range(n):
            j = (i + 1) % n
            t.faces.new((v0[i], v0[j], v1[j], v1[i]))
        bmesh.ops.recalc_face_normals(t, faces=t.faces[:])
        return self._finish(None, mat, Matrix.Translation(loc) @ _rotm(rot), bevel, uvscale)

    def mesh(self, verts, faces, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, bevel=0.0, uvscale=1.0):
        """Géométrie libre : verts [(x,y,z)], faces [(i,j,k,...)]."""
        t = self._tmp()
        vs = [t.verts.new(v) for v in verts]
        for f in faces:
            t.faces.new([vs[i] for i in f])
        bmesh.ops.recalc_face_normals(t, faces=t.faces[:])
        return self._finish(None, mat, Matrix.Translation(loc) @ _rotm(rot), bevel, uvscale)

    def build(self, name, origin=(0, 0, 0), collection=None, tile=2.0, smooth="auto"):
        """Crée l'objet. La géométrie est exprimée en coordonnées asset ; origin = position du pivot.
        tile = mètres couverts par une répétition de texture."""
        bm = self.bm
        bm.normal_update()
        bm.faces.ensure_lookup_table()
        uvl = bm.loops.layers.uv.new("UVMap")
        for i, f in enumerate(bm.faces):
            mi, us, ex = self.fdata[i]
            f.material_index = mi
            f.smooth = bool(smooth)
            if ex:
                for loop, uv in zip(f.loops, ex):
                    loop[uvl].uv = uv
                continue
            s = us / tile
            n = f.normal
            ax = max(range(3), key=lambda k: abs(n[k]))
            for loop in f.loops:
                c = loop.vert.co
                if ax == 0:
                    u, v = (c.y if n.x > 0 else -c.y), c.z
                elif ax == 1:
                    u, v = (-c.x if n.y > 0 else c.x), c.z
                else:
                    u, v = c.x, (c.y if n.z > 0 else -c.y)
                loop[uvl].uv = (u * s, v * s)
        bmesh.ops.translate(bm, verts=bm.verts, vec=-Vector(origin))
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me); bm.free()
        if smooth is None or smooth == "auto":
            for poly in me.polygons:
                poly.use_smooth = True
            me.set_sharp_from_angle(angle=math.radians(35))
        for m in self.mats:
            me.materials.append(m)
        ob = bpy.data.objects.new(name, me)
        ob.location = origin
        (collection or bpy.context.scene.collection).objects.link(ob)
        return ob


# Formes de fam_p4_refaits.py
def lathe(p, profile_rz, seg, mat, phase=0.0, loc=(0, 0, 0)):
    """Révolution autour de Z d'un profil fermé [(r, z), ...] (solide annulaire fermé, sans bouchon à faire).
    phase en radians."""
    verts, faces = [], []
    n = len(profile_rz)
    for k in range(seg):
        a = 2 * math.pi * k / seg + phase
        for r_, z in profile_rz:
            verts.append((r_ * math.cos(a), r_ * math.sin(a), z))
    for k in range(seg):
        k2 = (k + 1) % seg
        for i in range(n):
            i2 = (i + 1) % n
            faces.append((k * n + i, k * n + i2, k2 * n + i2, k2 * n + i))
    p.mesh(verts, faces, loc=loc, mat=mat)


def obox(p, center, axes, half, mat):
    """Boîte orientée : centre, trois axes (normalisés ici), demi-dimensions le long de chacun."""
    c = Vector(center); u, v, w = (Vector(a).normalized() * h for a, h in zip(axes, half))
    verts = [tuple(c + su * u + sv * v + sw * w) for su in (-1, 1) for sv in (-1, 1) for sw in (-1, 1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    p.mesh(verts, faces, mat=mat)


def tube(p, pts, r, mat, seg=6, sub=4):
    """Tube (câble) le long d'une polyligne, sections perpendiculaires transportées d'un point à l'autre, bouts fermés
    (à enfouir dans une autre pièce). La polyligne est lissée (Catmull-Rom, `sub` pas par segment)."""
    Q = [Vector(q) for q in pts]
    P = []
    for i in range(len(Q) - 1):
        p0, p1, p2, p3 = Q[max(i - 1, 0)], Q[i], Q[i + 1], Q[min(i + 2, len(Q) - 1)]
        for k in range(sub):
            t = k / sub
            P.append(0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                            + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t))
    P.append(Q[-1])
    tans = []
    for i in range(len(P)):
        a = P[max(i - 1, 0)]; b = P[min(i + 1, len(P) - 1)]
        tans.append((b - a).normalized())
    ref = Vector((0, 0, 1)) if abs(tans[0].z) < 0.9 else Vector((1, 0, 0))
    n = tans[0].cross(ref).normalized()
    verts, faces = [], []
    for i, (c, t) in enumerate(zip(P, tans)):
        if i:
            n = (n - t * n.dot(t)).normalized()
        b = t.cross(n)
        for k in range(seg):
            a = 2 * math.pi * k / seg
            verts.append(tuple(c + (n * math.cos(a) + b * math.sin(a)) * r))
    for i in range(len(P) - 1):
        for k in range(seg):
            k2 = (k + 1) % seg
            faces.append((i * seg + k, i * seg + k2, (i + 1) * seg + k2, (i + 1) * seg + k))
    faces.append(tuple(range(seg - 1, -1, -1)))
    faces.append(tuple((len(P) - 1) * seg + k for k in range(seg)))
    p.mesh(verts, faces, mat=mat)


# ----------------------------------------------------------------------------- collisions / assemblage
def col_box(name, size, loc, rot=(0, 0, 0), parent=None, collection=None):
    p = Part(); p.box(size, loc, rot)
    o = p.build(name + "-col", collection=collection)
    o.display_type = 'WIRE'
    if parent:
        reparent(o, parent)
    return o


def col_cyl(name, r, h, loc, rot=(0, 0, 0), parent=None, collection=None, seg=8):
    p = Part(); p.cyl(r, h, loc, rot, seg=seg)
    o = p.build(name + "-col", collection=collection)
    o.display_type = 'WIRE'
    if parent:
        reparent(o, parent)
    return o


def reparent(child, parent):
    # matrix_world d'un objet tout juste créé / déplacé n'est recalculée qu'à l'update du view layer :
    # sans cet update, un vide placé par .location perdait sa position (Handle collé au pivot du parent).
    bpy.context.view_layer.update()
    mw = child.matrix_world.copy()
    child.parent = parent
    child.matrix_world = mw


def root(name, collection=None, **props):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'PLAIN_AXES'; e.empty_display_size = 0.3
    (collection or bpy.context.scene.collection).objects.link(e)
    for k, v in props.items():
        e[k] = v
    return e


def empty(name, loc, parent=None, collection=None):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'SPHERE'; e.empty_display_size = 0.05
    e.location = loc
    (collection or bpy.context.scene.collection).objects.link(e)
    if parent:
        reparent(e, parent)
    return e


def hinged(r, part, name, pivot, axis="X", angle=-100, col=None, handle=None):
    """Partie mobile (fam_03_mobilier.hinged) : géométrie en coordonnées asset, origine placée sur l'axe."""
    o = part.build(name, origin=pivot); o.parent = r
    o["hinge_axis"] = axis; o["open_angle_deg"] = angle
    if col:
        c = col_box(name, col[0], col[1]); reparent(c, o)
    if handle:
        h = empty("Handle", handle); reparent(h, o)
    return o


def hierarchy(o):
    out = [o]
    for c in o.children:
        out += hierarchy(c)
    return out


def tri_count(o):
    n = 0
    for x in hierarchy(o):
        if x.type == 'MESH' and not x.name.endswith("-col"):
            n += sum(len(p.vertices) - 2 for p in x.data.polygons)
    return n


EXPORTED = []
OPT_STATS = []

# ----------------------------------------------------------------------------- optimisation à l'export
# L'export travaille sur une COPIE de la hiérarchie (le .blend source garde ses pièces éditables) :
#  1. fusion des meshes statiques enfants directs de la racine en un seul objet ;
#  2. suppression des faces invisibles des meshes statiques : faces cachées dans / contre un autre volume fermé opaque,
#     et faces posées au sol si l'objet ne peut pas basculer (pas de fall_pivot, pas un débris, masse >= 100 kg) ;
#  3. noms nettoyés (pas de suffixe .001 : Godot ne reconnaîtrait pas « X-col.001 » comme collision).
# Un objet est « statique » s'il n'a aucune propriété personnalisée (pas de charnière, glissière, texte éditable…)
# et si son nom ne désigne pas une pièce pilotée par le jeu (feux, lampes, néons, faces de panneau…).
_PROTECTED = _re.compile(r"(Light|Lamp|Neon|Screen|Display|Sign_|Face|Poster|Letters|Door|Leaf|Lid|Arm|Piston|Slider|"
                         r"Flap|Head|Lock|Handle|Interact|Nozzle|Debris|Fabric|Blade|Rotor|Wheel|Flag)")
_SUFFIX = _re.compile(r"\.\d{3}$")


def _is_static(o, rootname=""):
    if o.type != 'MESH' or o.name.endswith("-col") or "-col." in o.name:
        return False
    if any(not k.startswith("_") for k in o.keys()):
        return False
    nm = _SUFFIX.sub("", o.name)
    if rootname and nm.startswith(rootname):      # « RoadSign_Stop_Mesh » -> « _Mesh » : seul le nom de pièce compte
        nm = nm[len(rootname):]
    return not _PROTECTED.search(nm)


def _mat_transparent(m):
    if m is None or not m.use_nodes:
        return False
    if m.surface_render_method == 'BLENDED':
        return True
    b = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    return b is not None and (b.inputs["Alpha"].is_linked or b.inputs["Alpha"].default_value < 0.999)


def _islands(bm):
    seen = set(); out = []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack = [f]; isl = []
        seen.add(f.index)
        while stack:
            g = stack.pop(); isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index); stack.append(h)
        out.append(isl)
    return out


def _inside(bvh, p, d=Vector((0.4817, 0.6123, 0.6268))):
    """Point dans un volume fermé : parité des intersections d'un rayon."""
    n = 0; o = p.copy()
    for _ in range(64):
        hit = bvh.ray_cast(o, d)
        if hit[0] is None:
            break
        n += 1; o = hit[0] + d * 1e-5
    return n % 2 == 1


def _face_samples(vs, c, step=0.05):
    """Points témoins d'une face : centre + grille de chaque triangle (centre, a, b) au pas de `step` (8 par côté au
    plus), rentrée de 8 % vers le centre. L'original ne prenait que le centre et les sommets : une face longue dont le
    centre et les bouts tombaient dans d'autres pièces (axe du treuil du puits, entre la corde et les poteaux) était
    supprimée alors qu'elle restait visible entre elles."""
    pts = [c]
    for i in range(len(vs)):
        a, b = vs[i], vs[(i + 1) % len(vs)]
        m = max(1, min(8, math.ceil(max((a - c).length, (b - c).length, (b - a).length) / step)))
        for p in range(m + 1):
            for q in range(m + 1 - p):
                if p or q:
                    pts.append(c + ((a - c) * (p / m) + (b - c) * (q / m)) * 0.92)
    return pts


def _cull_hidden(objs, cull_ground):
    """Supprime les faces invisibles des meshes statiques objs (coordonnées monde). Renvoie le nombre de faces ôtées."""
    data = []
    occl = []   # (aabb_min, aabb_max, bvh, obj_index, island_id)
    for oi, o in enumerate(objs):
        bm = bmesh.new(); bm.from_mesh(o.data)
        bm.transform(o.matrix_world); bm.normal_update()
        bm.faces.ensure_lookup_table()
        isl = _islands(bm)
        fid = {}
        for k, faces in enumerate(isl):
            for f in faces:
                fid[f.index] = k
            closed = all(len(e.link_faces) == 2 for f in faces for e in f.edges)
            opaque = all(not _mat_transparent(o.material_slots[f.material_index].material
                                              if f.material_index < len(o.material_slots) else None) for f in faces)
            if closed and opaque and len(faces) >= 4:
                vs = {v for f in faces for v in f.verts}
                cos = [v.co.copy() for v in vs]
                mn = Vector([min(c[i] for c in cos) for i in range(3)]); mx = Vector([max(c[i] for c in cos) for i in range(3)])
                idx = {v.index: j for j, v in enumerate(vs)}
                polys = [[idx[v.index] for v in f.verts] for f in faces]
                occl.append((mn, mx, _BVH.FromPolygons(cos, polys), oi, k))
        data.append((o, bm, fid))
    removed = 0
    for oi, (o, bm, fid) in enumerate(data):
        kill = []
        for f in bm.faces:
            n = f.normal
            if n.length < 0.5:
                continue
            vs = [v.co for v in f.verts]
            if cull_ground and n.z < -0.99 and max(v.z for v in vs) < 0.003:
                kill.append(f); continue
            c = f.calc_center_median()
            pts = [q + n * 0.002 for q in _face_samples(vs, c)]
            own = fid[f.index]

            def covered(q):
                for mn, mx, bvh, ooi, k in occl:
                    if ooi == oi and k == own:
                        continue
                    if all(mn[i] - 1e-4 <= q[i] <= mx[i] + 1e-4 for i in range(3)) and _inside(bvh, q):
                        return True
                return False
            if all(covered(q) for q in pts):
                kill.append(f)
        if kill:
            bmesh.ops.delete(bm, geom=kill, context='FACES_ONLY')
            bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context='EDGES')
            bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_edges], context='VERTS')
            bm.transform(o.matrix_world.inverted())
            bm.to_mesh(o.data); o.data.update()
            removed += len(kill)
        bm.free()
    return removed


def _optimized_copy(rootobj, relpath):
    """Copie optimisée de la hiérarchie pour l'export. Renvoie (racine copiée, objets copiés)."""
    src = hierarchy(rootobj)
    mp = {}
    for o in src:
        c = o.copy()
        if o.type == 'MESH':
            c.data = o.data.copy()
        bpy.context.scene.collection.objects.link(c)
        mp[o] = c
    for o, c in mp.items():
        if o.parent in mp:
            c.parent = mp[o.parent]; c.matrix_parent_inverse = o.matrix_parent_inverse.copy()
    r = mp[rootobj]
    bpy.context.view_layer.update()
    # 1. fusion des meshes statiques enfants directs de la racine (et de la racine si c'est un mesh)
    rn = _SUFFIX.sub("", rootobj.name)
    cand = [c for c in r.children if _is_static(c, rn) and all(g.name.endswith("-col") or "-col." in g.name for g in c.children)]
    merged = 0
    if len(cand) >= 2:
        for c in cand[1:]:
            for g in list(c.children):
                mw = g.matrix_world.copy(); g.parent = r; g.matrix_world = mw
        tgt = cand[0]
        with bpy.context.temp_override(active_object=tgt, selected_editable_objects=cand, selected_objects=cand):
            bpy.ops.object.join()
        merged = len(cand) - 1
        bpy.context.view_layer.update()
    # 2. faces invisibles
    rp = rootobj
    keep_bottom = bool(rp.get("fall_pivot")) or "Debris" in relpath or float(rp.get("mass_kg", 1e9)) < 100
    stat = [c for c in hierarchy(r) if _is_static(c, rn)]
    tris_before = sum(sum(len(p.vertices) - 2 for p in c.data.polygons) for c in stat)
    removed = _cull_hidden(stat, not keep_bottom) if stat else 0
    tris_after = sum(sum(len(p.vertices) - 2 for p in c.data.polygons) for c in stat)
    OPT_STATS.append((relpath, merged, removed, tris_before, tris_after))
    return r, hierarchy(r)


def export(rootobj, path, optimize=True):
    """Exporte la hiérarchie de rootobj vers `path` (.glb), via une copie optimisée (voir plus haut)."""
    if optimize:
        r, objs = _optimized_copy(rootobj, path)
    else:
        r, objs = rootobj, hierarchy(rootobj)
    # noms propres dans le .glb : on écarte temporairement les homonymes de la scène
    renamed, clean = [], {}
    if optimize:
        for o in objs:
            want = _SUFFIX.sub("", o.name)
            if want in clean.values():                 # homonymes dans un même asset : Handle, Handle_2…
                base, col = (want[:-4], "-col") if want.endswith("-col") else (want, "")
                k = 2
                while f"{base}_{k}{col}" in clean.values():
                    k += 1
                want = f"{base}_{k}{col}"
            clean[o] = want
        for o, want in clean.items():
            other = bpy.data.objects.get(want)
            if other is not None and other is not o and other not in clean:
                renamed.append((other, want)); other.name = want + "~src"
        for o, want in clean.items():
            o.name = want
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.hide_set(False); o.select_set(True)
    bpy.context.view_layer.objects.active = r
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True,
                              export_extras=True, export_yup=True, export_apply=True,
                              export_image_format='AUTO', export_animations=False)
    tris = tri_count(r)
    EXPORTED.append((path, tris))
    if optimize:
        for o in objs:
            me = o.data if o.type == 'MESH' else None
            bpy.data.objects.remove(o, do_unlink=True)
            if me is not None and me.users == 0:
                bpy.data.meshes.remove(me)
        for other, want in renamed:
            other.name = want
    return tris


def save_blend(path):
    bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, compress=True)
