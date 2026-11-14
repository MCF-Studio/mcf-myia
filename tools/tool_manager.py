"""Gestionnaire d'outils : découverte des manifestes, validation, politique, confirmation, exécution.

Usage :
  python tools/tool_manager.py list
  python tools/tool_manager.py run <outil> '{"param": "valeur"}' [--confirmed]
  python tools/tool_manager.py run <outil> - [--confirmed]        (paramètres JSON lus sur l'entrée standard)

Toujours une réponse JSON {success, tool, risk, data, error, warnings} sur stdout.
Code de sortie : 0 = exécuté, 1 = refusé ou en échec, 2 = confirmation requise.

Sûr par défaut (docs/SPEC.md §3) :
- rien ne démarre sans politique locale `tools/policy.json` (copie adaptée de `policy.example.json`) ;
- chaque outil déclare un niveau de risque `read` / `launch` / `local` / `external` ; un outil `local` ou `external`
  n'est exécuté qu'avec `--confirmed`, sinon le gestionnaire renvoie un aperçu de ce qu'il ferait ;
- `--confirmed` est posé par l'APPELANT (humain ou harnais) après l'accord de l'utilisateur sur cet aperçu, jamais par
  le modèle de sa propre initiative ;
- les permissions qui lancent un programme ou ouvrent une adresse ne sont accordées que si la politique locale les nomme.
"""
import importlib.util
import json
import math
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import safety  # noqa: E402

POLICY_PATH = ROOT / "policy.json"
ENTRYPOINT, FUNCTION = "tool.py", "execute"       # fixés : un manifeste ne choisit ni le fichier ni la fonction
PATH_NAMES = {"path", "file", "project", "directory", "repo", "output", "folder", "dir"}
TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict}
NAME = re.compile(r"^[a-z][a-z0-9_]{1,60}$")

# Permissions connues et niveau de risque MINIMAL de l'outil qui les demande.
PERMISSIONS = {
    "filesystem.read": "read",
    "filesystem.write": "local",          # toute écriture de fichier se confirme
    "network.local": "read",              # 127.0.0.1 uniquement
    "process.exec.readonly": "read",      # git durci en lecture, « --version » : lance tout de même un programme
    "process.exec": "local",              # cargo, Godot sans fenêtre : exécute le code du projet
    "app.launch": "launch",               # application du catalogue local, dossier dans l'Explorateur, notification
    "url.open": "external",               # navigateur : canal de sortie de données
}
# Accordées seulement si la politique locale les nomme ; jamais dans policy.example.json.
EXEC_PERMISSIONS = ("process.exec.readonly", "process.exec", "app.launch", "url.open")

MAX_STRING, MAX_ITEMS, MAX_PARAMS_BYTES = 20_000, 500, 2_500_000
PREVIEW_CHARS = 1500


class Refusal(Exception):
    """Refus attendu : `kind` devient error.type dans la réponse."""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


def reply(ok, data=None, error=None, warnings=None, tool=None, risk=None):
    return {"success": ok, "tool": tool, "risk": risk, "data": data, "error": error, "warnings": warnings or []}


def load_policy():
    """Politique LOCALE. Absente ou mal formée : le gestionnaire refuse de démarrer."""
    if not POLICY_PATH.is_file():
        raise Refusal("PolicyMissing",
                      "aucune politique locale : copier tools/policy.example.json vers tools/policy.json, puis y mettre "
                      "les dossiers autorisés de CE poste et les permissions voulues. Rien ne s'exécute sans elle.")
    try:
        policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
        dirs = policy["allowed_dirs"]
        granted = policy["granted_permissions"]
        ok = (isinstance(granted, list) and all(isinstance(g, str) for g in granted)
              and all(isinstance(dirs[m], list) and all(isinstance(d, str) for d in dirs[m]) for m in ("read", "write")))
    except (ValueError, KeyError, TypeError) as exc:
        raise Refusal("PolicyInvalid", f"tools/policy.json illisible ({exc}) : repartir de policy.example.json") from None
    if not ok:
        raise Refusal("PolicyInvalid", "tools/policy.json : allowed_dirs.read / .write et granted_permissions doivent être des listes de chaînes")
    unknown = [g for g in granted if g not in PERMISSIONS]
    if unknown:
        raise Refusal("PolicyInvalid", f"tools/policy.json : permission inconnue ({', '.join(unknown)}) ; connues : {', '.join(PERMISSIONS)}")
    for mode in ("read", "write"):
        for d in dirs[mode]:
            if not os.path.isabs(d) or d.startswith(("\\\\", "//")):
                raise Refusal("PolicyInvalid", f"tools/policy.json : « {d} » doit être un chemin absolu local")
            if mode == "write" and os.path.dirname(os.path.realpath(d)) == os.path.realpath(d):
                raise Refusal("PolicyInvalid", f"tools/policy.json : un disque entier (« {d} ») ne peut pas être ouvert en écriture")
    return policy


def check_manifest(m, folder):
    """Lève ValueError si le manifeste n'est pas utilisable (il est alors ignoré et signalé)."""
    if not isinstance(m, dict):
        raise ValueError("objet JSON attendu")
    name = m.get("name")
    if not isinstance(name, str) or not NAME.match(name) or name != folder.name:
        raise ValueError(f"name doit être le nom du dossier ({folder.name})")
    if m.get("entrypoint", ENTRYPOINT) != ENTRYPOINT or m.get("function", FUNCTION) != FUNCTION:
        raise ValueError(f"entrypoint et function sont fixés à {ENTRYPOINT} / {FUNCTION}")
    if not (folder / ENTRYPOINT).is_file():
        raise ValueError(f"{ENTRYPOINT} absent")
    risk = m.get("risk")
    if risk not in safety.RISKS:
        raise ValueError(f"risk requis : {' / '.join(safety.RISKS)}")
    perms = m.get("permissions", [])
    if not isinstance(perms, list) or any(p not in PERMISSIONS for p in perms):
        raise ValueError(f"permissions : liste parmi {', '.join(PERMISSIONS)}")
    for p in perms:
        if safety.RISKS.index(risk) < safety.RISKS.index(PERMISSIONS[p]):
            raise ValueError(f"risk « {risk} » trop bas pour la permission {p} (au moins « {PERMISSIONS[p]} »)")
    spec = m.get("parameters", {})
    if not isinstance(spec, dict) or not all(isinstance(s, dict) for s in spec.values()):
        raise ValueError("parameters : objet {nom: {...}} attendu")
    for k, s in spec.items():
        if s.get("type", "string") not in TYPES:
            raise ValueError(f"paramètre {k} : type inconnu")
        if s.get("access", "read") not in ("read", "write"):
            raise ValueError(f"paramètre {k} : access = read ou write")
        if s.get("access") == "write" and "filesystem.write" not in perms:
            raise ValueError(f"paramètre {k} en écriture sans la permission filesystem.write")


def discover():
    """({nom: (dossier, manifeste)}, problèmes). Un manifeste invalide ou un nom en double n'est jamais chargé."""
    found, problems, twice = {}, [], set()
    for p in sorted(ROOT.glob("*/*/manifest.json")):
        rel = p.relative_to(ROOT).as_posix()
        try:
            m = json.loads(p.read_text(encoding="utf-8"))
            check_manifest(m, p.parent)
        except (OSError, ValueError) as exc:
            problems.append(f"{rel} ignoré : {exc}")
            continue
        name = m["name"]
        if name in found or name in twice:
            twice.add(name)
            found.pop(name, None)
            problems.append(f"{rel} ignoré : deux outils s'appellent {name} (aucun des deux n'est chargé)")
            continue
        found[name] = (p.parent, m)
    return found, problems


def is_path(key, spec):
    """Mode fermé : `kind: path` explicite, OU nom typique d'un chemin, quel que soit le champ `type` (un manifeste
    qui oublie le marquage reste contrôlé). Pour un texte qui porte un de ces noms : `"kind": "text"`."""
    return spec.get("kind") == "path" or (spec.get("kind") != "text" and key in PATH_NAMES)


def access_of(key, spec, manifest):
    """`access` explicite, sinon : dans un outil qui écrit, `output` (ou `path` s'il n'y a pas d'`output`)."""
    if spec.get("access"):
        return spec["access"]
    if "filesystem.write" not in manifest.get("permissions", []):
        return "read"
    return "write" if key == "output" or (key == "path" and "output" not in manifest.get("parameters", {})) else "read"


def _check_value(key, value, spec):
    t = TYPES[spec.get("type", "string")]
    if not isinstance(value, t) or (isinstance(value, bool) and t is not bool):
        return f"paramètre {key} : type {spec.get('type', 'string')} attendu"
    if isinstance(value, float) and not math.isfinite(value):
        return f"paramètre {key} : nombre fini attendu"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "min" in spec and value < spec["min"] or "max" in spec and value > spec["max"]:
            return f"paramètre {key} : hors limites ({spec.get('min', '…')} à {spec.get('max', '…')})"
    if isinstance(value, str) and len(value) > spec.get("max_length", MAX_STRING):
        return f"paramètre {key} : trop long ({spec.get('max_length', MAX_STRING)} caractères au plus)"
    if isinstance(value, (list, dict)) and len(value) > MAX_ITEMS:
        return f"paramètre {key} : trop d'éléments ({MAX_ITEMS} au plus)"
    return None


def validate(manifest, params):
    if not isinstance(params, dict):
        return "paramètres : objet JSON attendu"
    spec = manifest.get("parameters", {})
    for k, s in spec.items():
        if s.get("required") and k not in params:
            return f"paramètre requis manquant : {k}"
    for k, v in params.items():
        if k not in spec:
            return f"paramètre inconnu : {k}"
        err = _check_value(k, v, spec[k])
        if err:
            return err
    return None


def check_policy(manifest, params, policy):
    """Permissions accordées + dossiers autorisés pour tous les paramètres chemin.

    Retourne (paramètres où chaque chemin est remplacé par son chemin RÉEL contrôlé, cibles pour l'aperçu)."""
    perms = manifest.get("permissions", [])
    denied = [x for x in perms if x not in policy["granted_permissions"]]
    if denied:
        hint = (" ; les permissions qui lancent un programme ou ouvrent une adresse sont désactivées par défaut"
                if any(d in EXEC_PERMISSIONS for d in denied) else "")
        raise Refusal("PermissionDenied", f"permission non accordée : {', '.join(denied)} (granted_permissions de "
                      f"tools/policy.json){hint}")
    out, targets = dict(params), []
    for k, s in manifest.get("parameters", {}).items():
        if not is_path(k, s) or k not in params:
            continue
        mode = access_of(k, s, manifest)
        label = "écriture" if mode == "write" else "lecture"
        try:
            real = safety.resolve(params[k])
            if mode == "write":
                safety.check_write_target(real)
            else:
                safety.check_read_target(real)
        except (ValueError, OSError) as exc:
            raise Refusal("PermissionDenied", f"{k} : {exc}") from None
        if not any(safety.inside(real, d) for d in policy["allowed_dirs"][mode]):
            raise Refusal("PermissionDenied", f"{k} : '{real}' hors des dossiers autorisés en {label} (tools/policy.json)")
        out[k] = real
        targets.append({"param": k, "path": real, "access": mode, "exists": os.path.exists(real)})
    return out, targets


def _short(value):
    if isinstance(value, str) and len(value) > PREVIEW_CHARS:
        return value[:PREVIEW_CHARS] + f"… ({len(value)} caractères au total)"
    if isinstance(value, list):
        return [_short(v) for v in value[:50]]
    if isinstance(value, dict):
        return {k: _short(v) for k, v in list(value.items())[:50]}
    return value


def preview(name, manifest, params, targets):
    """Ce que l'outil ferait, à montrer à l'utilisateur avant de relancer avec --confirmed."""
    writes = [t for t in targets if t["access"] == "write"]
    lines = [f"{name} (risque {manifest['risk']}) : {manifest.get('description', '')}"]
    lines += [f"{'remplace ou modifie' if t['exists'] else 'crée'} : {t['path']}" for t in writes]
    return {"action": "\n".join(lines), "permissions": manifest.get("permissions", []), "targets": targets,
            "params": {k: _short(v) for k, v in params.items()}}


def run(name, params, confirmed=False):
    risk = None
    try:
        policy = load_policy()
        tools, _ = discover()
        if not isinstance(name, str) or name not in tools:
            raise Refusal("UnknownTool", f"outil inconnu : {name}")
        folder, manifest = tools[name]
        risk = manifest["risk"]
        err = validate(manifest, params)
        if err:
            raise Refusal("InvalidParams", err)
        params, targets = check_policy(manifest, params, policy)
        if risk in safety.NEEDS_CONFIRMATION and confirmed is not True:
            return reply(False, {"preview": preview(name, manifest, params, targets)}, tool=name, risk=risk, error={
                "type": "ConfirmationRequired",
                "message": f"outil de niveau « {risk} » : rien n'a été exécuté. Montrer l'aperçu à l'utilisateur ; "
                           "s'il est d'accord, c'est l'appelant (humain ou harnais) qui relance avec --confirmed."})
        spec = importlib.util.spec_from_file_location(f"myia_tool_{name}", folder / ENTRYPOINT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        out = getattr(mod, FUNCTION)(params)
        return reply(True, out.get("data"), warnings=out.get("warnings", []), tool=name, risk=risk)
    except Refusal as exc:
        return reply(False, error={"type": exc.kind, "message": str(exc)}, tool=name, risk=risk)
    except Exception as exc:  # un outil qui échoue donne une réponse JSON, jamais une trace Python
        return reply(False, error={"type": type(exc).__name__, "message": str(exc)}, tool=name, risk=risk)


def listing():
    try:
        policy = load_policy()
        tools, problems = discover()
    except Refusal as exc:
        return reply(False, error={"type": exc.kind, "message": str(exc)})
    granted = policy["granted_permissions"]
    items = []
    for n, (_, m) in sorted(tools.items()):
        perms = m.get("permissions", [])
        items.append({"name": n, "category": m.get("category"), "description": m.get("description"),
                      "risk": m["risk"], "needs_confirmation": m["risk"] in safety.NEEDS_CONFIRMATION,
                      "permissions": perms, "enabled": all(p in granted for p in perms),
                      "parameters": m.get("parameters", {})})
    return reply(True, items, warnings=problems)


def main(argv):
    """(réponse, code de sortie). `--confirmed` n'est lu que sur la ligne de commande, jamais dans les paramètres."""
    args = [a for a in argv if a != "--confirmed"]
    confirmed = len(args) != len(argv)
    if args[:1] == ["list"] and len(args) == 1 and not confirmed:
        res = listing()
    elif args[:1] == ["run"] and 2 <= len(args) <= 3:
        try:
            raw = "{}" if len(args) == 2 else (sys.stdin.read(MAX_PARAMS_BYTES + 1) if args[2] == "-" else args[2])
            if len(raw) > MAX_PARAMS_BYTES:
                raise ValueError("paramètres trop volumineux")
            params = json.loads(raw)
        except ValueError as exc:
            return reply(False, error={"type": "InvalidParams", "message": f"JSON des paramètres invalide : {exc}"},
                         tool=args[1]), 1
        res = run(args[1], params, confirmed=confirmed)
    else:
        res = reply(False, error={"type": "Usage", "message": "list | run <outil> [json | -] [--confirmed]"})
    code = 0 if res["success"] else 2 if (res["error"] or {}).get("type") == "ConfirmationRequired" else 1
    return res, code


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    response, exit_code = main(sys.argv[1:])
    print(json.dumps(response, ensure_ascii=False, indent=2))
    sys.exit(exit_code)
