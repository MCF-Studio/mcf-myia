"""Version de Blender, catalogue de blender_build et état de la bibliothèque Poly Haven."""
import blender_runtime as br


def execute(params):
    warnings = []
    with br.Job("blender_info") as job:
        res = job.run("runner_info", {}, 120)
    if not res["completed"]:
        return br.incomplete(res)
    data = res["data"]
    data["executable"] = br.blender_exe()
    if not data.get("version_ok"):
        warnings.append(f"Blender {data.get('version')} : les outils blender_* demandent Blender 5.2 LTS ou plus récent")
    try:
        lib, mats = br.polyhaven_manifest()
        data["polyhaven_library"] = {"path": str(lib), "materials": len(mats)}
    except (OSError, ValueError) as exc:
        data["polyhaven_library"] = None
        warnings.append(f"bibliothèque Poly Haven indisponible : {exc}")
    return {"data": data, "warnings": warnings + res["warnings"]}
