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

### Taille du contexte : qui fait quoi

Le **contexte** est tout ce que le modèle a sous les yeux pour un appel : consignes de l'agent, description des outils,
messages relus, résultats d'outils, et la réponse qu'il écrit. Il se compte en jetons (environ 3,5 caractères par jeton).
Plusieurs réglages y touchent, chacun à un endroit différent :

| Réglage                         | Bornes                      | Ce qu'il fixe                                                                                   | Concerne                         |
| ------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------- |
| `llm.numCtx`                    | 2048 à 131072 (défaut 8192) | La fenêtre de contexte demandée à Ollama à chaque appel.                                        | Agents locaux, moteur Ollama     |
| `llm.llamacpp.ctx`              | `auto`, ou 2048 à 262144    | La fenêtre de llama.cpp, fixée au lancement du moteur. `auto` = la plus grande qui tient en mémoire, en visant 32 768. | Agents locaux, moteur llama.cpp |
| (fixe, non réglable)            | 32 768                      | La fenêtre donnée à Claude Code quand il tourne sur un modèle local (son prompt seul fait environ 15 000 jetons). | Consoles Claude Code en local |
| `llm.kvCache`                   | `f16`, `q8_0`, `q4_0`       | La mémoire que coûte chaque jeton de contexte, **pas** la taille de la fenêtre. `q8_0` : environ moitié moins. | Les deux moteurs locaux |
| `historyMessages`               | 4 à 200 (défaut 30)         | Le nombre de messages de la conversation relus à chaque demande.                                | Tous les agents                  |
| (fixe, non réglable)            | 4 000 / 30 000 caractères   | La longueur gardée de chaque résultat d'outil : 4 000 pour un agent local, 30 000 pour un agent en ligne. | Tous les agents          |
| `optimization.context.*`        | 100 à 200000 jetons         | La place des notes ajoutées au prompt (coordination, registre de travail, mémoire).             | Si le Context Compiler est activé |
| `claudeApi.maxTokens`, `apiProviders.maxTokens` | jusqu'à 128000 | La longueur maximale d'une **réponse**. La fenêtre d'entrée, elle, est celle du modèle en ligne. | Agents en ligne      |
| `optimization.budget.maxTokens` | 0 à 10 000 000              | Le total consommé par une demande (tous les appels cumulés). Ce n'est pas une taille de fenêtre. | Si le budget est activé         |

À retenir :

- **Un seul moteur à la fois.** `llm.numCtx` ne sert qu'avec Ollama, `llm.llamacpp.ctx` qu'avec llama.cpp. Changer l'un
  quand l'autre moteur est actif n'a aucun effet.
- **Plus grand = plus de mémoire.** La fenêtre se réserve au chargement du modèle. Si elle ne tient plus dans la VRAM, une
  partie du modèle passe sur le processeur et les réponses ralentissent nettement. Avec 8 Go de VRAM et un modèle 8B,
  8192 à 16384 est une plage raisonnable.
- **Au-delà de ce que le modèle sait faire, rien n'est gagné.** Chaque modèle a une fenêtre maximale (affichée dans sa
  fiche) : il n'a pas été entraîné au-delà, une valeur plus haute n'apporte rien.
- **Quand la fenêtre est pleine**, Ollama écarte sans prévenir le début de l'échange : l'agent « oublie » les premières
  consignes ou le début de la conversation. Si un agent local perd le fil sur de longues tâches, monte `llm.numCtx`, ou
  baisse `historyMessages`.
- Ces réglages se changent dans le fichier (`llm.kvCache` aussi dans **Paramètres → Système**), puis redémarrage de MyIA.

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

## Optimisation des agents (`optimization`)

Phase 1 de `opti.md` : mesurer et contrôler la consommation des agents. **Tout est désactivé par défaut**, sauf les
statistiques en mémoire, qui ne changent rien au comportement : sans réglage, les agents font exactement comme avant.

### Statistiques des appels (`optimization.stats`)

Chaque appel au modèle est enregistré : agent, demande, modèle, jetons (estimés, et facturés quand le moteur les donne),
durée, outils demandés, erreur. **Jamais le contenu des échanges.**

| Option                          | Par défaut | Rôle                                                                             |
| ------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| `optimization.stats.enabled`    | `true`     | Enregistrer les appels (en mémoire).                                             |
| `optimization.stats.maxRecords` | `2000`     | Appels gardés en mémoire (100 à 100000) ; les plus anciens sortent.              |
| `optimization.stats.journal`    | `false`    | Écrire aussi chaque appel dans `data/stats/AAAA-MM.jsonl` (un fichier par mois). |

### Budget par demande (`optimization.budget`)

Chaque demande a son budget, contrôlé avant chaque itération, avant chaque appel et après chaque réponse. Budget épuisé :
l'agent s'arrête proprement, sans nouvel appel, et propose de continuer (« Dis « continue » »). L'arrêt est journalisé
(événement d'audit `budget_stop`). Les jetons **facturés** (API Claude, autres fournisseurs) sont décomptés quand ils sont
connus, l'estimation (environ 3,5 caractères par jeton) sinon (modèle local, Claude Code par abonnement).

| Option                                 | Par défaut | Rôle                                                                                |
| -------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `optimization.budget.enabled`          | `false`    | Activer le budget.                                                                  |
| `optimization.budget.maxTokens`        | `0`        | Jetons au plus par demande, entrée + sortie de tous les appels. 0 = sans limite.    |
| `optimization.budget.maxIterations`    | `0`        | Tours de la boucle au plus. 0 = `maxSteps`.                                         |
| `optimization.budget.maxLlmCalls`      | `0`        | Appels au modèle au plus. 0 = `maxSteps` + 1 (le point d'étape final).              |
| `optimization.budget.timeoutSeconds`   | `0`        | Durée au plus d'une demande. 0 = sans limite. Contrôlée entre deux appels : un appel en cours n'est pas coupé. |
| `optimization.budget.reserveForOutput` | `2000`     | Jetons gardés pour la réponse : un appel n'est lancé que s'il en reste assez.       |
| `optimization.budget.maxEscalations`   | `2`        | Changements de modèle (routeur) au plus par demande (0 à 5).                        |

### Context Compiler (`optimization.context`)

Assemble les notes variables du prompt (coordination de l'équipe, note du moment, mémoire) sous un budget de jetons, sans
appel au modèle : doublons retirés, blocs trop longs résumés puis tronqués avec un marqueur. Les règles de coordination
(consignes de l'utilisateur) ne sont **jamais** coupées. La trace de la dernière demande est dans `Agent.lastContextTrace`.

| Option                                    | Par défaut | Rôle                                                                            |
| ----------------------------------------- | ---------- | ------------------------------------------------------------------------------- |
| `optimization.context.enabled`            | `false`    | Activer le compilateur (sinon les notes sont recopiées telles quelles).         |
| `optimization.context.essentialMaxTokens` | `2000`     | Plafond indicatif des blocs essentiels : dépassement signalé, rien n'est coupé. |
| `optimization.context.relevantMaxTokens`  | `4000`     | Plafond des blocs pertinents (registre de travail, mémoire).                    |

### Model Router (`optimization.router`)

Choisit le modèle d'une demande **sans appeler de modèle** : classification par mots-clés, longueur et nombre d'étapes.
Modèle léger pour une demande simple, modèle de l'agent sinon. Si la réponse finale est jugée insuffisante (vide, coupée
par la limite de longueur, action annoncée sans être faite), la demande est reprise par le palier supérieur, dans la limite
de `budget.maxEscalations`. Un modèle qui échoue trop souvent sur une catégorie (historique en mémoire, remis à zéro au
redémarrage) est sauté.

- Seulement pour les agents **sans modèle fixé dans leur profil**.
- **Confidentialité** : un agent local ne reçoit que des modèles locaux. Un modèle en ligne indiqué pour un agent local
  est ignoré (sa mémoire et ses notes ne quittent pas le PC), et inversement.

| Option                               | Par défaut | Rôle                                                                  |
| ------------------------------------ | ---------- | --------------------------------------------------------------------- |
| `optimization.router.enabled`        | `false`    | Activer le routeur.                                                   |
| `optimization.router.light`          | vide       | Modèle léger pour les demandes simples (ex. `qwen3:4b`).              |
| `optimization.router.strong`         | vide       | Modèle plus fort pour l'escalade (ex. `qwen3:14b`).                   |
| `optimization.router.minSamples`     | `5`        | Essais sur une catégorie avant de juger un modèle sur son historique. |
| `optimization.router.minSuccessRate` | `0.6`      | Taux de réussite en dessous duquel le modèle est sauté (0 à 1).       |

Exemple :

```json
"optimization": {
  "budget": { "enabled": true, "maxTokens": 60000, "timeoutSeconds": 300 },
  "context": { "enabled": true },
  "router": { "enabled": true, "light": "qwen3:4b", "strong": "qwen3:14b" }
}
```
