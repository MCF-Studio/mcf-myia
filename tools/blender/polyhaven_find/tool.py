"""Cherche un matériau dans la bibliothèque Poly Haven locale (manifest.json), par mots-clés."""
import re
import unicodedata

import blender_runtime as br
from common import bounded

# Mots français courants -> mots des tags Poly Haven (en anglais).
FR = {
    "bois": "wood", "planche": "planks", "planches": "planks", "beton": "concrete", "metal": "metal",
    "rouille": "rust", "pierre": "stone", "roche": "rock", "brique": "brick",
    "briques": "brick", "tuile": "tiles", "tuiles": "tiles", "carrelage": "tiles", "sol": "floor", "mur": "wall",
    "platre": "plaster", "enduit": "plaster", "crepi": "stucco", "sable": "sand", "terre": "soil", "herbe": "grass",
    "gravier": "gravel", "pave": "cobblestone", "paves": "cobblestone", "goudron": "asphalt", "bitume": "asphalt",
    "route": "road", "ecorce": "bark", "tissu": "fabric", "cuir": "leather", "toit": "roofing", "toiture": "roofing",
    "tole": "corrugated", "neige": "snow", "boue": "mud", "vieux": "old", "use": "worn", "sale": "dirty",
    "peint": "painted", "peinture": "paint", "rouge": "red", "blanc": "white", "noir": "black", "gris": "gray",
    "vert": "green", "bleu": "blue", "jaune": "yellow", "marron": "brown", "fonce": "dark", "clair": "light",
}


def _norm(s):
    s = unicodedata.normalize("NFD", str(s).lower())
    return "".join(c for c in s if not unicodedata.combining(c))


def _words(s):
    return [w for w in re.split(r"[^a-z0-9]+", _norm(s)) if w]


def _score(terms, slug, m):
    name = _words(m.get("name", "")) + _words(slug)
    tags = [_norm(t) for t in (m.get("tags") or []) + (m.get("categories") or [])]
    tag_words = {w for t in tags for w in _words(t)}
    folder = _norm(m.get("folder", ""))
    score = 0
    for t in terms:
        if t in tags:
            score += 3
        elif t in tag_words or t in name:
            score += 2
        elif t == folder:
            score += 2
        elif any(t in w for w in name) or any(t in w for w in tag_words):
            score += 1
        else:
            return 0                       # chaque mot demandé doit se retrouver quelque part
    return score


def execute(params):
    query = params["query"]
    limite = bounded(params, "limite", 10, 1, 20)
    terms = []
    for w in _words(query):
        terms.append(FR.get(w, w))
    if not terms:
        raise ValueError("query : au moins un mot-clé")
    lib, mats = br.polyhaven_manifest()
    hits = []
    for slug, m in mats.items():
        if not isinstance(m, dict):
            continue
        s = _score(terms, slug, m)
        if s:
            hits.append((-s, slug, m))
    hits.sort(key=lambda h: (h[0], h[1]))
    items = []
    for neg, slug, m in hits[:limite]:
        tex = br.texture_files(lib, mats, slug)
        items.append({"slug": slug, "name": m.get("name"), "famille": m.get("folder"), "score": -neg,
                      "tags": (m.get("tags") or [])[:8],
                      "textures": {k: tex.get(k) for k in ("diff", "nor", "arm")}})
    warnings = [] if items else [f"aucun matériau pour « {query} » : essayer un mot plus général (wood, metal, "
                                 "concrete, stone, plaster…)"]
    return {"data": {"query": terms, "results": items, "total": len(hits), "truncated": len(hits) > limite,
                     "usage": "dans la spec de blender_build : \"materials\": {\"M\": {\"polyhaven\": \"<slug>\"}}"},
            "warnings": warnings}
