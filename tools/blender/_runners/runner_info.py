"""blender_info : version de Blender et ce que sait construire blender_build."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common  # noqa: E402
import bpy  # noqa: E402
import spec_schema  # noqa: E402


def handle(req):
    return {"version": bpy.app.version_string, "version_ok": tuple(bpy.app.version) >= _common.MIN_VERSION,
            **spec_schema.catalog()}, []


_common.main(handle)
