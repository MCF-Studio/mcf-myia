"""Garde-fous des outils images et textures (Pillow requis) : aucun écrasement silencieux, tailles bornées,
formats d'ouverture restreints. python -m unittest discover -s tools/tests -v"""
import gc
import importlib.util
import os
import sys
import tempfile
import unittest
import weakref
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS))

from PIL import Image  # noqa: E402

import imaging  # noqa: E402


def call(name, category="images", **params):
    spec = importlib.util.spec_from_file_location(name, TOOLS / category / name / "tool.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.execute(params)


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.d = Path(self._tmp.name).resolve()
        self.src = self.d / "in"
        self.src.mkdir()
        Image.new("RGB", (80, 60), "#ff0000").save(self.src / "a.png")
        Image.new("RGB", (80, 60), "#00ff00").save(self.src / "b.png")

    def px(self, p, xy=(1, 1)):
        with Image.open(p) as im:
            return im.convert("RGBA").getpixel(xy)


class Overwrite(Base):
    def test_existing_output_is_refused_without_overwrite(self):
        out = self.d / "out.png"
        Image.new("RGB", (4, 4), "#0000ff").save(out)
        with self.assertRaises(FileExistsError):
            call("image_adjust", path=str(self.src / "a.png"), output=str(out), grayscale=True)
        self.assertEqual(self.px(out), (0, 0, 255, 255))
        call("image_adjust", path=str(self.src / "a.png"), output=str(out), grayscale=True, overwrite=True)
        self.assertEqual(Image.open(out).size, (80, 60))

    def test_batch_refuses_before_touching_anything(self):
        out = self.d / "out"
        out.mkdir()
        Image.new("RGB", (4, 4), "#0000ff").save(out / "b.png")
        with self.assertRaises(FileExistsError):
            call("image_adjust", path=str(self.src), output=str(out), grayscale=True)
        self.assertFalse((out / "a.png").exists())           # rien d'écrit : le refus précède le traitement
        self.assertEqual(self.px(out / "b.png"), (0, 0, 255, 255))

    def test_source_is_never_overwritten_after_the_extension_change(self):
        before = (self.src / "a.png").read_bytes()
        for overwrite in (False, True):                      # même avec overwrite : une source ne se remplace pas
            with self.assertRaises(ValueError):
                call("image_optimize", path=str(self.src / "a.png"), output=str(self.src / "a.jpg"), format="png",
                     overwrite=overwrite)
        self.assertEqual((self.src / "a.png").read_bytes(), before)
        self.assertFalse((self.src / "a.jpg").exists())

    def test_batch_into_its_own_folder_cannot_replace_a_source(self):
        (self.src / "sub").mkdir()
        Image.new("RGB", (8, 8), "#123456").save(self.src / "sub" / "a.png")
        before = (self.src / "a.png").read_bytes()
        with self.assertRaises(ValueError):                  # sub/a.png -> a.png, qui est une source
            call("image_adjust", path=str(self.src / "sub"), output=str(self.src), grayscale=True, overwrite=True)
        self.assertEqual((self.src / "a.png").read_bytes(), before)

    def test_two_sources_cannot_land_on_the_same_file(self):
        Image.new("RGB", (8, 8), "#123456").save(self.src / "a.jpg")
        with self.assertRaises(ValueError):
            call("image_optimize", path=str(self.src), output=str(self.d / "o"), format="webp")
        self.assertFalse((self.d / "o").exists())

    def test_compare_palette_and_icons_protect_their_sources(self):
        a, b = self.src / "a.png", self.src / "b.png"
        with self.assertRaises(ValueError):
            call("image_compare", path=str(a), other=str(b), output=str(b), overwrite=True)
        with self.assertRaises(ValueError):
            call("image_palette", path=str(a), output=str(a), overwrite=True)
        self.assertEqual((self.px(a), self.px(b)), ((255, 0, 0, 255), (0, 255, 0, 255)))
        Image.new("RGB", (4, 4), "#0000ff").save(self.d / "p.png")
        with self.assertRaises(FileExistsError):
            call("image_palette", path=str(a), output=str(self.d / "p.png"))
        with self.assertRaises(FileExistsError):
            call("image_compare", path=str(a), other=str(b), output=str(self.d / "p.png"))
        icons = self.d / "icons"
        icons.mkdir()
        Image.new("RGBA", (64, 64), "#336699").save(icons / "icon.png")
        with self.assertRaises(ValueError):                  # la source s'appelle comme une sortie du preset
            call("image_app_icons", path=str(icons / "icon.png"), output=str(icons), overwrite=True)
        self.assertEqual(sorted(p.name for p in icons.iterdir()), ["icon.png"])
        with self.assertRaises(FileExistsError):
            call("image_app_icons", path=str(a), output=str(icons), preset="tauri")    # icon.png existe déjà
        self.assertEqual(sorted(p.name for p in icons.iterdir()), ["icon.png"])

    def test_generated_images_do_not_replace_a_file(self):
        out = self.d / "g.png"
        call("image_generate", output=str(out), width=8, height=8)
        with self.assertRaises(FileExistsError):
            call("image_generate", output=str(out), width=8, height=8)
        with self.assertRaises(FileExistsError):
            call("image_icon_create", output=str(out), size=32, symbol="play")
        call("image_icon_create", output=str(out), size=32, symbol="play", overwrite=True)

    def test_sprite_sheet_atlas_cannot_replace_a_json_file(self):
        proj = self.d / "projet"
        proj.mkdir()
        (proj / "package.json").write_text('{"name": "x"}', encoding="utf-8")
        (proj / "data.json").write_text('{"garde": 1}', encoding="utf-8")
        for overwrite in (False, True):                      # package.json pilote npm : jamais, même avec overwrite
            with self.assertRaises(PermissionError):
                call("image_sprite_sheet", path=str(self.src), output=str(proj / "package.png"), overwrite=overwrite)
        with self.assertRaises(FileExistsError):
            call("image_sprite_sheet", path=str(self.src), output=str(proj / "data.png"))
        self.assertEqual((proj / "package.json").read_text(encoding="utf-8"), '{"name": "x"}')
        self.assertEqual((proj / "data.json").read_text(encoding="utf-8"), '{"garde": 1}')
        self.assertEqual(sorted(p.name for p in proj.iterdir()), ["data.json", "package.json"])
        tiles = self.d / "tiles"
        call("image_sprite_sheet", path=str(self.src), output=str(self.d / "sheet.png"), columns=2)
        call("image_sprite_sheet", path=str(self.d / "sheet.png"), output=str(tiles), tile_width=80, tile_height=60)
        with self.assertRaises(FileExistsError):
            call("image_sprite_sheet", path=str(self.d / "sheet.png"), output=str(tiles), tile_width=80, tile_height=60)

    def test_textures_follow_the_same_rules(self):
        a, out = self.src / "a.png", self.d / "t.jpg"
        for tool, extra in (("texture_convert", {}), ("texture_resize", {"width": 10})):
            with self.assertRaises(ValueError):
                call(tool, "textures", path=str(a), output=str(a), overwrite=True, **extra)
        call("texture_convert", "textures", path=str(a), output=str(out))
        os.remove(out)                                       # échouerait sous Windows si un descripteur restait ouvert
        Image.new("RGB", (4, 4), "#0000ff").save(out)
        with self.assertRaises(FileExistsError):
            call("texture_convert", "textures", path=str(a), output=str(out))
        with self.assertRaises(FileExistsError):
            call("texture_resize", "textures", path=str(a), output=str(out), width=10)
        self.assertEqual(Image.open(out).size, (4, 4))
        call("texture_resize", "textures", path=str(a), output=str(out), width=10, overwrite=True)
        with self.assertRaises(ValueError):                  # pas de format hors liste (pdf, eps…)
            call("texture_convert", "textures", path=str(a), output=str(self.d / "t.pdf"))


class Limits(Base):
    def test_oversized_parameters_are_refused(self):
        a, out = str(self.src / "a.png"), str(self.d / "o.png")
        cases = [
            ("image_generate", {"output": out, "width": 8192, "height": 8192}),
            ("image_generate", {"output": out, "width": 4096, "height": 4096, "kind": "checker", "cell": 1}),
            ("image_frame", {"path": a, "output": out, "padding": 100_000}),
            ("image_frame", {"path": a, "output": out, "border_width": 100_000}),
            ("image_frame", {"path": a, "output": out, "shadow_blur": 100_000}),
            ("image_frame", {"path": a, "output": out, "radius": 10**7}),
            ("image_fit", {"path": a, "output": out, "width": 16384, "height": 16384, "mode": "stretch"}),
            ("image_overlay", {"path": a, "output": out, "overlay": str(self.src / "b.png"), "scale": 100_000}),
            ("image_text", {"path": a, "output": out, "text": "x", "size": 10**6}),
            ("image_text", {"path": a, "output": out, "text": "x", "stroke_width": 10**6}),
            ("image_adjust", {"path": a, "output": out, "blur": 10**6}),
            ("image_optimize", {"path": a, "output": out, "max_side": 10**7}),
            ("image_icon_create", {"output": out, "size": 256, "symbol": "play", "glyph_scale": 500}),
            ("image_icon_create", {"output": out, "size": 256, "symbol": "play", "border_width": 10**6}),
            ("image_sprite_sheet", {"path": str(self.src), "output": out, "padding": 10**6}),
            ("image_sprite_sheet", {"path": str(self.src), "output": out, "cell_width": 10**6}),
            ("image_transform", {"path": a, "output": out, "rotate": 10**9}),
        ]
        for name, params in cases:
            with self.assertRaises(ValueError, msg=(name, params)):
                call(name, **params)
        self.assertFalse(Path(out).exists())
        for params in ({"width": 100_000}, {"height": 10**6}):
            with self.assertRaises(ValueError):
                call("texture_resize", "textures", path=a, output=out, **params)

    def test_huge_image_is_refused_before_decoding(self):
        big = self.d / "big.png"
        Image.new("1", (7000, 6000)).save(big)               # 42 Mpx, quelques Ko sur disque
        with self.assertRaises(ValueError):
            imaging.open_image(big)
        with self.assertRaises(ValueError):
            call("image_adjust", path=str(big), output=str(self.d / "o.png"), grayscale=True)
        with self.assertRaises(ValueError):
            call("texture_info", "textures", path=str(big))
        with self.assertRaises(ValueError):
            call("texture_resize", "textures", path=str(big), output=str(self.d / "o.png"), width=10)
        self.assertLessEqual(imaging.MAX_PIXELS, 64_000_000)

    def test_frame_supersampling_is_bounded_on_large_images(self):
        mod_spec = importlib.util.spec_from_file_location("frame", TOOLS / "images" / "image_frame" / "tool.py")
        frame = importlib.util.module_from_spec(mod_spec)
        mod_spec.loader.exec_module(frame)
        created = []
        real_new = Image.new

        def spy(mode, size, *a, **k):
            created.append(size[0] * size[1])
            return real_new(mode, (min(size[0], 64), min(size[1], 64)), *a, **k)

        Image.new = spy
        try:
            frame._shape_mask((6000, 5000), 10, False)        # 30 Mpx : x4 donnerait 480 Mpx
        except Exception:
            pass
        finally:
            Image.new = real_new
        self.assertLessEqual(max(created), imaging.MAX_PIXELS)

    def test_only_listed_decoders_are_used(self):
        for fmt in ("EPS", "PDF", "WMF", "PS"):
            self.assertNotIn(fmt, imaging.OPEN_FORMATS)
        eps = b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n%%EndComments\nshowpage\n%%EOF\n"
        for name in ("piege.eps", "piege.png"):              # l'extension ne change rien : jamais le décodeur EPS
            (self.d / name).write_bytes(eps)
            with self.assertRaises(Exception) as ctx:
                call("texture_info", "textures", path=str(self.d / name))
            self.assertIn("cannot identify", str(ctx.exception))
            with self.assertRaises(Exception):
                imaging.open_image(self.d / name)

    def test_sprite_sheet_opens_images_one_at_a_time(self):
        for i in range(12):
            Image.new("RGB", (16, 16), "#112233").save(self.src / f"s{i}.png")
        mod_spec = importlib.util.spec_from_file_location("sheet", TOOLS / "images" / "image_sprite_sheet" / "tool.py")
        sheet = importlib.util.module_from_spec(mod_spec)
        mod_spec.loader.exec_module(sheet)
        refs, still_open, real_open = [], [], sheet.open_image

        def spy(path):
            gc.collect()
            still_open.append(sum(1 for r in refs if r() is not None))   # images précédentes encore en mémoire
            im = real_open(path)
            refs.append(weakref.ref(im))
            return im

        sheet.open_image = spy
        r = sheet.execute({"path": str(self.src), "output": str(self.d / "s.png")})
        self.assertEqual(r["data"]["count"], 14)
        self.assertEqual(len(refs), 14)
        self.assertEqual(max(still_open), 0)                 # jamais deux images décodées à la fois


if __name__ == "__main__":
    unittest.main()
