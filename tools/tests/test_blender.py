"""Tests des outils blender_* : python -m unittest discover -s tools/tests -v

Deux niveaux :
- sans Blender (CI) : schéma de la spec, ligne de commande fixe, empreintes des scripts, chemins, glb externes,
  analyse des .blend, polyhaven_find sur un manifest factice ;
- avec Blender 5.2 (poste local) : `set MYIA_TEST_BLENDER=1` ; utilisent tools/apps.json et tools/blender.json du
  poste, et écrivent dans un dossier temporaire.
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import blender_runtime as br  # noqa: E402
import safety  # noqa: E402
import tool_manager as tm  # noqa: E402
from test_manager import Base  # noqa: E402

sys.path.insert(0, str(TOOLS / "blender" / "_runners"))
import blendscan  # noqa: E402

schema = br.spec_schema()
EXAMPLES = TOOLS / "blender" / "examples"
BLENDER_TOOLS = ("blender_info", "blender_inspect", "blender_build", "blender_qa", "blender_render_views",
                 "blender_export_glb", "polyhaven_find")


def spec(*parts, **extra):
    return {"name": "Test", "materials": {"M": {"flat": [0.5, 0.5, 0.5]}}, "parts": list(parts),
            "collisions": [{"shape": "box", "size": [1, 1, 1], "loc": [0, 0, 0.5]}], **extra}


def errors_of(s, slugs=None):
    with unittest.TestCase().assertRaises(schema.SpecError) as cm:
        schema.validate(s, slugs)
    return cm.exception.errors


# ============================================================================= schéma de la spec
class Spec(unittest.TestCase):
    SHAPES = {
        "box": {"size": [1, 1, 1]},
        "boxz": {"size": [1, 1, 1], "bevel": 0.01},
        "obox": {"loc": [0, 0, 1], "axes": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "half": [0.1, 0.1, 0.1]},
        "cyl": {"r": 0.1, "h": 1, "seg": 8, "r2": 0.05},
        "cyl_between": {"a": [0, 0, 0], "b": [0, 0, 1], "r": 0.05},
        "torus": {"R": 0.3, "r": 0.02, "arc": 180},
        "prism": {"profile": [[0, 0], [1, 0], [0, 1]], "length": 2},
        "lathe": {"profile": [[0.5, 0], [0.6, 0], [0.6, 1]], "seg": 12, "phase": 15},
        "tube": {"points": [[0, 0, 0], [0, 0.5, 0.5], [0, 1, 0]], "r": 0.01},
        "heightfield": {"size": [2, 2], "seg": 8, "bottom": 0.0, "layers": [{"fn": "flat", "z": 0.2},
                        {"fn": "mound", "amp": 0.1, "center": [0, 0], "radius": 0.3}]},
        "mesh": {"verts": [[0, 0, 0], [1, 0, 0], [0, 1, 0]], "faces": [[0, 1, 2]]},
    }

    def test_reference_specs_are_valid(self):
        for f in ("playground_sandbox", "ev_charger_double", "well_stone"):
            s, warnings = schema.validate(json.loads((EXAMPLES / f"{f}.json").read_text(encoding="utf-8")))
            self.assertEqual(warnings, [], f)
            self.assertIn("polyhaven", json.dumps(s["materials"]))

    def test_every_shape_accepts_its_fields_and_refuses_an_unknown_one(self):
        self.assertEqual(set(self.SHAPES), set(schema.PRIMITIVES))
        for shape, fields in self.SHAPES.items():
            schema.validate(spec({"shape": shape, "mat": "M", **fields}))
            errs = errors_of(spec({"shape": shape, "mat": "M", "couleur": "rouge", **fields}))
            self.assertTrue(any(e.startswith("parts[0].couleur") and "champ inconnu" in e for e in errs), (shape, errs))

    def test_errors_cite_the_json_path_and_what_was_expected(self):
        errs = errors_of(spec({"shape": "box", "mat": "M", "size": [1, 1, 1]},
                              {"mirror": "x", "parts": [{"shape": "box", "mat": "M", "size": [1, -2, 1]}]}))
        self.assertTrue(any(e.startswith("parts[1].parts[0].size[1]") and "entre" in e for e in errs), errs)
        errs = errors_of(spec({"shape": "cyl", "mat": "Inconnu", "r": 0.1, "h": 1}))
        self.assertTrue(any(e.startswith("parts[0].mat") for e in errs), errs)
        errs = errors_of(spec({"shape": "cyl", "mat": "M", "r": 0.1, "h": 1, "seg": 500}))
        self.assertTrue(any(e.startswith("parts[0].seg") and "3 et 64" in e for e in errs), errs)

    def test_names_are_restricted(self):
        for bad in ("-P evil.py", "a;b", 'a"b', "a\nb", "a b", "é", "", "x" * 65, "../x", 12):
            errs = errors_of({**spec({"shape": "box", "mat": "M", "size": [1, 1, 1]}), "name": bad})
            self.assertTrue(any(e.startswith("name") for e in errs), (bad, errs))
        errs = errors_of({**spec({"shape": "box", "mat": "--python-expr", "size": [1, 1, 1]}),
                          "materials": {"--python-expr": {"flat": [0.5, 0.5, 0.5]}}})
        self.assertTrue(any(e.startswith("materials.--python-expr") for e in errs), errs)

    def test_bounds(self):
        box = {"shape": "box", "mat": "M", "size": [1, 1, 1]}
        self.assertTrue(errors_of(spec({**box, "size": [500, 1, 1]})))                       # > 200 m
        self.assertTrue(errors_of(spec({**box, "loc": [0, 0, 1e9]})))
        self.assertTrue(errors_of(spec({**box, "size": [1, float("nan"), 1]})))
        self.assertTrue(errors_of(spec({**box, "size": [1, True, 1]})))
        many = {"array": {"count": 100, "step": [1, 0, 0]}, "parts": [{"array": {"count": 30, "step": [0, 1, 0]},
                                                                         "parts": [box]}]}
        self.assertTrue(any("2000" in e for e in errors_of(spec(many))))                    # 3000 pièces
        dense = {"array": {"count": 50, "step": [0.1, 0, 0]},
                 "parts": [{"shape": "torus", "mat": "M", "R": 0.3, "r": 0.02, "seg": 64, "rseg": 64}]}
        self.assertTrue(any("200000" in e for e in errors_of(spec(dense, dense))))         # ~800 000 triangles
        mesh = {"shape": "mesh", "mat": "M", "verts": [[0, 0, 0]] * 3, "faces": [[0, 1, 5]]}
        self.assertTrue(any("indice" in e for e in errors_of(spec(mesh))))
        deep = box
        for _ in range(10):
            deep = {"group": {"loc": [0, 0, 0]}, "parts": [deep]}
        self.assertTrue(any("niveaux" in e for e in errors_of(spec(deep))))

    def test_hinged_parts(self):
        door = {"hinged": {"name": "Door", "pivot": [0.5, 0, 0], "axis": "Z", "angle": -100,
                           "collision": {"size": [1, 0.05, 2], "loc": [0, 0, 1]}, "handle": [0.9, -0.05, 1]},
                "parts": [{"shape": "boxz", "mat": "M", "size": [1, 0.04, 2]}]}
        schema.validate(spec(door))
        self.assertTrue(errors_of(spec(door, door)))                                         # même nom deux fois
        nested = {"group": {"loc": [0, 0, 0]}, "parts": [door]}
        self.assertTrue(any("premier niveau" in e for e in errors_of(spec(nested))))

    def test_materials(self):
        box = {"shape": "box", "mat": "M", "size": [1, 1, 1]}
        _, warnings = schema.validate({**spec(box), "materials": {"M": {"flat": [1.0, 0.0, 0.0]}}})
        self.assertTrue(any("saturée" in w for w in warnings))
        _, warnings = schema.validate({**spec(box), "materials": {"M": {"emissive": [1.0, 0.0, 0.0]}}})
        self.assertEqual(warnings, [])
        errs = errors_of({**spec(box), "materials": {"M": {"polyhaven": "absent_01"}}}, slugs={"sand_01"})
        self.assertTrue(any("polyhaven_find" in e for e in errs))
        errs = errors_of({**spec(box), "materials": {"M": {"flat": [0.5] * 3, "kit": "Wood"}}})
        self.assertTrue(any("exactement un" in e for e in errs))
        s, _ = schema.validate({**spec(box), "materials": {"M": {"kit": "Painted_Red"}}})
        self.assertEqual(schema.polyhaven_slugs(s), ["white_stucco"])

    def test_warnings_for_missing_collisions_and_unused_materials(self):
        s = spec({"shape": "box", "mat": "M", "size": [1, 1, 1]})
        s.pop("collisions")
        s["materials"]["X"] = {"kit": "Rubber"}
        _, warnings = schema.validate(s)
        self.assertTrue(any("collision" in w for w in warnings))
        self.assertTrue(any("X" in w for w in warnings))


# ============================================================================= .blend et .glb
def blend_v5(blocks):
    """Petit .blend au format de Blender 5 : en-tête 17 octets, BHead de 32 octets."""
    out = b"BLENDER17-01v0502"
    for code, body in blocks + [(b"ENDB", b"")]:
        out += struct.pack("<4sIQqq", code, 0, 0, len(body), 1) + body
    return out


def blend_legacy(blocks):
    out = b"BLENDER-v405"
    for code, body in blocks + [(b"ENDB", b"")]:
        out += struct.pack("<4siQii", code, len(body), 0, 0, 1) + body
    return out


class BlendScan(unittest.TestCase):
    def test_linked_libraries_and_external_files_are_found_before_opening(self):
        for make in (blend_v5, blend_legacy):
            self.assertEqual(blendscan.scan(make([(b"REND", b"x" * 8), (b"OB\0\0", b"OBCube\0")])), [])
            issues = blendscan.scan(make([(b"LI\0\0", b"LIlib.blend\0//\\\\serveur\\partage\\lib.blend\0")]))
            self.assertEqual(len(issues), 1)
            self.assertIn("bibliothèque liée", issues[0])
            self.assertEqual(blendscan.scan(make([(b"VF\0\0", b"VFBfont\0<builtin>\0")])), [])
            self.assertTrue(blendscan.scan(make([(b"VF\0\0", b"VFfont\0C:/f.ttf\0")])))
            self.assertTrue(blendscan.scan(make([(b"SO\0\0", b"SOson\0")])))

    def test_unreadable_files_are_refused(self):
        with self.assertRaises(blendscan.BlendError):
            blendscan.scan(b"pas un blend")
        with self.assertRaises(blendscan.BlendError):
            blendscan.scan(blend_v5([(b"OB\0\0", b"x")])[:-10])                          # tronqué
        with self.assertRaises(blendscan.BlendError):
            blendscan.scan(blendscan.ZSTD_MAGIC + b"....")


def glb(doc):
    js = json.dumps(doc).encode()
    js += b" " * (-len(js) % 4)
    return b"glTF" + struct.pack("<II", 2, 20 + len(js)) + struct.pack("<II", len(js), 0x4E4F534A) + js


class Glb(unittest.TestCase):
    def test_external_references(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d).resolve()
            (d / "assets" / "tex").mkdir(parents=True)
            base, roots = d / "assets" / "models", [str(d / "assets")]
            base.mkdir()
            br.check_glb(glb({"images": [{"uri": "data:image/png;base64,AAAA"}], "buffers": [{"byteLength": 4}]}))
            br.check_glb(glb({"images": [{"uri": "../tex/a.png"}]}), base, roots)
            for uri in ("C:/Windows/a.png", "//serveur/partage/a.png", "\\\\serveur\\a.png", "file:///C:/a.png",
                        "http://exemple.org/a.png", "../../../a.png", "../tex/a.png:flux"):
                with self.assertRaises(PermissionError, msg=uri):
                    br.check_glb(glb({"images": [{"uri": uri}]}), base, roots)
            with self.assertRaises(PermissionError):
                br.check_glb(glb({"images": [{"uri": "../tex/a.png"}]}), base, roots, denied=[str(d / "assets" / "tex")])
            with self.assertRaises(PermissionError):                                       # sans base : autonome seulement
                br.check_glb(glb({"buffers": [{"uri": "a.bin"}]}))
            with self.assertRaises(ValueError):
                br.check_glb(b"pas un glb du tout")


# ============================================================================= lancement : empreintes, ligne de commande
class Runtime(unittest.TestCase):
    def test_digest_table_matches_the_reviewed_scripts(self):
        self.assertEqual(br.compute_digests(), br.RUNNER_DIGESTS,
                         "script Blender modifié : relire puis `python tools/blender_runtime.py --digests`")

    def test_a_modified_added_or_removed_script_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            for rel, src in br.code_files().items():
                (Path(d) / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, Path(d) / rel)
            br.check_digests(d)
            target = Path(d) / "_runners" / "runner_info.py"
            original = target.read_bytes()
            # Simple texte ajouté à une COPIE temporaire : jamais exécuté, seule son empreinte compte.
            target.write_bytes(original + b"\nimport os; os.system('calc')\n")
            with self.assertRaises(PermissionError):
                br.check_digests(d)
            target.write_bytes(original)
            (Path(d) / "_runners" / "bonus.py").write_text("x = 1\n", encoding="utf-8")
            with self.assertRaises(PermissionError):
                br.check_digests(d)
            (Path(d) / "_runners" / "bonus.py").unlink()
            target.unlink()
            with self.assertRaises(PermissionError):
                br.check_digests(d)

    def test_job_refuses_to_launch_when_a_digest_differs(self):
        table = {**br.RUNNER_DIGESTS, "_runners/runner_info.py": "0" * 64}
        with mock.patch.object(br, "RUNNER_DIGESTS", table), mock.patch("subprocess.run") as run:
            with self.assertRaises(PermissionError):
                with br.Job("blender_info"):
                    pass
            run.assert_not_called()

    def test_command_line_is_fixed(self):
        cmd = br.command("C:/b/blender.exe", "T/code/_runners/runner_build.py", "T/request.json", "T/result.json")
        self.assertEqual(cmd[:5], ["C:/b/blender.exe", "-b", "--factory-startup", "--disable-autoexec", "--offline-mode"])
        self.assertNotIn("--python-expr", cmd)
        self.assertNotIn("--enable-autoexec", cmd)
        self.assertEqual(cmd[-3:], ["--", "T/request.json", "T/result.json"])

    def test_environment_drops_python_and_blender_variables(self):
        with mock.patch.dict(os.environ, {"PYTHONPATH": "C:/piege", "BLENDER_USER_SCRIPTS": "C:/piege",
                                          "BLENDER_SYSTEM_SCRIPTS": "C:/piege", "PATH": os.environ.get("PATH", "")}):
            env = br._env()
        self.assertFalse([k for k in env if k.upper().startswith(("PYTHON", "BLENDER_"))])
        self.assertIn("PATH", env)

    def test_one_blender_at_a_time_per_tool(self):
        with br._Lock("blender_test_verrou"):
            with self.assertRaises(RuntimeError):
                with br._Lock("blender_test_verrou"):
                    pass
        with br._Lock("blender_test_verrou"):                                             # libéré
            pass

    def test_log_tail_keeps_useful_lines(self):
        text = "Blender 5.2.4 LTS\nRead prefs: x\n" + "\n".join(f"ligne {i}" for i in range(30)) + "\nBlender quit\n"
        tail = br.log_tail(text)
        self.assertEqual(len(tail.splitlines()), 20)
        self.assertNotIn("Blender quit", tail)


def fake_blender(captured, data=None):
    """Remplace subprocess.run : note la ligne de commande, écrit result.json comme un runner."""
    def run(cmd, **kw):
        captured.append((cmd, kw))
        req = json.loads(Path(cmd[-2]).read_text(encoding="utf-8"))
        out = Path(req["work"]) / "out"
        out.mkdir(parents=True, exist_ok=True)
        name = req.get("spec", {}).get("name", "x") if isinstance(req.get("spec"), dict) else "x"
        for f in (f"{name}.glb", f"{name}.blend"):
            (out / f).write_bytes(b"x")
        Path(cmd[-1]).write_text(json.dumps({"ok": True, "data": data or {"name": name, "tris": 12}, "warnings": []}),
                                 encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0)
    return run


class Tools(Base):
    def setUp(self):
        super().setUp()
        self.spec_path = self.r / "objet.json"
        self.spec_path.write_text(json.dumps(spec({"shape": "box", "mat": "M", "size": [1, 1, 1]})), encoding="utf-8")
        exe = mock.patch.object(br, "blender_exe", return_value="C:/faux/blender.exe")
        exe.start()
        self.addCleanup(exe.stop)

    def test_tools_are_declared_and_off_by_default(self):
        tools, _ = tm.discover()
        for name in BLENDER_TOOLS:
            self.assertIn(name, tools)
            self.assertEqual(tools[name][1]["category"], "blender")
        for name in ("blender_build", "blender_render_views", "blender_export_glb"):
            m = tools[name][1]
            self.assertEqual((m["risk"], m["parameters"]["output"]["access"]), ("local", "write"), name)
            self.assertIn("process.exec", m["permissions"])
        for name in ("blender_info", "blender_inspect", "blender_qa"):
            self.assertEqual(tools[name][1]["risk"], "read", name)
            self.assertIn("process.exec.readonly", tools[name][1]["permissions"])
        self.assertEqual(tools["polyhaven_find"][1]["permissions"], ["filesystem.read"])
        self.assertIn("5 mm", tools["blender_build"][1]["description"])
        with mock.patch("subprocess.run") as run:
            res = self.run_tool("blender_build", confirmed=True, spec=str(self.spec_path), output=str(self.w))
            self.assertRefused(res, "PermissionDenied")
            self.assertIn("désactivées par défaut", res["error"]["message"])
            self.assertRefused(self.run_tool("blender_info"), "PermissionDenied")
            run.assert_not_called()

    def test_build_is_confirmed_and_never_puts_model_values_on_the_command_line(self):
        self.grant("process.exec", "process.exec.readonly")
        captured = []
        with mock.patch("subprocess.run", side_effect=fake_blender(captured)):
            self.assertRefused(self.run_tool("blender_build", spec=str(self.spec_path), output=str(self.w)),
                               "ConfirmationRequired")
            self.assertEqual(captured, [])
            res = self.run_tool("blender_build", confirmed=True, spec=str(self.spec_path), output=str(self.w))
        self.assertTrue(res["success"], res)
        self.assertTrue((self.w / "Test.glb").is_file() and (self.w / "Test.blend").is_file())
        cmd, kw = captured[0]
        self.assertEqual(cmd[:5], ["C:/faux/blender.exe", *br.FIXED_ARGS])
        tmp = os.path.realpath(tempfile.gettempdir())
        for arg in cmd[len(br.FIXED_ARGS) + 4:]:
            if arg != "--":
                self.assertTrue(os.path.realpath(arg).startswith(tmp), arg)
        self.assertNotIn("Test", " ".join(cmd))                       # le nom de l'objet reste dans les données
        self.assertFalse([k for k in kw["env"] if k.upper().startswith("PYTHON")])
        self.assertIn("timeout", kw)

    def test_hostile_values_never_reach_the_command_line(self):
        self.grant("process.exec", "process.exec.readonly")
        for bad in ("-P evil.py", "--python-expr=import os", "a;calc", 'a" --enable-autoexec "', "a\n--python x"):
            self.spec_path.write_text(json.dumps({**spec({"shape": "box", "mat": "M", "size": [1, 1, 1]}),
                                                  "name": bad}), encoding="utf-8")
            with mock.patch("subprocess.run") as run:
                res = self.run_tool("blender_build", confirmed=True, spec=str(self.spec_path), output=str(self.w))
                self.assertRefused(res, "SpecError")
                run.assert_not_called()
        with mock.patch("subprocess.run") as run:
            for bad in ("-P", "--python-expr", "-b;calc"):                   # chemins hostiles : relatifs, hors dossiers
                self.assertRefused(self.run_tool("blender_inspect", file=bad))
                self.assertRefused(self.run_tool("blender_build", confirmed=True, spec=bad, output=str(self.w)))
            run.assert_not_called()

    def test_outputs_go_only_where_allowed(self):
        self.grant("process.exec", "process.exec.readonly")
        (self.w / ".git").mkdir()
        (self.w / ".claude").mkdir()
        with mock.patch("subprocess.run") as run:
            for out in (self.out, self.r, self.w / ".git", self.w / ".claude" / "x", TOOLS / "blender"):
                res = self.run_tool("blender_build", confirmed=True, spec=str(self.spec_path), output=str(out))
                self.assertRefused(res)
            run.assert_not_called()

    def test_existing_outputs_are_kept_without_overwrite(self):
        self.grant("process.exec", "process.exec.readonly")
        (self.w / "Test.glb").write_bytes(b"ancien")
        captured = []
        with mock.patch("subprocess.run", side_effect=fake_blender(captured)):
            self.assertRefused(self.run_tool("blender_build", confirmed=True, spec=str(self.spec_path),
                                             output=str(self.w)), "FileExistsError")
            self.assertEqual(captured, [])
            self.assertTrue(self.run_tool("blender_build", confirmed=True, spec=str(self.spec_path), output=str(self.w),
                                          overwrite=True)["success"])
        self.assertEqual((self.w / "Test.glb").read_bytes(), b"x")

    def test_timeout_reports_incomplete_and_delivers_nothing(self):
        self.grant("process.exec", "process.exec.readonly")
        with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired("blender", 5)):
            res = self.run_tool("blender_build", confirmed=True, spec=str(self.spec_path), output=str(self.w),
                                timeout=5)
        self.assertTrue(res["success"])
        self.assertFalse(res["data"]["completed"])
        self.assertFalse((self.w / "Test.glb").exists())

    def test_temporary_folder_is_removed_even_on_error(self):
        self.grant("process.exec", "process.exec.readonly")
        seen = []

        def boom(cmd, **kw):
            seen.append(Path(cmd[-2]).parent)
            raise OSError("panne")
        with mock.patch("subprocess.run", side_effect=boom):
            self.assertRefused(self.run_tool("blender_build", confirmed=True, spec=str(self.spec_path),
                                             output=str(self.w)), "OSError")
        self.assertFalse(seen[0].exists())

    def test_glb_input_with_an_external_file_is_refused_before_blender(self):
        self.grant("process.exec", "process.exec.readonly")
        (self.r / "m.glb").write_bytes(glb({"images": [{"uri": "C:/Windows/win.ini"}]}))
        with mock.patch("subprocess.run") as run:
            self.assertRefused(self.run_tool("blender_qa", file=str(self.r / "m.glb")), "PermissionError")
            run.assert_not_called()


class PolyhavenFind(Base):
    def setUp(self):
        super().setUp()
        lib = self.r / "polyhaven"
        mats = {
            "brown_planks_03": {"name": "Brown Planks 03", "folder": "wood", "tags": ["planks", "wood", "brown"]},
            "weathered_planks": {"name": "Weathered Planks", "folder": "wood", "tags": ["planks", "old", "worn", "wood"]},
            "rust_coarse_01": {"name": "Rust Coarse 01", "folder": "metal", "tags": ["rust", "metal"]},
            "sand_01": {"name": "Sand 01", "folder": "sand", "tags": ["sand", "beach"]},
            "evasion": {"name": "Evasion", "folder": "x", "tags": ["wood"],
                        "files": {"diff": "../../../Windows/win.ini"}},
        }
        for slug, m in mats.items():
            m.setdefault("files", {k: f"{m['folder']}/{slug}/{slug}_{k}_2k.jpg" for k in ("diff", "nor_gl", "arm")})
            for rel in m["files"].values():
                p = lib / rel
                if safety.inside(str(p), str(lib)):
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_bytes(b"jpg")
        lib.mkdir(exist_ok=True)
        (lib / "manifest.json").write_text(json.dumps({"materials": mats}), encoding="utf-8")
        cfg = self.d / "blender.json"
        cfg.write_text(json.dumps({"polyhaven_library": str(lib)}), encoding="utf-8")
        patch = mock.patch.object(br, "CONFIG_PATH", cfg)
        patch.start()
        self.addCleanup(patch.stop)

    def test_relevance_order_french_words_and_limit(self):
        res = self.run_tool("polyhaven_find", query="planches bois usé")
        self.assertTrue(res["success"], res)
        self.assertEqual([r["slug"] for r in res["data"]["results"]], ["weathered_planks"])
        res = self.run_tool("polyhaven_find", query="bois", limite=2)
        self.assertEqual(len(res["data"]["results"]), 2)
        self.assertTrue(res["data"]["truncated"])
        self.assertEqual(res["data"]["results"][0]["textures"]["diff"],
                         str((self.r / "polyhaven" / "wood" / "brown_planks_03" / "brown_planks_03_diff_2k.jpg")))
        res = self.run_tool("polyhaven_find", query="licorne")
        self.assertEqual(res["data"]["results"], [])
        self.assertTrue(res["warnings"])

    def test_texture_paths_never_leave_the_library(self):
        res = self.run_tool("polyhaven_find", query="wood", limite=20)
        ev = next(r for r in res["data"]["results"] if r["slug"] == "evasion")
        self.assertIsNone(ev["textures"]["diff"])

    def test_missing_configuration_is_explained(self):
        with mock.patch.object(br, "CONFIG_PATH", self.d / "absent.json"):
            res = self.run_tool("polyhaven_find", query="bois")
        self.assertRefused(res, "FileNotFoundError")
        self.assertIn("blender.example.json", res["error"]["message"])


class Published(unittest.TestCase):
    def test_example_config_holds_no_personal_path_and_local_one_is_not_tracked(self):
        text = (TOOLS / "blender.example.json").read_text(encoding="utf-8")
        self.assertNotRegex(text, r"(?i)users[\\/]|appdata|game_dev|program files")
        tracked = subprocess.run(["git", "ls-files", "blender.json"], cwd=TOOLS, capture_output=True, text=True)
        if tracked.returncode == 0:
            self.assertEqual(tracked.stdout.strip(), "")

    def test_vendored_code_keeps_its_license(self):
        lic = (TOOLS / "blender" / "_vendor" / "LICENSE-blender-agent-skills.txt").read_text(encoding="utf-8")
        self.assertIn("MIT License", lic)
        self.assertIn("EL4CTEO", lic)
        for f in ("qa_check.py", "_bpyx.py"):
            self.assertIn("licence MIT", (TOOLS / "blender" / "_vendor" / f).read_text(encoding="utf-8")[:400])


# ============================================================================= avec Blender 5.2 (poste local)
@unittest.skipUnless(os.environ.get("MYIA_TEST_BLENDER") == "1", "MYIA_TEST_BLENDER=1 pour lancer le vrai Blender")
class WithBlender(Base):
    REFERENCES = {"playground_sandbox": ("Playground_Sandbox", 934), "ev_charger_double": ("EVCharger_Double", 1976),
                  "well_stone": ("WellStone", 692)}

    def setUp(self):
        super().setUp()
        self.grant("process.exec", "process.exec.readonly")

    def build(self, spec_path, **kw):
        res = self.run_tool("blender_build", confirmed=True, spec=str(spec_path), output=str(self.w), **kw)
        self.assertTrue(res["success"], res)
        return res["data"]

    def qa(self, path, **kw):
        res = self.run_tool("blender_qa", file=str(path), **kw)
        self.assertTrue(res["success"], res)
        return res["data"]

    def test_info(self):
        res = self.run_tool("blender_info")
        self.assertTrue(res["success"], res)
        self.assertTrue(res["data"]["version_ok"], res["data"]["version"])

    def test_reference_specs_build_pass_qa_render_and_export(self):
        for f, (name, claude_tris) in self.REFERENCES.items():
            shutil.copyfile(EXAMPLES / f"{f}.json", self.r / f"{f}.json")
            data = self.build(self.r / f"{f}.json")
            self.assertLessEqual(abs(data["tris"] - claude_tris), claude_tris * 0.1, (name, data["tris"]))
            q = self.qa(self.w / f"{name}.glb")
            self.assertTrue(q["pass"], (name, q["errors"]))
        res = self.run_tool("blender_render_views", confirmed=True, file=str(self.w / "WellStone.glb"),
                            output=str(self.w / "vues"))
        self.assertTrue(res["success"], res)
        self.assertEqual(len(res["data"]["files"]), 4)
        for p in res["data"]["files"]:
            self.assertGreater(os.path.getsize(p), 10_000, p)
        res = self.run_tool("blender_export_glb", confirmed=True, file=str(self.w / "EVCharger_Double.blend"),
                            output=str(self.w / "export"))
        self.assertTrue(res["success"], res)
        self.assertEqual(res["data"]["gaps"], [])
        res = self.run_tool("blender_inspect", file=str(self.w / "Playground_Sandbox.blend"))
        self.assertTrue(res["success"], res)
        self.assertEqual(res["data"]["collisions"], 5)

    def test_faulty_model_fails_with_the_right_pair_and_piece(self):
        (self.r / "fautif.json").write_text(json.dumps({
            "name": "Fautif", "materials": {"B": {"kit": "Concrete"}, "R": {"kit": "Painted_Red"}},
            "parts": [{"shape": "boxz", "size": [1, 1, 0.5], "mat": "B"},
                      {"shape": "boxz", "size": [0.4, 0.4, 0.5], "loc": [0.5, 0, 0], "mat": "R"},     # dessus coplanaires
                      {"shape": "box", "size": [0.2, 0.2, 0.2], "loc": [0, 0, 1.5], "mat": "R"}],     # en l'air
            "collisions": [{"shape": "box", "size": [1, 1, 0.5], "loc": [0, 0, 0.25]}]}), encoding="utf-8")
        self.build(self.r / "fautif.json")
        q = self.qa(self.w / "Fautif.glb")
        self.assertFalse(q["pass"])
        self.assertTrue(q["zfighting_points"])
        for p in q["zfighting_points"]:
            self.assertAlmostEqual(p["center"][2], 0.5, places=2)
            self.assertGreaterEqual(p["center"][0], 0.3 - 1e-3)
        self.assertEqual([f["center"] for f in q["floating"]], [[0.0, 0.0, 1.5]])
        self.assertTrue(any("5 mm" in e for e in q["errors"]))

    def test_a_startup_script_in_a_blend_never_runs(self):
        witness = self.w / "temoin.txt"
        maker = self.d / "fabrique.py"
        maker.write_text(
            "import bpy, sys\n"
            "out, witness = sys.argv[sys.argv.index('--') + 1:]\n"
            "bpy.ops.wm.read_factory_settings(use_empty=True)\n"
            "bpy.ops.mesh.primitive_cube_add()\n"
            "t = bpy.data.texts.new('demarrage.py')\n"
            "t.write('open(%r, \"w\").write(\"x\")\\n' % witness)\n"
            "t.use_module = True\n"
            "bpy.ops.wm.save_as_mainfile(filepath=out)\n", encoding="utf-8")
        subprocess.run([br.blender_exe(), "-b", "--factory-startup", "--python", str(maker), "--",
                        str(self.r / "piege.blend"), str(witness)], capture_output=True, timeout=120, check=True)
        self.assertFalse(witness.exists())
        res = self.run_tool("blender_inspect", file=str(self.r / "piege.blend"))
        self.assertTrue(res["success"], res)
        self.assertFalse(witness.exists(), "le script de démarrage du .blend a été exécuté")

    def test_timeout_stops_blender(self):
        shutil.copyfile(EXAMPLES / "well_stone.json", self.r / "well_stone.json")
        res = self.run_tool("blender_build", confirmed=True, spec=str(self.r / "well_stone.json"), output=str(self.w),
                            timeout=5)
        self.assertTrue(res["success"], res)
        self.assertFalse(res["data"]["completed"])
        self.assertFalse((self.w / "WellStone.glb").exists())


if __name__ == "__main__":
    unittest.main()
