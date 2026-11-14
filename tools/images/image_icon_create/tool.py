"""Icônes simples dessinées en vectoriel (sur-échantillonnage x4 pour des bords lisses)."""
import math

from PIL import Image, ImageDraw

from common import check_range
from imaging import load_font, parse_color, save_image

SS = 4
T = Image.Transpose
SHAPES = ("circle", "square", "rounded", "squircle", "hexagon", "diamond", "triangle", "none")
# symboles qui se dérivent d'un autre par symétrie / rotation
DERIVED = {"arrow_left": ("arrow_right", T.FLIP_LEFT_RIGHT), "arrow_up": ("arrow_right", T.ROTATE_90),
           "arrow_down": ("arrow_right", T.ROTATE_270), "upload": ("download", T.FLIP_TOP_BOTTOM)}


def _thick(d, pts, w):
    d.line(pts, fill=255, width=w, joint="curve")
    for x, y in pts:
        d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=255)


def _draw_symbol(name, d, n, sw):
    """Dessine `name` en blanc (255) sur un masque n x n ; coordonnées unitaires 0..1."""
    P = lambda *pts: [(x * n, y * n) for x, y in pts]       # noqa: E731
    w = max(2, round(sw * n))
    box = lambda x0, y0, x1, y1: (x0 * n, y0 * n, x1 * n, y1 * n)   # noqa: E731
    if name == "play":
        d.polygon(P((.36, .26), (.36, .74), (.76, .5)), fill=255)
    elif name == "pause":
        d.rounded_rectangle(box(.31, .26, .45, .74), radius=n * .02, fill=255)
        d.rounded_rectangle(box(.55, .26, .69, .74), radius=n * .02, fill=255)
    elif name == "stop":
        d.rounded_rectangle(box(.3, .3, .7, .7), radius=n * .03, fill=255)
    elif name == "check":
        _thick(d, P((.27, .52), (.43, .68), (.74, .34)), w)
    elif name == "cross":
        _thick(d, P((.3, .3), (.7, .7)), w)
        _thick(d, P((.7, .3), (.3, .7)), w)
    elif name == "plus":
        _thick(d, P((.5, .27), (.5, .73)), w)
        _thick(d, P((.27, .5), (.73, .5)), w)
    elif name == "minus":
        _thick(d, P((.27, .5), (.73, .5)), w)
    elif name == "arrow_right":
        _thick(d, P((.25, .5), (.72, .5)), w)
        _thick(d, P((.5, .26), (.74, .5), (.5, .74)), w)
    elif name == "download":
        _thick(d, P((.5, .22), (.5, .58)), w)
        _thick(d, P((.3, .42), (.5, .62), (.7, .42)), w)
        _thick(d, P((.27, .77), (.73, .77)), w)
    elif name == "menu":
        for y in (.3, .5, .7):
            _thick(d, P((.27, y), (.73, y)), w)
    elif name == "search":
        d.ellipse(box(.25, .25, .65, .65), outline=255, width=w)
        _thick(d, P((.6, .6), (.77, .77)), w)
    elif name == "home":
        d.polygon(P((.2, .5), (.5, .22), (.8, .5)), fill=255)
        d.rectangle(box(.29, .48, .71, .76), fill=255)
        d.rectangle(box(.45, .56, .55, .76), fill=0)
    elif name == "user":
        d.ellipse(box(.37, .2, .63, .46), fill=255)
        d.pieslice(box(.24, .52, .76, 1.04), 180, 360, fill=255)
    elif name == "heart":
        pts = []
        for i in range(120):
            t = 2 * math.pi * i / 120
            x = 16 * math.sin(t) ** 3
            y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
            pts.append((.5 + x / 16 * .27, .5 - (y + 2.5) / 29 * .54))
        d.polygon(P(*pts), fill=255)
    elif name == "star":
        pts = [(.5 + (.32 if i % 2 == 0 else .13) * math.sin(math.pi * i / 5),
                .53 - (.32 if i % 2 == 0 else .13) * math.cos(math.pi * i / 5)) for i in range(10)]
        d.polygon(P(*pts), fill=255)
    elif name == "bolt":
        d.polygon(P((.56, .18), (.31, .55), (.47, .55), (.42, .82), (.69, .43), (.53, .43)), fill=255)
    elif name == "gear":
        pts = []
        for i in range(8):
            a0 = i * math.tau / 8
            for da, r in ((-.3, .24), (-.15, .33), (.15, .33), (.3, .24)):
                pts.append((.5 + r * math.cos(a0 + da), .5 + r * math.sin(a0 + da)))
        d.polygon(P(*pts), fill=255)
        d.ellipse(box(.4, .4, .6, .6), fill=0)
    elif name == "folder":
        d.rounded_rectangle(box(.2, .28, .46, .42), radius=n * .02, fill=255)
        d.rounded_rectangle(box(.2, .36, .8, .72), radius=n * .03, fill=255)
    elif name == "mail":
        d.rounded_rectangle(box(.2, .3, .8, .7), radius=n * .03, outline=255, width=w)
        _thick(d, P((.24, .35), (.5, .55), (.76, .35)), max(2, w * 2 // 3))
    elif name == "lock":
        d.arc(box(.36, .2, .64, .6), 180, 360, fill=255, width=w)
        d.rounded_rectangle(box(.29, .46, .71, .78), radius=n * .04, fill=255)
    elif name == "dot":
        d.ellipse(box(.37, .37, .63, .63), fill=255)
    elif name == "ring":
        d.ellipse(box(.25, .25, .75, .75), outline=255, width=w)
    else:
        raise ValueError(f"symbole inconnu : {name!r} (voir la liste dans la description de l'outil)")


SYMBOLS = ("play", "pause", "stop", "check", "cross", "plus", "minus", "arrow_right", "arrow_left", "arrow_up",
           "arrow_down", "download", "upload", "menu", "search", "home", "user", "heart", "star", "bolt", "gear",
           "folder", "mail", "lock", "dot", "ring")


def _shape(kind, n, inset):
    """Masque L de la forme de fond, rentrée de `inset` px (n = taille sur-échantillonnée)."""
    m = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(m)
    lo, hi = inset, n - 1 - inset
    c, r = n / 2, (hi - lo) / 2
    if kind == "circle":
        d.ellipse((lo, lo, hi, hi), fill=255)
    elif kind == "square":
        d.rectangle((lo, lo, hi, hi), fill=255)
    elif kind in ("rounded", "squircle"):
        d.rounded_rectangle((lo, lo, hi, hi), radius=r * (.42 if kind == "rounded" else .7), fill=255)
    elif kind == "hexagon":
        d.polygon([(c + r * math.cos(math.pi / 3 * i + math.pi / 6), c + r * math.sin(math.pi / 3 * i + math.pi / 6))
                   for i in range(6)], fill=255)
    elif kind == "diamond":
        d.polygon([(c, lo), (hi, c), (c, hi), (lo, c)], fill=255)
    elif kind == "triangle":
        d.polygon([(c, lo), (hi, hi), (lo, hi)], fill=255)
    elif kind != "none":
        raise ValueError(f"shape : {', '.join(SHAPES)}")
    return m


def _fill(n, c1, c2):
    if c2 is None:
        return Image.new("RGBA", (n, n), c1)
    g = Image.linear_gradient("L").resize((n, n), Image.BILINEAR)
    return Image.composite(Image.new("RGBA", (n, n), c2), Image.new("RGBA", (n, n), c1), g)


def execute(params):
    size, shape = params.get("size", 256), params.get("shape", "rounded")
    symbol, text = params.get("symbol"), params.get("text")
    if not 16 <= size <= 1024:
        raise ValueError("size : 16 à 1024")
    if not symbol and not text and shape == "none":
        raise ValueError("rien à dessiner : donner shape, symbol et/ou text")
    if symbol and symbol not in SYMBOLS:
        raise ValueError(f"symbole inconnu : {symbol!r} ({', '.join(SYMBOLS)})")
    if text and len(text) > 4:
        raise ValueError("text : 4 caractères maximum (initiales, chiffre…)")
    check_range("border_width", params.get("border_width", 0), 0, 256)
    check_range("glyph_scale", params.get("glyph_scale", 1.0), 0.05, 2)
    check_range("stroke", params.get("stroke", .09), 0.01, 0.5)
    n = size * SS
    bg, bg2 = parse_color(params.get("background", "#3b82f6")), params.get("background2")
    fg, bwidth = parse_color(params.get("color", "#ffffff")), round(params.get("border_width", 0) * SS)
    out = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    inset = round(n * .03)
    if bwidth:
        out.paste(Image.new("RGBA", (n, n), parse_color(params.get("border_color", "#ffffff"))),
                  mask=_shape(shape, n, inset))
    out.paste(_fill(n, bg, parse_color(bg2) if bg2 else None), mask=_shape(shape, n, inset + bwidth))
    glyph = Image.new("L", (n, n), 0)
    if symbol:
        base, tr = DERIVED.get(symbol, (symbol, None))
        _draw_symbol(base, ImageDraw.Draw(glyph), n, params.get("stroke", .09))
        if tr is not None:
            glyph = glyph.transpose(tr)
    if text:
        fsize = int(n * .5)
        while True:
            font = load_font(fsize, params.get("font"))
            l, t, r, b = ImageDraw.Draw(glyph).textbbox((0, 0), text, font=font)
            if r - l <= n * .62 or fsize < 12:
                break
            fsize = int(fsize * .92)
        ImageDraw.Draw(glyph).text((n / 2 - (l + r) / 2, n / 2 - (t + b) / 2), text, font=font, fill=255)
    gs = params.get("glyph_scale", 1.0)
    if gs != 1.0:
        k = max(1, round(n * gs))
        scaled = glyph.resize((k, k), Image.LANCZOS)
        glyph = Image.new("L", (n, n), 0)
        glyph.paste(scaled, ((n - k) // 2, (n - k) // 2))
    out.paste(Image.new("RGBA", (n, n), fg), mask=glyph)
    out = out.resize((size, size), Image.LANCZOS)
    nbytes, _ = save_image(out, params["output"], params.get("quality", 90), overwrite=params.get("overwrite", False) is True)
    return {"data": {"output": params["output"], "size": size, "shape": shape, "symbol": symbol, "text": text,
                     "bytes": nbytes}}
