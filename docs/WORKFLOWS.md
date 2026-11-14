# Workflows : partager une équipe

Un **workflow** est une équipe exportée : son organisation (chef, sous-agents, coéquipiers, budgets), le profil de
chacun de ses agents et, s'il y en a, ses **scripts**. Il se partage en fichier (`*.workflow.json`) ou par le
marketplace de mcfstudio.fr.

Code : `agent/src/core/workflow.ts` (format, export, import), `agent/src/core/scripts.ts` (scripts),
`agent/src/core/market.ts` (site). Règles de sécurité : [SPEC.md](SPEC.md) §3 bis et §5. Côté site : spec
`docs/superpowers/specs/2026-11-14-workflows-myia-design.md` du dépôt du site.

## Dans l'app

| Geste | Où |
| --- | --- |
| Exporter une équipe en fichier | Équipes → « Exporter en workflow » |
| Installer un fichier reçu | Équipes → « Importer un workflow » |
| Publier (privé ou public) | Équipes → « Publier » |
| Parcourir et installer les workflows publics | Marketplace → Workflows |
| Gérer ses publications | Marketplace → Workflows → « Mes publications » |
| Ajouter, lire, accepter un script | Équipes → « Scripts de l'équipe » |

Avant toute installation, MyIA montre ce que contient le workflow : les agents avec leurs consignes, le code de chaque
script, et ce qui manque sur le PC (modèle non installé, service absent, moteur Python absent).

## Ce qui voyage, ce qui ne voyage pas

| Voyage | Ne voyage jamais |
| --- | --- |
| nom et description de l'équipe, arbre, budgets | espace de travail de l'équipe et des agents |
| profils des agents de l'arbre : nom, modèle, consignes, couleur, photo, services autorisés | rôle MASTER |
| scripts de l'équipe (fichiers texte) | espace de coordination (règles locales, journal) |
| | conversations, mémoire, secrets, configuration |

À l'import, **rien n'est écrasé** : un agent ou un script déjà présent à l'identique est réutilisé ; s'il porte le même
id avec un contenu différent, le nouveau est installé sous un autre id (`chef` → `chef-2`). Importer deux fois le même
fichier crée deux équipes.

## Format `myia/workflow@1`

Un fichier JSON de 512 Ko au plus :

```json
{
  "$schema": "myia/workflow@1",
  "name": "Studio 3D",
  "description": "Scènes Godot",
  "team": {
    "root": { "id": "n-chef", "agentId": "chef", "subagents": [], "teammates": [] },
    "maxCalls": 8,
    "maxDepth": 3
  },
  "agents": [{ "id": "chef", "name": "Chef", "instructions": "…" }],
  "scripts": [
    {
      "id": "pont-godot",
      "name": "Pont Godot",
      "description": "Pilote l'éditeur Godot",
      "entry": "server.py",
      "files": [{ "path": "server.py", "content": "…" }]
    }
  ]
}
```

- `agents` : 1 à 40 profils, même schéma que `*.agent.json` ; tout agent de l'arbre doit y figurer.
- `scripts` : 8 au plus ; 20 fichiers par script, 200 000 caractères par fichier, 400 000 par script.
- Fichiers d'un script : chemins relatifs (4 niveaux au plus), sans `..`, extensions texte seulement
  (`.py .pyi .txt .md .json .toml .yaml .yml .cfg .ini .csv`). `entry` est un des fichiers `.py`.

## Scripts

Un script est un **serveur MCP en Python** qui parle sur l'entrée/sortie standard : il donne des outils en plus à tous
les membres de l'équipe qui le porte, et à eux seuls.

**C'est du code.** Un script accepté s'exécute avec les droits de l'utilisateur : MyIA ne l'isole pas. Les garde-fous :

1. **Accord** : un script ne se lance jamais sans que l'utilisateur ait vu son code et l'ait accepté. Un script reçu
   avec un workflow arrive « en attente ». Un script ajouté depuis ses propres fichiers est accepté d'office.
2. **Empreinte** : l'accord porte sur l'empreinte SHA-256 des fichiers. Un fichier modifié, ajouté ou retiré dans le
   dossier du script après l'accord, et il ne se lance plus tant qu'il n'a pas été relu et accepté de nouveau.
3. **Dossier fermé** : les fichiers vivent dans `data\scripts\<id>`, que les agents ne peuvent ni lire ni écrire.
4. **Lancement** : sans shell, dans l'espace de travail de l'équipe (sinon `workspace\`), avec un environnement réduit
   (ni variable de MyIA, ni jeton d'un autre outil).
5. **Confirmation** : tous les outils d'un script sont de niveau `external` : chaque appel est confirmé, avec ses
   arguments exacts.
6. **Publication** : un workflow public n'est listé qu'après relecture par un admin du site.

### Moteur Python

MyIA lance les scripts avec [uv](https://docs.astral.sh/uv/) (`uv run --no-project --script server.py`). uv télécharge
Python et les dépendances du script au premier lancement. Il s'installe depuis Équipes → Scripts : version figée,
empreinte vérifiée, dans `runtime\uv`. Sans uv, MyIA utilise un Python 3 du PATH : le script n'a alors que les paquets
déjà installés.

Un script déclare ses dépendances en tête de fichier (PEP 723) :

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp>=2,<3"]
# ///
from mcp.server.mcpserver import MCPServer

mcp = MCPServer("pont-godot")


@mcp.tool()
def lister_scenes(dossier: str) -> str:
    """Liste les scènes .tscn d'un projet Godot."""
    from pathlib import Path

    return "\n".join(str(p) for p in Path(dossier).rglob("*.tscn")) or "aucune scène"


if __name__ == "__main__":
    mcp.run()
```

Les dépendances viennent de PyPI : elles font partie de ce que l'utilisateur accepte en lisant le script.

La variable `MYIA_WORKSPACE` donne au script le dossier de travail de l'équipe.

## Marketplace

- **Lire** (liste, détail, téléchargement d'un workflow public validé) : sans compte.
- **Publier** : autorisation OAuth de portée `workflows` sur mcfstudio.fr, séparée de celles de la Guilde et de la carte
  des agents ; le jeton de renouvellement reste dans le coffre Windows.
- **Privé** : seul l'auteur le voit et peut l'installer (sur ses autres PC, par exemple).
- **Public** : listé une fois validé par un admin ; toute modification du contenu repasse par la validation.
- L'app ne fait confiance à rien de ce qui vient du site : l'empreinte du paquet est recalculée et comparée à celle
  annoncée dans la liste, le paquet repasse par toute la validation du format, et les scripts par l'accord.
