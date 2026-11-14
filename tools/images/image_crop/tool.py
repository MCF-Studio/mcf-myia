from PIL import Image, ImageChops

from imaging import run_batch


def _trim_box(im, tol):
    """Rectangle du contenu : par l'alpha s'il y a de la transparence, sinon écart à la couleur du coin haut-gauche."""
    a = im.getchannel("A")
    if a.getextrema()[0] < 255:
        return a.point(lambda v: 255 if v > tol else 0).getbbox()
    diff = ImageChops.difference(im.convert("RGB"), Image.new("RGB", im.size, im.getpixel((0, 0))[:3]))
    mask = diff.convert("L").point(lambda v: 255 if v > tol else 0)
    return mask.getbbox()


def _ratio(text):
    try:
        a, b = (float(x) for x in text.split(":"))
        assert a > 0 and b > 0
        return a / b
    except Exception:
        raise ValueError("ratio : 'largeur:hauteur', ex. 16:9 ou 1:1")


def execute(params):
    modes = [bool(params.get("trim")), "ratio" in params, any(k in params for k in ("x", "y", "width", "height"))]
    if sum(modes) != 1:
        raise ValueError("un seul mode : trim, ratio, ou rectangle (x, y, width, height)")
    tol, pad = params.get("tolerance", 8), params.get("padding", 0)
    if not -16384 <= pad <= 16384:
        raise ValueError("padding : -16384 à 16384")

    def process(im, _src):
        W, H = im.size
        if params.get("trim"):
            box = _trim_box(im, tol)
            if box is None:
                raise ValueError("image entièrement vide/uniforme : rien à rogner")
            l, t, r, b = box
            box = (max(0, l - pad), max(0, t - pad), min(W, r + pad), min(H, b + pad))
        elif "ratio" in params:
            ratio = _ratio(params["ratio"])
            w, h = (round(H * ratio), H) if W / H > ratio else (W, round(W / ratio))
            x0, y0 = (W - w) // 2, (H - h) // 2
            box = (x0, y0, x0 + w, y0 + h)
        else:
            x, y = params.get("x", 0), params.get("y", 0)
            w, h = params.get("width", W - x), params.get("height", H - y)
            box = (x, y, x + w, y + h)
            if x < 0 or y < 0 or w < 1 or h < 1 or box[2] > W or box[3] > H:
                raise ValueError(f"rectangle {box} hors de l'image {W}x{H}")
        return im.crop(box)

    return run_batch(params, process)
