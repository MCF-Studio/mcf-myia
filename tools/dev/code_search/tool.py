import re
from pathlib import Path

from common import iter_files


def execute(params):
    root = Path(params["directory"])
    pat = params["pattern"]
    rx = re.compile(pat if params.get("regex") else re.escape(pat))
    ext, limit = params.get("extension", "").lower(), params.get("limit", 100)
    hits = []
    for p in iter_files(root):
        if (ext and p.suffix.lower() != ext) or p.stat().st_size > 2_000_000:
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # binaire ou illisible
        for i, line in enumerate(text.splitlines(), 1):
            if rx.search(line):
                hits.append({"file": str(p.relative_to(root)).replace("\\", "/"), "line": i, "text": line.strip()[:200]})
                if len(hits) > limit:
                    return {"data": {"count": limit, "truncated": True, "items": hits[:limit]}}
    return {"data": {"count": len(hits), "truncated": False, "items": hits}}
