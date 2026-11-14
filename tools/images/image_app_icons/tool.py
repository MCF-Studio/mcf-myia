from pathlib import Path

from PIL import Image

from imaging import open_image, save_image

# preset -> ([(fichier png, taille)], ico (nom, [tailles]) ou None, icns ou None)
PRESETS = {
    "tauri": ([("icon.png", 512), ("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)],
              ("icon.ico", [16, 24, 32, 48, 64, 128, 256]), "icon.icns"),
    "web": ([("favicon-32.png", 32), ("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)],
            ("favicon.ico", [16, 32, 48]), None),
    "windows": ([("icon-256.png", 256)], ("icon.ico", [16, 24, 32, 48, 64, 128, 256]), None),
    "sizes": ([], None, None),
}


def execute(params):
    preset, sizes = params.get("preset", "tauri"), params.get("sizes") or []
    if preset not in PRESETS:
        raise ValueError(f"preset : {', '.join(PRESETS)}")
    if preset == "sizes" and not sizes:
        raise ValueError("preset 'sizes' : donner sizes, ex. [16, 64, 512]")
    if any(not isinstance(s, int) or not 8 <= s <= 2048 for s in sizes):
        raise ValueError("sizes : entiers de 8 à 2048")
    src, out = open_image(params["path"]), Path(params["output"])
    warnings = []
    side = max(src.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))     # carré, centré, sans déformer
    sq.alpha_composite(src, ((side - src.width) // 2, (side - src.height) // 2))
    if src.width != src.height:
        warnings.append(f"source non carrée ({src.width}x{src.height}) : centrée sur fond transparent.")
    pngs, ico, icns = PRESETS[preset]
    need = max([s for _, s in pngs] + sizes + ([max(ico[1])] if ico else []) + ([512] if icns else []))
    if side < need:
        warnings.append(f"source de {side}px < {need}px : les grandes tailles seront agrandies (flou). "
                        f"Fournir une source d'au moins {need}px.")
    written = []

    def resized(n):
        return sq.resize((n, n), Image.LANCZOS)

    for name, n in pngs + [(f"icon_{s}.png", s) for s in sizes]:
        save_image(resized(n), out / name)
        written.append(name)
    if ico:
        base = resized(max(ico[1]))
        (out).mkdir(parents=True, exist_ok=True)
        base.save(out / ico[0], sizes=[(s, s) for s in ico[1]])
        written.append(ico[0])
    if icns:
        try:
            resized(1024).save(out / icns)
            written.append(icns)
        except Exception as exc:
            warnings.append(f"{icns} non généré ({exc}) ; utiliser l'outil Tauri : `tauri icon`.")
    return {"data": {"output": str(out), "preset": preset, "files": written}, "warnings": warnings}
