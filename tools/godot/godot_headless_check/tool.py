import re
import subprocess
import time
from pathlib import Path

from common import app_path, resolve_app

LEVEL = re.compile(r"^(SCRIPT ERROR|ERROR|WARNING|USER ERROR|USER WARNING):\s*(.*)$")
MAX = 50


def execute(params):
    root = Path(params["project"])
    if not (root / "project.godot").is_file():
        raise FileNotFoundError(f"pas de project.godot dans {root}")
    exe = app_path(resolve_app("godot")[1])
    if not exe:
        raise FileNotFoundError("Godot introuvable (tools/apps.json)")
    timeout = params.get("timeout", 120)
    t0 = time.time()
    try:
        r = subprocess.run([exe, "--headless", "--path", str(root), "--import", "--quit"],
                           capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return {"data": {"completed": False, "reason": f"délai de {timeout}s dépassé"},
                "warnings": ["Vérification incomplète : ne pas conclure que le projet est sain."]}
    items = []
    for line in (r.stdout + "\n" + r.stderr).splitlines():
        m = LEVEL.match(line.strip())
        if m:
            items.append({"level": "warning" if "WARNING" in m[1] else "error", "message": m[2]})
    errors = [i for i in items if i["level"] == "error"]
    return {"data": {"completed": True, "exit_code": r.returncode, "duration_s": round(time.time() - t0, 1),
                     "ok": r.returncode == 0 and not errors,
                     "error_count": len(errors), "warning_count": len(items) - len(errors),
                     "items": items[:MAX], "truncated": len(items) > MAX}}
