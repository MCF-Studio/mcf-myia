import webbrowser
from urllib.parse import urlparse


def execute(params):
    url = params["url"].strip()
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.netloc:
        raise ValueError("seules les URL http(s) complètes sont autorisées")
    if not webbrowser.open(url):
        raise RuntimeError("aucun navigateur n'a pu ouvrir l'URL")
    return {"data": {"url": url, "host": u.hostname}}
