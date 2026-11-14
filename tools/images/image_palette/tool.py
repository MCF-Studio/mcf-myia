from PIL import Image

from imaging import open_image, save_image, to_hex


def execute(params):
    n = params.get("colors", 6)
    if not 1 <= n <= 32:
        raise ValueError("colors : 1 à 32")
    im = open_image(params["path"])
    im.thumbnail((200, 200))
    px = [p for p in im.getdata() if p[3] >= 128]       # ignore le transparent
    if not px:
        raise ValueError("image entièrement transparente")
    flat = Image.new("RGB", (len(px), 1))
    flat.putdata([p[:3] for p in px])
    q = flat.quantize(colors=n, method=Image.Quantize.MEDIANCUT)
    pal, counts = q.getpalette(), sorted(q.getcolors(), reverse=True)
    colors = [{"hex": to_hex(pal[i * 3:i * 3 + 3]), "rgb": pal[i * 3:i * 3 + 3],
               "percent": round(100 * c / len(px), 1)} for c, i in counts]
    data = {"path": params["path"], "colors": colors, "opaque_pixels_sampled": len(px)}
    if params.get("output"):                            # bande de pastilles pour visualiser
        sw = 64
        strip = Image.new("RGBA", (sw * len(colors), sw))
        for i, c in enumerate(colors):
            strip.paste(tuple(c["rgb"]) + (255,), (i * sw, 0, (i + 1) * sw, sw))
        save_image(strip, params["output"])
        data["swatch"] = params["output"]
    return {"data": data}
