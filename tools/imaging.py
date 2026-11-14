"""Aides images partagées par les outils de la catégorie `images` (Pillow uniquement, pas de numpy).

Convention des outils « en lot » : `path` = un fichier OU un dossier, `output` = un fichier (si `path` est un fichier)
OU un dossier (si `path` est un dossier). La source n'est jamais modifiée ni écrasée.
"""
import os
import re
import warnings as _warnings
from pathlib import Path

from PIL import Image, ImageColor, ImageFont, ImageOps

from common import iter_files

IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
# Décodeurs autorisés à l'ouverture : liste fermée, pour ne jamais passer par un décodeur qui lance un programme
# externe (EPS -> Ghostscript) ni par un format exotique, quelle que soit l'extension du fichier.
OPEN_FORMATS = ["PNG", "JPEG", "WEBP", "BMP", "GIF", "TIFF", "TGA", "DDS", "ICO"]
MAX_BATCH = 500          # images par appel
MAX_LISTED = 50          # entrées détaillées dans la réponse
MAX_PIXELS = 40_000_000  # par image ouverte ou créée (160 Mo en RGBA)
MAX_SIDE = 16_384        # côté demandé par un paramètre (largeur, hauteur, cellule…)
Image.MAX_IMAGE_PIXELS = MAX_PIXELS   # Pillow n'avertit qu'au-delà et ne refuse qu'au double : open_raw refuse dès le plafond


def check_canvas(width, height, what="image"):
    """Refuse une image à créer hors limites AVANT de l'allouer."""
    if width < 1 or height < 1 or width * height > MAX_PIXELS:
        raise ValueError(f"{what} trop grande ou vide ({width}x{height}) : {MAX_PIXELS // 1_000_000} Mpx au plus")
    return width, height


def open_raw(path):
    """Ouvre une image sans la décoder (formats de OPEN_FORMATS, taille plafonnée). À utiliser dans un `with`."""
    with _warnings.catch_warnings():
        _warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            im = Image.open(path, formats=OPEN_FORMATS)
        except (Image.DecompressionBombWarning, Image.DecompressionBombError):
            raise ValueError(f"image trop grande : {Path(path).name} ({MAX_PIXELS // 1_000_000} Mpx au plus)") from None
    if im.width * im.height > MAX_PIXELS:
        size = im.size
        im.close()
        raise ValueError(f"image trop grande : {Path(path).name} ({size[0]}x{size[1]}, {MAX_PIXELS // 1_000_000} Mpx au plus)")
    return im


def image_size(path):
    """(largeur, hauteur) telles que `open_image` les rendra (orientation EXIF comprise), sans décoder l'image."""
    with open_raw(path) as im:
        w, h = im.size
        try:
            turned = im.getexif().get(0x0112) in (5, 6, 7, 8)
        except Exception:
            turned = False
    return (h, w) if turned else (w, h)

ANCHORS = {"top-left": (0, 0), "top": (.5, 0), "top-right": (1, 0), "left": (0, .5), "center": (.5, .5),
           "right": (1, .5), "bottom-left": (0, 1), "bottom": (.5, 1), "bottom-right": (1, 1)}
POSITION_DOC = "top-left, top, top-right, left, center, right, bottom-left, bottom, bottom-right"


def parse_color(value):
    """'#rgb', '#rrggbb', '#rrggbbaa', 'red', 'rgb(1,2,3)', 'transparent' -> tuple RGBA."""
    if isinstance(value, (list, tuple)) and 3 <= len(value) <= 4:
        v = tuple(int(x) for x in value)
        return v + (255,) if len(v) == 3 else v
    s = str(value).strip().lower()
    if s in ("transparent", "none", ""):
        return (0, 0, 0, 0)
    try:
        return ImageColor.getcolor(s, "RGBA")
    except ValueError:
        raise ValueError(f"couleur invalide : {value!r} (ex. #ff8800, #ff880080, red, rgb(255,0,0), transparent)")


def to_hex(rgba):
    return "#%02x%02x%02x" % tuple(rgba[:3])


def check_position(position):
    if position not in ANCHORS:
        raise ValueError(f"position inconnue : {position!r} (valeurs : {POSITION_DOC})")
    return position


def anchor_xy(position, base, item, margin=0):
    """Coin haut-gauche d'un élément `item` (w, h) ancré dans `base` (W, H)."""
    fx, fy = ANCHORS[check_position(position)]
    return (round(margin + fx * (base[0] - item[0] - 2 * margin)),
            round(margin + fy * (base[1] - item[1] - 2 * margin)))


def open_image(path):
    """Ouvre une image en RGBA (orientation EXIF appliquée ; GIF animé : première image)."""
    with open_raw(path) as im:
        im.load()
        im = ImageOps.exif_transpose(im)
        return im.convert("RGBA")


def guard_output(dst, overwrite=False, sources=()):
    """À appeler sur le chemin FINAL de chaque fichier écrit : jamais une source, jamais un fichier existant sans
    `overwrite`, jamais un lien ni un dossier."""
    dst = Path(dst)
    if any(s and _same(s, dst) for s in sources):
        raise ValueError(f"la sortie {dst} écraserait une image source : choisir un autre output")
    if os.path.islink(dst):
        raise ValueError(f"{dst} est un lien : écriture refusée")
    if dst.is_dir():
        raise ValueError(f"{dst} est un dossier : donner un nom de fichier")
    if dst.exists() and not overwrite:
        raise FileExistsError(f"{dst} existe déjà (overwrite=true pour le remplacer)")
    return dst


def save_image(im, dst, quality=90, png_colors=None, overwrite=False, sources=()):
    """Enregistre selon l'extension. Retourne (octets, aplati_sur_blanc). Refuse d'écraser sans `overwrite`."""
    dst = Path(dst)
    ext = dst.suffix.lower()
    if ext not in IMG_EXTS:
        raise ValueError(f"extension de sortie non gérée : '{dst.suffix}' (png, jpg, webp, bmp, gif, tif)")
    check_canvas(im.width, im.height)
    guard_output(dst, overwrite, sources)
    quality = int(min(max(quality, 1), 100))
    dst.parent.mkdir(parents=True, exist_ok=True)
    flat, opts = False, {}
    if ext in (".jpg", ".jpeg"):
        flat = im.getchannel("A").getextrema()[0] < 255
        bg = Image.new("RGB", im.size, "white")
        bg.paste(im, mask=im.getchannel("A"))
        im, opts = bg, {"quality": quality}
    elif ext == ".webp":
        opts = {"quality": quality}
    elif ext == ".png":
        opts = {"optimize": True}
        if png_colors:
            im = im.quantize(colors=int(png_colors), method=Image.Quantize.FASTOCTREE)
    elif ext == ".bmp":
        im = im.convert("RGB")
    im.save(dst, **opts)
    return dst.stat().st_size, flat


def _same(a, b):
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def _under(p, folder):
    p, f = os.path.normcase(os.path.realpath(p)), os.path.normcase(os.path.realpath(folder))
    return p == f or p.startswith(f + os.sep)


def list_images(folder, recursive=False, exclude=None):
    folder = Path(folder)
    files = iter_files(folder) if recursive else (p for p in folder.iterdir() if p.is_file())
    return sorted(p for p in files if p.suffix.lower() in IMG_EXTS and not (exclude and _under(p, exclude)))


def run_batch(params, process, force_ext=None, protect=()):
    """Applique `process(image_rgba, chemin_source) -> image | None` à un fichier ou à tout un dossier.

    Réponse bornée ; en lot, une image en échec n'arrête pas les autres (erreurs listées). Aucun fichier existant
    n'est remplacé sans `overwrite`, aucune source (ni fichier de `protect`) n'est jamais remplacée : ces contrôles
    portent sur les chemins FINAUX (après changement d'extension) et précèdent tout traitement."""
    src, dst = Path(params["path"]), Path(params["output"])
    quality, colors = params.get("quality", 90), params.get("png_colors")
    overwrite = params.get("overwrite", False) is True
    if not src.exists():
        raise FileNotFoundError(f"introuvable : {src}")
    if _same(src, dst):
        raise ValueError("output doit être différent de la source")
    if src.is_dir():
        if dst.exists() and not dst.is_dir():
            raise ValueError("output doit être un dossier quand path est un dossier")
        jobs = [(f, dst / f.relative_to(src)) for f in list_images(src, params.get("recursive", False), dst)]
        if not jobs:
            raise ValueError("aucune image trouvée dans le dossier")
        if len(jobs) > MAX_BATCH:
            raise ValueError(f"trop d'images ({len(jobs)} > {MAX_BATCH}) : traiter par sous-dossier")
    else:
        if not dst.suffix:
            raise ValueError("output doit être un fichier avec extension (ex. out.png) quand path est un fichier")
        jobs = [(src, dst)]
    if force_ext:
        jobs = [(s, d.with_suffix("." + force_ext.lstrip("."))) for s, d in jobs]
    key = lambda p: os.path.normcase(os.path.realpath(p))  # noqa: E731
    kept, seen, existing = {key(s) for s, _ in jobs} | {key(p) for p in protect}, set(), []
    for _s, d in jobs:
        k = key(d)
        if k in kept:
            raise ValueError(f"la sortie {d} écraserait une image source : choisir un autre output")
        if k in seen:
            raise ValueError(f"deux images produiraient le même fichier {d.name} : traiter séparément ou renommer")
        seen.add(k)
        if os.path.islink(d) or d.is_dir():
            raise ValueError(f"{d} est un lien ou un dossier : écriture refusée")
        if d.exists():
            existing.append(d)
    if existing and not overwrite:
        raise FileExistsError(f"{len(existing)} fichier(s) de sortie existe(nt) déjà (ex. {existing[0]}) : "
                              "overwrite=true pour les remplacer")
    done, errors, flat, bytes_in, bytes_out = [], [], 0, 0, 0
    for s, d in jobs:
        try:
            out = process(open_image(s), s)
            if out is None:
                continue
            size, f = save_image(out, d, quality, colors, overwrite=overwrite, sources=[s])
            flat += f
            bytes_in += s.stat().st_size
            bytes_out += size
            done.append(str(d.relative_to(dst)) if src.is_dir() else str(d))
        except Exception as exc:
            if len(jobs) == 1:
                raise
            errors.append(f"{s.name} : {exc}")
    if not done:
        raise ValueError("aucune image traitée" + (f" ({errors[0]})" if errors else ""))
    warnings = []
    if flat:
        warnings.append(f"{flat} image(s) avec transparence aplatie(s) sur fond blanc (sortie JPEG sans alpha).")
    if errors:
        warnings.append(f"{len(errors)} image(s) en échec : {'; '.join(errors[:5])}")
    data = {"output": str(dst), "processed": len(done), "failed": len(errors), "outputs": done[:MAX_LISTED],
            "truncated": len(done) > MAX_LISTED, "bytes_in": bytes_in, "bytes_out": bytes_out}
    return {"data": data, "warnings": warnings}


_FONT_DEFAULTS = ["segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf"]


def load_font(size, name=None):
    """Police TrueType : `name` = nom de police système (ex. 'arial', 'consolas') ; repli sur une police par défaut."""
    size = min(max(6, int(size)), 4096)
    cands = list(_FONT_DEFAULTS)
    if name:
        if not re.fullmatch(r"[A-Za-z0-9 _-]{1,40}", name):
            raise ValueError("font : simple nom de police système (ex. arial, consolas, segoeui)")
        cands = [name + ".ttf", name.replace(" ", "") + ".ttf", name.lower().replace(" ", "") + ".ttf"] + cands
    for c in cands:
        try:
            return ImageFont.truetype(c, size)
        except OSError:
            continue
    return ImageFont.load_default(size)
