import re
import subprocess
from pathlib import Path

MAX_FILES = 100
MAX_DIFF_LINES = 120
# « Diff in C:\…\src\main.rs:12: » (rustfmt récent) ou « Diff in /…/main.rs at line 12: » (ancien format).
DIFF_HEADER = re.compile(r"^Diff in (.+?)(?::(\d+):| at line (\d+):)\s*$")


def parse_diff(stdout):
    files, diff = {}, []
    for line in stdout.splitlines():
        if m := DIFF_HEADER.match(line):
            f = m.group(1)
            files.setdefault(f, []).append(int(m.group(2) or m.group(3)))
        if len(diff) < MAX_DIFF_LINES:
            diff.append(line)
    return files, diff


def execute(params):
    root = Path(params["project"])
    if not (root / "Cargo.toml").is_file():
        raise FileNotFoundError(f"pas de Cargo.toml dans {root}")
    timeout = params.get("timeout", 120)
    try:
        # --check : rustfmt n'écrit rien, il compare seulement.
        r = subprocess.run(["cargo", "fmt", "--all", "--check"], cwd=root, capture_output=True, text=True,
                           timeout=timeout, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        raise RuntimeError("cargo introuvable") from None
    except subprocess.TimeoutExpired:
        return {"data": {"completed": False, "reason": f"délai de {timeout}s dépassé"},
                "warnings": ["Vérification incomplète."]}
    if "no such command: `fmt`" in r.stderr or "rustfmt" in r.stderr and "is not installed" in r.stderr:
        raise RuntimeError("rustfmt n'est pas installé : rustup component add rustfmt")
    files, diff = parse_diff(r.stdout)
    data = {"completed": True, "exit_code": r.returncode, "formatted": r.returncode == 0,
            "files": [{"file": f, "lines": lines[:20]} for f, lines in list(files.items())[:MAX_FILES]],
            "file_count": len(files), "diff": "\n".join(diff), "truncated": len(files) > MAX_FILES or len(r.stdout.splitlines()) > MAX_DIFF_LINES}
    warnings = []
    if r.returncode != 0 and not files:
        data["stderr_tail"] = r.stderr.strip().splitlines()[-15:]
        warnings.append("rustfmt a échoué sans lister de fichier (erreur de syntaxe ?) : voir stderr_tail.")
    return {"data": data, "warnings": warnings}
