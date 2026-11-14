import re
from pathlib import Path

from common import bounded

# Niveau d'une ligne : du plus grave au moins grave, premier motif qui correspond.
LEVELS = [
    ("error", re.compile(r"\b(?:ERROR|FATAL|CRITICAL|PANIC|SCRIPT ERROR|Unhandled|Traceback)\b|"
                         r"\berror(?:\[E\d+\])?:|\bpanicked at\b|\bException\b|\bfailed\b", re.I)),
    ("warning", re.compile(r"\b(?:WARN(?:ING)?|DEPRECATED)\b|\bwarning(?:\[\w+\])?:", re.I)),
]
# Parties variables remplacées pour regrouper les messages identiques.
NORMALIZE = [
    (re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?"), "<date>"),
    (re.compile(r"\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b"), "<heure>"),
    # Chemin absolu ou relatif vers un fichier, avec ligne et colonne éventuelles (C:\a\b.rs:3:5, src/main.rs:10).
    (re.compile(r"(?:[A-Za-z]:)?[\\/]?(?:[\w.@~-]+[\\/])+[\w.@~-]+\.\w+(?::\d+)*"), "<chemin>"),
    (re.compile(r"\b0x[0-9a-fA-F]+\b"), "<hex>"),
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I), "<uuid>"),
    (re.compile(r"\b\d+(?:\.\d+)?\b"), "<n>"),
]


def level_of(line):
    for name, rx in LEVELS:
        if rx.search(line):
            return name
    return None


def signature(line):
    s = line.strip()
    for rx, rep in NORMALIZE:
        s = rx.sub(rep, s)
    return re.sub(r"\s+", " ", s)[:240]


def analyze(lines, first_line=1):
    """Groupes d'erreurs et d'avertissements (testable sans fichier)."""
    groups = {}
    for i, line in enumerate(lines, first_line):
        lvl = level_of(line)
        if not lvl:
            continue
        key = (lvl, signature(line))
        g = groups.get(key)
        if g:
            g["count"] += 1
            g["last_line"] = i
        else:
            groups[key] = {"level": lvl, "signature": key[1], "count": 1, "first_line": i, "last_line": i,
                           "example": line.strip()[:400]}
    order = {"error": 0, "warning": 1}
    return sorted(groups.values(), key=lambda g: (order[g["level"]], -g["count"], g["first_line"]))


def execute(params):
    path = Path(params["file"])
    if not path.is_file():
        raise FileNotFoundError(f"introuvable : {path}")
    tail = bounded(params, "tail_mb", 20, 1, 64) * 1024 * 1024
    limit = bounded(params, "limit", 40, 1, 1000)
    size = path.stat().st_size
    warnings = []
    with path.open("rb") as fh:
        if size > tail:
            fh.seek(size - tail)
            fh.readline()  # ligne coupée par le début de la lecture
            warnings.append(f"Seule la fin du fichier a été lue ({tail // (1024 * 1024)} Mo sur {size // (1024 * 1024)} Mo) : "
                            "les numéros de ligne partent du début de cette partie.")
        raw = fh.read()
    text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines()
    groups = analyze(lines)
    errors = sum(g["count"] for g in groups if g["level"] == "error")
    warns = sum(g["count"] for g in groups if g["level"] == "warning")
    return {"data": {"lines_read": len(lines), "error_count": errors, "warning_count": warns,
                     "group_count": len(groups), "groups": groups[:limit], "truncated": len(groups) > limit},
            "warnings": warnings}
