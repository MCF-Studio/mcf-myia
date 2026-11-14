from pathlib import Path

from PIL import Image

from imaging import IMG_EXTS, guard_output, open_raw

OUT_EXTS = IMG_EXTS | {".tga"}


def execute(params):
    src, dst = Path(params["path"]), Path(params["output"])
    ext = dst.suffix.lower()
    if ext not in OUT_EXTS:
        raise ValueError(f"extension de sortie non gérée : '{dst.suffix}' ({', '.join(sorted(OUT_EXTS))})")
    guard_output(dst, params.get("overwrite", False) is True, [src])   # jamais la source, jamais un fichier existant
    quality = int(min(max(params.get("quality", 90), 1), 100))
    warnings = []
    with open_raw(src) as im:      # mêmes gardes que imaging.py : formats autorisés, taille plafonnée
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
    with open_raw(dst) as written:   # refermé : plus de descripteur laissé ouvert sur le fichier produit
        fmt = written.format
    return {"data": {"output": str(dst), "format": fmt, "bytes": dst.stat().st_size,
                     "source_bytes": src.stat().st_size}, "warnings": warnings}
