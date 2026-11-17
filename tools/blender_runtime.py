"""Lancement de Blender pour les outils blender_* (importable : le gestionnaire ajoute tools/ au sys.path).

Principe : Blender exécute du Python, donc aucune donnée venue du modèle n'atteint son interpréteur autrement que
comme données JSON validées. Chaque appel :
1. prend un verrou (un seul Blender à la fois par outil) et crée un dossier temporaire propre à l'appel ;
2. y copie les scripts fixes (tools/blender/_runners et _vendor) et vérifie leur empreinte SHA-256 ;
3. écrit request.json, lance `blender -b --factory-startup --disable-autoexec … --python <runner> -- <request>
   <result>` (liste d'arguments fixe : aucune valeur du modèle, environnement sans variables PYTHON* ni BLENDER*) ;
4. lit result.json (jamais la console de Blender) ; les fichiers produits restent dans le dossier temporaire, que
   tool.py copie vers le dossier de sortie contrôlé, puis le dossier est supprimé, même en cas d'erreur.

Empreintes : après une modification relue d'un runner, `python tools/blender_runtime.py --digests` imprime la
nouvelle table RUNNER_DIGESTS à recopier ici (le test test_blender.py vérifie qu'elle est à jour).
"""
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import safety
from common import app_path, resolve_app

ROOT = Path(__file__).resolve().parent
BLENDER_DIR = ROOT / "blender"
CODE_DIRS = ("_runners", "_vendor")
CONFIG_PATH = ROOT / "blender.json"          # local, hors dépôt : copie adaptée de blender.example.json
MAX_INPUT_BYTES = 512 * 1024 ** 2
MAX_LOG_BYTES = 200_000
FIXED_ARGS = ("-b", "--factory-startup", "--disable-autoexec", "--offline-mode")
ENV_DROP = re.compile(r"^(PYTHON|BLENDER_)", re.I)
NOISE = re.compile(r"^(Blender \d|Read prefs|Read blend|Saved |Info:|Fra:|Blender quit|Color management|"
                    r"\d\d:\d\d\.\d+\s+(render|blend|gpu|bke)|$)", re.I)

RUNNER_DIGESTS = {
    "_runners/_common.py": "0040c6f9c78a94d101bdbffe99975dc2ab68aab4275e580bcd00274c6894084b",
    "_runners/blendscan.py": "32b45205c7a82fa4ce6ef99a4951c6f4f4ca55f230ada8eeb4c1c9cf46bdf60e",
    "_runners/runner_build.py": "563d1031d9eafd405366dbcd92b75214c99f03c822d798fe82bdb7e493fc4543",
    "_runners/runner_export_glb.py": "e9794dbcac511bd38d47b112e630eaed1d3a7ff4dfd1d7954e8a526c3d67ed29",
    "_runners/runner_info.py": "ba202a6bd1e8453b296e68e3c74bc3c081b580d3cbcd9d61e638d069568fb38f",
    "_runners/runner_inspect.py": "5b21e7b91bb454907abd1293c52574ffcc672a83e9e4d994d2b8560ab2976302",
    "_runners/runner_qa.py": "92261c2b35f31dcaff2861faf77c1264185d7a800329e0f4179cb574a98f9044",
    "_runners/runner_render_views.py": "bfdb036a53ac584ae850ff0412bcffb94aad129fedcd83572a5bf9eb7d6d0069",
    "_runners/spec_schema.py": "3acb2ec02f622e6d9a514474c44b0b980891a3ee625edcb8043c74181a88141f",
    "_vendor/_bpyx.py": "6680297b43f0c0e240475d86e31d8089ce3b19281285a0478203029b7a3ddf0a",
    "_vendor/mcf_kit.py": "0e1c1cc68582d2f435e72242e4b25679dcebaaed5510b4bcb7f365aaa298f020",
    "_vendor/qa_check.py": "aaaf7799564ff5b78665e22ab9a34a3302c2f58c909776269c0e362c857d1168",
}


# ----------------------------------------------------------------------------- scripts fixes et empreintes
def code_files(base=BLENDER_DIR):
    """Scripts Python exécutés dans Blender : {chemin relatif posix: Path}."""
    out = {}
    for d in CODE_DIRS:
        for p in sorted((Path(base) / d).glob("*.py")):
            out[f"{d}/{p.name}"] = p
    return out


def digest(path):
    """SHA-256 du script, fins de ligne ramenées à LF (git peut extraire en CRLF sous Windows)."""
    return hashlib.sha256(Path(path).read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def compute_digests(base=BLENDER_DIR):
    return {rel: digest(p) for rel, p in code_files(base).items()}


def check_digests(base):
    """Les scripts de `base` sont exactement ceux relus en revue (ni modifiés, ni ajoutés, ni retirés)."""
    found = compute_digests(base)
    if set(found) != set(RUNNER_DIGESTS):
        extra, missing = sorted(set(found) - set(RUNNER_DIGESTS)), sorted(set(RUNNER_DIGESTS) - set(found))
        raise PermissionError(f"scripts Blender inattendus (en plus : {extra or 'aucun'}, manquants : "
                              f"{missing or 'aucun'}) : Blender n'est pas lancé")
    bad = sorted(rel for rel, h in found.items() if h != RUNNER_DIGESTS[rel])
    if bad:
        raise PermissionError(f"empreinte SHA-256 différente pour {', '.join(bad)} : script modifié depuis la revue, "
                              "Blender n'est pas lancé (tools/blender_runtime.py --digests après relecture)")


_SCHEMA = []


def spec_schema():
    """Module de validation de la spec de blender_build (le même fichier que relit le runner dans Blender)."""
    if not _SCHEMA:
        import importlib.util
        spec = importlib.util.spec_from_file_location("myia_blender_spec_schema",
                                                      BLENDER_DIR / "_runners" / "spec_schema.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _SCHEMA.append(mod)
    return _SCHEMA[0]


# ----------------------------------------------------------------------------- configuration locale
def blender_exe():
    exe = app_path(resolve_app("blender")[1])
    if not exe:
        raise FileNotFoundError("Blender introuvable : entrée « blender » de tools/apps.json (chemin de Blender 5.2)")
    if Path(exe).stem.lower() != "blender":
        raise PermissionError("l'entrée « blender » de tools/apps.json doit pointer sur blender.exe")
    return exe


def load_config():
    if not CONFIG_PATH.is_file():
        raise FileNotFoundError("aucune configuration Blender : copier tools/blender.example.json vers "
                                "tools/blender.json et y mettre le chemin de la bibliothèque Poly Haven de CE poste")
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    if not isinstance(cfg, dict):
        raise ValueError("tools/blender.json : objet JSON attendu")
    return cfg


def polyhaven_library():
    """Dossier de la bibliothèque Poly Haven (lecture seule) : chemin absolu local, avec manifest.json."""
    raw = load_config().get("polyhaven_library")
    if not isinstance(raw, str) or not os.path.isabs(raw):
        raise ValueError("tools/blender.json : polyhaven_library doit être un chemin absolu local")
    real = safety.resolve(raw)
    safety.check_denied(real)
    safety.check_read_target(real)
    if not os.path.isfile(os.path.join(real, "manifest.json")):
        raise FileNotFoundError(f"pas de manifest.json dans la bibliothèque Poly Haven ({real})")
    return Path(real)


def polyhaven_manifest():
    lib = polyhaven_library()
    data = json.loads((lib / "manifest.json").read_text(encoding="utf-8"))
    mats = data.get("materials") if isinstance(data, dict) else None
    if not isinstance(mats, dict):
        raise ValueError("manifest.json de la bibliothèque : champ « materials » attendu")
    return lib, mats


def texture_files(lib, mats, slug):
    """{diff, nor, arm: chemin réel} d'un matériau, chaque fichier sous la bibliothèque."""
    files = (mats.get(slug) or {}).get("files") or {}
    out = {}
    for key, name in (("diff", "diff"), ("nor", "nor_gl"), ("arm", "arm")):
        rel = files.get(name)
        if not isinstance(rel, str):
            continue
        real = os.path.realpath(lib / rel)
        if safety.inside(real, lib) and os.path.isfile(real):
            out[key] = real
    return out


def read_roots():
    """Dossiers autorisés en lecture (politique locale) et dossiers fermés de l'appel : pour les fichiers que
    référence un .blend (images, bibliothèques), contrôlés dans Blender avant lecture."""
    import tool_manager
    policy = tool_manager.load_policy()
    return [os.path.realpath(d) for d in policy["allowed_dirs"]["read"]], list(safety.DENIED)


# ----------------------------------------------------------------------------- fichiers d'entrée
def check_input(path, exts, roots=(), denied=()):
    """Fichier d'entrée : extension attendue, taille bornée ; les fichiers qu'un .glb référence restent dans les
    dossiers autorisés en lecture (`roots`) et hors des dossiers fermés (`denied`)."""
    p = Path(path)
    if p.suffix.lower() not in exts:
        raise ValueError(f"fichier {' ou '.join(exts)} attendu, pas « {p.name} »")
    if not p.is_file():
        raise FileNotFoundError(f"fichier introuvable : {p}")
    if p.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError(f"fichier trop volumineux ({p.stat().st_size // 1024 ** 2} Mo, {MAX_INPUT_BYTES // 1024 ** 2} au plus)")
    if p.suffix.lower() == ".glb":
        check_glb(p.read_bytes(), p.parent, roots, denied)
    return p


_URI_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


def _check_uri(uri, base, roots, denied):
    """`uri` d'un glTF : `data:` ou chemin RELATIF qui, résolu depuis le dossier du .glb, reste dans les dossiers
    autorisés en lecture. Refusés : schéma (file:, http:…), chemin absolu, réseau, dossier fermé."""
    from urllib.parse import unquote
    if not isinstance(uri, str):
        raise PermissionError("glb : uri qui n'est pas un texte")
    if uri.startswith("data:"):
        return
    raw = unquote(uri)
    if _URI_SCHEME.match(raw) or raw.startswith(("/", "\\")) or os.path.isabs(raw) or "\0" in raw:
        raise PermissionError(f"glb : fichier externe absolu, réseau ou URL ({uri[:80]}) : refusé")
    try:
        real = safety.resolve(str(Path(base) / raw))
        safety.check_read_target(real)
    except (ValueError, OSError) as exc:
        raise PermissionError(f"glb : fichier externe refusé ({uri[:80]}) : {exc}") from None
    if any(safety.inside(real, d) or safety.inside(d, real) for d in denied):
        raise PermissionError(f"glb : fichier externe dans un dossier fermé ({uri[:80]}) : refusé")
    if not any(safety.inside(real, d) for d in roots):
        raise PermissionError(f"glb : fichier externe hors des dossiers autorisés en lecture ({real}) : refusé")


def check_glb(data, base=None, roots=(), denied=()):
    """GLB : en-tête glTF 2, premier bloc JSON ; chaque `uri` (tampons, images) passe `_check_uri` (sans `base`, seuls
    les .glb autonomes passent)."""
    if len(data) < 20 or data[:4] != b"glTF":
        raise ValueError("ce fichier n'est pas un .glb (en-tête glTF absent)")
    version, length = struct.unpack_from("<II", data, 4)
    if version != 2 or length > len(data):
        raise ValueError("glb : version 2 attendue, ou fichier tronqué")
    clen, ctype = struct.unpack_from("<II", data, 12)
    if ctype != 0x4E4F534A or 20 + clen > len(data):
        raise ValueError("glb : bloc JSON absent")
    try:
        doc = json.loads(data[20:20 + clen].decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ValueError("glb : JSON illisible") from None
    for key in ("buffers", "images"):
        for item in doc.get(key, []) if isinstance(doc, dict) else []:
            uri = item.get("uri") if isinstance(item, dict) else None
            if uri is None:
                continue
            if base is None and not (isinstance(uri, str) and uri.startswith("data:")):
                raise PermissionError(f"glb : {key} référence un fichier externe ({str(uri)[:80]}) : refusé")
            _check_uri(uri, base, roots, denied)
    return doc


# ----------------------------------------------------------------------------- sorties
def prepare_outputs(output, names, overwrite, sources=()):
    """Chemins finals dans le dossier de sortie (déjà contrôlé par le gestionnaire), recontrôlés ; refus d'écraser
    sans `overwrite`, jamais sur un fichier d'entrée."""
    out_dir = Path(output)
    if out_dir.exists() and not out_dir.is_dir():
        raise NotADirectoryError(f"output doit être un dossier : {out_dir}")
    dests = {}
    for n in names:
        real = safety.resolve(str(out_dir / n))
        safety.check_denied(real)
        safety.check_write_target(real)
        if any(safety.same(real, s) for s in sources):
            raise PermissionError(f"{n} : la sortie remplacerait le fichier d'entrée")
        if os.path.exists(real) and not overwrite:
            raise FileExistsError(f"{real} existe déjà (overwrite: true pour le remplacer)")
        dests[n] = real
    return dests


def deliver(produced_dir, dests):
    """Copie les fichiers produits par Blender (dossier temporaire) vers leurs chemins finals contrôlés."""
    first = next(iter(dests.values()), None)
    if first:
        os.makedirs(os.path.dirname(first), exist_ok=True)
    for name, dest in dests.items():
        src = Path(produced_dir) / name
        if not src.is_file():
            raise RuntimeError(f"Blender n'a pas produit {name}")
        safety.check_write_target(safety.resolve(dest))
        shutil.copyfile(src, dest)
    return list(dests.values())


# ----------------------------------------------------------------------------- lancement
class _Lock:
    """Verrou de fichier par outil, libéré par le système si le processus meurt."""

    def __init__(self, tool):
        self.path = Path(tempfile.gettempdir()) / f"myia_{tool}.lock"
        self.f = None

    def __enter__(self):
        self.f = open(self.path, "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                self.f.seek(0)
                msvcrt.locking(self.f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.f.close()
            raise RuntimeError("un autre appel de cet outil fait déjà tourner Blender : réessayer à la fin") from None
        return self

    def __exit__(self, *exc):
        try:
            if os.name == "nt":
                import msvcrt
                self.f.seek(0)
                msvcrt.locking(self.f.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        self.f.close()


def _env():
    return {k: v for k, v in os.environ.items() if not ENV_DROP.match(k)}


def log_tail(text, n=20):
    lines = [ln.rstrip() for ln in text.splitlines()]
    useful = [ln for ln in lines if not NOISE.match(ln.strip())]
    return "\n".join(useful[-n:])


def command(exe, runner, request, result):
    """Ligne de commande de Blender : arguments fixes, chemins du dossier temporaire uniquement."""
    return [exe, *FIXED_ARGS, "--python-exit-code", "1", "--python", str(runner), "--", str(request), str(result)]


class Job:
    """Un appel : verrou + dossier temporaire + scripts copiés et vérifiés. `run()` lance un runner."""

    def __init__(self, tool):
        self.tool = tool
        self.lock = _Lock(tool)
        self.dir = None

    def __enter__(self):
        self.lock.__enter__()
        try:
            self.dir = Path(tempfile.mkdtemp(prefix="myia_blender_"))
            code = self.dir / "code"
            for rel, src in code_files().items():
                dst = code / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dst)
            check_digests(code)                     # sur les COPIES : ce que Blender lira est ce qui a été vérifié
            (self.dir / "work").mkdir()
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def __exit__(self, *exc):
        if self.dir is not None:
            shutil.rmtree(self.dir, ignore_errors=True)
        self.lock.__exit__(*exc)

    @property
    def out(self):
        return self.dir / "work" / "out"

    def run(self, runner, request, timeout):
        """{"completed": True, "data", "warnings"} ou {"completed": False, "reason"} si le délai est dépassé."""
        exe = blender_exe()
        script = self.dir / "code" / "_runners" / f"{runner}.py"
        if not script.is_file():
            raise ValueError(f"runner inconnu : {runner}")
        req_path, res_path = self.dir / "request.json", self.dir / "result.json"
        req_path.write_text(json.dumps({**request, "work": str(self.dir / "work")}, ensure_ascii=False),
                            encoding="utf-8")
        log_path = self.dir / "blender.log"
        with open(log_path, "wb") as log:
            try:
                proc = subprocess.run(command(exe, script, req_path, res_path), stdin=subprocess.DEVNULL,
                                      stdout=log, stderr=subprocess.STDOUT, cwd=str(self.dir), env=_env(),
                                      timeout=timeout)
            except subprocess.TimeoutExpired:   # subprocess.run a tué Blender et attendu sa fin
                return {"completed": False, "reason": f"délai de {timeout} s dépassé : Blender a été arrêté"}
        text = log_path.read_bytes()[-MAX_LOG_BYTES:].decode("utf-8", errors="replace")
        if not res_path.is_file():
            raise RuntimeError(f"Blender s'est arrêté sans résultat (code {proc.returncode}) :\n{log_tail(text)}")
        res = json.loads(res_path.read_text(encoding="utf-8"))
        if not res.get("ok"):
            detail = res.get("error") or "erreur inconnue"
            if res.get("trace"):
                detail += "\n" + log_tail(res["trace"] + "\n" + text)
            raise RuntimeError(detail)
        return {"completed": True, "data": res.get("data"), "warnings": res.get("warnings", [])}


def incomplete(res):
    """Réponse d'outil quand le délai est dépassé : ne jamais conclure que l'objet est sain."""
    return {"data": {"completed": False, "reason": res["reason"]},
            "warnings": ["Opération incomplète : rien n'a été livré, ne pas conclure que le modèle est sain."]}


if __name__ == "__main__":
    if sys.argv[1:] == ["--digests"]:
        print("RUNNER_DIGESTS = {")
        for rel, h in compute_digests().items():
            print(f'    "{rel}": "{h}",')
        print("}")
    else:
        print("usage : python tools/blender_runtime.py --digests")
