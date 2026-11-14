import shutil
import subprocess

from common import app_path, load_apps

CHECKS = {"python": ["python", "--version"], "rustc": ["rustc", "--version"], "cargo": ["cargo", "--version"],
          "git": ["git", "--version"], "node": ["node", "--version"]}


def _version(exe, arg="--version"):
    try:
        r = subprocess.run([exe, arg], capture_output=True, text=True, timeout=30)
        line = (r.stdout or r.stderr).strip().splitlines()
        return line[0] if line else ""
    except subprocess.TimeoutExpired:
        return None


def execute(_params):
    out = {}
    for name, cmd in CHECKS.items():
        path = shutil.which(cmd[0])
        out[name] = {"found": True, "path": path, "version": _version(path)} if path else {"found": False}
    for name, entry in load_apps(missing_ok=True).items():  # applis du catalogue (Godot, Blender…)
        path = app_path(entry)
        out[name] = {"found": True, "path": path, "version": _version(path)} if path else {"found": False}
    return {"data": out}
