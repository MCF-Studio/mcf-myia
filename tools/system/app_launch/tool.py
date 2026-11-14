import os
import subprocess
from pathlib import Path

from common import app_path, resolve_app
from safety import EXECUTABLE

MAX_ARGS = 20


def build_command(params):
    """(identifiant, ligne de commande) ou refus. Séparé du lancement pour être testé sans rien lancer.

    Liste BLANCHE : un argument n'est accepté que s'il figure tel quel dans `allowed_args` de l'application
    (tools/apps.json, fichier local). Une liste noire ne protège pas : « --path <projet> » ou un simple fichier
    suffisent à faire exécuter du code par Godot ou Blender. Le seul argument libre est `file`, un fichier existant
    que le gestionnaire a contrôlé (dossiers autorisés en lecture) et dont l'extension est listée pour l'application."""
    app_id, entry = resolve_app(params["app"])
    exe = app_path(entry)
    if not exe:
        raise FileNotFoundError(f"{app_id} : exécutable introuvable (tools/apps.json)")
    args = params.get("args", [])
    if not isinstance(args, list) or len(args) > MAX_ARGS or not all(isinstance(a, str) for a in args):
        raise ValueError(f"args doit être une liste de chaînes ({MAX_ARGS} au plus)")
    allowed, forced = entry.get("allowed_args", []), entry.get("forced_args", [])
    if not all(isinstance(x, list) and all(isinstance(a, str) for a in x) for x in (allowed, forced)):
        raise ValueError(f"{app_id} : allowed_args et forced_args doivent être des listes de chaînes (tools/apps.json)")
    bad = [a for a in args if a not in allowed]
    if bad:
        raise PermissionError(f"argument(s) hors liste blanche pour {app_id} : {', '.join(bad)[:300]} "
                              f"(autorisés : {', '.join(allowed) or 'aucun'} ; liste `allowed_args` de tools/apps.json)")
    cmd = [exe, *forced, *args]
    if params.get("file"):
        f = Path(os.path.abspath(params["file"]))
        exts = [str(e).lower() for e in entry.get("open_extensions", [])]
        ext = f.suffix.lower()
        if not f.is_file():
            raise FileNotFoundError(f"fichier introuvable : {f}")
        if ext not in exts or ext.lstrip(".") in EXECUTABLE:
            raise PermissionError(f"{app_id} n'ouvre pas les fichiers « {ext or '(sans extension)'} » "
                                  f"(autorisés : {', '.join(exts) or 'aucun'} ; `open_extensions` de tools/apps.json)")
        cmd.append(str(f))
    return app_id, cmd


def execute(params):
    app_id, cmd = build_command(params)
    # Liste d'arguments, jamais de shell : pas d'injection de commande.
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            creationflags=0x00000008 | 0x00000200)  # DETACHED | NEW_GROUP
    return {"data": {"app": app_id, "pid": proc.pid, "args": cmd[1:]}}
