from pathlib import Path

from PIL import Image

from imaging import IMG_EXTS, MAX_SIDE, check_canvas, guard_output, open_raw

OUT_EXTS = IMG_EXTS | {".tga"}


def execute(params):
    src, dst = Path(params["path"]), Path(params["output"])
    if dst.suffix.lower() not in OUT_EXTS:
        raise ValueError(f"extension de sortie non gérée : '{dst.suffix}' ({', '.join(sorted(OUT_EXTS))})")
    w, h = params.get("width"), params.get("height")
    if not w and not h:
        raise ValueError("width et/ou height requis")
    if any(v is not None and not 1 <= v <= MAX_SIDE for v in (w, h)):
        raise ValueError(f"dimensions entre 1 et {MAX_SIDE}")
    guard_output(dst, params.get("overwrite", False) is True, [src])   # jamais la source, jamais un fichier existant
    with open_raw(src) as im:      # mêmes gardes que imaging.py : formats autorisés, taille plafonnée
        ow, oh = im.size
        w = w or max(1, round(ow * h / oh))
        h = h or max(1, round(oh * w / ow))
        check_canvas(w, h)
        dst.parent.mkdir(parents=True, exist_ok=True)
        im.resize((w, h), Image.LANCZOS).save(dst)
    return {"data": {"output": str(dst), "from": [ow, oh], "to": [w, h], "bytes": dst.stat().st_size}}
