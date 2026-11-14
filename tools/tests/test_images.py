"""Tests des outils `images` (Pillow requis) : python -m unittest discover -s tools/tests -v"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS))

from PIL import Image  # noqa: E402


def load(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / "images" / name / "tool.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def call(name, **params):
    return load(name).execute(params)


class ImageTools(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.d = Path(self._tmp.name)
        self.src = self.d / "in"
        self.src.mkdir()
        for i, c in enumerate(("#ff0000", "#00ff00")):
            Image.new("RGB", (80 + i * 20, 60), c).save(self.src / f"img{i}.png")
        Image.new("RGBA", (20, 20), "#0000ffff").save(self.d / "logo.png")

    def tearDown(self):
        self._tmp.cleanup()

    def px(self, p, xy=(1, 1)):
        return Image.open(p).convert("RGBA").getpixel(xy)

    def test_every_manifest_matches_a_tool(self):
        for m in (TOOLS / "images").glob("*/manifest.json"):
            data = json.loads(m.read_text(encoding="utf-8"))
            self.assertEqual(data["name"], m.parent.name)
            self.assertTrue((m.parent / "tool.py").exists())

    def test_color_replace_folder(self):
        out = self.d / "out"
        r = call("image_color_replace", path=str(self.src), output=str(out), **{"from": "#ff0000", "to": "#0000ff"})
        self.assertEqual(r["data"]["processed"], 2)
        self.assertEqual(self.px(out / "img0.png"), (0, 0, 255, 255))
        self.assertEqual(self.px(out / "img1.png"), (0, 255, 0, 255))      # non concernée
        self.assertEqual(self.px(self.src / "img0.png"), (255, 0, 0, 255))  # source intacte

    def test_color_replace_to_transparent(self):
        out = self.d / "t.png"
        call("image_color_replace", path=str(self.src / "img0.png"), output=str(out), **{"from": "red", "to": "transparent"})
        self.assertEqual(self.px(out)[3], 0)

    def test_overlay_skips_logo_and_places_it(self):
        out = self.d / "out"
        r = call("image_overlay", path=str(self.src), output=str(out), overlay=str(self.d / "logo.png"),
                 position="top-left", margin=0, scale=0)
        self.assertEqual(r["data"]["processed"], 2)
        self.assertEqual(self.px(out / "img0.png", (5, 5)), (0, 0, 255, 255))
        self.assertEqual(self.px(out / "img0.png", (40, 40)), (255, 0, 0, 255))

    def test_fit_pad_and_cover(self):
        pad = self.d / "pad.png"
        call("image_fit", path=str(self.src / "img0.png"), output=str(pad), width=100, height=100, mode="pad")
        self.assertEqual(Image.open(pad).size, (100, 100))
        self.assertEqual(self.px(pad, (0, 0))[3], 0)
        cov = self.d / "cov.png"
        call("image_fit", path=str(self.src / "img0.png"), output=str(cov), width=50, height=50, mode="cover")
        self.assertEqual(Image.open(cov).size, (50, 50))

    def test_adjust_requires_operation_and_works(self):
        with self.assertRaises(ValueError):
            call("image_adjust", path=str(self.src), output=str(self.d / "o"))
        out = self.d / "g.png"
        call("image_adjust", path=str(self.src / "img0.png"), output=str(out), grayscale=True)
        r, g, b, _ = self.px(out)
        self.assertTrue(r == g == b)

    def test_crop_trim_and_ratio(self):
        im = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
        im.paste((255, 0, 0, 255), (30, 40, 50, 60))
        im.save(self.d / "t.png")
        out = self.d / "trim.png"
        call("image_crop", path=str(self.d / "t.png"), output=str(out), trim=True)
        self.assertEqual(Image.open(out).size, (20, 20))
        sq = self.d / "sq.png"
        call("image_crop", path=str(self.src / "img0.png"), output=str(sq), ratio="1:1")
        self.assertEqual(Image.open(sq).size, (60, 60))

    def test_transform_rotate_90_swaps_size(self):
        out = self.d / "r.png"
        call("image_transform", path=str(self.src / "img0.png"), output=str(out), rotate=90)
        self.assertEqual(Image.open(out).size, (60, 80))

    def test_text_and_frame_and_optimize(self):
        t = self.d / "t.png"
        call("image_text", path=str(self.src / "img0.png"), output=str(t), text="Hi", color="#ffffff")
        self.assertNotEqual(list(Image.open(t).getdata()), list(Image.open(self.src / "img0.png").convert("RGBA").getdata()))
        f = self.d / "f.png"
        call("image_frame", path=str(self.src / "img0.png"), output=str(f), radius=20, border_width=4, shadow_blur=3)
        self.assertGreater(Image.open(f).width, 80)
        o = self.d / "opt"
        r = call("image_optimize", path=str(self.src), output=str(o), format="webp")
        self.assertTrue((o / "img0.webp").exists())
        self.assertIn("saved_bytes", r["data"])

    def test_generate_icon_palette_compare(self):
        for kind in ("solid", "gradient", "radial", "checker", "stripes", "noise"):
            p = self.d / f"{kind}.png"
            call("image_generate", output=str(p), kind=kind, width=64, height=64, color="#000000")
            self.assertEqual(Image.open(p).size, (64, 64))
        sym = load("image_icon_create")
        for s in sym.SYMBOLS:
            icon = self.d / f"i_{s}.png"
            call("image_icon_create", output=str(icon), size=64, symbol=s)
            self.assertEqual(Image.open(icon).size, (64, 64))
        for shape in sym.SHAPES:
            call("image_icon_create", output=str(self.d / f"s_{shape}.png"), size=64, shape=shape, text="A")
        pal = call("image_palette", path=str(self.src / "img0.png"), colors=2)
        self.assertEqual(pal["data"]["colors"][0]["hex"], "#ff0000")
        same = call("image_compare", path=str(self.src / "img0.png"), other=str(self.src / "img0.png"))
        self.assertTrue(same["data"]["identical"])
        diff = call("image_compare", path=str(self.src / "img0.png"), other=str(self.src / "img1.png"),
                    output=str(self.d / "diff.png"))
        self.assertFalse(diff["data"]["identical"])

    def test_sprite_sheet_roundtrip_and_app_icons(self):
        sheet = self.d / "sheet.png"
        r = call("image_sprite_sheet", path=str(self.src), output=str(sheet), columns=2)
        self.assertEqual(r["data"]["count"], 2)
        self.assertTrue(sheet.with_suffix(".json").exists())
        tiles = self.d / "tiles"
        r = call("image_sprite_sheet", path=str(sheet), output=str(tiles), tile_width=100, tile_height=60)
        self.assertEqual(r["data"]["written"], 2)
        icons = self.d / "icons"
        Image.new("RGBA", (1024, 1024), "#336699").save(self.d / "big.png")
        r = call("image_app_icons", path=str(self.d / "big.png"), output=str(icons))
        for f in ("icon.ico", "icon.png", "32x32.png", "128x128.png", "128x128@2x.png"):
            self.assertTrue((icons / f).exists(), f)

    def test_refuses_same_output_and_bad_color(self):
        with self.assertRaises(ValueError):
            call("image_adjust", path=str(self.src), output=str(self.src), grayscale=True)
        with self.assertRaises(ValueError):
            call("image_color_replace", path=str(self.src), output=str(self.d / "o"), **{"from": "pasunecouleur", "to": "red"})


if __name__ == "__main__":
    unittest.main()
