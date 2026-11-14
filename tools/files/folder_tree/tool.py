from pathlib import Path

from common import SKIP_DIRS


def execute(params):
    root = Path(params["directory"])
    depth, limit = params.get("depth", 2), params.get("limit", 200)
    lines = []

    def walk(d, level):
        for p in sorted(d.iterdir(), key=lambda x: (x.is_file(), x.name.lower())):
            if len(lines) >= limit:
                return
            lines.append("  " * level + p.name + ("/" if p.is_dir() else ""))
            if p.is_dir() and level + 1 < depth and p.name not in SKIP_DIRS:
                walk(p, level + 1)

    walk(root, 0)
    return {"data": {"tree": "\n".join(lines), "truncated": len(lines) >= limit}}
