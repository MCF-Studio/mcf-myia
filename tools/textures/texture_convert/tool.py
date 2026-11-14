from pathlib import Path

from PIL import Image


def execute(params):
    src, dst = Path(params["path"]), Path(params["output"])
    if src.resolve() == dst.resolve():
        raise ValueError("output doit être différent de la source")
    quality = params.get("quality", 90)
    warnings = []
    with Image.open(src) as im:
        ext = dst.suffix.lower()
        if ext in (".jpg", ".jpeg") and ("A" in im.getbands() or im.mode == "P"):
            rgba = im.convert("RGBA")
            if rgba.getchannel("A").getextrema()[0] < 255:
                warnings.append("La transparence a été aplatie sur fond blanc (JPEG sans alpha).")
            bg = Image.new("RGB", rgba.size, "white")
            bg.paste(rgba, mask=rgba.getchannel("A"))
            im = bg
        elif ext in (".jpg", ".jpeg") and im.mode != "RGB":
            im = im.convert("RGB")
        dst.parent.mkdir(parents=True, exist_ok=True)
        opts = {"quality": quality} if ext in (".jpg", ".jpeg", ".webp") else {}
        im.save(dst, **opts)
        fmt = Image.open(dst).format
    return {"data": {"output": str(dst), "format": fmt, "bytes": dst.stat().st_size,
                     "source_bytes": src.stat().st_size}, "warnings": warnings}
