from pathlib import Path

from common import bounded, iter_files


def execute(params):
    root = Path(params["directory"])
    q = params.get("query", "").lower()
    ext = params.get("extension", "").lower()
    limit = bounded(params, "limit", 100, 1, 1000)
    hits = []
    for p in iter_files(root):
        if (not q or q in p.name.lower()) and (not ext or p.suffix.lower() == ext.lower()):
            hits.append(str(p))
            if len(hits) > limit:
                break
    return {"data": {"count": min(len(hits), limit), "truncated": len(hits) > limit, "items": hits[:limit]}}
