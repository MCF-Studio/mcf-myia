# MyIA

Agent IA **local** du quotidien, par [MCF Studio](https://mcfstudio.fr). Tu lui écris ce que tu veux (« envoie une
annonce Discord… », « build tel projet », « prépare un projet Godot avec tel addon »). Il regarde les services
disponibles, choisit le bon outil, te montre exactement ce qu'il va faire et **attend ton accord** avant toute action
sensible. Le modèle tourne sur ta machine avec [Ollama](https://ollama.com).

Deux interfaces sur le même cœur :

- **l'app de bureau** (Tauri 2 + Vue 3) ;
- **la console** (`myia`).

> Projet jeune (v0.1). Windows est la plateforme testée. Les contributions sont bienvenues, voir
> [CONTRIBUTING.md](CONTRIBUTING.md).

## L'app

| Catégorie          | Contenu                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| **Vue d'ensemble** | CPU, RAM, GPU et VRAM en direct, modèles chargés en mémoire, agents et leur activité, services, processus |
| **Conversations**  | une conversation par agent, affichage en **onglets** ou en **grille**, chaque panneau avec sa saisie      |
| **Agents**         | personnalités : nom, modèle, consignes, couleur, services autorisés ; import et export en fichier         |
| **Modèles**        | téléchargement avec progression, modèle par défaut, déchargement de la VRAM, suppression                |
| **Marketplace**    | en préparation (voir plus bas) ; l'installation d'agents et de thèmes depuis un fichier marche déjà      |
| **Paramètres**     | thèmes (installables), lumières, densité, voix de l'IA, sons de notification, notifications, raccourcis  |

Thème par défaut : sombre, lumières orange fusion → jaune foncé.

### Marketplace

Le but : partager modèles, agents, thèmes et extensions entre membres de la communauté et membres certifiés de
mcfstudio.fr. Le registre en ligne n'est **pas encore ouvert**. Les formats d'échange existent déjà :

- **agent** (`*.agent.json`) : nom, consignes, modèle, couleur, liste de services autorisés. Des données, pas de code.
- **thème** (`*.theme.json`) : une liste fermée de couleurs. Pas de CSS libre, pas d'URL.

Les personnalités ne sont **pas** livrées avec le code : chacun crée les siennes et choisit de les partager ou non.

## Installation (depuis les sources)

Prérequis : Windows 10/11, [Node.js](https://nodejs.org) 22+, [Rust](https://rustup.rs) stable,
[Ollama](https://ollama.com) (ou son binaire autonome dans `runtime\ollama\ollama.exe`, lancé automatiquement).

```bash
git clone https://github.com/MCF-Studio/mcf-myia
cd mcf-myia
copy config\agent.example.json config\agent.json   # puis adapte-le
cd agent && npm install && npm run build && cd ..
cd app && npm install && npm run tauri dev
```

Un modèle doit être installé : `ollama pull qwen3:8b` (ou depuis l'onglet Modèles de l'app).

Pour l'instant l'app s'exécute depuis le dépôt (elle lance `agent/dist/server/main.js` avec le Node du système).
Un installateur autonome viendra plus tard.

### Console

```
myia.cmd            discussion
myia.cmd doctor     état d'Ollama, du modèle et des services
myia.cmd ask "…"    une seule demande
```

## Brancher les services

| Service     | Ce qu'il faut                                                                                |
| ----------- | -------------------------------------------------------------------------------------------- |
| Telegram    | `myia secret set telegram_bot_token` + `telegram.destinations` dans `config\agent.json`      |
| Discord     | `myia secret set discord_bot_token` + `discord.channels` (bot invité sur le serveur)          |
| Builds      | `projects` ou `projectRoots` : projets Godot, Tauri, Rust, Node détectés automatiquement      |
| Godot       | `godot.projectsRoot` + `godot.versionsDir` ou `godot.executables`                             |
| Claude Code | la commande `claude` installée et connectée                                                  |
| Autre (MCP) | une entrée `mcpServers` : n'importe quel serveur MCP stdio devient un service                 |

Exemple complet : [`config/agent.example.json`](config/agent.example.json). Les jetons vont dans le Gestionnaire
d'identification Windows, jamais dans la config.

## Sécurité

Le modèle choisit des outils, jamais des commandes : les builds sont générés par le code et lancés sans shell, les
destinations de messages sont fermées, tout ce qui sort de la machine demande ta confirmation avec le contenu exact,
et chaque action est inscrite dans un journal (`data\audit`). Détails, menaces et mesures : [docs/SPEC.md](docs/SPEC.md).

Une faille ? Pas d'issue publique : utilise le signalement privé de GitHub (onglet **Security** → *Report a vulnerability*).

## Structure

```
agent\        cœur TypeScript (moteur, services, console, sidecar JSON-RPC de l'app)
app\          app de bureau : src-tauri\ (Rust) + src\ (Vue 3)
config\       agent.example.json (agent.json et agents.json restent locaux)
docs\         spécification
```

Dossiers créés à l'usage et jamais publiés : `data\` (conversations, réglages, thèmes installés, journal), `runtime\`,
`ollama\`, `workspace\`.

## Licence

[AGPL-3.0](LICENSE). Tu peux utiliser, modifier et redistribuer MyIA ; toute version modifiée distribuée ou proposée en
service en ligne doit rester open source sous la même licence.
