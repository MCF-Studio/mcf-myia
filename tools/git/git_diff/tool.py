import os
import re

from common import bounded, run_git


def inner_path(repo, rel):
    """Filtre de chemin RELATIF AU DÉPÔT (et non au dossier courant du gestionnaire) : ni absolu, ni « .. », ni
    option, et le chemin réel reste dans le dépôt (un lien qui en sort est refusé)."""
    rel = rel.strip().replace("\\", "/")
    parts = [x for x in rel.split("/") if x]
    if (not parts or rel.startswith(("/", "-", ":")) or re.match(r"^[A-Za-z]:", rel) or ".." in parts
            or "\0" in rel or len(rel) > 400):
        raise ValueError("path : chemin relatif au dépôt attendu (ni absolu, ni « .. », ni option)")
    base = os.path.normcase(os.path.realpath(repo))
    real = os.path.normcase(os.path.realpath(os.path.join(repo, *parts)))
    if real != base and not real.startswith(base.rstrip("\\/") + os.sep):
        raise ValueError("path : sort du dépôt (lien) : refusé")
    return "/".join(parts)


def execute(params):
    repo = params["repo"]
    base = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"] + (["--cached"] if params.get("staged") else [])
    tail = ["--", inner_path(repo, params["path"])] if params.get("path") else ["--"]
    stat, _ = run_git(repo, *base, "--numstat", *tail)
    files = []
    for l in stat.splitlines():
        cols = l.split("\t", 2)
        if len(cols) != 3:
            continue
        a, d, f = cols
        files.append({"file": f, "added": int(a) if a.isdigit() else None, "deleted": int(d) if d.isdigit() else None})
    cap = bounded(params, "max_chars", 20000, 1, 200_000)
    diff, cut = run_git(repo, *base, *tail, max_bytes=4 * cap)
    return {"data": {"files": files[:500], "diff": diff[:cap], "truncated": cut or len(diff) > cap or len(files) > 500}}
