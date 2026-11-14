from common import run_git


def execute(params):
    # git durci (common.run_git) : la config du dépôt ne peut faire lancer aucune commande, même en « lecture ».
    out, cut = run_git(params["repo"], "status", "--porcelain=v1", "-b")
    lines = out.splitlines()
    branch = lines[0][3:] if lines else ""
    files = [{"status": l[:2].strip() or "?", "path": l[3:]} for l in lines[1:]]
    return {"data": {"branch": branch, "clean": not files, "count": len(files), "files": files[:200],
                     "truncated": len(files) > 200 or cut}}
