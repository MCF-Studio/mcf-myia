from common import app_path, load_apps


def execute(_params):
    return {"data": [{"id": k, "label": a["label"], "aliases": a.get("aliases", []),
                      "executable": a["executable"], "installed": app_path(a) is not None}
                     for k, a in load_apps().items()]}
