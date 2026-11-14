import re
from pathlib import Path

from common import iter_files

DEFAULT = ["TODO", "FIXME", "HACK", "XXX", "BUG"]
MAX_FILE = 2_000_000
# Fichiers texte de code et de configuration ; les binaires et images sont ignorés.
TEXT_EXT = {
    ".py", ".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue", ".svelte", ".gd", ".gdshader", ".cs", ".c", ".h",
    ".cpp", ".hpp", ".go", ".java", ".kt", ".lua", ".sh", ".ps1", ".bat", ".md", ".txt", ".toml", ".yaml", ".yml",
    ".json", ".html", ".css", ".scss", ".sql", ".tscn", ".tres", ".cfg", ".ini",
}
MARKER = re.compile(r"^[A-Za-z]{2,12}$")


def scan_text(text, markers):
    """(ligne, marqueur, texte, auteur) des marqueurs en tant que mots (« TODO: », « FIXME(léa) », pas « todolist »)."""
    rx = re.compile(r"\b(" + "|".join(map(re.escape, markers)) + r")\b(?:\(([^)]{1,40})\))?[\s:\-]*(.*)")
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        if m := rx.search(line):
            out.append((i, m.group(1), m.group(3).strip(" :-*/#")[:200], m.group(2)))
    return out


def execute(params):
    root = Path(params["directory"])
    if not root.is_dir():
        raise NotADirectoryError(f"dossier introuvable : {root}")
    markers = [m.strip().upper() for m in params.get("markers", ",".join(DEFAULT)).split(",") if m.strip()]
    bad = [m for m in markers if not MARKER.match(m)]
    if not markers or bad:
        raise ValueError(f"marqueurs invalides : {', '.join(bad) or '(aucun)'} (lettres seulement)")
    limit = params.get("limit", 200)
    items, totals, total = [], {m: 0 for m in markers}, 0
    for p in iter_files(root):
        if p.suffix.lower() not in TEXT_EXT or p.stat().st_size > MAX_FILE:
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for line, marker, note, author in scan_text(text, markers):
            totals[marker] += 1
            total += 1
            if len(items) < limit:
                item = {"file": str(p.relative_to(root)).replace("\\", "/"), "line": line, "marker": marker, "text": note}
                if author:
                    item["author"] = author
                items.append(item)
    return {"data": {"count": total, "totals": totals, "items": items, "truncated": total > limit}}
