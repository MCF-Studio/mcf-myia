import json
import re
import subprocess
import sys
from pathlib import Path

MAX_PATTERN = 300        # caractères du motif
MAX_LINE = 2000          # caractères examinés par ligne
MAX_FILE = 2_000_000     # octets par fichier
MAX_FILES = 50_000       # fichiers parcourus par appel
REGEX_TIMEOUT = 20       # secondes, pour une recherche par expression régulière


def search(root, pattern, regex, ext, limit):
    """Recherche bornée. En mode texte : sous-chaîne simple, aucune expression régulière n'est compilée."""
    from common import iter_files
    root = Path(root)
    rx = re.compile(pattern) if regex else None
    hits, scanned = [], 0
    for p in iter_files(root):
        if ext and p.suffix.lower() != ext:
            continue
        scanned += 1
        if scanned > MAX_FILES:
            return {"count": len(hits), "truncated": True, "items": hits, "files_scanned": MAX_FILES}
        try:
            if p.stat().st_size > MAX_FILE:
                continue
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # binaire ou illisible
        for i, line in enumerate(text.splitlines(), 1):
            line = line[:MAX_LINE]
            if rx.search(line) if rx else pattern in line:
                hits.append({"file": str(p.relative_to(root)).replace("\\", "/"), "line": i, "text": line.strip()[:200]})
                if len(hits) > limit:
                    return {"count": limit, "truncated": True, "items": hits[:limit], "files_scanned": scanned}
    return {"count": len(hits), "truncated": False, "items": hits, "files_scanned": scanned}


def execute(params):
    from common import bounded
    root, pat = Path(params["directory"]), params["pattern"]
    if not root.is_dir():
        raise NotADirectoryError(f"dossier introuvable : {root}")
    if not pat or len(pat) > MAX_PATTERN:
        raise ValueError(f"pattern : 1 à {MAX_PATTERN} caractères")
    ext, limit = params.get("extension", "").lower(), bounded(params, "limit", 100, 1, 1000)
    if not params.get("regex"):
        return {"data": search(root, pat, False, ext, limit)}
    try:
        re.compile(pat)
    except re.error as exc:
        raise ValueError(f"expression régulière invalide : {exc}") from None
    # Une expression du modèle peut ne jamais finir (retour arrière catastrophique) et `re` ne s'interrompt pas :
    # la recherche tourne dans un processus à part (ce même fichier, mode isolé), tué au bout du délai.
    job = json.dumps({"root": str(root), "pattern": pat, "ext": ext, "limit": limit})
    try:
        r = subprocess.run([sys.executable, "-I", str(Path(__file__).resolve())], input=job, capture_output=True,
                           text=True, encoding="utf-8", timeout=REGEX_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise TimeoutError(f"recherche arrêtée après {REGEX_TIMEOUT}s : expression trop coûteuse, la simplifier "
                           "(ou regex=false pour un texte exact)") from None
    if r.returncode != 0:
        raise RuntimeError((r.stderr.strip().splitlines() or ["recherche en échec"])[-1][:300])
    return {"data": json.loads(r.stdout)}


if __name__ == "__main__":   # processus de recherche par expression régulière (lancé par execute, jamais par un agent)
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    j = json.loads(sys.stdin.read())
    print(json.dumps(search(j["root"], j["pattern"], True, j["ext"], j["limit"]), ensure_ascii=False))
