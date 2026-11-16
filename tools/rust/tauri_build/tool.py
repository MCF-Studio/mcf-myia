"""Construit une application Tauri 2 (frontend + Rust), où que soit son frontend (racine ou sous-dossier).

Lance le CLI Tauri du projet par node (jamais par cmd : aucun caractère de chemin n'est interprété par un shell),
comme `tauri build` : le beforeBuildCommand du projet construit le frontend, puis cargo construit l'exécutable."""
import json
import shutil
import subprocess
import time
from pathlib import Path

from common import bounded

CLI = Path("node_modules", "@tauri-apps", "cli", "tauri.js")
SKIP = {"node_modules", "target", "dist", "build", ".git", "src-tauri"}


def _uses_tauri_cli(folder):
    """Dossier dont le package.json déclare @tauri-apps/cli (installé ou non)."""
    try:
        pkg = json.loads((folder / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
    return "@tauri-apps/cli" in deps


def find_frontend(root, name=None):
    """Dossier du frontend : celui donné (sous-dossier du projet), sinon la racine ou un sous-dossier direct qui
    déclare @tauri-apps/cli. Le chemin réel doit rester dans le projet (pas de .. ni de lien vers ailleurs)."""
    if name:
        folder = (root / name).resolve()
        if folder != root and root not in folder.parents:
            raise PermissionError(f"frontend hors du projet : {name!r}")
        if not (folder / "package.json").is_file():
            raise FileNotFoundError(f"pas de package.json dans {folder}")
        return folder
    candidates = [root] + sorted(p for p in root.iterdir() if p.is_dir() and not p.is_symlink()
                                 and p.name not in SKIP and not p.name.startswith("."))
    found = [c for c in candidates if _uses_tauri_cli(c)]
    if len(found) != 1:
        raise ValueError("frontend introuvable (aucun package.json avec @tauri-apps/cli)" if not found else
                         f"plusieurs frontends possibles ({', '.join(f.name for f in found)}) : préciser frontend")
    return found[0]


def _node():
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node introuvable dans le PATH (Node.js requis pour le CLI Tauri)")
    return node


def _npm_cli(node):
    """npm lancé par node (npm-cli.js livré avec Node), pas par npm.cmd : pas de shell intermédiaire."""
    cli = Path(node).resolve().parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
    if not cli.is_file():
        raise RuntimeError(f"npm introuvable à côté de node ({cli})")
    return str(cli)


def _run(cmd, cwd, timeout):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                          encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL)


def _tail(text, n=25):
    return [line for line in text.strip().splitlines() if line.strip()][-n:]


def outputs(root, profile, since, bundle):
    """Exécutables (et installateurs si bundle) écrits depuis `since` dans target/<profil>."""
    found = []
    for target in (root / "src-tauri" / "target", root / "target"):
        out = target / profile
        if not out.is_dir():
            continue
        files = list(out.glob("*.exe")) + ([p for p in (out / "bundle").rglob("*") if p.is_file()
                                            and p.suffix.lower() in (".exe", ".msi")] if bundle else [])
        found += [str(p) for p in files if p.stat().st_mtime >= since - 1]
    return sorted(set(found))


def execute(params):
    root = Path(params["project"]).resolve()
    if not (root / "src-tauri" / "tauri.conf.json").is_file():
        raise FileNotFoundError(f"pas de src-tauri/tauri.conf.json dans {root} : pas une application Tauri")
    profile = params.get("profile", "release")
    if profile not in ("debug", "release"):
        raise ValueError("profile : debug ou release")
    bundle = params.get("bundle", False)
    install = params.get("install", False)
    if not isinstance(bundle, bool) or not isinstance(install, bool):
        raise ValueError("bundle et install : vrai ou faux")
    timeout = bounded(params, "timeout", 1800, 1, 3600)
    frontend = find_frontend(root, params.get("frontend"))
    node = _node()
    t0 = time.time()
    data = {"frontend": str(frontend), "profile": profile, "bundle": bundle, "installed_dependencies": False}

    if not (frontend / CLI).is_file():
        if not install:
            raise FileNotFoundError(f"dépendances du frontend absentes ({frontend / 'node_modules'}) : "
                                    "relancer avec install=true (npm ci)")
        npm = ["ci"] if (frontend / "package-lock.json").is_file() else ["install"]
        try:
            r = _run([node, _npm_cli(node), *npm, "--no-audit", "--no-fund"], frontend, timeout)
        except subprocess.TimeoutExpired:
            return {"data": {**data, "completed": False, "reason": f"npm : délai de {timeout}s dépassé"},
                    "warnings": ["Installation incomplète : rien n'a été construit."]}
        if r.returncode != 0 or not (frontend / CLI).is_file():
            return {"data": {**data, "completed": True, "ok": False, "step": "npm " + npm[0],
                             "exit_code": r.returncode, "stderr_tail": _tail(r.stderr)}, "warnings": []}
        data["installed_dependencies"] = True

    cmd = [node, str(frontend / CLI), "build", "--ci"]
    if profile == "debug":
        cmd.append("--debug")
    if not bundle:
        cmd.append("--no-bundle")
    started = time.time()
    remaining = max(1, timeout - int(started - t0))
    try:
        # Depuis src-tauri, comme les scripts du projet : lancé depuis la racine, le CLI prendrait le dossier du
        # frontend pour celui de l'application et le beforeBuildCommand (chemins relatifs) chercherait au mauvais endroit.
        r = _run(cmd, root / "src-tauri", remaining)
    except subprocess.TimeoutExpired:
        return {"data": {**data, "completed": False, "reason": f"délai de {timeout}s dépassé"},
                "warnings": ["Build incomplet : ne pas conclure qu'il a réussi."]}
    ok = r.returncode == 0
    data.update({"completed": True, "ok": ok, "step": "tauri build", "exit_code": r.returncode,
                 "duration_s": round(time.time() - t0, 1), "outputs": outputs(root, profile, started, bundle)})
    warnings = []
    if not ok:
        data["stderr_tail"] = _tail(r.stderr + "\n" + r.stdout)
        warnings.append("Échec du build : voir stderr_tail (frontend, compilation Rust ou édition de liens).")
    elif not data["outputs"]:
        warnings.append("Build réussi mais aucun exécutable récent trouvé dans target/ (CARGO_TARGET_DIR ?).")
    return {"data": data, "warnings": warnings}
