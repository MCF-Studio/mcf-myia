from pathlib import Path

import safety
from common import SKIP_DIRS, bounded


def execute(params):
    root = Path(params["directory"])
    depth, limit = bounded(params, "depth", 2, 1, 10), bounded(params, "limit", 200, 1, 2000)
    lines = []

    def walk(d, level):
        for p in sorted(d.iterdir(), key=lambda x: (x.is_file(), x.name.lower())):
            if len(lines) >= limit:
                return
            if not safety.contained(p, root):
                continue  # lien ou jonction qui mène hors du dossier demandé, ou dossier fermé
            link = safety.is_link(p)
            lines.append("  " * level + p.name + ("/" if p.is_dir() else "") + (" (lien)" if link else ""))
            if p.is_dir() and not link and level + 1 < depth and p.name not in SKIP_DIRS:
                walk(p, level + 1)

    walk(root, 0)
    return {"data": {"tree": "\n".join(lines), "truncated": len(lines) >= limit}}
