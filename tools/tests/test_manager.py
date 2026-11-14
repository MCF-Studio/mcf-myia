"""Tests du gestionnaire et des règles de sécurité : python -m unittest discover -s tools/tests -v

Chaque test correspond à une règle de docs/SPEC.md §3 (boîte à outils). Aucun chemin propre à un poste : tout se
passe dans un dossier temporaire, avec une politique écrite pour le test."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS))

import common  # noqa: E402
import safety  # noqa: E402
import tool_manager as tm  # noqa: E402

EXEC = ["process.exec.readonly", "process.exec", "app.launch", "url.open"]


def load_tool(category, name):
    spec = importlib.util.spec_from_file_location(f"t_{name}", TOOLS / category / name / "tool.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.d = Path(self._tmp.name).resolve()      # chemin réel (pas de nom court 8.3)
        self.r, self.w, self.out = self.d / "lecture", self.d / "ecriture", self.d / "dehors"
        for p in (self.r, self.w, self.out):
            p.mkdir()
        self.policy_path = self.d / "policy.json"
        self.grant()
        patch = mock.patch.object(tm, "POLICY_PATH", self.policy_path)
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(self._tmp.cleanup)

    def grant(self, *extra, read=None, write=None):
        self.policy_path.write_text(json.dumps({
            "allowed_dirs": {"read": [str(p) for p in (read or [self.r, self.w])],
                             "write": [str(p) for p in (write or [self.w])]},
            "granted_permissions": ["filesystem.read", "filesystem.write", *extra]}), encoding="utf-8")

    def run_tool(self, name, confirmed=False, **params):
        return tm.run(name, params, confirmed=confirmed)

    def assertRefused(self, res, kind="PermissionDenied"):
        self.assertFalse(res["success"], res)
        self.assertEqual(res["error"]["type"], kind, res)


class Startup(Base):
    def test_refuses_to_start_without_local_policy(self):
        with mock.patch.object(tm, "POLICY_PATH", self.d / "absente.json"):
            self.assertRefused(self.run_tool("text_read", path=str(self.r / "a.txt")), "PolicyMissing")
            res, code = tm.main(["list"])
            self.assertRefused(res, "PolicyMissing")
            self.assertEqual(code, 1)
            self.assertIn("policy.example.json", res["error"]["message"])

    def test_invalid_policy_is_a_json_refusal(self):
        self.policy_path.write_text("{pas du json", encoding="utf-8")
        self.assertRefused(self.run_tool("text_read", path=str(self.r / "a.txt")), "PolicyInvalid")
        self.policy_path.write_text(json.dumps({"allowed_dirs": {"read": [], "write": []},
                                                "granted_permissions": ["tout"]}), encoding="utf-8")
        self.assertRefused(tm.main(["list"])[0], "PolicyInvalid")
        root = os.path.splitdrive(str(self.d))[0] + os.sep
        self.grant(write=[root])                      # un disque entier en écriture
        self.assertRefused(tm.main(["list"])[0], "PolicyInvalid")

    def test_published_examples_grant_nothing_dangerous_and_hold_no_personal_path(self):
        policy = json.loads((TOOLS / "policy.example.json").read_text(encoding="utf-8"))
        self.assertEqual(policy["allowed_dirs"], {"read": [], "write": []})
        self.assertFalse(set(policy["granted_permissions"]) & set(tm.EXEC_PERMISSIONS))
        self.assertNotIn("network.local", policy["granted_permissions"])
        apps = json.loads((TOOLS / "apps.example.json").read_text(encoding="utf-8"))
        for entry in (a for k, a in apps.items() if not k.startswith("_")):
            self.assertEqual(entry["allowed_args"], [])
            self.assertEqual(entry["open_extensions"], [])
        for name in ("policy.example.json", "apps.example.json"):
            self.assertNotRegex((TOOLS / name).read_text(encoding="utf-8"), r"(?i)users[\\/]|appdata|program files")
        tracked = subprocess.run(["git", "ls-files", "policy.json", "apps.json"], cwd=TOOLS, capture_output=True, text=True)
        if tracked.returncode == 0:                   # dans un dépôt : les fichiers locaux ne sont pas suivis
            self.assertEqual(tracked.stdout.strip(), "")

    def test_malformed_call_is_a_json_reply_not_a_traceback(self):
        self.assertRefused(tm.run("text_read", "pas un objet"), "InvalidParams")
        self.assertRefused(tm.run("text_read", {"path": 12}), "InvalidParams")
        self.assertRefused(tm.run("text_read", {"path": str(self.r / "a.txt"), "inconnu": 1}), "InvalidParams")
        self.assertRefused(tm.run(None, {}), "UnknownTool")
        res, code = tm.main(["run", "text_read", "{cassé"])
        self.assertRefused(res, "InvalidParams")
        self.assertEqual(code, 1)
        self.assertRefused(tm.main(["nimporte"])[0], "Usage")
        self.assertRefused(tm.run("text_read", {"path": str(self.r / "absent.txt")}), "FileNotFoundError")


class Manifests(Base):
    def test_every_manifest_is_valid_and_declares_a_risk(self):
        tools, problems = tm.discover()
        self.assertEqual(problems, [])
        self.assertEqual(len(tools), 47)
        for name, (folder, m) in tools.items():
            self.assertIn(m["risk"], safety.RISKS, name)
            perms = m["permissions"]
            if "filesystem.write" in perms or "process.exec" in perms:
                self.assertIn(m["risk"], ("local", "external"), name)
        self.assertEqual(tools["url_open"][1]["risk"], "external")
        self.assertEqual(tools["url_open"][1]["permissions"], ["url.open"])
        for name in ("cargo_check", "cargo_test", "cargo_build", "cargo_clippy", "godot_headless_check"):
            m = tools[name][1]
            self.assertIn("process.exec", m["permissions"], name)
            self.assertEqual(m["parameters"]["project"]["access"], "write", name)   # target/ et .godot/ sont écrits

    def test_listing_reports_risk_and_what_is_disabled(self):
        res, code = tm.main(["list"])
        self.assertEqual(code, 0)
        by = {t["name"]: t for t in res["data"]}
        self.assertEqual(by["text_read"]["risk"], "read")
        self.assertTrue(by["text_write"]["needs_confirmation"])
        for name in ("cargo_check", "app_launch", "url_open", "git_status", "folder_open", "godot_headless_check"):
            self.assertFalse(by[name]["enabled"], name)
        self.assertTrue(by["image_fit"]["enabled"])

    def _fake_root(self):
        root = self.d / "boite"
        for cat, name, extra in (("a", "dup", {}), ("b", "dup", {}), ("a", "sorti", {"entrypoint": "../../x.py"}),
                                 ("a", "autre_nom", {"name": "menteur"}), ("a", "sans_risque", {"risk": None}),
                                 ("a", "trop_bas", {"risk": "read", "permissions": ["process.exec"]}),
                                 ("a", "bon", {})):
            folder = root / cat / name
            folder.mkdir(parents=True)
            (folder / "tool.py").write_text("def execute(p):\n    return {'data': 'ok'}\n", encoding="utf-8")
            m = {"name": name, "category": cat, "risk": "read", "description": "", "parameters": {}, "permissions": []}
            m.update(extra)
            (folder / "manifest.json").write_text(json.dumps({k: v for k, v in m.items() if v is not None}), encoding="utf-8")
        return root

    def test_duplicates_and_unsafe_manifests_are_never_loaded(self):
        with mock.patch.object(tm, "ROOT", self._fake_root()):
            tools, problems = tm.discover()
            self.assertEqual(sorted(tools), ["bon"])
            text = "\n".join(problems)
            for word in ("dup", "sorti", "autre_nom", "sans_risque", "trop_bas"):
                self.assertIn(word, text)
            self.assertRefused(tm.run("dup", {}), "UnknownTool")
            self.assertRefused(tm.run("sorti", {}), "UnknownTool")     # entrypoint hors du dossier de l'outil
            self.assertTrue(tm.run("bon", {})["success"])
            self.assertTrue(any("dup" in w for w in tm.main(["list"])[0]["warnings"]))

    def test_parameter_named_path_is_checked_even_without_type_or_kind(self):
        self.assertTrue(tm.is_path("path", {}))
        self.assertTrue(tm.is_path("output", {"type": "object"}))
        self.assertFalse(tm.is_path("path", {"kind": "text"}))
        manifest = {"parameters": {"path": {}}, "permissions": ["filesystem.read"]}
        policy = tm.load_policy()
        with self.assertRaises(tm.Refusal):
            tm.check_policy(manifest, {"path": str(self.out / "x.txt")}, policy)
        with self.assertRaises(tm.Refusal):
            tm.check_policy(manifest, {"path": ["pas", "une", "chaîne"]}, policy)


class Confirmation(Base):
    def test_local_tool_needs_the_callers_flag_and_returns_a_preview(self):
        target = self.w / "note.md"
        res = self.run_tool("text_write", path=str(target), content="bonjour")
        self.assertRefused(res, "ConfirmationRequired")
        self.assertEqual(res["risk"], "local")
        self.assertFalse(target.exists())
        preview = res["data"]["preview"]
        self.assertIn(str(target), preview["action"])
        self.assertEqual(preview["params"]["content"], "bonjour")
        self.assertEqual(preview["targets"][0]["access"], "write")
        res = self.run_tool("text_write", confirmed=True, path=str(target), content="bonjour")
        self.assertTrue(res["success"], res)
        self.assertEqual(target.read_text(encoding="utf-8"), "bonjour")

    def test_flag_comes_from_the_command_line_never_from_the_parameters(self):
        target = self.w / "n.md"
        self.assertRefused(tm.run("text_write", {"path": str(target), "content": "x", "confirmed": True}), "InvalidParams")
        self.assertRefused(tm.run("text_write", {"path": str(target), "content": "x"}, confirmed="oui"),
                           "ConfirmationRequired")
        payload = json.dumps({"path": str(target), "content": "x"})
        res, code = tm.main(["run", "text_write", payload])
        self.assertEqual((res["error"]["type"], code), ("ConfirmationRequired", 2))
        self.assertFalse(target.exists())
        res, code = tm.main(["run", "text_write", payload, "--confirmed"])
        self.assertEqual((res["success"], code), (True, 0))

    def test_read_tool_runs_without_confirmation(self):
        (self.r / "a.txt").write_text("un\ndeux\n", encoding="utf-8")
        res = self.run_tool("text_read", path=str(self.r / "a.txt"))
        self.assertTrue(res["success"], res)
        self.assertEqual((res["risk"], res["data"]["total_lines"]), ("read", 2))

    def test_every_image_tool_that_writes_is_confirmed(self):
        res = self.run_tool("image_generate", output=str(self.w / "g.png"))
        self.assertRefused(res, "ConfirmationRequired")
        self.assertFalse((self.w / "g.png").exists())

    def test_external_tool_is_confirmed_even_when_its_permission_is_granted(self):
        self.grant("url.open")
        res = self.run_tool("url_open", url="https://example.org/?q=secret")
        self.assertRefused(res, "ConfirmationRequired")
        self.assertEqual(res["risk"], "external")
        self.assertEqual(res["data"]["preview"]["params"]["url"], "https://example.org/?q=secret")


class Writes(Base):
    def write(self, rel, content="x", **kw):
        return self.run_tool("text_write", confirmed=True, path=str(self.w / rel), content=content, **kw)

    def test_write_into_git_and_other_autorun_folders_is_refused(self):
        (self.w / ".git").mkdir()
        (self.w / ".git" / "config").write_text("[core]\n", encoding="utf-8")
        for rel in (".git/config", ".git/hooks/pre-commit.txt", ".github/workflows/ci.yml", ".vscode/notes.json",
                    ".claude/notes.md", ".cargo/notes.toml", "projet/node_modules/x/readme.md", ".GIT/config.txt"):
            self.assertRefused(self.write(rel), "PermissionDenied")
            self.assertFalse((self.w / rel).exists() and rel != ".git/config", rel)
        self.assertEqual((self.w / ".git" / "config").read_text(encoding="utf-8"), "[core]\n")
        res = self.run_tool("text_patch", confirmed=True, path=str(self.w / ".git" / "config"), old="[core]", new="[x]")
        self.assertRefused(res, "PermissionDenied")
        # un outil image ne peut pas davantage y déposer un fichier
        self.assertRefused(self.run_tool("image_generate", confirmed=True, output=str(self.w / ".git" / "a.png")))

    def test_executable_code_and_tool_driving_files_are_refused(self):
        for rel in ("build.rs", "run.bat", "x.ps1", "a.py", "main.gd", "lib.js", "x.cmd", "x.sh", "x.exe", "x.lnk",
                    "Cargo.toml", "package.json", "CLAUDE.md", "AGENTS.md", ".mcp.json", "projet/pyproject.toml",
                    "sans_extension", "x.txt.", "a.txt:b.exe", "nul.txt", "project.godot"):
            res = self.write(rel)
            self.assertFalse(res["success"], rel)
            self.assertIn(res["error"]["type"], ("PermissionDenied", "PermissionError"), (rel, res))
        self.assertEqual(sorted(p.name for p in self.w.rglob("*") if p.is_file()), [])
        (self.w / "main.rs").write_text("fn main() {}\n", encoding="utf-8")
        res = self.run_tool("text_patch", confirmed=True, path=str(self.w / "main.rs"), old="main", new="evil")
        self.assertFalse(res["success"])
        self.assertEqual((self.w / "main.rs").read_text(encoding="utf-8"), "fn main() {}\n")

    def test_text_formats_are_written_and_never_overwritten_silently(self):
        for rel in ("a.md", "b.json", "sous/c.yaml", "d.csv", "e.html"):
            self.assertTrue(self.write(rel)["success"], rel)
        res = self.write("a.md", "nouveau")
        self.assertRefused(res, "FileExistsError")
        self.assertEqual((self.w / "a.md").read_text(encoding="utf-8"), "x")
        res = self.write("a.md", "nouveau", overwrite=True)
        self.assertTrue(res["success"], res)
        self.assertEqual((self.w / "a.md.bak").read_text(encoding="utf-8"), "x")
        self.assertRefused(self.write("gros.txt", "é" * 600_000), "ValueError")     # 1,2 Mo en UTF-8

    def test_paths_outside_the_allowed_folders_are_refused(self):
        self.assertRefused(self.run_tool("text_write", confirmed=True, path=str(self.out / "a.md"), content="x"))
        self.assertRefused(self.run_tool("text_write", confirmed=True, path=str(self.w / ".." / "dehors" / "a.md"), content="x"))
        self.assertRefused(self.run_tool("text_write", confirmed=True, path=str(self.r / "a.md"), content="x"))  # lecture seule
        (self.out / "secret.txt").write_text("s", encoding="utf-8")
        self.assertRefused(self.run_tool("text_read", path=str(self.out / "secret.txt")))
        self.assertRefused(self.run_tool("text_read", path="\\\\serveur\\partage\\a.txt"))
        self.assertEqual(list(self.out.glob("*.md")), [])

    def test_a_link_out_of_the_allowed_folder_is_followed_before_the_check(self):
        try:
            os.symlink(self.out, self.w / "lien", target_is_directory=True)
        except (OSError, NotImplementedError):
            try:                                      # Windows sans droit de créer un lien : une jonction suffit
                import _winapi
                _winapi.CreateJunction(str(self.out), str(self.w / "lien"))
            except Exception:
                self.skipTest("ni lien symbolique ni jonction disponibles sur ce poste")
        self.assertRefused(self.run_tool("text_write", confirmed=True, path=str(self.w / "lien" / "a.md"), content="x"))
        self.assertFalse((self.out / "a.md").exists())

    def test_the_toolbox_cannot_write_into_itself(self):
        self.grant(read=[TOOLS], write=[TOOLS])       # même si la politique locale l'ouvrait
        for name, params in (("text_write", {"path": str(TOOLS / "zz_test.md"), "content": "x"}),
                             ("text_write", {"path": str(TOOLS / "files" / "text_write" / "notes.md"), "content": "x"}),
                             ("image_generate", {"output": str(TOOLS / "zz_test.png")})):
            res = tm.run(name, params, confirmed=True)
            self.assertRefused(res, "PermissionDenied")
            self.assertIn("boîte à outils", res["error"]["message"])
        self.assertFalse((TOOLS / "zz_test.md").exists() or (TOOLS / "zz_test.png").exists())

    def test_the_repository_holding_the_toolbox_is_closed_except_its_workspace(self):
        repo = self.d / "depot"
        with mock.patch.object(safety, "REPO", repo):
            for rel in ("docs/x.md", "agent/src/x.json", "README.md"):
                with self.assertRaises(PermissionError):
                    safety.check_write_target(str(repo / rel))
            safety.check_write_target(str(repo / "workspace" / "x.md"))
            for rel in ("data/cles.json", "config/agent.json"):
                with self.assertRaises(PermissionError):
                    safety.check_read_target(str(repo / rel))
            safety.check_read_target(str(repo / "docs" / "SPEC.md"))

    def test_text_read_is_bounded(self):
        big = self.r / "gros.log"
        big.write_text("\n".join(f"ligne {i} " + "x" * 3000 for i in range(5000)), encoding="utf-8")
        self.assertRefused(self.run_tool("text_read", path=str(big), lines=100_000), "InvalidParams")
        data = load_tool("files", "text_read").execute({"path": str(big), "lines": 100_000})["data"]
        self.assertEqual(len(data["text"].splitlines()), 2000)
        self.assertTrue(all(len(line) < 2100 for line in data["text"].splitlines()))
        self.assertTrue(data["truncated"])
        (self.r / "bin.dat").write_bytes(b"\0\1\2" * 100)
        self.assertRefused(self.run_tool("text_read", path=str(self.r / "bin.dat")), "ValueError")


class Execution(Base):
    def test_tools_that_launch_a_program_are_off_by_default(self):
        (self.w / "Cargo.toml").write_text("[package]\n", encoding="utf-8")
        (self.w / "project.godot").write_text("", encoding="utf-8")
        calls = {
            "cargo_check": {"project": str(self.w)}, "cargo_test": {"project": str(self.w)},
            "cargo_build": {"project": str(self.w)}, "cargo_clippy": {"project": str(self.w)},
            "cargo_fmt_check": {"project": str(self.w)}, "godot_headless_check": {"project": str(self.w)},
            "app_launch": {"app": "godot"}, "url_open": {"url": "https://example.org"},
            "folder_open": {"path": str(self.w)}, "notification_send": {"title": "t", "message": "m"},
            "git_status": {"repo": str(self.w)}, "git_diff": {"repo": str(self.w)}, "git_log": {"repo": str(self.w)},
            "environment_check": {}, "rust_environment_check": {},
        }
        with mock.patch("subprocess.Popen") as popen, mock.patch("subprocess.run") as run:
            for name, params in calls.items():
                res = tm.run(name, params, confirmed=True)       # même confirmé : la permission manque
                self.assertRefused(res, "PermissionDenied")
                self.assertIn("désactivées par défaut", res["error"]["message"], name)
            popen.assert_not_called()
            run.assert_not_called()

    def test_build_tools_stay_confirmed_once_their_permission_is_granted(self):
        (self.w / "Cargo.toml").write_text("[package]\n", encoding="utf-8")
        self.grant("process.exec")
        with mock.patch("subprocess.run") as run:
            for name in ("cargo_check", "cargo_test", "cargo_build", "cargo_clippy", "cargo_fmt_check"):
                res = self.run_tool(name, project=str(self.w))
                self.assertRefused(res, "ConfirmationRequired")
            run.assert_not_called()
        self.assertRefused(self.run_tool("cargo_check", confirmed=True, project=str(self.w), timeout=10**9), "InvalidParams")

    def test_cargo_needs_write_access_to_the_project(self):
        (self.r / "Cargo.toml").write_text("[package]\n", encoding="utf-8")
        self.grant("process.exec")
        with mock.patch("subprocess.run") as run:
            res = self.run_tool("cargo_check", confirmed=True, project=str(self.r))    # dossier en lecture seule
            self.assertRefused(res, "PermissionDenied")
            run.assert_not_called()

    def test_timeouts_and_limits_from_the_model_are_clamped(self):
        self.assertEqual(common.bounded({"timeout": 10**9}, "timeout", 60, 1, 600), 600)
        self.assertEqual(common.bounded({"timeout": -5}, "timeout", 60, 1, 600), 1)
        self.assertEqual(common.bounded({}, "timeout", 60, 1, 600), 60)
        with self.assertRaises(ValueError):
            common.bounded({"timeout": "long"}, "timeout", 60, 1, 600)
        with self.assertRaises(ValueError):
            common.bounded({"timeout": float("nan")}, "timeout", 60, 1, 600)


class AppLaunch(Base):
    def setUp(self):
        super().setUp()
        self.exe = self.d / "FauxEditeur.exe"
        self.exe.write_bytes(b"MZ")
        self.apps = self.d / "apps.json"
        self.set_apps(allowed_args=["--version"], open_extensions=[".blend"], forced_args=["--disable-autoexec"])
        patch = mock.patch.object(common, "APPS_PATH", self.apps)
        patch.start()
        self.addCleanup(patch.stop)
        self.tool = load_tool("system", "app_launch")

    def set_apps(self, executable=None, **entry):
        self.apps.write_text(json.dumps({"_doc": "test", "editeur": {
            "label": "Faux éditeur", "executable": str(executable or self.exe), "aliases": ["faux"], **entry}}),
            encoding="utf-8")

    def test_arguments_are_a_whitelist(self):
        _, cmd = self.tool.build_command({"app": "editeur", "args": ["--version"]})
        self.assertEqual(cmd, [str(self.exe), "--disable-autoexec", "--version"])
        for args in (["--path", str(self.w)], ["--script", "x.gd"], ["--version=1"], ["-s"], ["--python-expr", "1"],
                     [str(self.w / "projet")]):
            with self.assertRaises(PermissionError, msg=args):
                self.tool.build_command({"app": "editeur", "args": args})
        self.set_apps()                                # pas de liste : aucun argument
        with self.assertRaises(PermissionError):
            self.tool.build_command({"app": "editeur", "args": ["--version"]})
        self.assertEqual(self.tool.build_command({"app": "editeur"})[1], [str(self.exe)])

    def test_file_argument_is_limited_to_listed_extensions(self):
        scene, script = self.r / "scene.blend", self.r / "x.py"
        scene.write_bytes(b"BLENDER")
        script.write_text("print(1)", encoding="utf-8")
        self.assertEqual(self.tool.build_command({"app": "editeur", "file": str(scene)})[1][-1], str(scene))
        with self.assertRaises(PermissionError):
            self.tool.build_command({"app": "editeur", "file": str(script)})
        with self.assertRaises(FileNotFoundError):
            self.tool.build_command({"app": "editeur", "file": str(self.r / "absent.blend")})

    def test_file_argument_goes_through_the_folder_policy(self):
        self.grant("app.launch")
        outside = self.out / "scene.blend"
        outside.write_bytes(b"BLENDER")
        with mock.patch("subprocess.Popen") as popen:
            self.assertRefused(self.run_tool("app_launch", confirmed=True, app="editeur", file=str(outside)))
            self.assertRefused(self.run_tool("app_launch", app="editeur"), "ConfirmationRequired")
            self.assertRefused(self.run_tool("app_launch", confirmed=True, app="editeur", args=["--path", str(self.w)]),
                               "PermissionError")
            popen.assert_not_called()

    def test_shells_and_interpreters_cannot_be_catalogued(self):
        self.set_apps(executable=sys.executable)
        with self.assertRaises(PermissionError):
            self.tool.build_command({"app": "editeur"})

    def test_no_local_catalogue_means_nothing_to_launch(self):
        with mock.patch.object(common, "APPS_PATH", self.d / "absent.json"):
            with self.assertRaises(FileNotFoundError) as ctx:
                self.tool.build_command({"app": "editeur"})
            self.assertIn("apps.example.json", str(ctx.exception))
            self.assertEqual(common.load_apps(missing_ok=True), {})


class UrlOpen(unittest.TestCase):
    def test_only_plain_http_urls(self):
        check = load_tool("system", "url_open").check_url
        self.assertEqual(check(" https://example.org/a?b=1 "), ("https://example.org/a?b=1", "example.org"))
        for bad in ("file:///C:/Windows/win.ini", "javascript:alert(1)", "https://user:pw@example.org/", "http://",
                    "https://example.org/a b", "https://example.org/" + "a" * 3000, "ms-settings:"):
            with self.assertRaises(ValueError, msg=bad):
                check(bad)


class CodeSearch(Base):
    def setUp(self):
        super().setUp()
        (self.r / "a.txt").write_text("alpha\n" + "a" * 40 + "b\nfn main() {}\n", encoding="utf-8")
        self.tool = load_tool("dev", "code_search")

    def test_runaway_regex_is_stopped(self):
        self.tool.REGEX_TIMEOUT = 2
        with self.assertRaises(TimeoutError):
            self.tool.execute({"directory": str(self.r), "pattern": r"(a+)+$", "regex": True})

    def test_search_still_works_and_is_bounded(self):
        hit = self.tool.execute({"directory": str(self.r), "pattern": r"fn\s+\w+", "regex": True})["data"]
        self.assertEqual((hit["count"], hit["items"][0]["line"]), (1, 3))
        plain = self.tool.execute({"directory": str(self.r), "pattern": "(a+)+$"})["data"]     # texte : pas de regex
        self.assertEqual(plain["count"], 0)
        self.assertEqual(self.tool.execute({"directory": str(self.r), "pattern": "alpha"})["data"]["count"], 1)
        with self.assertRaises(ValueError):
            self.tool.execute({"directory": str(self.r), "pattern": "(", "regex": True})
        with self.assertRaises(ValueError):
            self.tool.execute({"directory": str(self.r), "pattern": "x" * 301})


@unittest.skipUnless(shutil.which("git"), "git absent")
class Git(Base):
    def git(self, *args):
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")}
        return subprocess.run(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", *args],
                              cwd=self.repo, capture_output=True, text=True, env=env)

    def setUp(self):
        super().setUp()
        self.repo = self.r / "depot"
        (self.repo / "sous").mkdir(parents=True)
        self.git("init", "-q")
        (self.repo / "sous" / "a.txt").write_text("un\n", encoding="utf-8")
        (self.repo / "b.txt").write_text("un\n", encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "premier")
        (self.repo / "sous" / "a.txt").write_text("deux\n", encoding="utf-8")
        (self.repo / "b.txt").write_text("deux\n", encoding="utf-8")
        self.grant("process.exec.readonly")
        self.marker = self.d / "execute.txt"

    def plant(self, key):
        """Config de dépôt piégée : une commande qui laisse une trace si git la lance."""
        script = self.d / "piege.sh"
        script.write_text(f"#!/bin/sh\necho lance > '{self.marker.as_posix()}'\n", encoding="utf-8", newline="\n")
        os.chmod(script, 0o755)
        self.git("config", key, script.as_posix())

    def test_hardening_flags_match_the_app(self):
        base = " ".join(common.GIT_BASE)
        for flag in ("--no-pager", "core.fsmonitor=false", "protocol.ext.allow=never", "log.showSignature=false",
                     "--literal-pathspecs"):
            self.assertIn(flag, base)
        with mock.patch.dict(os.environ, {"GIT_EXTERNAL_DIFF": "calc.exe", "GIT_DIR": "ailleurs"}):
            env = common.git_env()
        self.assertNotIn("GIT_EXTERNAL_DIFF", env)
        self.assertNotIn("GIT_DIR", env)
        self.assertEqual(env["GIT_TERMINAL_PROMPT"], "0")

    def test_repository_config_cannot_run_a_command_through_diff(self):
        self.plant("diff.external")
        self.git("diff")
        if not self.marker.exists():
            self.skipTest("ce git ne lance pas diff.external ici : le piège ne prouve rien")
        self.marker.unlink()
        res = self.run_tool("git_diff", repo=str(self.repo))
        self.assertTrue(res["success"], res)
        self.assertIn("deux", res["data"]["diff"])
        self.assertFalse(self.marker.exists(), "git_diff a lancé la commande de diff.external")

    def test_repository_config_cannot_run_a_command_through_status(self):
        self.plant("core.fsmonitor")
        self.git("status")
        trapped = self.marker.exists()
        if trapped:
            self.marker.unlink()
        res = self.run_tool("git_status", repo=str(self.repo))
        self.assertTrue(res["success"], res)
        self.assertEqual(res["data"]["count"], 2)
        self.assertFalse(self.marker.exists(), "git_status a lancé la commande de core.fsmonitor")
        if not trapped:
            self.skipTest("ce git ne lance pas core.fsmonitor ici : seul le résultat de git_status est vérifié")

    def test_diff_path_is_relative_to_the_repository_not_to_the_current_folder(self):
        res = self.run_tool("git_diff", repo=str(self.repo), path="sous/a.txt")     # le dossier courant est ailleurs
        self.assertTrue(res["success"], res)
        self.assertEqual([f["file"] for f in res["data"]["files"]], ["sous/a.txt"])
        for bad in ("../../dehors", str(self.out), "--output=x", "-O", "sous/../../x", ":(top)b.txt"):
            res = self.run_tool("git_diff", repo=str(self.repo), path=bad)
            self.assertFalse(res["success"], bad)
        self.assertRefused(self.run_tool("git_diff", repo=str(self.out)))

    def test_log_and_status(self):
        res = self.run_tool("git_log", repo=str(self.repo))
        self.assertTrue(res["success"], res)
        self.assertEqual(res["data"]["commits"][0]["subject"], "premier")


if __name__ == "__main__":
    unittest.main()
