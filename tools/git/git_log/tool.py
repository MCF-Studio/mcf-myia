import subprocess
from pathlib import Path


def git(repo, *args):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=60,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f"git a échoué ({r.returncode})")
    return r.stdout


def execute(params):
    n = min(max(1, params.get("count", 10)), 100)
    out = git(params["repo"], "log", f"-{n}", "--pretty=format:%h%x1f%an%x1f%ad%x1f%s", "--date=short")
    items = [dict(zip(("hash", "author", "date", "subject"), l.split("\x1f"))) for l in out.splitlines()]
    return {"data": {"count": len(items), "commits": items}}
