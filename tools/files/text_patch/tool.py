import shutil
from pathlib import Path


def execute(params):
    p = Path(params["path"])
    old = params["old"]
    if not old:
        raise ValueError("old ne doit pas être vide")
    with open(p, encoding="utf-8", newline="") as f:
        text = f.read()
    n = text.count(old)
    if n == 0:
        raise ValueError("extrait 'old' introuvable (vérifier espaces et retours à la ligne)")
    if n > 1:
        raise ValueError(f"extrait 'old' présent {n} fois : ajouter du contexte pour le rendre unique")
    bak = p.with_name(p.name + ".bak")
    shutil.copy2(p, bak)
    p.write_text(text.replace(old, params["new"], 1), encoding="utf-8", newline="")
    return {"data": {"path": str(p), "backup": str(bak), "bytes": p.stat().st_size}}
