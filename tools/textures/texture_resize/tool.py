from pathlib import Path

from PIL import Image


def execute(params):
    src, dst = Path(params["path"]), Path(params["output"])
    if src.resolve() == dst.resolve():
        raise ValueError("output doit être différent de la source")
    w, h = params.get("width"), params.get("height")
    if not w and not h:
        raise ValueError("width et/ou height requis")
    if (w is not None and w < 1) or (h is not None and h < 1):
        raise ValueError("dimensions > 0 requises")
    with Image.open(src) as im:
        ow, oh = im.size
        w = w or max(1, round(ow * h / oh))
        h = h or max(1, round(oh * w / ow))
        dst.parent.mkdir(parents=True, exist_ok=True)
        im.resize((w, h), Image.LANCZOS).save(dst)
    return {"data": {"output": str(dst), "from": [ow, oh], "to": [w, h], "bytes": dst.stat().st_size}}
