from PIL import Image, ImageOps

from imaging import check_canvas, parse_color, run_batch

MODES = ("contain", "cover", "pad", "stretch")


def execute(params):
    w, h, mode = params.get("width"), params.get("height"), params.get("mode", "contain")
    if mode not in MODES:
        raise ValueError(f"mode : {', '.join(MODES)}")
    if not w and not h:
        raise ValueError("width et/ou height requis")
    if (w or 1) < 1 or (h or 1) < 1 or (w or 1) > 16384 or (h or 1) > 16384:
        raise ValueError("dimensions entre 1 et 16384")
    if mode != "contain" and not (w and h):
        raise ValueError(f"le mode {mode} demande width ET height")
    bg, shrink = parse_color(params.get("background", "transparent")), params.get("no_upscale", False)

    def process(im, _src):
        W, H = w or round(im.width * h / im.height), h or round(im.height * w / im.width)
        check_canvas(W, H, "image redimensionnée")
        if mode == "stretch":
            return im.resize((W, H), Image.LANCZOS)
        if mode == "cover":
            return ImageOps.fit(im, (W, H), Image.LANCZOS)
        if shrink and im.width <= W and im.height <= H:
            fitted = im
        else:
            fitted = ImageOps.contain(im, (W, H), Image.LANCZOS)
        if mode == "contain":
            return fitted
        canvas = Image.new("RGBA", (W, H), bg)
        canvas.alpha_composite(fitted, ((W - fitted.width) // 2, (H - fitted.height) // 2))
        return canvas

    return run_batch(params, process)
