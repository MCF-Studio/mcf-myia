"""Quatre vues PNG 1024 px (avant, trois-quarts, arrière, dessus) et mesures de silhouette."""
import re
from pathlib import Path

import blender_runtime as br
from common import bounded

VIEWS = ("avant", "trois_quarts", "arriere", "dessus")


def execute(params):
    roots, denied = br.read_roots()
    path = br.check_input(params["file"], (".glb", ".blend"), roots, denied)
    timeout = bounded(params, "timeout", 300, 5, 600)
    stem = re.sub(r"[^A-Za-z0-9_-]", "_", Path(path).stem)[:64] or "vue"
    names = [f"{stem}_{v}.png" for v in VIEWS]
    dests = br.prepare_outputs(params["output"], names, params.get("overwrite", False), sources=[path])
    with br.Job("blender_render_views") as job:
        res = job.run("runner_render_views", {"file": str(path), "stem": stem, "read_roots": roots,
                                              "denied": denied}, timeout)
        if not res["completed"]:
            return br.incomplete(res)
        written = br.deliver(job.out, dests)
    data = {**res["data"], "files": written}
    return {"data": data, "warnings": res["warnings"]}
