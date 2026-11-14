from PIL import Image

from imaging import parse_color, run_batch


def execute(params):
    flip = params.get("flip")
    if flip not in (None, "horizontal", "vertical", "both"):
        raise ValueError("flip : horizontal, vertical ou both")
    angle = params.get("rotate", 0)
    if not angle and not flip:
        raise ValueError("rotate (degrés, sens horaire) et/ou flip")
    fill, expand = parse_color(params.get("fill", "transparent")), params.get("expand", True)

    def process(im, _src):
        if flip in ("horizontal", "both"):
            im = im.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        if flip in ("vertical", "both"):
            im = im.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
        if angle:
            im = im.rotate(-angle, resample=Image.BICUBIC, expand=expand, fillcolor=fill)  # Pillow : anti-horaire
        return im

    return run_batch(params, process)
