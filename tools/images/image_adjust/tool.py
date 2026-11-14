from PIL import Image, ImageEnhance, ImageFilter, ImageOps

from imaging import run_batch

OPS = ("brightness", "contrast", "saturation", "sharpness", "hue_shift", "gamma", "grayscale", "sepia", "invert",
       "autocontrast", "posterize", "blur", "pixelate")


def execute(params):
    if not any(k in params for k in OPS):
        raise ValueError("au moins une opération : " + ", ".join(OPS))
    for k in ("brightness", "contrast", "saturation", "sharpness", "gamma"):
        if k in params and (params[k] > 100 or (params[k] <= 0 and k != "sharpness")):
            raise ValueError(f"{k} : > 0 et <= 100 (1.0 = inchangé)")
    if "posterize" in params and not 1 <= params["posterize"] <= 8:
        raise ValueError("posterize : 1 à 8 bits")
    if not 2 <= params.get("pixelate", 2) <= 4096 or not 0 <= params.get("blur", 0) <= 256:
        raise ValueError("pixelate : 2 à 4096 (taille des blocs en px), blur : 0 à 256")

    def process(im, _src):
        a = im.getchannel("A")
        rgb = im.convert("RGB")
        if params.get("invert"):
            rgb = ImageOps.invert(rgb)
        if "gamma" in params:
            g = params["gamma"]
            rgb = rgb.point([round(255 * (i / 255) ** (1 / g)) for i in range(256)] * 3)
        if "hue_shift" in params:
            h, s, v = rgb.convert("HSV").split()
            k = round(params["hue_shift"] * 256 / 360)
            rgb = Image.merge("HSV", (h.point([(i + k) % 256 for i in range(256)]), s, v)).convert("RGB")
        if params.get("autocontrast"):
            rgb = ImageOps.autocontrast(rgb, cutoff=1)
        for key, cls in (("brightness", ImageEnhance.Brightness), ("contrast", ImageEnhance.Contrast),
                         ("saturation", ImageEnhance.Color), ("sharpness", ImageEnhance.Sharpness)):
            if key in params:
                rgb = cls(rgb).enhance(params[key])
        if params.get("grayscale") or params.get("sepia"):
            gray = ImageOps.grayscale(rgb)
            rgb = (ImageOps.colorize(gray, "#1b1005", "#ffeccc", mid="#a07850") if params.get("sepia")
                   else gray.convert("RGB"))
        if "posterize" in params:
            rgb = ImageOps.posterize(rgb, params["posterize"])
        out = Image.merge("RGBA", (*rgb.split(), a))
        if params.get("blur"):
            out = out.filter(ImageFilter.GaussianBlur(params["blur"]))
        if "pixelate" in params:
            n = params["pixelate"]
            small = out.resize((max(1, out.width // n), max(1, out.height // n)), Image.BOX)
            out = small.resize(out.size, Image.NEAREST)
        return out

    return run_batch(params, process)
