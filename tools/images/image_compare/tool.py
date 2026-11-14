from PIL import Image, ImageChops, ImageStat

from imaging import guard_output, open_image, save_image


def execute(params):
    sources, overwrite = [params["path"], params["other"]], params.get("overwrite", False) is True
    if params.get("output"):          # avant tout travail : ni l'une des deux images, ni un fichier existant
        guard_output(params["output"], overwrite, sources)
    a, b = open_image(params["path"]), open_image(params["other"])
    tol, warnings = params.get("tolerance", 8), []
    same_size = a.size == b.size
    if not same_size:
        warnings.append(f"tailles différentes ({a.size} vs {b.size}) : 'other' redimensionnée pour comparer.")
        b = b.resize(a.size, Image.LANCZOS)
    diff = ImageChops.difference(a, b)
    peak = ImageChops.lighter(ImageChops.lighter(diff.getchannel("R"), diff.getchannel("G")),
                              ImageChops.lighter(diff.getchannel("B"), diff.getchannel("A")))
    mask = peak.point(lambda v: 255 if v > tol else 0)
    total = a.width * a.height
    changed = mask.histogram()[255]
    mean = sum(ImageStat.Stat(diff).mean) / 4
    data = {"same_size": same_size, "size": list(a.size), "identical": changed == 0,
            "changed_pixels": changed, "changed_percent": round(100 * changed / total, 3),
            "mean_difference_0_255": round(mean, 3), "changed_bbox": list(mask.getbbox() or [])}
    if params.get("output"):
        view = Image.blend(Image.new("RGBA", a.size, "white"), a, .35)
        view.paste(Image.new("RGBA", a.size, (255, 0, 0, 255)), mask=mask)
        save_image(view, params["output"], overwrite=overwrite, sources=sources)
        data["diff_image"] = params["output"]
    return {"data": data, "warnings": warnings}
