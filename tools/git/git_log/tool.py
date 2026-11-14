from common import bounded, run_git


def execute(params):
    n = bounded(params, "count", 10, 1, 100)
    out, _ = run_git(params["repo"], "log", f"-{n}", "--no-ext-diff", "--pretty=format:%h%x1f%an%x1f%ad%x1f%s",
                     "--date=short")
    items = [dict(zip(("hash", "author", "date", "subject"), l.split("\x1f"))) for l in out.splitlines()]
    return {"data": {"count": len(items), "commits": items}}
