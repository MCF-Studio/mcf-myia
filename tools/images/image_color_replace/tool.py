from PIL import Image, ImageChops

from imaging import parse_color, run_batch


def _mask(im, target, tol, feather):
    """Masque L : 255 là où la couleur est à ≤ tol de `target` (écart max par canal), dégradé sur `feather`."""
    dist = None
    for band, t in zip(im.split()[:3], target[:3]):
        d = ImageChops.difference(band, Image.new("L", im.size, t))
        dist = d if dist is None else ImageChops.lighter(dist, d)
    lut = [255 if v <= tol else 0 if (feather <= 0 or v >= tol + feather) else round(255 * (1 - (v - tol) / feather))
           for v in range(256)]
    return dist.point(lut)


def execute(params):
    pairs = []
    if "from" in params or "to" in params:
        if "from" not in params or "to" not in params:
            raise ValueError("'from' et 'to' vont ensemble")
        pairs.append((parse_color(params["from"]), parse_color(params["to"])))
    for a, b in (params.get("mapping") or {}).items():
        pairs.append((parse_color(a), parse_color(b)))
    if not pairs:
        raise ValueError("donner from+to, ou mapping {\"#ancienne\": \"#nouvelle\"}")
    tol, feather = params.get("tolerance", 16), params.get("feather", 0)
    if not 0 <= tol <= 255 or feather < 0:
        raise ValueError("tolerance 0-255, feather >= 0")

    def process(im, _src):
        r, g, b, a = im.split()
        rgb = Image.merge("RGB", (r, g, b))
        for src_c, dst_c in [(s, d) for s, d in pairs]:
            m = _mask(im, src_c, tol, feather)           # calculé sur l'original : pas de chaînage A->B->C
            rgb.paste(Image.new("RGB", im.size, dst_c[:3]), mask=m)
            if dst_c[3] < 255:                            # vers (semi-)transparent : alpha = min(ancien, cible)
                a = ImageChops.darker(a, Image.composite(Image.new("L", im.size, dst_c[3]), a, m))
        return Image.merge("RGBA", (*rgb.split(), a))

    return run_batch(params, process)
