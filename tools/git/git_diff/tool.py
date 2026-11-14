import subprocess
from pathlib import Path


def git(repo, *args):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=60,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f"git a échoué ({r.returncode})")
    return r.stdout


def execute(params):
    base = ["diff"] + (["--cached"] if params.get("staged") else [])
    tail = ["--", params["path"]] if params.get("path") else []
    stat = git(params["repo"], *base, "--numstat", *tail)
    files = []
    for l in stat.splitlines():
        a, d, f = l.split("\t", 2)
        files.append({"file": f, "added": None if a == "-" else int(a), "deleted": None if d == "-" else int(d)})
    diff = git(params["repo"], *base, *tail)
    cap = params.get("max_chars", 20000)
    return {"data": {"files": files, "diff": diff[:cap], "truncated": len(diff) > cap}}
