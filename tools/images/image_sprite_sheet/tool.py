import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from imaging import MAX_BATCH, list_images, load_font, open_image, parse_color, save_image

MAX_TILES = 1024


def _pack(params):
    src, dst = Path(params["path"]), Path(params["output"])
    files = list_images(src, params.get("recursive", False))
    if not files:
        raise ValueError("aucune image dans le dossier")
    if len(files) > MAX_BATCH:
        raise ValueError(f"trop d'images ({len(files)} > {MAX_BATCH})")
    if dst.suffix.lower() == "":
        raise ValueError("output : fichier image (ex. sheet.png)")
    ims = [open_image(f) for f in files]
    cw = params.get("cell_width") or max(i.width for i in ims)
    ch = params.get("cell_height") or max(i.height for i in ims)
    cols = params.get("columns") or math.ceil(math.sqrt(len(ims)))
    pad, labels = params.get("padding", 0), params.get("labels", False)
    lab_h = round(max(12, min(cw, 200) * .12)) if labels else 0
    rows = math.ceil(len(ims) / cols)
    W, H = cols * (cw + pad) + pad, rows * (ch + lab_h + pad) + pad
    if W * H > 64_000_000:
        raise ValueError(f"planche trop grande ({W}x{H})")
    sheet = Image.new("RGBA", (W, H), parse_color(params.get("background", "transparent")))
    d, font, atlas = ImageDraw.Draw(sheet), (load_font(lab_h * .8) if labels else None), []
    for i, (f, im) in enumerate(zip(files, ims)):
        x, y = pad + (i % cols) * (cw + pad), pad + (i // cols) * (ch + lab_h + pad)
        fit = im if (im.width <= cw and im.height <= ch) else ImageOps.contain(im, (cw, ch), Image.LANCZOS)
        ox, oy = x + (cw - fit.width) // 2, y + (ch - fit.height) // 2
        sheet.alpha_composite(fit, (ox, oy))
        if labels:
            d.text((x + 2, y + ch + 1), f.stem[:int(cw / (lab_h * .5)) or 1], font=font, fill=(255, 255, 255, 255),
                   stroke_width=1, stroke_fill=(0, 0, 0, 255))
        atlas.append({"name": f.name, "x": ox, "y": oy, "w": fit.width, "h": fit.height})
    nbytes, _ = save_image(sheet, dst)
    atlas_path = dst.with_suffix(".json")
    atlas_path.write_text(json.dumps({"image": dst.name, "cell": [cw, ch], "columns": cols, "sprites": atlas},
                                     ensure_ascii=False, indent=1), encoding="utf-8")
    return {"mode": "pack", "output": str(dst), "atlas": str(atlas_path), "count": len(ims), "columns": cols,
            "rows": rows, "size": [W, H], "bytes": nbytes}


def _split(params):
    src, dst = Path(params["path"]), Path(params["output"])
    im = open_image(src)
    tw, th = params.get("tile_width"), params.get("tile_height")
    if params.get("columns") and params.get("rows"):
        tw, th = im.width // params["columns"], im.height // params["rows"]
    if not tw or not th or tw < 1 or th < 1:
        raise ValueError("split : tile_width+tile_height, ou columns+rows")
    cols, rows = im.width // tw, im.height // th
    if cols * rows > MAX_TILES:
        raise ValueError(f"trop de tuiles ({cols * rows} > {MAX_TILES})")
    outs = []
    for r in range(rows):
        for c in range(cols):
            tile = im.crop((c * tw, r * th, (c + 1) * tw, (r + 1) * th))
            if params.get("skip_empty", True) and tile.getchannel("A").getextrema()[1] == 0:
                continue
            p = dst / f"{src.stem}_{r}_{c}.png"
            save_image(tile, p)
            outs.append(p.name)
    return {"mode": "split", "output": str(dst), "tile": [tw, th], "columns": cols, "rows": rows,
            "written": len(outs), "files": outs[:50], "truncated": len(outs) > 50}


def execute(params):
    src = Path(params["path"])
    if not src.exists():
        raise FileNotFoundError(f"introuvable : {src}")
    mode = params.get("mode") or ("pack" if src.is_dir() else "split")
    if mode == "pack" and not src.is_dir() or mode == "split" and src.is_dir():
        raise ValueError("pack : path = dossier d'images ; split : path = planche (fichier)")
    if mode not in ("pack", "split"):
        raise ValueError("mode : pack ou split")
    return {"data": _pack(params) if mode == "pack" else _split(params), "warnings": []}
