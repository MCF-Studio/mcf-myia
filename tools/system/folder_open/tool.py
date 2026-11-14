import os
from pathlib import Path


def execute(params):
    p = Path(params["path"])
    if not p.is_dir():
        raise NotADirectoryError(f"{p} n'est pas un dossier existant")  # un fichier serait exécuté : refusé
    os.startfile(p)
    return {"data": {"path": str(p)}}
