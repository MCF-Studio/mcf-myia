import shutil
from pathlib import Path

from safety import MAX_TEXT_BYTES, check_text_target


def execute(params):
    # Formats texte seulement, jamais un fichier qui pilote un outil ni un dossier qui exécute du code (safety.py).
    p = Path(check_text_target(params["path"]))
    content = params["content"]
    if len(content.encode("utf-8")) > MAX_TEXT_BYTES:
        raise ValueError("contenu trop gros (1 Mo au plus)")
    warnings = []
    exists = p.exists()
    if exists and params.get("overwrite") is not True:
        raise FileExistsError(f"{p} existe déjà (overwrite=true pour écraser)")
    p.parent.mkdir(parents=True, exist_ok=True)
    p = Path(check_text_target(p))  # recontrôle juste avant d'écrire : un lien a pu apparaître entre-temps
    if exists:
        bak = p.with_name(p.name + ".bak")
        if bak.is_symlink() or bak.is_dir():
            raise PermissionError(f"{bak} est un lien ou un dossier : sauvegarde impossible, écriture annulée")
        shutil.copy2(p, bak)
        warnings.append(f"ancien contenu sauvegardé dans {bak}")
    # « x » : la création échoue si un fichier est apparu depuis le contrôle, au lieu de l'écraser.
    with open(p, "w" if exists else "x", encoding="utf-8", newline="") as f:
        f.write(content)
    return {"data": {"path": str(p), "bytes": p.stat().st_size, "replaced": exists}, "warnings": warnings}
