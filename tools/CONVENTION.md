# Convention des outils MyIA (à donner à une IA)

Tu vas écrire un outil pour la boîte à outils de MyIA (agents IA locaux, Windows, Python 3.12). Réponds avec
**exactement deux fichiers**, à placer dans un dossier qui porte le nom de l'outil : `manifest.json` et `tool.py`
(un `README.md` facultatif). Rien d'autre : pas de sous-dossier, pas d'autre fichier.

## manifest.json

```json
{
  "name": "nom_de_l_outil",
  "version": "1.0.0",
  "description": "Ce que fait l'outil, en une ou deux phrases claires : c'est ce que lit l'agent pour le choisir.",
  "category": "categorie",
  "risk": "read",
  "entrypoint": "tool.py",
  "function": "execute",
  "parameters": {
    "path": { "type": "string", "required": true, "kind": "path", "description": "Fichier à lire." },
    "limite": { "type": "integer", "description": "Nombre maximal de résultats (défaut 50).", "min": 1, "max": 500 }
  },
  "permissions": ["filesystem.read"]
}
```

- `name` : minuscules, chiffres et `_` (2 à 61 caractères, commence par une lettre), **identique au nom du dossier**.
- `entrypoint` et `function` sont toujours `tool.py` et `execute`.
- `parameters` : `type` parmi `string`, `integer`, `number`, `boolean`, `array`, `object` ; `required`, `description`,
  `min`/`max` (nombres), `max_length` (textes) facultatifs.
- **Chemins** : un paramètre est un chemin s'il a `"kind": "path"` ou s'il s'appelle `path`, `file`, `project`,
  `directory`, `repo`, `output`, `folder` ou `dir`. Le gestionnaire le contrôle (dossiers autorisés, liens résolus) et
  passe à l'outil le **chemin réel**. Ajouter `"access": "write"` si l'outil y écrit. Un texte qui porte un de ces noms :
  `"kind": "text"`.
- `permissions` et `risk` minimal :

| Permission              | Pour                                                    | `risk` au moins |
| ----------------------- | ------------------------------------------------------- | --------------- |
| `filesystem.read`       | lire des fichiers                                       | `read`          |
| `filesystem.write`      | écrire des fichiers                                     | `local`         |
| `network.local`         | parler à un serveur sur 127.0.0.1 seulement             | `read`          |
| `process.exec.readonly` | lancer un programme en lecture seule (`--version`…)     | `read`          |
| `process.exec`          | lancer un programme qui agit (build, export, Blender…)  | `local`         |
| `app.launch`            | ouvrir une application ou un dossier                    | `launch`        |
| `url.open`              | ouvrir une adresse web                                  | `external`      |

`risk` : `read` (sans demander), `launch`, `local` (l'utilisateur confirme avant chaque exécution), `external`
(confirmé, sort de la machine). Choisir le plus bas qui reste honnête.

## tool.py

```python
from pathlib import Path

from common import bounded   # facultatif : entier venu du modèle, ramené dans des bornes


def execute(params):
    path = Path(params["path"])                       # déjà contrôlé par le gestionnaire
    limite = bounded(params, "limite", 50, 1, 500)
    lignes = path.read_text(encoding="utf-8").splitlines()[:limite]
    return {"data": {"lignes": lignes, "total": len(lignes)}, "warnings": []}
```

- `execute(params)` reçoit les paramètres validés et rend `{"data": ..., "warnings": [...]}` ; `data` doit être
  sérialisable en JSON et rester court (résumer, borner les listes).
- Une erreur : lever une exception avec un message clair en français (`ValueError`, `FileNotFoundError`…).
- Bibliothèque standard de préférence. Toute dépendance externe doit être signalée à l'utilisateur.
- **Interdit** : `shell=True`, `os.system`, `eval`/`exec`, télécharger ou lancer du code, réseau hors 127.0.0.1 sans
  la permission adaptée, écrire ailleurs que dans les chemins `access: write` reçus, lire des secrets (clés, `.ssh`,
  mots de passe). Pour lancer un programme : `subprocess.run([...liste d'arguments...], timeout=...)`, jamais une
  chaîne de commande, et refuser toute valeur venue du modèle qui commence par `-`.
- Un délai maximal pour tout ce qui peut durer (paramètre `timeout` borné).

## Import

Dans MyIA : Paramètres > Boîte à outils > « Importer un outil… », choisir le dossier. MyIA montre le risque, les
permissions et les paramètres avant de copier l'outil dans `tools/imports/`. Un outil dont la permission n'est pas
accordée dans `tools/policy.json` reste désactivé.
