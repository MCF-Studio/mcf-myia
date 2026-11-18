"""Exporte un .blend en .glb pour Godot, puis rouvre le .glb et compare objets et triangles."""
import re
from pathlib import Path

import blender_runtime as br
from common import bounded


def execute(params):
    roots, denied = br.read_roots()
    path = br.check_input(params["file"], (".blend",), roots, denied)
    timeout = bounded(params, "timeout", 300, 5, 600)
    stem = re.sub(r"[^A-Za-z0-9_-]", "_", Path(path).stem)[:64] or "export"
    dests = br.prepare_outputs(params["output"], [f"{stem}.glb"], params.get("overwrite", False), sources=[path])
    with br.Job("blender_export_glb") as job:
        res = job.run("runner_export_glb", {"file": str(path), "stem": stem, "read_roots": roots,
                                            "denied": denied}, timeout)
        if not res["completed"]:
            return br.incomplete(res)
        written = br.deliver(job.out, dests)
    data = {**res["data"], "file": written[0]}
    warnings = res["warnings"]
    if data["gaps"]:
        warnings.append("Le .glb relu diffère du .blend : voir gaps.")
    return {"data": data, "warnings": warnings}
