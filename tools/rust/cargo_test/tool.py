import json
import re
import subprocess
import time
from pathlib import Path

from common import bounded

MAX_TESTS = 200
MAX_FAILURE_LINES = 40
# Noms de crate ou de test : jamais une option (« --… ») glissée dans un paramètre.
SAFE = re.compile(r"^[A-Za-z0-9_:.\-]{1,200}$")
TEST_LINE = re.compile(r"^test (\S+) \.\.\. (ok|FAILED|ignored)\b")
RESULT_LINE = re.compile(r"^test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored")
FAIL_HEADER = re.compile(r"^---- (\S+) stdout ----$")
STATUS = {"ok": "ok", "FAILED": "failed", "ignored": "ignored"}


def _safe(name, value):
    if not SAFE.match(value) or value.startswith("-"):
        raise ValueError(f"{name} invalide : {value!r}")
    return value


def _compile_errors(stdout):
    """Erreurs de compilation (messages JSON de cargo, mêlés à la sortie texte des tests sur stdout)."""
    errors = []
    for line in stdout.splitlines():
        if not line.startswith("{"):
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("reason") != "compiler-message" or msg["message"]["level"] != "error":
            continue
        d = msg["message"]
        span = next((s for s in d["spans"] if s.get("is_primary")), None)
        errors.append({"message": d["message"], "file": span["file_name"] if span else None,
                       "line": span["line_start"] if span else None})
    return errors


def parse_tests(lines):
    """Résultats de libtest : tests, sorties des échecs, totaux (testé sans cargo)."""
    tests, failures, current = [], {}, None
    totals = {"passed": 0, "failed": 0, "ignored": 0}
    for line in lines:
        if m := TEST_LINE.match(line):
            tests.append({"name": m.group(1), "status": STATUS[m.group(2)]})
        elif m := RESULT_LINE.match(line):
            for k, i in (("passed", 2), ("failed", 3), ("ignored", 4)):
                totals[k] += int(m.group(i))
        if m := FAIL_HEADER.match(line):
            current = m.group(1)
            failures[current] = []
        elif current and (line.startswith("failures:") or RESULT_LINE.match(line)):
            current = None
        elif current and len(failures[current]) < MAX_FAILURE_LINES:
            failures[current].append(line)
    return tests, failures, totals


def execute(params):
    root = Path(params["project"])
    if not (root / "Cargo.toml").is_file():
        raise FileNotFoundError(f"pas de Cargo.toml dans {root}")
    timeout = bounded(params, "timeout", 900, 1, 1800)
    cmd = ["cargo", "test", "--no-fail-fast", "--message-format=json"]
    if params.get("package"):
        cmd += ["-p", _safe("package", params["package"])]
    cmd += ["--"]
    if params.get("filter"):
        cmd += [_safe("filter", params["filter"])]
    t0 = time.time()
    try:
        r = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=timeout,
                           encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return {"data": {"completed": False, "reason": f"délai de {timeout}s dépassé"},
                "warnings": ["Tests incomplets : ne pas conclure qu'ils passent."]}

    tests, failures, totals = parse_tests(r.stdout.splitlines())
    compile_errors = _compile_errors(r.stdout)
    data = {
        "completed": True,
        "exit_code": r.returncode,
        "duration_s": round(time.time() - t0, 1),
        "ok": r.returncode == 0 and totals["failed"] == 0 and not compile_errors,
        "totals": totals,
        "compile_errors": compile_errors[:30],
        "failed": [{"name": n, "output": "\n".join(o).strip()} for n, o in failures.items()][:30],
        "tests": tests[:MAX_TESTS],
        "truncated": len(tests) > MAX_TESTS,
    }
    warnings = []
    if r.returncode != 0 and not compile_errors and totals["failed"] == 0:
        data["stderr_tail"] = r.stderr.strip().splitlines()[-15:]
        warnings.append("Échec hors tests (dépendances, édition de liens…) : voir stderr_tail.")
    if not tests and not compile_errors and r.returncode == 0:
        warnings.append("Aucun test exécuté : vérifier le filtre ou le projet.")
    return {"data": data, "warnings": warnings}
