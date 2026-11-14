"""Aides partagées par les outils (importable : le gestionnaire ajoute tools/ au sys.path)."""
import json
import os
import subprocess
import tempfile
import threading
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APPS_PATH = ROOT / "apps.json"          # local, hors dépôt : copie adaptée de apps.example.json
SKIP_DIRS = {".git", ".godot", ".import", "node_modules", "target", "__pycache__", ".venv", "dist", "build"}

# Programmes qui exécutent ce qu'on leur passe : jamais dans le catalogue (ce serait une commande libre déguisée).
INTERPRETERS = {
    "cmd", "powershell", "pwsh", "bash", "sh", "zsh", "wsl", "python", "pythonw", "py", "node", "deno", "bun", "ruby",
    "perl", "php", "wscript", "cscript", "mshta", "rundll32", "regsvr32", "msiexec", "conhost", "wt", "java", "javaw",
    "cargo", "git", "ssh", "curl", "wget", "certutil", "bitsadmin", "schtasks", "reg", "explorer",
}


def bounded(params, key, default, low, high):
    """Entier venu du modèle, ramené dans [low, high] (délais, limites de réponse)."""
    value = params.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        raise ValueError(f"{key} : nombre attendu")
    return int(min(max(value, low), high))


def check_range(name, value, low, high):
    """Paramètre numérique venu du modèle : refusé hors de [low, high] (un plafond explicite vaut mieux qu'un calcul géant)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or not low <= value <= high:
        raise ValueError(f"{name} : valeur entre {low} et {high} attendue")
    return value


def iter_files(root):
    """Fichiers sous root, sans entrer dans les dossiers lourds (os.walk élague, contrairement à rglob)."""
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            yield Path(dirpath) / f


def load_apps(missing_ok=False):
    """Catalogue local des applications. Absent : rien n'est lançable (message clair, ou {} si `missing_ok`)."""
    if not APPS_PATH.is_file():
        if missing_ok:
            return {}
        raise FileNotFoundError("aucun catalogue d'applications : copier tools/apps.example.json vers tools/apps.json "
                                "et y mettre les chemins de CE poste (fichier local, jamais publié)")
    apps = json.loads(APPS_PATH.read_text(encoding="utf-8"))
    if not isinstance(apps, dict):
        raise ValueError("tools/apps.json : objet {identifiant: {...}} attendu")
    return {k: v for k, v in apps.items() if isinstance(v, dict) and not k.startswith("_")}


def _norm(s):
    s = unicodedata.normalize("NFD", s.lower().strip())
    return "".join(c for c in s if not unicodedata.combining(c))


def resolve_app(name):
    """Retourne (id, entrée) si UNE seule appli correspond ; lève ValueError sinon."""
    apps, q = load_apps(), _norm(name)
    exact = [k for k, a in apps.items() if q == _norm(k) or q in map(_norm, a.get("aliases", []))]
    hits = exact or [k for k, a in apps.items() if q in _norm(a.get("label", ""))]
    if len(hits) != 1:
        raise ValueError(f"application '{name}' : " + ("inconnue du catalogue" if not hits
                         else f"ambiguë ({', '.join(hits)})"))
    return hits[0], apps[hits[0]]


def app_path(entry):
    """Exécutable d'une entrée du catalogue : chemin absolu local existant, jamais un shell ni un interpréteur."""
    raw = entry.get("executable")
    if not isinstance(raw, str) or not raw:
        return None
    p = os.path.expandvars(raw)
    if p.startswith(("\\\\", "//")) or not os.path.isabs(p):
        return None
    if Path(p).stem.lower() in INTERPRETERS:
        raise PermissionError(f"{Path(p).name} : shell ou interpréteur, refusé dans le catalogue d'applications")
    return p if os.path.exists(p) else None  # exists, pas isfile : certains volumes le signalent comme dossier


# Même durcissement que agent/src/services/git.ts : pas de pager, pas de moniteur de fichiers ni de pilote de diff
# pris dans la config du dépôt (ils lanceraient une commande), pathspecs littéraux, transport ext:: interdit.
GIT_BASE = [
    "git", "--no-pager", "--literal-pathspecs", "--no-optional-locks",
    "-c", "core.fsmonitor=false",
    "-c", "core.quotepath=false",
    "-c", "core.pager=cat",
    "-c", "color.ui=never",
    "-c", "protocol.ext.allow=never",
    "-c", "log.showSignature=false",
]


def git_env():
    """Environnement de git : aucune variable GIT_* héritée (GIT_EXTERNAL_DIFF, GIT_DIR, GIT_CONFIG_*…), pas d'invite."""
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")}
    env.update({"GIT_TERMINAL_PROMPT": "0", "GIT_PAGER": "cat", "GIT_EDITOR": "true"})
    return env


def run_git(repo, *args, timeout=60, max_bytes=2_000_000):
    """Lance git (lecture seule, durci) dans `repo`. Retourne (sortie, tronquée) ; sortie bornée à `max_bytes`."""
    timed_out = []
    with tempfile.TemporaryFile() as err:
        try:
            proc = subprocess.Popen([*GIT_BASE, *args], cwd=str(repo), stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=err, env=git_env())
        except FileNotFoundError:
            raise RuntimeError("git introuvable dans le PATH") from None

        def kill():
            timed_out.append(True)
            proc.kill()

        timer = threading.Timer(timeout, kill)
        timer.start()
        try:
            out = proc.stdout.read(max_bytes + 1)
            truncated = len(out) > max_bytes
            if truncated:
                proc.kill()
            proc.stdout.close()
            code = proc.wait()
        finally:
            timer.cancel()
        err.seek(0)
        stderr = err.read(20_000).decode("utf-8", errors="replace").strip()
    if timed_out:
        raise TimeoutError(f"git : délai de {timeout}s dépassé")
    if code != 0 and not truncated:
        raise RuntimeError(stderr or f"git a échoué ({code})")
    return out[:max_bytes].decode("utf-8", errors="replace"), truncated
