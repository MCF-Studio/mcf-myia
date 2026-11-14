import importlib.util
import subprocess
import time
from collections import Counter
from pathlib import Path

# Lecture des messages JSON de cargo : même code que cargo_build (chargé depuis son dossier, sans copie).
_spec = importlib.util.spec_from_file_location("cargo_build_tool", Path(__file__).parent.parent / "cargo_build" / "tool.py")
_build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_build)

MAX = 80


def execute(params):
    root = Path(params["project"])
    if not (root / "Cargo.toml").is_file():
        raise FileNotFoundError(f"pas de Cargo.toml dans {root}")
    timeout = params.get("timeout", 900)
    cmd = ["cargo", "clippy", "--message-format=json"]
    if params.get("all_targets", True):
        cmd.append("--all-targets")
    if params.get("package"):
        cmd += ["-p", _build._safe("package", params["package"])]
    t0 = time.time()
    try:
        r = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=timeout,
                           encoding="utf-8", errors="replace")
    except FileNotFoundError:
        raise RuntimeError("cargo introuvable") from None
    except subprocess.TimeoutExpired:
        return {"data": {"completed": False, "reason": f"délai de {timeout}s dépassé"},
                "warnings": ["Analyse incomplète : ne pas conclure qu'il n'y a pas d'avertissement."]}
    if "no such command: `clippy`" in r.stderr or "clippy" in r.stderr and "is not installed" in r.stderr:
        raise RuntimeError("Clippy n'est pas installé : rustup component add clippy")
    items, _ = _build.parse_messages(r.stdout)
    errors = [i for i in items if i["level"] == "error"]
    by_lint = Counter(i["code"] or "(sans code)" for i in items if i["level"] == "warning")
    data = {"completed": True, "exit_code": r.returncode, "duration_s": round(time.time() - t0, 1),
            "ok": r.returncode == 0 and not items, "error_count": len(errors),
            "warning_count": len(items) - len(errors), "by_lint": dict(by_lint.most_common(30)),
            "items": items[:MAX], "truncated": len(items) > MAX}
    warnings = []
    if r.returncode != 0 and not errors:
        data["stderr_tail"] = r.stderr.strip().splitlines()[-15:]
        warnings.append("Échec hors analyse (dépendances…) : voir stderr_tail.")
    return {"data": data, "warnings": warnings}
