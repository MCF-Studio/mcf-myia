"""Construit un objet 3D depuis une spec JSON : <name>.blend + <name>.glb optimisé pour Godot."""
import json
from pathlib import Path

import blender_runtime as br
from common import bounded

MAX_SPEC_BYTES = 2 * 1024 * 1024


def execute(params):
    spec_path = Path(params["spec"])
    if spec_path.suffix.lower() != ".json" or not spec_path.is_file():
        raise ValueError(f"spec : fichier .json existant attendu ({spec_path.name})")
    if spec_path.stat().st_size > MAX_SPEC_BYTES:
        raise ValueError("spec : 2 Mo au plus")
    try:
        raw = json.loads(spec_path.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise ValueError(f"spec : JSON invalide ({exc})") from None
    schema = br.spec_schema()
    spec, _ = schema.validate(raw)                     # forme d'abord : erreurs claires même sans bibliothèque
    slugs = schema.polyhaven_slugs(spec)
    textures = {}
    if slugs:
        lib, mats = br.polyhaven_manifest()
        schema.validate(raw, slugs=set(mats))
        textures = {s: br.texture_files(lib, mats, s) for s in slugs}
    timeout = bounded(params, "timeout", 300, 5, 600)
    name = spec["name"]
    dests = br.prepare_outputs(params["output"], [f"{name}.glb", f"{name}.blend"], params.get("overwrite", False),
                               sources=[spec_path])
    with br.Job("blender_build") as job:
        res = job.run("runner_build", {"spec": raw, "textures": textures}, timeout)   # revalidée dans Blender
        if not res["completed"]:
            return br.incomplete(res)
        written = br.deliver(job.out, dests)
    data = res["data"]
    data["files"] = {"glb": written[0], "blend": written[1]}
    missing = [s for s, t in textures.items() if len(t) < 3]
    warnings = res["warnings"]
    if missing:
        warnings.append(f"textures incomplètes dans la bibliothèque pour : {', '.join(missing)}")
    warnings.append("Étape suivante : blender_qa sur le .glb.")
    return {"data": data, "warnings": warnings}
