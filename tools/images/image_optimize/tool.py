from PIL import Image, ImageOps

from imaging import run_batch

FORMATS = ("png", "jpg", "webp")


def execute(params):
    fmt, side = params.get("format"), params.get("max_side")
    if fmt not in (None,) + FORMATS:
        raise ValueError(f"format : {', '.join(FORMATS)}")
    if side is not None and not 16 <= side <= 16384:
        raise ValueError("max_side : 16 à 16384")
    colors = params.get("png_colors")
    if colors is not None and not 2 <= colors <= 256:
        raise ValueError("png_colors : 2 à 256")

    def process(im, _src):
        if side and max(im.size) > side:
            im = ImageOps.contain(im, (side, side), Image.LANCZOS)
        return im

    res = run_batch(params, process, force_ext=fmt)
    d = res["data"]
    d["saved_bytes"] = d["bytes_in"] - d["bytes_out"]
    d["saved_percent"] = round(100 * d["saved_bytes"] / d["bytes_in"], 1) if d["bytes_in"] else 0
    if d["saved_bytes"] < 0:
        res["warnings"].append("les fichiers produits sont plus gros que les sources (autre format ou qualité ?)")
    return res
