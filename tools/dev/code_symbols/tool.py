import ast
import re
from pathlib import Path

from common import bounded, iter_files

MAX_FILE = 2_000_000

# Langages sans analyseur dans la bibliothèque standard : expressions régulières ligne à ligne (suffisant pour
# repérer les déclarations ; un symbole dans une chaîne multiligne peut être compté à tort).
PATTERNS = {
    ".rs": [
        ("function", re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+|async\s+|unsafe\s+|extern\s+\"[^\"]*\"\s+)*fn\s+([A-Za-z_]\w*)")),
        ("struct", re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)")),
        ("enum", re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)")),
        ("trait", re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)")),
        ("impl", re.compile(r"^\s*impl(?:<[^>]*>)?\s+(.+?)\s*\{?\s*$")),
        ("module", re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)")),
        ("import", re.compile(r"^\s*(?:pub\s+)?use\s+(.+?);")),
    ],
    ".gd": [
        ("class", re.compile(r"^\s*class_name\s+([A-Za-z_]\w*)")),
        ("class", re.compile(r"^\s*class\s+([A-Za-z_]\w*)")),
        ("function", re.compile(r"^\s*(?:static\s+)?func\s+([A-Za-z_]\w*)")),
        ("signal", re.compile(r"^\s*signal\s+([A-Za-z_]\w*)")),
        ("import", re.compile(r"^\s*extends\s+(\S+)")),
    ],
    ".ts": [
        ("class", re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)")),
        ("interface", re.compile(r"^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)")),
        ("type", re.compile(r"^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]")),
        ("function", re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)")),
        ("function", re.compile(r"^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>")),
        ("import", re.compile(r"^\s*import\s+.*?from\s+['\"]([^'\"]+)['\"]")),
    ],
    ".cs": [
        ("class", re.compile(r"^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial)\s+)*(?:class|record)\s+([A-Za-z_]\w*)")),
        ("interface", re.compile(r"^\s*(?:(?:public|private|protected|internal)\s+)*interface\s+([A-Za-z_]\w*)")),
        ("struct", re.compile(r"^\s*(?:(?:public|private|protected|internal|readonly)\s+)*struct\s+([A-Za-z_]\w*)")),
        ("enum", re.compile(r"^\s*(?:(?:public|private|protected|internal)\s+)*enum\s+([A-Za-z_]\w*)")),
        ("method", re.compile(r"^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|abstract|sealed)\s+)+[\w<>\[\],.? ]+\s+([A-Za-z_]\w*)\s*\(")),
        ("import", re.compile(r"^\s*using\s+([\w.]+)\s*;")),
    ],
}
PATTERNS[".tsx"] = PATTERNS[".js"] = PATTERNS[".jsx"] = PATTERNS[".mjs"] = PATTERNS[".ts"]
SUPPORTED = {".py", *PATTERNS}


def _python(text):
    out = []
    try:
        tree = ast.parse(text)
    except SyntaxError as e:
        return [], f"syntaxe Python invalide ligne {e.lineno} : {e.msg}"

    def visit(node, owner=None):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.ClassDef):
                out.append({"kind": "class", "name": child.name, "line": child.lineno})
                visit(child, child.name)
            elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                kind = "method" if owner else "function"
                out.append({"kind": kind, "name": f"{owner}.{child.name}" if owner else child.name, "line": child.lineno})
            elif isinstance(child, ast.Import):
                out.extend({"kind": "import", "name": a.name, "line": child.lineno} for a in child.names)
            elif isinstance(child, ast.ImportFrom):
                out.append({"kind": "import", "name": "." * child.level + (child.module or ""), "line": child.lineno})

    visit(tree)
    return out, None


def _regex(text, patterns):
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith(("//", "#", "/*", "*")):
            continue
        for kind, rx in patterns:
            if m := rx.match(line):
                out.append({"kind": kind, "name": m.group(1).strip()[:120], "line": i})
                break
    return out


def symbols_of(path, text):
    """Symboles d'un fichier (testable sans disque) ; renvoie (symboles, avertissement)."""
    ext = Path(path).suffix.lower()
    if ext == ".py":
        return _python(text)
    return _regex(text, PATTERNS[ext]), None


def execute(params):
    root = Path(params["path"])
    if not root.exists():
        raise FileNotFoundError(f"introuvable : {root}")
    limit = bounded(params, "limit", 300, 1, 1000)
    keep_imports = params.get("imports", False)
    files = [root] if root.is_file() else [p for p in iter_files(root) if p.suffix.lower() in SUPPORTED]
    if root.is_file() and root.suffix.lower() not in SUPPORTED:
        raise ValueError(f"langage non pris en charge : {root.suffix or '(sans extension)'} ({', '.join(sorted(SUPPORTED))})")
    items, warnings, scanned = [], [], 0
    for f in files:
        if f.stat().st_size > MAX_FILE:
            warnings.append(f"ignoré (trop gros) : {f}")
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        scanned += 1
        found, warn = symbols_of(f, text)
        if warn:
            warnings.append(f"{f} : {warn}")
        rel = f.name if root.is_file() else str(f.relative_to(root)).replace("\\", "/")
        for s in found:
            if s["kind"] == "import" and not keep_imports:
                continue
            items.append({"file": rel, **s})
            if len(items) > limit:
                return {"data": {"files_scanned": scanned, "count": limit, "truncated": True, "items": items[:limit]},
                        "warnings": warnings[:20]}
    return {"data": {"files_scanned": scanned, "count": len(items), "truncated": False, "items": items},
            "warnings": warnings[:20]}
