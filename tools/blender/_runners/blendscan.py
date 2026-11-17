"""Lecture des blocs d'un .blend AVANT de l'ouvrir dans Blender (sans bpy).

Ouvrir un .blend charge aussitôt ses bibliothèques liées (un chemin `\\\\serveur\\partage` ferait fuiter le jeton
NTLM, un chemin hors des dossiers autorisés lirait un fichier interdit). On refuse donc, avant toute ouverture :
bibliothèques liées (LI), polices non intégrées (VF), sons (SO), vidéos (MC), caches (CF) et volumes (VO). Les
images (IM) sont contrôlées après l'ouverture, avant qu'aucun pixel ne soit lu (runner : `check_external_files`).

Formats : en-tête historique `BLENDER_v300` / `BLENDER-v300` (BHead de 20 ou 24 octets) et en-tête de Blender 5
`BLENDER17-01v0502` (BHead de 32 octets : code, SDNAnr, ancien pointeur 64 bits, longueur 64 bits, nombre 64 bits).
Le fichier compressé (zstd) est décompressé par l'appelant.
"""
import re
import struct

ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
REFUSED = {
    b"LI\0\0": "bibliothèque liée",
    b"VF\0\0": "police externe",
    b"SO\0\0": "son externe",
    b"MC\0\0": "vidéo externe",
    b"CF\0\0": "cache externe",
    b"VO\0\0": "volume externe",
}
_STRINGS = re.compile(rb"[\x20-\x7e]{4,}")


class BlendError(ValueError):
    pass


def _layout(data):
    """(décalage du premier bloc, format struct du BHead, taille du BHead, index de la longueur)."""
    if not data.startswith(b"BLENDER"):
        raise BlendError("ce fichier n'est pas un .blend (en-tête BLENDER absent)")
    m = re.match(rb"BLENDER(\d\d)-(\d\d)([vV])(\d{4})", data[:32])
    if m:                                                  # Blender 5 : en-tête de taille variable
        if m[3] != b"v" or m[2] != b"01":
            raise BlendError("format de .blend inconnu (seuls les fichiers petit-boutistes de Blender 5 sont lus)")
        return int(m[1]), "<4sIQqq", 32, 3
    if len(data) < 12 or data[7:8] not in (b"_", b"-") or data[8:9] not in (b"v", b"V"):
        raise BlendError("en-tête de .blend illisible")
    end = "<" if data[8:9] == b"v" else ">"
    if data[7:8] == b"_":
        return 12, end + "4siIii", 20, 1
    return 12, end + "4siQii", 24, 1


def scan(data, max_blocks=5_000_000):
    """Liste des refus (vide = rien de dangereux trouvé). Lève BlendError si le fichier est illisible."""
    if data[:4] == ZSTD_MAGIC:
        raise BlendError("fichier compressé : à décompresser avant l'analyse")
    off, fmt, size, len_idx = _layout(data)
    issues, seen = [], 0
    while True:
        if off + size > len(data):
            raise BlendError("fichier .blend tronqué (pas de bloc ENDB)")
        head = struct.unpack_from(fmt, data, off)
        code, length = head[0], head[len_idx]
        if code == b"ENDB":
            return issues
        if length < 0 or off + size + length > len(data):
            raise BlendError("bloc de .blend de longueur invalide")
        if code in REFUSED:
            body = data[off + size:off + size + length]
            if code == b"VF\0\0" and b"<builtin>" in body:
                pass                                       # police intégrée à Blender : rien d'externe
            else:
                names = [s.decode("ascii") for s in _STRINGS.findall(body)[:3]]
                issues.append(f"{REFUSED[code]} ({', '.join(names) or 'sans nom'})")
        off += size + length
        seen += 1
        if seen > max_blocks:
            raise BlendError("trop de blocs dans le .blend")
