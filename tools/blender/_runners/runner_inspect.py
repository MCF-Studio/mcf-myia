"""blender_inspect : objets d'un .blend ou d'un .glb (triangles, boîte englobante, matériaux, collisions)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common  # noqa: E402
import bpy  # noqa: E402

MAX_OBJECTS = 200


def handle(req):
    _common.open_input(req, req["file"])
    objs = sorted(bpy.context.scene.objects, key=lambda o: o.name)
    items, total, cols = [], 0, 0
    for o in objs:
        item = {"name": o.name[:80], "type": o.type, "parent": o.parent.name[:80] if o.parent else None}
        if o.type == "MESH":
            tris = _common.mesh_tris(o)
            b = _common.world_bounds([o])
            item.update({"tris": tris, "collision": _common.is_collision(o),
                         "bbox_min": b[0], "bbox_max": b[1],
                         "materials": [s.material.name[:60] if s.material else None for s in o.material_slots][:8]})
            if _common.is_collision(o):
                cols += 1
            else:
                total += tris
        props = {k: o[k] for k in o.keys() if not k.startswith("_") and isinstance(o[k], (int, float, str, bool))}
        if props:
            item["props"] = dict(list(props.items())[:10])
        items.append(item)
    meshes = _common.visible_meshes()
    b = _common.world_bounds(meshes)
    return {"objects": items[:MAX_OBJECTS], "object_count": len(items), "truncated": len(items) > MAX_OBJECTS,
            "tris": total, "collisions": cols,
            "materials": sorted({s.material.name for o in meshes for s in o.material_slots if s.material})[:50],
            "dimensions": [b[1][i] - b[0][i] for i in range(3)] if b else None,
            "lowest_z": _common.lowest_z(meshes) if meshes else None}, []


_common.main(handle)
