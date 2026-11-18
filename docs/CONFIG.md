# Configuration : `config/agent.json`

Le fichier se trouve dans `%APPDATA%\fr.mcfstudio.myia\config\agent.json`. Pour l'ouvrir : **Paramètres → Système**, sous
« Dossier MyIA » (bouton à côté de `config/agent.json`).

Au démarrage, MyIA complète ce fichier avec **toutes** les options qui manquent. Celles qui ont une valeur par défaut
la reçoivent, les autres restent vides (`""`, `[]` ou `{}`). Il ne modifie jamais une valeur que tu as écrite.

- **Vide = valeur par défaut.** `""` et `[]` comptent comme « non rempli ».
- **Pas de secret ici.** Les jetons de bots et les clés d'API se saisissent dans **Paramètres → Général**, qui les range
  dans le coffre Windows.
- **Après une modification**, redémarre MyIA. Une valeur invalide est signalée au démarrage avec son chemin, par exemple
  `llm.baseUrl`.
- Sur Windows, écris les chemins avec des `/` (`"D:/projets/mon-jeu"`) ou des `\\` doublés.

## Toi

| Option      | Par défaut      | Rôle                                                   |
| ----------- | --------------- | ------------------------------------------------------ |
| `user.name` | `l'utilisateur` | Comment les agents t'appellent (Paramètres → Général). |

## Modèle local (`llm`)

| Option                   | Par défaut               | Rôle                                                                              |
| ------------------------ | ------------------------ | --------------------------------------------------------------------------------- |
| `llm.engine`             | `ollama`                 | Moteur local : `ollama` ou `llamacpp` (Paramètres → Système).                     |
| `llm.model`              | `qwen3:8b`               | Modèle par défaut des agents (onglet Modèles).                                    |
| `llm.baseUrl`            | `http://127.0.0.1:11434` | Adresse d'Ollama. **Locale obligatoire** (127.0.0.1 ou localhost).                |
| `llm.numCtx`             | `8192`                   | Taille du contexte avec Ollama (2048 à 131072). Plus grand = plus de VRAM.        |
| `llm.temperature`        | `0.4`                    | Créativité des réponses (0 à 2).                                                  |
| `llm.keepAlive`          | `30m`                    | Durée pendant laquelle Ollama garde le modèle en mémoire après usage.             |
| `llm.autoStart`          | `true`                   | Lancer Ollama s'il ne répond pas.                                                 |
| `llm.flashAttention`     | `true`                   | Calcul plus rapide et plus sobre (nécessaire pour compresser le contexte).        |
| `llm.kvCache`            | `q8_0`                   | Compression du contexte : `f16` (aucune), `q8_0` (conseillé), `q4_0` (forte).     |
| `llm.gpu.mode`           | `auto`                   | Plusieurs cartes : `auto`, `single` (une seule carte), `split` (réparti).         |
| `llm.gpu.device`         | vide                     | Carte choisie en mode `single` pour llama.cpp (ex. `CUDA1`).                      |
| `llm.gpu.uuid`           | vide                     | Carte choisie en mode `single` pour Ollama (UUID NVIDIA, `GPU-…`).                |
| `llm.gpu.splitMode`      | `layer`                  | Répartition en mode `split` : `layer`, `row` ou `tensor`.                         |
| `llm.gpu.ratios`         | vide                     | Parts par carte en mode `split` (ex. `[3, 1]`). Vide = le moteur décide.          |
| `llm.otherModels`        | vide                     | Modèle gardé pour l'autre moteur (rempli par MyIA quand tu changes de moteur).    |
| `llm.llamacpp.port`      | `11435`                  | Port de llama.cpp, sur 127.0.0.1 seulement.                                       |
| `llm.llamacpp.backend`   | vide                     | Build installée : `cuda`, `vulkan` ou `cpu` (choisie dans Paramètres → Système).  |
| `llm.llamacpp.modelsMax` | `1`                      | Modèles chargés en même temps (1 avec 8 Go de VRAM).                              |
| `llm.llamacpp.ctx`       | `auto`                   | Contexte de llama.cpp : `auto` ou un nombre (2048 à 262144).                      |

## Comportement des agents

| Option                       | Par défaut | Rôle                                                                                       |
| ---------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `maxSteps`                   | `25`       | Appels au modèle au plus par demande (1 à 100).                                            |
| `historyMessages`            | `30`       | Messages de la conversation relus à chaque demande (4 à 200).                              |
| `agents.bypassConfirmations` | `false`    | **Mode bypass** : plus aucune confirmation. À activer depuis Paramètres, en connaissance de cause. |
| `files.fullAccess`           | `false`    | Accès des agents à tous les disques (Paramètres → Général → Accès aux fichiers).                      |
| `web.enabled`                | `true`     | Lecture de pages web par les agents.                                                       |
| `web.maxPageBytes`           | `2000000`  | Taille maximale d'une page lue (octets).                                                    |
| `memory.folders`             | vide       | Dossiers de notes (`.md`, `.txt`) que les agents locaux consultent (Paramètres → Général). |

## Messages : Telegram et Discord

Les agents ne peuvent écrire **qu'aux noms déclarés ici**. À gauche, un nom de ton choix (celui que tu diras à l'agent).
À droite, l'identifiant.

```json
"telegram": { "destinations": { "annonces": "-1001234567890" } },
"discord":  { "channels":     { "annonces": "123456789012345678" } }
```

- **Telegram** : jeton du bot dans Paramètres → Général → Bots. Le `chat_id` d'un groupe commence par `-100`.
- **Discord** : jeton du bot dans Paramètres → Général → Bots, bot invité sur ton serveur avec le droit d'écrire dans le
  salon. Pour l'ID du salon : Discord → Paramètres → Avancés → **Mode développeur**, puis clic droit sur le
  salon → **Copier l'identifiant du salon**.

## Projets, builds et Godot

| Option                   | Par défaut | Rôle                                                                                  |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------- |
| `projectRoots`           | vide       | Dossiers où MyIA détecte tes projets : `[{ "path": "D:/projets", "depth": 3 }]`.      |
| `projects`               | vide       | Projets déclarés à la main, avec leurs commandes de build (voir `config/agent.example.json`). |
| `godot.projectsRoot`     | vide       | Dossier où créer les nouveaux projets Godot.                                          |
| `godot.versionsDir`      | vide       | Dossier qui contient les `Godot_vX.Y.Z-stable_win64.exe` (détectés automatiquement).  |
| `godot.executables`      | vide       | Version → exécutable, prioritaire sur la détection : `{ "4.7": "D:/…/Godot.exe" }`.   |
| `godot.defaultVersion`   | `4.7`      | Version utilisée par défaut.                                                          |
| `programs`               | vide       | Programmes que l'IA peut lancer. Ajoute-les en le demandant à un agent (il cherche l'exe, tu confirmes). |

## Claude

| Option                         | Par défaut | Rôle                                                                                   |
| ------------------------------ | ---------- | -------------------------------------------------------------------------------------- |
| `claude.command`               | `claude`   | Commande de Claude Code (installé et connecté à ton abonnement).                       |
| `claude.model`                 | vide       | Modèle imposé aux délégations (vide = choix automatique).                              |
| `claude.autoModel`             | `true`     | Choisir Haiku, Sonnet ou Opus selon la difficulté de chaque tâche.                     |
| `claude.bypassPermissions`     | `false`    | Consoles Claude Code sans demande d'autorisation (Paramètres → Général).               |
| `claude.subagentModel`         | vide       | Modèle des sous-agents des consoles : vide (celui de la console), `haiku`, `sonnet`, `opus`. |
| `claude.consoleMcp.mode`       | `all`      | Serveurs MCP lancés par chaque console : `all` (tous), `none` (aucun), `only` (liste ci-dessous). |
| `claude.consoleMcp.servers`    | vide       | Avec `only` : noms des serveurs gardés (portées utilisateur et locale de ~/.claude.json). |
| `claude.maxTurns`              | `40`       | Tours au plus par délégation.                                                          |
| `claude.timeoutMinutes`        | `30`       | Durée maximale d'une délégation.                                                       |
| `claude.defaultAllowedTools`   | vide       | Outils accordés à Claude Code par défaut. Vide = lecture, écriture et git en lecture.  |
| `claudeApi.effort`             | `medium`   | Agents « API Claude » : `low`, `medium`, `high`, `xhigh`, `max` (coût et profondeur).  |
| `claudeApi.maxTokens`          | `32000`    | Longueur maximale d'une réponse (borne le coût).                                       |
| `claudeApi.timeoutMinutes`     | `10`       | Durée maximale d'une réponse.                                                          |

## Domotique

| Option              | Par défaut | Rôle                                                                                     |
| ------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `homeAssistant.url` | vide       | Adresse de Home Assistant (Paramètres → Appareils et domotique). Le jeton est dans le coffre Windows. |
| `autohotkey.path`   | vide       | AutoHotkey64.exe (v2) pour le contrôle de l'écran ; vide = emplacement d'installation habituel. |

## Registre de travail des équipes

| Option               | Par défaut | Rôle                                                                                     |
| -------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `work.provider`      | `file`     | `file` = registre local seul ; `exec:<chemin absolu du script>` = synchronisé avec un autre outil de suivi (docs/TRAVAIL.md §7). |
| `work.pullMinutes`   | `0`        | Relève automatique du suivi externe toutes les N minutes (0 = bouton « Synchroniser » seulement). |
| `work.timeoutSeconds`| `30`       | Durée maximale d'un appel du script (5 à 300 s).                                         |

## Autres IA : OpenAI, Gemini, Mistral, OpenRouter, Groq, DeepSeek, xAI

Les clés se saisissent dans **Paramètres → Général → Autres IA**. Elles sont vérifiées puis rangées dans le coffre Windows, jamais
dans ce fichier. Le modèle se choisit dans **Agents → Modèle → Autres IA**.

| Option                        | Par défaut | Rôle                                                  |
| ----------------------------- | ---------- | ----------------------------------------------------- |
| `apiProviders.maxTokens`      | `8192`     | Longueur maximale d'une réponse (borne le coût).      |
| `apiProviders.timeoutMinutes` | `10`       | Durée maximale d'une réponse.                         |

## Boîte à outils et serveurs MCP

| Option           | Par défaut | Rôle                                                                                   |
| ---------------- | ---------- | -------------------------------------------------------------------------------------- |
| `toolbox.dir`    | vide       | Dossier de la boîte à outils Python (vide = celle livrée avec MyIA).                   |
| `toolbox.python` | `python`   | Python qui lance la boîte à outils.                                                     |
| `mcpServers`     | vide       | N'importe quel serveur MCP (stdio) devient un service. Exemple dans `config/agent.example.json`. Un secret s'écrit `"secret:<nom>"` et se range avec `myia secret set <nom>` (console, depuis les sources). |
