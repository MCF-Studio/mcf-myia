"""Décrit un .blend ou un .glb (objets, triangles, boîtes englobantes, matériaux, collisions)."""
import blender_runtime as br
from common import bounded


def execute(params):
    roots, denied = br.read_roots()
    path = br.check_input(params["file"], (".blend", ".glb"), roots, denied)
    timeout = bounded(params, "timeout", 120, 5, 600)
    with br.Job("blender_inspect") as job:
        res = job.run("runner_inspect", {"file": str(path), "read_roots": roots, "denied": denied}, timeout)
    if not res["completed"]:
        return br.incomplete(res)
    return {"data": {"file": str(path), **res["data"]}, "warnings": res["warnings"]}
