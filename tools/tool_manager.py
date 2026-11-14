"""Gestionnaire d'outils : découverte des manifestes, validation, exécution.

Usage :
  python tools/tool_manager.py list
  python tools/tool_manager.py run <outil> '{"param": "valeur"}'
Toujours une réponse JSON {success, data, error, warnings} sur stdout.
"""
import importlib.util
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
PATH_NAMES = {"path", "file", "project", "directory", "repo", "output", "folder", "dir"}
TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict}


def reply(ok, data=None, error=None, warnings=None):
    return {"success": ok, "data": data, "error": error, "warnings": warnings or []}


def discover():
    found = {}
    for p in ROOT.glob("*/*/manifest.json"):
        m = json.loads(p.read_text(encoding="utf-8"))
        found[m["name"]] = (p.parent, m)
    return found


def validate(manifest, params):
    spec = manifest.get("parameters", {})
    for k, s in spec.items():
        if s.get("required") and k not in params:
            return f"paramètre requis manquant : {k}"
    for k, v in params.items():
        if k not in spec:
            return f"paramètre inconnu : {k}"
        t = TYPES.get(spec[k].get("type", "string"))
        if not isinstance(v, t) or (t is int and isinstance(v, bool)):
            return f"paramètre {k} : type {spec[k].get('type')} attendu"
    return None


def _inside(path, dirs):
    real = os.path.normcase(os.path.realpath(path))
    for d in dirs:
        base = os.path.normcase(os.path.realpath(d))
        if real == base or real.startswith(base + os.sep):
            return True
    return False


def check_policy(manifest, params):
    """Applique policy.json : permissions accordées + dossiers autorisés pour les paramètres kind=path."""
    policy = json.loads((ROOT / "policy.json").read_text(encoding="utf-8"))
    perms = manifest.get("permissions", [])
    denied = [x for x in perms if x not in policy["granted_permissions"]]
    if denied:
        return f"permission non accordée : {', '.join(denied)}"
    mode = "write" if "filesystem.write" in perms else "read"
    for k, s in manifest.get("parameters", {}).items():
        # Mode fermé : kind=path explicite, OU nom typique d'un chemin (un manifeste qui oublie le marquage
        # reste contrôlé). Pour un texte non-chemin portant ce nom, déclarer "kind": "text".
        is_path = s.get("kind") == "path" or (s.get("type") == "string" and s.get("kind") != "text"
                                              and k in PATH_NAMES)
        if not is_path or k not in params:
            continue
        # une source (lecture) reste en lecture même dans un outil qui écrit ailleurs
        m = "write" if (mode == "write" and k == "output") else "read"
        if k == "path" and mode == "write" and "output" not in manifest["parameters"]:
            m = "write"
        if not _inside(params[k], policy["allowed_dirs"][m]):
            return f"{k} : '{params[k]}' hors des dossiers autorisés en {'écriture' if m == 'write' else 'lecture'} (tools/policy.json)"
    return None


def run(name, params):
    tools = discover()
    if name not in tools:
        return reply(False, error={"type": "UnknownTool", "message": f"outil inconnu : {name}"})
    folder, manifest = tools[name]
    err = validate(manifest, params)
    if err:
        return reply(False, error={"type": "InvalidParams", "message": err})
    err = check_policy(manifest, params)
    if err:
        return reply(False, error={"type": "PermissionDenied", "message": err})
    try:
        spec = importlib.util.spec_from_file_location(name, folder / manifest["entrypoint"])
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        out = getattr(mod, manifest.get("function", "execute"))(params)
        return reply(True, out.get("data"), warnings=out.get("warnings", []))
    except Exception as exc:
        return reply(False, error={"type": type(exc).__name__, "message": str(exc)})


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    a = sys.argv[1:]
    if a[:1] == ["list"]:
        res = reply(True, [{"name": n, "category": m["category"], "description": m["description"],
                            "permissions": m.get("permissions", []), "parameters": m.get("parameters", {})}
                           for n, (_, m) in sorted(discover().items())])
    elif a[:1] == ["run"] and len(a) >= 2:
        res = run(a[1], json.loads(a[2]) if len(a) > 2 else {})
    else:
        res = reply(False, error={"type": "Usage", "message": "list | run <outil> [json]"})
    print(json.dumps(res, ensure_ascii=False, indent=2))
