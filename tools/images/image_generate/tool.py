import random

from PIL import Image, ImageChops, ImageDraw

from imaging import check_canvas, parse_color, save_image

KINDS = ("solid", "gradient", "radial", "checker", "stripes", "noise")


def _mask(kind, w, h, p):
    """Masque L (0 = color, 255 = color2)."""
    if kind == "solid":
        return Image.new("L", (w, h), 0)
    if kind == "gradient":
        direction = p.get("direction", "vertical")
        v = Image.linear_gradient("L").resize((w, h), Image.BILINEAR)           # noir en haut -> blanc en bas
        hz = v.transpose(Image.Transpose.ROTATE_90).transpose(Image.Transpose.FLIP_LEFT_RIGHT).resize((w, h))
        if direction == "vertical":
            return v
        if direction == "horizontal":
            return hz
        if direction == "diagonal":
            return ImageChops.add(v, hz, scale=2)
        raise ValueError("direction : vertical, horizontal, diagonal")
    if kind == "radial":
        return Image.radial_gradient("L").resize((w, h), Image.BILINEAR)         # noir au centre -> blanc au bord
    if kind in ("checker", "stripes"):
        n = p.get("cell", 32)
        if n < 1 or (w // n + 1) * (h // n + 1) > 1_000_000:
            raise ValueError("cell >= 1, et un million de cases au plus (agrandir cell)")
        m = Image.new("L", (w, h), 0)
        d = ImageDraw.Draw(m)
        for y in range(0, h, n):
            for x in range(0, w, n):
                on = ((x // n + y // n) % 2 == 1) if kind == "checker" else ((x // n) % 2 == 1)
                if on:
                    d.rectangle((x, y, x + n - 1, y + n - 1), fill=255)
        return m
    if kind == "noise":
        return Image.frombytes("L", (w, h), random.Random(p.get("seed", 0)).randbytes(w * h))
    raise ValueError(f"kind : {', '.join(KINDS)}")


def execute(params):
    w, h, kind = params.get("width", 256), params.get("height", 256), params.get("kind", "solid")
    if not (1 <= w <= 8192 and 1 <= h <= 8192):
        raise ValueError("width/height : 1 à 8192")
    check_canvas(w, h)
    c1, c2 = parse_color(params.get("color", "#808080")), parse_color(params.get("color2", "#ffffff"))
    mask = _mask(kind, w, h, params)
    out = Image.composite(Image.new("RGBA", (w, h), c2), Image.new("RGBA", (w, h), c1), mask)
    size, _ = save_image(out, params["output"], params.get("quality", 90), overwrite=params.get("overwrite", False) is True)
    return {"data": {"output": params["output"], "kind": kind, "width": w, "height": h, "bytes": size}}
