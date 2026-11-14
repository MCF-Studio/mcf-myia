import subprocess

from common import app_path, resolve_app


def execute(params):
    app_id, entry = resolve_app(params["app"])
    exe = app_path(entry)
    if not exe:
        raise FileNotFoundError(f"{app_id} : exécutable introuvable ({entry['executable']})")
    args = params.get("args", [])
    if not all(isinstance(a, str) for a in args):
        raise ValueError("args doit être une liste de chaînes")
    denied = {x.lower() for x in entry.get("denied_args", [])}
    bad = [a for a in args if a.split("=", 1)[0].lower() in denied]
    if bad:  # ces drapeaux exécuteraient du code arbitraire : hors catalogue, donc refusés
        raise PermissionError(f"argument(s) interdit(s) pour {app_id} : {', '.join(bad)}")
    # Liste d'arguments, jamais de shell : pas d'injection de commande.
    proc = subprocess.Popen([exe, *entry.get("forced_args", []), *args], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, creationflags=0x00000008 | 0x00000200)  # DETACHED | NEW_GROUP
    return {"data": {"app": app_id, "pid": proc.pid, "args": args}}
