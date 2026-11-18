"""Règles de sécurité de la boîte à outils, alignées sur docs/SPEC.md §3 et agent/src/services/file-write.ts.

Deux usages : le gestionnaire (contrôle de TOUS les paramètres chemin avant d'appeler un outil) et les outils qui
écrivent du texte (`text_write`, `text_patch`, atlas de `image_sprite_sheet`), qui recontrôlent juste avant d'écrire.
"""
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# Dépôt qui contient tools/ (s'il y en a un), ou dossier de données de l'app installée (tools/ y est copié par MyIA,
# marqueur .myia-version) : seul son dossier `workspace/` reste ouvert en écriture.
REPO = ROOT.parent if (ROOT.parent / ".git").exists() or (ROOT / ".myia-version").exists() else None
REPO_WRITABLE = ("workspace",)
# Données et config de MyIA (clés, agents, scripts acceptés) : fermées aux outils, même en lecture.
REPO_CLOSED = ("data", "config")

# Niveaux de risque (mêmes définitions que SPEC §3), du moins au plus engageant.
RISKS = ("read", "launch", "local", "external")
NEEDS_CONFIRMATION = ("local", "external")

MAX_TEXT_BYTES = 1024 * 1024
MAX_PATH_CHARS = 1000

# Dossiers où un fichier écrit peut être exécuté sans action de l'utilisateur (hooks, tâches d'éditeur, agents).
AUTORUN_SEGMENTS = {
    ".git", ".husky", ".vscode", ".idea", ".claude", ".cursor", ".github", ".gitlab", "node_modules", ".cargo",
    "startup", "démarrage", "start menu", "menu démarrer",
}

# Liste d'AUTORISATION : uniquement des formats texte. Le code et les scripts ne passent pas par ces outils.
TEXT_EXT = set("txt md markdown csv tsv json yaml yml toml xml html htm css log tex srt vtt sql rst adoc org ics vcf".split())

# Fichiers texte qui pilotent un autre outil (agents IA, npm, cargo, Windows) : jamais écrits par un agent.
BLOCKED_NAMES = {
    "claude.md", "claude.local.md", "agents.md", "gemini.md", "copilot-instructions.md", ".cursorrules", ".windsurfrules",
    ".mcp.json", "mcp.json", "settings.json", "settings.local.json", "desktop.ini", "package.json", "package-lock.json",
    ".npmrc", ".yarnrc.yml", "pnpm-workspace.yaml", "composer.json", "pyproject.toml", "cargo.toml", "tauri.conf.json",
    "docker-compose.yml", "compose.yml", "compose.yaml", ".gitlab-ci.yml", "tasks.json", "launch.json", "mise.toml",
    "agent.json", "agents.json", "teams.json", "guild.json",
    # En plus de la liste de l'app : ce que lisent les outils cargo de cette boîte (choix de la chaîne Rust, lints).
    "rust-toolchain.toml", "rustfmt.toml", ".rustfmt.toml", "clippy.toml", ".clippy.toml", "uv.toml", "bunfig.toml",
}

# Extensions exécutables (agent/src/services/files.ts) : refusées même si un jour elles entraient dans TEXT_EXT.
EXECUTABLE = set(
    ("exe com bat cmd ps1 psm1 psd1 vbs vbe js jse wsf wsh hta msi msp mst scr lnk url reg cpl jar pif application "
     "appref-ms gadget inf scf msc sh py pyw rb pl php ahk au3 dll sys ocx drv settingcontent-ms library-ms search-ms "
     "diagcab xbap xll website iqy slk").split()
)

_RESERVED = re.compile(r"^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$", re.I)


def _norm(p):
    return os.path.normcase(os.path.realpath(p))


def inside(path, base):
    """`path` est `base` ou se trouve dessous (chemins réels, casse du système)."""
    p, b = _norm(path), _norm(base)
    return p == b or p.startswith(b.rstrip("\\/") + os.sep)


def same(a, b):
    return _norm(a) == _norm(b)


def resolve(raw):
    """Chemin réel absolu d'un paramètre, après refus des écritures de chemin trompeuses sous Windows.

    Liens, jonctions et noms courts 8.3 sont résolus sur la partie existante : tous les contrôles portent ensuite sur
    le chemin RÉEL, et c'est lui que l'outil reçoit."""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("chemin vide ou qui n'est pas une chaîne")
    raw = raw.strip()
    if "\0" in raw or len(raw) > MAX_PATH_CHARS:
        raise ValueError("chemin invalide (trop long ou caractère nul)")
    # « C:dossier » (lecteur sans barre) = relatif au dossier courant de ce lecteur : ambigu, refusé.
    if re.match(r"^[A-Za-z]:(?![\\/])", raw):
        raise ValueError(f"chemin invalide « {raw} » : l'écrire en entier (lecteur, puis barre oblique)")
    # Chemin réseau ou de périphérique : ferait fuiter le jeton NTLM, ou contournerait les contrôles.
    if raw.startswith(("\\\\", "//")):
        raise ValueError("chemin réseau ou de périphérique refusé : chemins locaux uniquement")
    # Contrôles sur le texte REÇU : abspath transformerait déjà « nul.txt » en périphérique et masquerait le reste.
    rest = os.path.splitdrive(raw)[1] if re.match(r"^[A-Za-z]:[\\/]", raw) else raw
    if ":" in rest:
        raise ValueError("caractère « : » interdit dans un chemin (flux alternatif)")
    for part in re.split(r"[\\/]+", rest):
        if not part:
            continue
        if part[-1] in ". " and part not in (".", ".."):
            raise ValueError(f"nom invalide « {part} » (point ou espace final)")
        if _RESERVED.match(part):
            raise ValueError(f"nom réservé par Windows : {part}")
    return os.path.realpath(os.path.abspath(raw))


# Dossiers fermés pour cet appel (lecture ET écriture), donnés par l'APPELANT sur la ligne de commande (`--deny`),
# jamais par les paramètres : par exemple la mémoire de l'utilisateur pour un agent sur un modèle en ligne.
DENIED = []

FILE_ATTRIBUTE_REPARSE_POINT = 0x400


def set_denied(raw_paths):
    """Chemins réels des dossiers fermés. Un chemin invalide lève ValueError : l'appel est alors refusé (fermé par défaut)."""
    DENIED[:] = []
    for raw in raw_paths:
        if not os.path.isabs(raw):
            raise ValueError(f"--deny : chemin absolu attendu, pas « {raw} »")
        DENIED.append(resolve(raw))


def check_denied(real):
    """Refus d'un chemin DANS un dossier fermé, ou AU-DESSUS (un outil récursif lancé sur un parent le parcourrait)."""
    for d in DENIED:
        if inside(real, d) or inside(d, real):
            raise PermissionError(f"{real} : contient ou touche un dossier fermé pour cet agent")


def is_link(path):
    """Lien symbolique, jonction ou autre point d'analyse Windows : un parcours n'y entre jamais."""
    try:
        st = os.lstat(path)
    except OSError:
        return True
    return os.path.islink(path) or bool(getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT)


def contained(path, root):
    """Vrai si le chemin RÉEL de `path` reste sous `root`, hors des dossiers fermés et des données de MyIA."""
    real = os.path.realpath(path)
    if not inside(real, root) or any(inside(real, d) for d in DENIED):
        return False
    try:
        check_read_target(real)
    except PermissionError:
        return False
    return True


def walk_files(root, skip=()):
    """Fichiers sous root, sans entrer dans `skip`, ni dans un lien ou une jonction (qui mènerait hors du dossier
    contrôlé), ni rendre un fichier dont le chemin réel en sort."""
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in skip and not is_link(os.path.join(dirpath, d))]
        for f in files:
            p = os.path.join(dirpath, f)
            if contained(p, root):
                yield Path(p)


def segments(path):
    return [s.lower() for s in re.split(r"[\\/]+", os.path.splitdrive(str(path))[1]) if s]


def check_read_target(real):
    """Lecture : les données et la config de MyIA restent fermées, quels que soient les dossiers autorisés."""
    if REPO is not None and any(inside(real, REPO / d) for d in REPO_CLOSED):
        raise PermissionError(f"{real} : données ou configuration de MyIA, fermées aux outils")


def check_write_target(real):
    """Refus en dur, quelle que soit la politique : boîte à outils, dépôt qui la contient, dossiers qui exécutent."""
    bad = next((s for s in segments(real) if s in AUTORUN_SEGMENTS), None)
    if bad:
        raise PermissionError(f"écriture refusée dans « {bad} » : ce dossier peut exécuter du code automatiquement")
    if inside(real, ROOT):
        raise PermissionError("écriture refusée dans la boîte à outils elle-même (tools/)")
    if REPO is not None and inside(real, REPO) and not any(inside(real, REPO / d) for d in REPO_WRITABLE):
        raise PermissionError(
            f"écriture refusée dans le dépôt qui contient la boîte à outils (seul {REPO_WRITABLE[0]}/ y reste ouvert)")


def check_text_target(path):
    """Destination d'une écriture de TEXTE : mêmes règles que `file_write` de l'app. Retourne le chemin réel."""
    absolute = os.path.abspath(str(path))
    if os.path.islink(absolute):
        raise PermissionError("la cible est un lien : écriture refusée")
    real = resolve(str(path))
    check_write_target(real)
    if os.path.isdir(real):
        raise IsADirectoryError(f"{real} est un dossier")
    name = os.path.basename(real)
    if name.lower() in BLOCKED_NAMES:
        raise PermissionError(f"{name} pilote un autre outil (agents, npm, cargo, Windows…) : non modifiable par un agent")
    ext = os.path.splitext(name)[1][1:].lower()
    if not ext:
        raise PermissionError("donner une extension au fichier (.txt, .md, .csv, .json…)")
    if ext not in TEXT_EXT or ext in EXECUTABLE:
        raise PermissionError(
            f".{ext} n'est pas un format texte autorisé ({', '.join(sorted(TEXT_EXT))}). Le code ne s'écrit pas par ces outils.")
    return real


# ─── Fenêtres de console ─────────────────────────────────────────────────────
CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_CONSOLE = 0x00000010


def hide_console_windows():
    """Windows : aucun programme lancé par un outil n'ouvre de fenêtre de terminal.

    MyIA lance le gestionnaire sans console ; un programme en ligne de commande lancé ensuite (git, cargo, Blender en
    arrière-plan, Godot sans fenêtre, PowerShell…) en recevrait une NOUVELLE, visible. Tout Popen (donc
    subprocess.run) reçoit CREATE_NO_WINDOW, outils importés compris. Sans effet sur la fenêtre d'une application
    graphique (app_launch ouvre toujours Godot ou Blender normalement). Un outil qui demande explicitement une
    console (CREATE_NEW_CONSOLE) la garde.
    """
    if os.name != "nt" or getattr(subprocess.Popen, "_myia_hidden", False):
        return
    base = subprocess.Popen

    class HiddenPopen(base):
        _myia_hidden = True

        def __init__(self, *args, **kwargs):
            flags = kwargs.get("creationflags", 0) or 0
            if not flags & CREATE_NEW_CONSOLE:
                kwargs["creationflags"] = flags | CREATE_NO_WINDOW
            super().__init__(*args, **kwargs)

    subprocess.Popen = HiddenPopen
