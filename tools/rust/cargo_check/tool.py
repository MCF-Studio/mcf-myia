import json
import subprocess
import time
from pathlib import Path

MAX = 50


def execute(params):
    root = Path(params["project"])
    if not (root / "Cargo.toml").is_file():
        raise FileNotFoundError(f"pas de Cargo.toml dans {root}")
    timeout = params.get("timeout", 600)
    t0 = time.time()
    try:
        r = subprocess.run(["cargo", "check", "--message-format=json"], cwd=root, capture_output=True,
                           text=True, timeout=timeout, encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return {"data": {"completed": False, "reason": f"délai de {timeout}s dépassé"},
                "warnings": ["Vérification incomplète : ne pas conclure que le build est sain."]}
    items = []
    for line in r.stdout.splitlines():
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("reason") != "compiler-message":
            continue
        d = msg["message"]
        if d["level"] not in ("error", "warning"):
            continue
        span = next((s for s in d["spans"] if s.get("is_primary")), None)
        items.append({"level": d["level"], "message": d["message"], "code": (d.get("code") or {}).get("code"),
                      "file": span["file_name"] if span else None, "line": span["line_start"] if span else None})
    errors = [i for i in items if i["level"] == "error"]
    data = {"completed": True, "exit_code": r.returncode, "duration_s": round(time.time() - t0, 1),
            "ok": r.returncode == 0, "error_count": len(errors), "warning_count": len(items) - len(errors),
            "items": items[:MAX], "truncated": len(items) > MAX}
    if r.returncode != 0 and not errors:  # échec hors compilation (ex. résolution des dépendances)
        data["stderr_tail"] = r.stderr.strip().splitlines()[-15:]
    return {"data": data}
