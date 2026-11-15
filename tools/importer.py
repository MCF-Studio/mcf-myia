"""Import d'un outil dans la boîte : un dossier `<nom>/` avec manifest.json et tool.py (README.md facultatif).

Appelé par `tool_manager.py import <dossier> [--confirmed]` (l'app, ou un humain) ; jamais proposé aux agents.
Sans `--confirmed` : rien n'est copié, la réponse décrit l'outil (risque, permissions, paramètres) pour que l'humain
décide. Avec : copie dans `tools/imports/<nom>/` (dossier local, ignoré par git).

Rien du code importé n'est exécuté ici : tool.py est seulement compilé (syntaxe) et inspecté (fonction execute).
Il ne s'exécutera qu'appelé comme tout outil, avec la politique locale et ses confirmations."""
import ast
import json
import shutil
from pathlib import Path

ALLOWED = {"manifest.json": 64_000, "tool.py": 512_000, "README.md": 256_000}
IGNORED = {"__pycache__"}


def _read_folder(src):
    """Fichiers du dossier source : seulement ceux de ALLOWED, ni lien ni sous-dossier, tailles bornées."""
    if not src.is_dir():
        raise ValueError(f"dossier introuvable : {src}")
    files = {}
    for entry in src.iterdir():
        if entry.name in IGNORED:
            continue
        if entry.is_symlink() or not entry.is_file() or entry.name not in ALLOWED:
            raise ValueError(f"« {entry.name} » non accepté : un outil importé ne contient que "
                             f"{', '.join(ALLOWED)} (pas de sous-dossier ni de lien)")
        size = entry.stat().st_size
        if size > ALLOWED[entry.name]:
            raise ValueError(f"{entry.name} trop gros ({size} octets, {ALLOWED[entry.name]} au plus)")
        files[entry.name] = entry.read_bytes()
    for required in ("manifest.json", "tool.py"):
        if required not in files:
            raise ValueError(f"{required} absent du dossier {src}")
    return files


def _check_code(source):
    """Syntaxe Python valide et `def execute(params)` au premier niveau, sans exécuter le fichier."""
    try:
        tree = ast.parse(source, filename="tool.py")
    except SyntaxError as exc:
        raise ValueError(f"tool.py : erreur de syntaxe ligne {exc.lineno} ({exc.msg})") from None
    if not any(isinstance(n, ast.FunctionDef) and n.name == "execute" for n in tree.body):
        raise ValueError("tool.py : fonction execute(params) absente au premier niveau")


def inspect(src, tm):
    """(manifeste, fichiers) d'un dossier à importer ; ValueError si l'outil n'est pas importable."""
    src = Path(src).resolve()
    files = _read_folder(src)
    try:
        manifest = json.loads(files["manifest.json"].decode("utf-8"))
        source = files["tool.py"].decode("utf-8")
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValueError(f"manifest.json ou tool.py illisible (UTF-8 et JSON attendus) : {exc}") from None
    tm.check_manifest(manifest, src)          # nom = nom du dossier, risque, permissions, paramètres
    _check_code(source)
    tools, _ = tm.discover()
    if manifest["name"] in tools or (tm.ROOT / "imports" / manifest["name"]).exists():
        raise ValueError(f"un outil s'appelle déjà {manifest['name']} : renommer le dossier et le champ name")
    return manifest, files


def summary(manifest, policy, tm, dest):
    perms = manifest.get("permissions", [])
    missing = [p for p in perms if p not in policy["granted_permissions"]]
    return {"name": manifest["name"], "version": manifest.get("version"), "category": manifest.get("category"),
            "description": manifest.get("description", ""), "risk": manifest["risk"],
            "needs_confirmation": manifest["risk"] in tm.safety.NEEDS_CONFIRMATION, "permissions": perms,
            "missing_permissions": missing, "parameters": manifest.get("parameters", {}), "destination": str(dest)}


def import_tool(src, confirmed, tm):
    """Réponse JSON du gestionnaire (voir tool_manager.reply)."""
    try:
        policy = tm.load_policy()
        manifest, files = inspect(src, tm)
    except tm.Refusal as exc:
        return tm.reply(False, error={"type": exc.kind, "message": str(exc)})
    except (OSError, ValueError) as exc:
        return tm.reply(False, error={"type": "InvalidTool", "message": str(exc)})
    dest = tm.ROOT / "imports" / manifest["name"]
    info = summary(manifest, policy, tm, dest)
    warnings = []
    if info["missing_permissions"]:
        warnings.append(f"Désactivé tant que tools/policy.json n'accorde pas : {', '.join(info['missing_permissions'])}.")
    if not confirmed:
        return tm.reply(False, {"preview": info}, warnings=warnings, tool=manifest["name"], risk=manifest["risk"], error={
            "type": "ConfirmationRequired",
            "message": "rien n'a été copié : relire l'outil (risque, permissions, code) puis relancer avec --confirmed"})
    tmp = dest.parent / f".{manifest['name']}.import"
    try:
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        for name, data in files.items():
            (tmp / name).write_bytes(data)
        tmp.rename(dest)
    except OSError as exc:
        shutil.rmtree(tmp, ignore_errors=True)
        return tm.reply(False, error={"type": "ImportFailed", "message": str(exc)}, tool=manifest["name"])
    tools, _ = tm.discover()
    if manifest["name"] not in tools:      # ex. un autre outil du même nom apparu entre-temps : on n'en garde aucun
        shutil.rmtree(dest, ignore_errors=True)
        return tm.reply(False, error={"type": "ImportFailed", "message": "outil copié mais non chargé : import annulé"},
                        tool=manifest["name"])
    return tm.reply(True, info, warnings=warnings, tool=manifest["name"], risk=manifest["risk"])
