"""Aides partagées par les outils (importable : le gestionnaire ajoute tools/ au sys.path)."""
import json
import os
import unicodedata
from pathlib import Path

ROOT = Path(__file__).parent
SKIP_DIRS = {".git", ".godot", ".import", "node_modules", "target", "__pycache__", ".venv", "dist", "build"}


def iter_files(root):
    """Fichiers sous root, sans entrer dans les dossiers lourds (os.walk élague, contrairement à rglob)."""
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            yield Path(dirpath) / f


def load_apps():
    return json.loads((ROOT / "apps.json").read_text(encoding="utf-8"))


def _norm(s):
    s = unicodedata.normalize("NFD", s.lower().strip())
    return "".join(c for c in s if not unicodedata.combining(c))


def resolve_app(name):
    """Retourne (id, entrée) si UNE seule appli correspond ; lève ValueError sinon."""
    apps, q = load_apps(), _norm(name)
    exact = [k for k, a in apps.items() if q == _norm(k) or q in map(_norm, a.get("aliases", []))]
    hits = exact or [k for k, a in apps.items() if q in _norm(a["label"])]
    if len(hits) != 1:
        raise ValueError(f"application '{name}' : " + ("inconnue du catalogue" if not hits
                         else f"ambiguë ({', '.join(hits)})"))
    return hits[0], apps[hits[0]]


def app_path(entry):
    p = os.path.expandvars(entry["executable"])
    return p if os.path.exists(p) else None  # exists, pas isfile : certains volumes le signalent comme dossier
