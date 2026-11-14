import subprocess
from pathlib import Path


def git(repo, *args):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=60,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f"git a échoué ({r.returncode})")
    return r.stdout


def execute(params):
    out = git(params["repo"], "status", "--porcelain=v1", "-b")
    lines = out.splitlines()
    branch = lines[0][3:] if lines else ""
    files = [{"status": l[:2].strip() or "?", "path": l[3:]} for l in lines[1:]]
    return {"data": {"branch": branch, "clean": not files, "count": len(files), "files": files[:200],
                     "truncated": len(files) > 200}}
