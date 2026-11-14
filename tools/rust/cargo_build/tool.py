import json
import re
import subprocess
import time
from pathlib import Path

from common import bounded

MAX = 50
# Nom de crate ou de binaire : jamais une option glissée dans un paramètre.
SAFE = re.compile(r"^[A-Za-z0-9_\-]{1,100}$")


def _safe(name, value):
    if not SAFE.match(value) or value.startswith("-"):
        raise ValueError(f"{name} invalide : {value!r}")
    return value


def parse_messages(stdout):
    """Diagnostics (erreurs, avertissements) et exécutables produits, depuis --message-format=json."""
    items, executables = [], []
    for line in stdout.splitlines():
        if not line.startswith("{"):
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("reason") == "compiler-artifact" and msg.get("executable"):
            executables.append(msg["executable"])
        if msg.get("reason") != "compiler-message":
            continue
        d = msg["message"]
        if d["level"] not in ("error", "warning"):
            continue
        span = next((s for s in d["spans"] if s.get("is_primary")), None)
        items.append({"level": d["level"], "message": d["message"], "code": (d.get("code") or {}).get("code"),
                      "file": span["file_name"] if span else None, "line": span["line_start"] if span else None})
    return items, executables


def execute(params):
    root = Path(params["project"])
    if not (root / "Cargo.toml").is_file():
        raise FileNotFoundError(f"pas de Cargo.toml dans {root}")
    profile = params.get("profile", "debug")
    if profile not in ("debug", "release"):
        raise ValueError("profile : debug ou release")
    timeout = bounded(params, "timeout", 1800, 1, 3600)
    cmd = ["cargo", "build", "--message-format=json"]
    if profile == "release":
        cmd.append("--release")
    if params.get("package"):
        cmd += ["-p", _safe("package", params["package"])]
    if params.get("bin"):
        cmd += ["--bin", _safe("bin", params["bin"])]
    t0 = time.time()
    try:
        r = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=timeout,
                           encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return {"data": {"completed": False, "profile": profile, "reason": f"délai de {timeout}s dépassé"},
                "warnings": ["Build incomplet : ne pas conclure qu'il a réussi."]}
    items, executables = parse_messages(r.stdout)
    errors = [i for i in items if i["level"] == "error"]
    data = {"completed": True, "profile": profile, "exit_code": r.returncode, "ok": r.returncode == 0,
            "duration_s": round(time.time() - t0, 1), "executables": executables,
            "error_count": len(errors), "warning_count": len(items) - len(errors),
            "items": items[:MAX], "truncated": len(items) > MAX}
    warnings = []
    if r.returncode != 0 and not errors:
        data["stderr_tail"] = r.stderr.strip().splitlines()[-15:]
        warnings.append("Échec hors compilation (dépendances, édition de liens…) : voir stderr_tail.")
    return {"data": data, "warnings": warnings}
