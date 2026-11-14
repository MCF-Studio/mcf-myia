from pathlib import Path

from imaging import open_raw


def _pot(n):
    return n > 0 and n & (n - 1) == 0


def execute(params):
    p = Path(params["path"])
    with open_raw(p) as im:      # mêmes gardes que imaging.py : formats autorisés, taille plafonnée
        w, h = im.size
        return {"data": {"path": str(p), "format": im.format, "mode": im.mode, "bands": list(im.getbands()),
                         "width": w, "height": h,
                         "has_alpha": "A" in im.getbands() or "transparency" in im.info,
                         "power_of_two": _pot(w) and _pot(h), "bytes": p.stat().st_size}}
