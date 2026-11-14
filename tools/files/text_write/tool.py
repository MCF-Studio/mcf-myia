import shutil
from pathlib import Path


def execute(params):
    p = Path(params["path"])
    warnings = []
    if p.exists():
        if not params.get("overwrite"):
            raise FileExistsError(f"{p} existe déjà (overwrite=true pour écraser)")
        bak = p.with_name(p.name + ".bak")
        shutil.copy2(p, bak)
        warnings.append(f"ancien contenu sauvegardé dans {bak}")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(params["content"], encoding="utf-8", newline="")
    return {"data": {"path": str(p), "bytes": p.stat().st_size}, "warnings": warnings}
