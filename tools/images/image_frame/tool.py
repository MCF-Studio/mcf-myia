from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

from imaging import parse_color, run_batch

SS = 4  # sur-échantillonnage pour des bords lissés


def _shape_mask(size, radius, circle):
    w, h = size
    big = Image.new("L", (w * SS, h * SS), 0)
    d = ImageDraw.Draw(big)
    if circle:
        d.ellipse((0, 0, w * SS - 1, h * SS - 1), fill=255)
    else:
        d.rounded_rectangle((0, 0, w * SS - 1, h * SS - 1), radius=radius * SS, fill=255)
    return big.resize(size, Image.LANCZOS)


def execute(params):
    radius, circle = params.get("radius", 0), params.get("circle", False)
    bw, pad = params.get("border_width", 0), params.get("padding", 0)
    blur, off = params.get("shadow_blur", 0), params.get("shadow_offset", 0)
    if min(radius, bw, pad, blur) < 0 or not (radius or circle or bw or pad or blur or off):
        raise ValueError("au moins un effet : radius, circle, border_width, padding, shadow_blur/shadow_offset")
    bcolor, pcolor = parse_color(params.get("border_color", "#ffffff")), parse_color(params.get("padding_color",
                                                                                              "transparent"))
    scolor = parse_color(params.get("shadow_color", "#00000099"))

    def process(im, _src):
        if circle:
            im = ImageOps.fit(im, (min(im.size),) * 2, Image.LANCZOS)
        if radius or circle:
            im.putalpha(ImageChops.multiply(im.getchannel("A"), _shape_mask(im.size, radius, circle)))
        if bw:
            outer = Image.new("RGBA", (im.width + 2 * bw, im.height + 2 * bw), (0, 0, 0, 0))
            outer.paste(Image.new("RGBA", outer.size, bcolor), mask=_shape_mask(outer.size, radius + bw if radius
                                                                                else 0, circle))
            outer.alpha_composite(im, (bw, bw))
            im = outer
        if pad:
            canvas = Image.new("RGBA", (im.width + 2 * pad, im.height + 2 * pad), pcolor)
            canvas.alpha_composite(im, (pad, pad))
            im = canvas
        if blur or off:
            m = blur * 3 + abs(off)
            sil = Image.new("L", (im.width + 2 * m, im.height + 2 * m), 0)
            sil.paste(im.getchannel("A"), (m + off, m + off))
            if blur:
                sil = sil.filter(ImageFilter.GaussianBlur(blur))
            shadow = Image.new("RGBA", sil.size, scolor[:3] + (0,))
            shadow.putalpha(sil.point(lambda v: v * scolor[3] // 255))
            shadow.alpha_composite(im, (m, m))
            im = shadow
        return im

    return run_batch(params, process)
