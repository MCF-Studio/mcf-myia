from pathlib import Path

from PIL import Image

from imaging import guard_output, open_image, save_image

# preset -> ([(fichier png, taille)], ico (nom, [tailles]) ou None, icns ou None)
PRESETS = {
    "tauri": ([("icon.png", 512), ("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)],
              ("icon.ico", [16, 24, 32, 48, 64, 128, 256]), "icon.icns"),
    "web": ([("favicon-32.png", 32), ("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)],
            ("favicon.ico", [16, 32, 48]), None),
    "windows": ([("icon-256.png", 256)], ("icon.ico", [16, 24, 32, 48, 64, 128, 256]), None),
    "sizes": ([], None, None),
}
MAX_SIZES = 32


def execute(params):
    preset, sizes = params.get("preset", "tauri"), params.get("sizes") or []
    overwrite = params.get("overwrite", False) is True
    if preset not in PRESETS:
        raise ValueError(f"preset : {', '.join(PRESETS)}")
    if preset == "sizes" and not sizes:
        raise ValueError("preset 'sizes' : donner sizes, ex. [16, 64, 512]")
    if len(sizes) > MAX_SIZES or any(isinstance(s, bool) or not isinstance(s, int) or not 8 <= s <= 2048 for s in sizes):
        raise ValueError(f"sizes : {MAX_SIZES} entiers au plus, de 8 à 2048")
    source, out = Path(params["path"]), Path(params["output"])
    if out.exists() and not out.is_dir():
        raise ValueError("output est le DOSSIER où écrire les icônes")
    pngs, ico, icns = PRESETS[preset]
    names = pngs + [(f"icon_{s}.png", s) for s in sizes]
    # Tous les chemins finaux d'abord : ni la source, ni un fichier existant sans overwrite ; rien d'écrit sinon.
    for name in [n for n, _ in names] + ([ico[0]] if ico else []) + ([icns] if icns else []):
        guard_output(out / name, overwrite, [source])
    src = open_image(source)
    warnings = []
    side = max(src.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))     # carré, centré, sans déformer
    sq.alpha_composite(src, ((side - src.width) // 2, (side - src.height) // 2))
    if src.width != src.height:
        warnings.append(f"source non carrée ({src.width}x{src.height}) : centrée sur fond transparent.")
    need = max([s for _, s in pngs] + sizes + ([max(ico[1])] if ico else []) + ([512] if icns else []))
    if side < need:
        warnings.append(f"source de {side}px < {need}px : les grandes tailles seront agrandies (flou). "
                        f"Fournir une source d'au moins {need}px.")
    written = []

    def resized(n):
        return sq.resize((n, n), Image.LANCZOS)

    for name, n in names:
        save_image(resized(n), out / name, overwrite=overwrite, sources=[source])
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
