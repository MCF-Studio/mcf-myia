import ast
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

MAX_FILE = 5_000_000
PAIRS = {")": "(", "]": "[", "}": "{"}


def _python(text):
    try:
        ast.parse(text)
        return []
    except SyntaxError as e:
        return [{"line": e.lineno, "column": e.offset, "message": e.msg}]


def _json(text):
    try:
        json.loads(text)
        return []
    except json.JSONDecodeError as e:
        return [{"line": e.lineno, "column": e.colno, "message": e.msg}]


def _xml(text):
    # Déclarations d'entités refusées avant analyse : ni entité externe (XXE) ni expansion en chaîne (billion laughs).
    if re.search(r"<!ENTITY", text, re.I):
        return [{"line": None, "column": None, "message": "déclaration d'entité (<!ENTITY>) refusée : non analysé par sécurité"}]
    try:
        ET.fromstring(text)
        return []
    except ET.ParseError as e:
        line, col = e.position
        return [{"line": line, "column": col + 1, "message": str(e).split(":")[0]}]


def _toml(text):
    try:
        import tomllib  # Python 3.11+
    except ImportError:
        return None
    try:
        tomllib.loads(text)
        return []
    except tomllib.TOMLDecodeError as e:
        m = re.search(r"line (\d+), column (\d+)", str(e))
        return [{"line": int(m.group(1)) if m else None, "column": int(m.group(2)) if m else None, "message": str(e)}]


def _brackets(text, comment="#"):
    """Parenthèses, crochets, accolades et chaînes équilibrés (hors commentaires). Contrôle partiel."""
    errors, stack = [], []
    for n, line in enumerate(text.splitlines(), 1):
        quote = None
        i = 0
        while i < len(line):
            c = line[i]
            if quote:
                if c == "\\":
                    i += 2
                    continue
                if c == quote:
                    quote = None
            elif c in "\"'":
                quote = c
            elif line.startswith(comment, i):
                break
            elif c in "([{":
                stack.append((c, n, i + 1))
            elif c in PAIRS:
                if not stack or stack[-1][0] != PAIRS[c]:
                    errors.append({"line": n, "column": i + 1, "message": f"« {c} » sans ouverture correspondante"})
                else:
                    stack.pop()
            i += 1
        if quote:
            errors.append({"line": n, "column": None, "message": "chaîne non fermée"})
    errors += [{"line": ln, "column": col, "message": f"« {c} » jamais fermé"} for c, ln, col in stack[:5]]
    return errors[:20]


def _gdscript(text):
    errors = _brackets(text)
    indents = {("\t" if l.startswith("\t") else "space") for l in text.splitlines() if l[:1] in ("\t", " ") and l.strip()}
    if len(indents) > 1:
        errors.append({"line": None, "column": None, "message": "indentation mélangée (tabulations et espaces)"})
    return errors


SECTION = re.compile(r"^\[(gd_scene|gd_resource|ext_resource|sub_resource|node|connection|editable|resource)(\s+[\w/]+=(\"[^\"]*\"|[^\s\]]+))*\s*\]$")


def _godot_text(text):
    """Scène / ressource Godot (.tscn/.tres) : en-tête et sections bien formés, valeurs équilibrées."""
    lines = text.splitlines()
    errors = []
    first = next((l for l in lines if l.strip()), "")
    if not first.startswith(("[gd_scene", "[gd_resource")):
        errors.append({"line": 1, "column": 1, "message": "en-tête [gd_scene …] ou [gd_resource …] attendu"})
    for n, line in enumerate(lines, 1):
        s = line.strip()
        if s.startswith("[") and s.endswith("]") and not SECTION.match(s):
            errors.append({"line": n, "column": 1, "message": f"section mal formée : {s[:80]}"})
    return (errors + _brackets(text, comment=";"))[:20]


CHECKERS = {
    ".py": ("python", _python, True),
    ".json": ("json", _json, True),
    ".xml": ("xml", _xml, True),
    ".svg": ("xml", _xml, True),
    ".toml": ("toml", _toml, True),
    ".gd": ("gdscript", _gdscript, False),
    ".tscn": ("godot", _godot_text, False),
    ".tres": ("godot", _godot_text, False),
}


def check_text(ext, text):
    """(langage, erreurs, complet) ; erreurs = None si le contrôle n'est pas disponible ici."""
    lang, fn, complete = CHECKERS[ext]
    return lang, fn(text), complete


def execute(params):
    path = Path(params["file"])
    if not path.is_file():
        raise FileNotFoundError(f"introuvable : {path}")
    ext = path.suffix.lower()
    if ext not in CHECKERS:
        raise ValueError(f"format non pris en charge : {ext or '(sans extension)'} ({', '.join(sorted(CHECKERS))})")
    if path.stat().st_size > MAX_FILE:
        raise ValueError("fichier trop gros (5 Mo au plus)")
    text = path.read_text(encoding="utf-8-sig", errors="strict")
    lang, errors, complete = check_text(ext, text)
    if errors is None:
        return {"data": {"language": lang, "checked": False},
                "warnings": ["TOML : nécessite Python 3.11 (tomllib) ; non vérifié."]}
    warnings = [] if complete else [
        f"{lang} : contrôle partiel (structure, parenthèses, chaînes) ; seul Godot valide entièrement "
        "(voir l'outil godot_headless_check)."]
    return {"data": {"language": lang, "checked": True, "complete": complete, "ok": not errors, "errors": errors},
            "warnings": warnings}
