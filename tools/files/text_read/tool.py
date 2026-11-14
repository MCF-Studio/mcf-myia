from pathlib import Path


def execute(params):
    p = Path(params["path"])
    start, n = max(1, params.get("start", 1)), params.get("lines", 200)
    all_lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    chunk = all_lines[start - 1:start - 1 + n]
    return {"data": {"path": str(p), "total_lines": len(all_lines), "start": start,
                     "text": "\n".join(f"{start + i}\t{l}" for i, l in enumerate(chunk)),
                     "truncated": start - 1 + n < len(all_lines)}}
