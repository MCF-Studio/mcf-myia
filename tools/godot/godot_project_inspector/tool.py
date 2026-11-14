import re
from pathlib import Path

SKIP = {".godot", ".git", ".import", "node_modules"}
RES = re.compile(r'"(res://[^"]+)"')
CFG = re.compile(r'^(config/name|run/main_scene|config/features)\s*=\s*(.+)$', re.M)


def walk(root):
    for p in root.rglob("*"):
        if p.is_file() and not (SKIP & set(p.relative_to(root).parts)):
            yield p


def rel(p, root):
    return str(p.relative_to(root)).replace("\\", "/")


def execute(params):
    root = Path(params["project"])
    cfg = root / "project.godot"
    if not cfg.is_file():
        raise FileNotFoundError(f"pas de project.godot dans {root}")
    files = list(walk(root))

    def ext(*e):
        return sorted(rel(p, root) for p in files if p.suffix.lower() in e)

    settings = {k: v.strip() for k, v in CFG.findall(cfg.read_text(encoding="utf-8", errors="replace"))}
    missing = {}
    for p in files:
        if p.suffix in (".tscn", ".tres", ".gd", ".godot", ".cfg") and p.stat().st_size <= 2_000_000:
            for ref in set(RES.findall(p.read_text(encoding="utf-8", errors="replace"))):
                if not (root / ref[6:]).exists():
                    missing.setdefault(ref, []).append(rel(p, root))
    addons = root / "addons"
    return {"data": {
        "settings": settings,
        "scenes": ext(".tscn"),
        "scripts": ext(".gd", ".cs"),
        "resources": {"textures": len(ext(".png", ".jpg", ".jpeg", ".webp", ".svg")),
                      "audio": len(ext(".wav", ".ogg", ".mp3")),
                      "models": len(ext(".glb", ".gltf", ".fbx", ".obj"))},
        "plugins": sorted(d.name for d in addons.iterdir() if d.is_dir()) if addons.is_dir() else [],
        "missing_resources": [{"ref": r, "referenced_by": s} for r, s in sorted(missing.items())],
    }}
