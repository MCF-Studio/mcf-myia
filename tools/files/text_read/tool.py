from pathlib import Path

from common import bounded

MAX_LINES = 2000            # lignes renvoyées par appel
MAX_LINE_CHARS = 2000       # au-delà, la ligne est coupée
MAX_SCAN_BYTES = 50_000_000  # au-delà, la lecture s'arrête (total_lines devient un minimum)


def execute(params):
    p = Path(params["path"])
    if not p.is_file():
        raise FileNotFoundError(f"introuvable : {p}")
    start = bounded(params, "start", 1, 1, 10**9)
    n = bounded(params, "lines", 200, 1, MAX_LINES)
    chunk, total, scanned, complete, warnings = [], 0, 0, True, []
    # Lecture en flux : le fichier n'est jamais chargé en entier, quelle que soit sa taille.
    with open(p, "rb") as fh:
        if b"\0" in fh.read(8000):
            raise ValueError("fichier binaire : lecture texte impossible")
        fh.seek(0)
        for raw in fh:
            scanned += len(raw)
            total += 1
            if start <= total < start + n:
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if len(line) > MAX_LINE_CHARS:
                    line = line[:MAX_LINE_CHARS] + " […ligne coupée]"
                chunk.append(f"{total}\t{line}")
            if scanned > MAX_SCAN_BYTES:
                complete = False
                warnings.append("fichier très gros : lecture arrêtée à 50 Mo, total_lines est un minimum.")
                break
    return {"data": {"path": str(p), "total_lines": total, "total_lines_exact": complete, "start": start,
                     "text": "\n".join(chunk), "truncated": (start - 1 + n < total) or not complete},
            "warnings": warnings}
