import shutil
import subprocess


def _run(cmd, timeout=30):
    """(code, stdout) ; None si la commande n'existe pas. Commandes de lecture seule uniquement."""
    if not shutil.which(cmd[0]):
        return None
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
        return r.returncode, r.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None


def _first_line(res):
    return res[1].splitlines()[0] if res and res[0] == 0 and res[1] else None


def execute(params):
    rustc = _first_line(_run(["rustc", "--version"]))
    cargo = _first_line(_run(["cargo", "--version"]))
    rustup = _first_line(_run(["rustup", "--version"]))
    data = {"rustc": rustc, "cargo": cargo, "rustup": rustup}
    warnings = []
    if not rustc or not cargo:
        warnings.append("Rust n'est pas installé ou pas dans le PATH : https://rustup.rs")
    if rustup:
        active = _run(["rustup", "show", "active-toolchain"])
        data["active_toolchain"] = _first_line(active)
        tl = _run(["rustup", "toolchain", "list"])
        data["toolchains"] = tl[1].splitlines()[:20] if tl and tl[0] == 0 else []
        targets = _run(["rustup", "target", "list", "--installed"])
        data["targets"] = targets[1].splitlines()[:40] if targets and targets[0] == 0 else []
        comps = _run(["rustup", "component", "list", "--installed"])
        installed = comps[1].splitlines() if comps and comps[0] == 0 else []
        data["components"] = {
            "clippy": any(c.startswith("clippy") for c in installed),
            "rustfmt": any(c.startswith("rustfmt") for c in installed),
        }
        for name, ok in data["components"].items():
            if not ok:
                warnings.append(f"{name} absent : rustup component add {name}")
    elif rustc:
        warnings.append("rustup absent : toolchains et cibles non listées.")
    data["ok"] = bool(rustc and cargo)
    return {"data": data, "warnings": warnings}
