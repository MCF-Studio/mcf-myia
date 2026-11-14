import os
from pathlib import Path

from PIL import Image

from imaging import anchor_xy, check_canvas, open_image, run_batch


def execute(params):
    ov_path = Path(params["overlay"])
    ov = open_image(ov_path)
    scale, opacity = params.get("scale", 20), params.get("opacity", 100)
    if not 0 <= opacity <= 100 or not 0 <= scale <= 1000:
        raise ValueError("opacity 0-100, scale 0-1000 (% de la largeur ; 0 = taille d'origine)")
    margin, position = params.get("margin", 16), params.get("position", "bottom-right")
    anchor_xy(position, (1, 1), (0, 0))  # valide la position avant de traiter
    ov_real = os.path.normcase(os.path.realpath(ov_path))

    def process(im, src):
        if os.path.normcase(os.path.realpath(src)) == ov_real:
            return None  # le logo posé dans le dossier n'est pas traité lui-même
        o = ov
        if scale > 0:
            w = max(1, round(im.width * scale / 100))
            oh = max(1, round(ov.height * w / ov.width))
            check_canvas(w, oh, "logo redimensionné")
            o = ov.resize((w, oh), Image.LANCZOS)
        if opacity < 100:
            o = o.copy()
            o.putalpha(o.getchannel("A").point(lambda v: v * opacity // 100))
        if "x" in params or "y" in params:   # négatif = depuis le bord droit / bas
            x, y = params.get("x", 0), params.get("y", 0)
            x = im.width - o.width + x if x < 0 else x
            y = im.height - o.height + y if y < 0 else y
        else:
            x, y = anchor_xy(position, im.size, o.size, margin)
        layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
        layer.paste(o, (x, y))
        return Image.alpha_composite(im, layer)

    return run_batch(params, process, protect=[ov_path])   # le logo n'est jamais une sortie
