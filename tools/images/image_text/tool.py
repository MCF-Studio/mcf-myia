from PIL import Image, ImageDraw

from imaging import anchor_xy, check_canvas, load_font, parse_color, run_batch


def execute(params):
    text = params["text"]
    if not text.strip() or len(text) > 500:
        raise ValueError("text : 1 à 500 caractères (\\n = retour à la ligne)")
    pct, px = params.get("size_pct", 5), params.get("size")
    color, stroke = parse_color(params.get("color", "#ffffff")), parse_color(params.get("stroke_color", "#000000"))
    stroke_w, margin = params.get("stroke_width", 0), params.get("margin", 16)
    box = parse_color(params["background"]) if "background" in params else None
    opacity, position = params.get("opacity", 100), params.get("position", "bottom-right")
    if not 0 <= opacity <= 100 or not 0 < pct <= 100:
        raise ValueError("opacity 0-100, size_pct > 0 et <= 100")
    if (px is not None and not 1 <= px <= 4096) or not 0 <= stroke_w <= 256:
        raise ValueError("size : 1 à 4096 px, stroke_width : 0 à 256")
    anchor_xy(position, (1, 1), (0, 0))

    def process(im, _src):
        font = load_font(px or max(8, im.width * pct / 100), params.get("font"))
        probe = ImageDraw.Draw(Image.new("L", (1, 1)))
        l, t, r, b = probe.multiline_textbbox((0, 0), text, font=font, stroke_width=stroke_w,
                                              align=params.get("align", "left"))
        pad = round(font.size * .3) if box else 0
        w, h = r - l + 2 * pad, b - t + 2 * pad
        check_canvas(w, h, "bloc de texte")
        layer = Image.new("RGBA", (w, h), box or (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        d.multiline_text((pad - l, pad - t), text, font=font, fill=color, stroke_width=stroke_w,
                         stroke_fill=stroke, align=params.get("align", "left"))
        if opacity < 100:
            layer.putalpha(layer.getchannel("A").point(lambda v: v * opacity // 100))
        if "x" in params or "y" in params:
            x, y = params.get("x", 0), params.get("y", 0)
        else:
            x, y = anchor_xy(position, im.size, (w, h), margin)
        canvas = Image.new("RGBA", im.size, (0, 0, 0, 0))
        canvas.paste(layer, (x, y))
        return Image.alpha_composite(im, canvas)

    return run_batch(params, process)
