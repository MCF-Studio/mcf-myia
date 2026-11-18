"""Contrôle qualité d'un .glb : z-fighting, pièces qui flottent, faces dos à dos, normales, n-gones, UV."""
import blender_runtime as br
from common import bounded

PROFILES = ("game", "render", "print")


def execute(params):
    roots, denied = br.read_roots()
    path = br.check_input(params["file"], (".glb",), roots, denied)
    profile = params.get("profile", "game")
    if profile not in PROFILES:
        raise ValueError(f"profile : {', '.join(PROFILES)}")
    held = params.get("held", False)
    timeout = bounded(params, "timeout", 300, 5, 600)
    with br.Job("blender_qa") as job:
        res = job.run("runner_qa", {"file": str(path), "profile": profile, "held": held,
                                    "read_roots": roots, "denied": denied}, timeout)
    if not res["completed"]:
        return br.incomplete(res)
    data = {"file": str(path), **res["data"]}
    warnings = res["warnings"]
    if not data["pass"]:
        warnings.append("Contrôle échoué : corriger la spec (voir errors et zfighting_points), reconstruire avec "
                        "blender_build, puis relancer blender_qa.")
    return {"data": data, "warnings": warnings}
