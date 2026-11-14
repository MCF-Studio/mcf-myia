import re
import webbrowser
from urllib.parse import urlparse

MAX_URL = 2000


def check_url(url):
    """Adresse http(s) complète, sans identifiants ni caractère de contrôle. Niveau `external` : l'ouverture d'une
    adresse est un canal de sortie de données (tout ce qui est dans l'URL part chez le site), toujours confirmée."""
    url = url.strip()
    if len(url) > MAX_URL or re.search(r"[\x00-\x20\x7f]", url):
        raise ValueError(f"URL invalide (espaces, caractères de contrôle, ou plus de {MAX_URL} caractères)")
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError("seules les URL http(s) complètes sont autorisées")
    if u.username or u.password:
        raise ValueError("URL avec identifiants (utilisateur@hôte) refusée")
    return url, u.hostname


def execute(params):
    url, host = check_url(params["url"])
    if not webbrowser.open(url):
        raise RuntimeError("aucun navigateur n'a pu ouvrir l'URL")
    return {"data": {"url": url, "host": host}}
