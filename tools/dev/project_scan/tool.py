from collections import Counter
from pathlib import Path

from common import iter_files

MARKERS = {"project.godot": "godot", "Cargo.toml": "rust", "package.json": "node", "pyproject.toml": "python",
           "requirements.txt": "python", "tauri.conf.json": "tauri", "Dockerfile": "docker"}


def execute(params):
    root = Path(params["directory"])
    kinds, markers, ext = set(), [], Counter()
    for p in iter_files(root):
        ext[p.suffix.lower() or "(aucune)"] += 1
        if p.name in MARKERS and len(p.relative_to(root).parts) <= 4:
            kinds.add(MARKERS[p.name])
            markers.append(str(p.relative_to(root)).replace("\\", "/"))
    return {"data": {"project_types": sorted(kinds), "entry_points": sorted(markers),
                     "total_files": sum(ext.values()), "by_extension": dict(ext.most_common(15)),
                     "has_git": (root / ".git").exists()}}
