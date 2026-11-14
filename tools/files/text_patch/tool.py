import shutil
from pathlib import Path

from safety import MAX_TEXT_BYTES, check_text_target


def execute(params):
    # Mêmes limites que text_write : formats texte, fichiers et dossiers interdits (safety.py).
    p = Path(check_text_target(params["path"]))
    old = params["old"]
    if not old:
        raise ValueError("old ne doit pas être vide")
    if not p.is_file():
        raise FileNotFoundError(f"introuvable : {p}")
    if p.stat().st_size > MAX_TEXT_BYTES:
        raise ValueError("fichier trop gros pour text_patch (1 Mo au plus)")
    with open(p, encoding="utf-8", newline="") as f:
        text = f.read()
    n = text.count(old)
    if n == 0:
        raise ValueError("extrait 'old' introuvable (vérifier espaces et retours à la ligne)")
    if n > 1:
        raise ValueError(f"extrait 'old' présent {n} fois : ajouter du contexte pour le rendre unique")
    new_text = text.replace(old, params["new"], 1)
    if len(new_text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise ValueError("résultat trop gros (1 Mo au plus)")
    bak = p.with_name(p.name + ".bak")
    if bak.is_symlink() or bak.is_dir():
        raise PermissionError(f"{bak} est un lien ou un dossier : sauvegarde impossible, modification annulée")
    shutil.copy2(p, bak)
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write(new_text)
    return {"data": {"path": str(p), "backup": str(bak), "bytes": p.stat().st_size}}
