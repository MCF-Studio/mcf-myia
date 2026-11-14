import http.client
import socket
import time
from urllib.parse import urlsplit

# Uniquement la machine elle-même : l'outil ne doit pas servir à sonder le réseau ni Internet.
LOOPBACK = {"127.0.0.1", "localhost", "::1", "[::1]"}


def _target(params):
    if params.get("url"):
        u = urlsplit(params["url"])
        if u.scheme not in ("http", "https"):
            raise ValueError("url : http:// ou https:// attendu")
        host = (u.hostname or "").lower()
        if host not in LOOPBACK or u.username or u.password:
            raise ValueError("server_check ne vérifie que des services locaux (127.0.0.1, localhost, ::1)")
        port = u.port or (443 if u.scheme == "https" else 80)
        return u.scheme, host, port, (u.path or "/") + (f"?{u.query}" if u.query else "")
    port = params.get("port")
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("donner url ou port (1 à 65535)")
    return None, "127.0.0.1", port, None


def execute(params):
    scheme, host, port, path = _target(params)
    timeout = min(max(params.get("timeout", 5), 1), 30)
    t0 = time.time()
    if scheme is None:
        try:
            with socket.create_connection((host, port), timeout=timeout):
                pass
            return {"data": {"host": host, "port": port, "open": True, "latency_ms": round((time.time() - t0) * 1000)}}
        except OSError as e:
            return {"data": {"host": host, "port": port, "open": False, "reason": str(e)[:200]}}
    cls = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
    conn = cls(host.strip("[]"), port, timeout=timeout)
    try:
        conn.request("GET", path, headers={"User-Agent": "myia-server-check"})
        r = conn.getresponse()
        body = r.read(64_000)
        data = {"url": params["url"], "responding": True, "status": r.status, "reason": r.reason,
                "ok": 200 <= r.status < 400, "content_type": r.getheader("content-type"),
                "bytes_read": len(body), "latency_ms": round((time.time() - t0) * 1000)}
        if 300 <= r.status < 400:
            data["redirect_to"] = r.getheader("location")
        return {"data": data}
    except (OSError, http.client.HTTPException) as e:
        return {"data": {"url": params["url"], "responding": False, "reason": str(e)[:200]}}
    finally:
        conn.close()
