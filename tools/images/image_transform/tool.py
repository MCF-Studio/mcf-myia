import math

from PIL import Image

from common import check_range
from imaging import check_canvas, parse_color, run_batch


def execute(params):
    flip = params.get("flip")
    if flip not in (None, "horizontal", "vertical", "both"):
        raise ValueError("flip : horizontal, vertical ou both")
    angle = check_range("rotate", params.get("rotate", 0), -36000, 36000)
    if not angle and not flip:
        raise ValueError("rotate (degrés, sens horaire) et/ou flip")
    fill, expand = parse_color(params.get("fill", "transparent")), params.get("expand", True)

    def process(im, _src):
        if flip in ("horizontal", "both"):
            im = im.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        if flip in ("vertical", "both"):
            im = im.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
        if angle and expand:   # taille après rotation contrôlée avant d'allouer
            c, s = abs(math.cos(math.radians(angle))), abs(math.sin(math.radians(angle)))
            check_canvas(math.ceil(im.width * c + im.height * s), math.ceil(im.width * s + im.height * c), "image tournée")
        if angle:
            im = im.rotate(-angle, resample=Image.BICUBIC, expand=expand, fillcolor=fill)  # Pillow : anti-horaire
        return im

    return run_batch(params, process)
