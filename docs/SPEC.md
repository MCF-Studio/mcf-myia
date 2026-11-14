# MyIA : agent local du quotidien (spec v2 : console + app de bureau)

## 1. But

Un agent local à qui l'utilisateur parle en texte, depuis la console ou l'app de bureau (Tauri 2 + Vue 3). Il comprend la demande,
regarde les **services disponibles** et les utilise : envoyer une annonce Telegram/Discord, lancer le build d'un
projet, préparer un projet Godot avec des addons, ou déléguer une tâche lourde à Claude Code.

## 2. Architecture

```
G:\MyIALocal\
  runtime\ollama\        binaire Ollama autonome (pas celui de C:)
  ollama\models\         modèles (variable OLLAMA_MODELS)
  agent\                 code (TypeScript, Node 24)
    src\core\            moteur indépendant de l'interface (réutilisé par Tauri)
    src\services\        un fichier par service (telegram, discord, claude, projects, godot, mcp)
    src\cli\             interface console
  config\agent.json      configuration NON secrète (projets, destinations, modèle)
  data\audit\            journal JSONL de toutes les actions
  workspace\             dossier de travail par défaut des délégations sans projet
  docs\                  cette spec
```

- **Cerveau hybride** : un modèle local (Ollama, `qwen3:8b`) comprend la demande et choisit l'outil. Les tâches lourdes
  (code, build cassé, mise en place complexe) partent vers Claude Code via `claude -p` (abonnement, pas de clé API).
- **Services** : chaque service déclare ses outils et une fonction `available()`. Seuls les outils des services
  disponibles (jeton présent, binaire trouvé…) sont montrés au modèle. Ajouter un service = un fichier dans
  `services/` ou une entrée `mcpServers` dans la config (n'importe quel serveur MCP stdio).
- **Interface** : le cœur expose `Agent.handle(message, ui)` où `ui` fournit `confirm()` et `progress()`. La console
  l'implémente directement ; l'app lance le même cœur en **sidecar** Node (`agent/dist/server/main.js`) et lui parle en
  JSON-RPC sur stdio. Le Rust ne fait que relayer les lignes ; le sidecar valide chaque paramètre (zod).
- **Agents multiples** : un profil = nom, modèle, consignes, couleur, liste blanche de services. Chaque conversation a
  sa propre instance d'agent et son historique ; plusieurs conversations peuvent tourner en parallèle.

## 3. Modèle de permissions (qui peut faire quoi)

Une seule personne : l'utilisateur, sur sa machine. Pas d'accès réseau entrant : rien n'écoute sur une interface externe
(Ollama est forcé sur 127.0.0.1).

Chaque outil a un niveau de risque :

| Niveau     | Exemples                                             | Règle                                                  |
| ---------- | ---------------------------------------------------- | ------------------------------------------------------ |
| `read`     | lister les projets, chercher un addon, recherche web | exécuté sans demander                                  |
| `launch`   | ouvrir l'éditeur Godot, ouvrir un lien               | sans demander ; `browser_open` demande si le lien ne vient ni d'l'utilisateur ni d'une recherche |
| `local`    | build, création de projet, délégation, écriture de fichier | confirmation, sauf projet en `autoApprove` ou cas déclaré sans risque par l'outil (ex. nouveau fichier dans Documents\MyIA) |
| `external` | message Telegram/Discord, tout outil MCP non déclaré, tout outil d'un script d'équipe | **confirmation toujours**, avec le contenu exact       |

Limites dures, appliquées dans le code et pas seulement dans le prompt :

- Destinations Telegram/Discord : uniquement les **noms** déclarés dans la config. Le modèle ne peut pas inventer un
  chat_id ni un salon.
- Projets : ceux de la config, plus ceux **détectés** sous `projectRoots` (project.godot, src-tauri, Cargo.toml,
  package.json, dépôt git). Les commandes de build sont **générées par le code** à partir de la structure du projet
  (un preset d'export Godot = une cible ; Tauri/Rust = build, build-debug, check, test, front), lancées **sans shell**.
  Le modèle choisit un projet et une cible, jamais une commande ; la commande exacte est montrée avant confirmation.
- Programmes : l'IA ne lance que les exécutables **enregistrés** (`programs` dans la config), sans shell, avec au plus
  un fichier existant en argument (alors confirmé). Chercher un exe sur le PC (`program_find`) est en lecture seule ;
  l'**enregistrer** demande confirmation. Shells et interpréteurs (cmd, PowerShell, node, python…) sont refusés à
  l'enregistrement : sinon ce serait une commande libre déguisée.
  Chemins locaux uniquement (pas de chemin réseau, qui ferait fuiter le jeton NTLM), nom réel vérifié (pas de nom court
  8.3), outils du dossier Windows refusés sauf une courte liste inoffensive, empreinte SHA-256 enregistrée : un
  exécutable modifié depuis redemande confirmation avant de se lancer.
- Fichiers et musique : `open_path` ouvre un dossier ou un fichier avec l'application par défaut (via l'Explorateur,
  sans shell), **jamais** un exécutable ou un script (`.exe`, `.bat`, `.ps1`, `.lnk`, `.js`…) ; chemins locaux uniquement ;
  liste d'**autorisation** : sans confirmation uniquement un dossier, ou un média/document d'extension connue (formats
  Office sans macros), dans les dossiers habituels (Bureau, Documents, Musique, Images, Vidéos, projets) ; tout le reste,
  et tout fichier de Téléchargements, est confirmé.
  `music_play` lance une playlist, un morceau ou un dossier du dossier Musique (playlist générée dans `workspace\playlists`).
- Écriture de fichiers : `file_write` crée, remplace ou complète des fichiers **texte** (liste d'autorisation : txt, md,
  csv, json, yaml, html… ; le code passe par Claude Code ; fichiers qui pilotent un autre outil refusés : CLAUDE.md,
  AGENTS.md, .mcp.json, package.json, desktop.ini…). Contrôle sur le chemin réel (liens, noms courts 8.3), flux
  alternatifs « a.txt:b », points/espaces finaux et noms réservés Windows refusés ;
  uniquement dans les dossiers de l'utilisateur ; jamais dans un dossier qui exécute du code automatiquement
  (`.git`, `.vscode`, `.claude`, `.github`…), ni via un lien qui en sortirait. Nouveau fichier dans `Documents\MyIA`
  (dossier par défaut) ou le workspace : direct ; remplacer, compléter ou écrire ailleurs : confirmation avec aperçu.
  `file_read` lit un fichier texte des mêmes dossiers (contenu traité comme une donnée).
- Délégation Claude Code : `cwd` = projet de la config, sinon espace de travail de l'agent, sinon `workspace\` ;
  outils autorisés listés par projet.
- **Espace de travail** d'un agent ou d'une équipe (champ `workspace` de `config/agents.json` / `config/teams.json`,
  optionnel) : un dossier choisi par l'utilisateur depuis l'écran Agents ou Équipes, sur n'importe quel disque. Contrôlé
  à l'enregistrement : dossier local existant, ni disque entier, ni dossier personnel, ni emplacement protégé. Il n'est
  jamais repris d'un profil importé, ni créé par MASTER, ni exporté, et un agent de la Guilde n'en a pas. Pour CET agent
  (ou tous les membres de l'équipe, dont l'espace remplace celui de chaque agent), le dossier s'ajoute aux dossiers
  ouverts aux outils de fichiers, un chemin relatif de `file_write`/`file_read` y est résolu et `claude_delegate` sans
  projet s'y exécute. Les règles ne changent pas : écrire dans un espace de travail et déléguer restent confirmés,
  mêmes formats, mêmes dossiers interdits. Dossier absent (disque débranché) : l'agent en est prévenu et retombe sur
  les dossiers habituels.
- **Espace de coordination** d'une équipe (champ `coordination` de `config/teams.json`, optionnel) : un dossier À PART
  du projet, choisi par l'utilisateur depuis l'écran Équipes, où l'équipe garde ses règles communes (`LISEZ-MOI.md`,
  `methode.md`, fiches) et sa mémoire de travail (`journal/etat.md`, `journal/AAAA-MM-JJ.md`). Mêmes contrôles qu'un
  espace de travail, plus : ce n'est pas un dépôt git et il ne recoupe pas l'espace de travail de l'équipe. Pour les
  membres de CETTE équipe (jamais un agent seul, MASTER ou la Guilde), le dossier s'ajoute aux dossiers ouverts aux
  outils de fichiers, et le début de `LISEZ-MOI.md` et de `journal/etat.md` est joint à leur prompt ; `claude_delegate`
  l'ouvre aussi à Claude Code (`--add-dir`, montré dans la confirmation). **Seule exception aux confirmations d'écriture** :
  `file_write` crée, complète ou remplace sans confirmation un fichier du sous-dossier `journal` (mêmes formats texte,
  mêmes noms et dossiers interdits qu'ailleurs). Tout le reste de l'espace (les règles, les fiches) reste confirmé : ces
  fichiers guident tous les membres. L'état, écrit sans confirmation, est présenté aux agents comme des notes à
  vérifier, jamais comme des consignes. Il n'est ni exporté ni publié avec l'équipe. Un membre sur Claude lit cet
  espace : ce qu'il contient part alors chez Anthropic (c'est écrit dans l'aide de l'écran).
- **Scripts d'équipe** (`core/scripts.ts`, détail dans [WORKFLOWS.md](WORKFLOWS.md)) : des serveurs MCP en Python
  rattachés à une équipe, donnés à ses membres et à eux seuls. C'est le seul code exécuté que MyIA accepte de recevoir
  d'un tiers, et il n'est **pas isolé** : un script accepté a les droits de l'utilisateur. Il ne se lance donc jamais
  sans l'**accord** de l'utilisateur, donné après affichage du code et lié à l'empreinte SHA-256 de ses fichiers (un
  fichier modifié, ajouté ou retiré ensuite : plus de lancement). Fichiers dans `data\scripts\<id>`, fermé aux
  outils de fichiers ; lancement sans shell, par uv (version figée, empreinte vérifiée) ou un Python du PATH, avec un
  environnement réduit ; tous ses outils sont `external`. Ni MASTER ni un agent ne peut ajouter ou accepter un script :
  seul l'écran Équipes le fait. Un agent de la Guilde (bac à sable) n'en reçoit jamais.
- Addons Godot : extraits seulement sous `addons/`, avec protection contre le « zip slip » (chemin qui sort du dossier).
- Web : `web_read` ne lit que des adresses **publiques** (IP vérifiées à chaque redirection : ni 127.0.0.1, ni LAN,
  ni 169.254.169.254), taille plafonnée. `web_research` lance Claude Code avec **seulement** WebSearch et WebFetch,
  dans `workspace\` : aucun accès aux fichiers ni aux commandes.

## 3 bis. App de bureau et contenus partagés

**Fenêtre (Tauri 2)** : CSP stricte (`script-src 'self'`, aucune connexion réseau depuis la page, `object-src 'none'`,
images locales plus le seul CDN des avatars Discord),
capacités limitées à : relais du sidecar, métriques, notifications, ouverture de liens **http/https**
dans le navigateur système, et gestion de sa propre fenêtre (déplacer, réduire, agrandir, fermer : la barre de titre
est dessinée par l'app). La page n'ouvre jamais de lien elle-même ; les réponses sont rendues en Markdown avec le
HTML échappé. (`freezePrototype` est désactivé : incompatible avec xterm.js, le terminal des consoles.)

**Consoles Claude Code** : seule la commande `claude` peut être lancée dans un pseudo-terminal (pas de shell
libre), uniquement dans le workspace, un dossier de `projectRoots`/`projects` ou l'espace de travail d'un agent ou
d'une équipe (vérifié côté Rust à partir de la config, pas de l'interface) ; Claude Code y applique ses propres règles de permission. Les consoles meurent avec l'app.
**Mode bypass permissions** (`claude.bypassPermissions`, Paramètres → Général, **désactivé par défaut**) : les consoles
sont lancées avec `--dangerously-skip-permissions`, Claude Code n'y demande plus d'accord avant de modifier des
fichiers ou de lancer des commandes. Le réglage est lu dans la config côté Rust à chaque lancement (un appel de
l'interface ne peut pas l'imposer pour une console) ; il ne change ni les dossiers autorisés ni `claude_delegate`,
qui garde ses outils listés et sa confirmation. Activé, il aggrave le compromis ci-dessous : ce qui est tapé dans
une console s'exécute sans garde-fou de Claude Code.
**Compromis assumé** : une page compromise pourrait taper dans une console ouverte, et Claude Code peut exécuter
des commandes. La défense repose donc sur l'impossibilité d'injecter du script dans la page (CSP sans inline, HTML
des réponses échappé, liens ouverts hors de l'app), et `freezePrototype` est désactivé à cause d'xterm.js.

**Mises à jour automatiques** : au démarrage (jamais en développement), le Rust lit `latest.json` de la dernière
release GitHub (https uniquement), télécharge l'installateur et **vérifie sa signature** (minisign) avec la clé
publique embarquée dans l'app avant de l'exécuter ; un fichier non signé par la clé de MCF Studio est refusé. La page
n'intervient pas : elle n'a aucun accès réseau et ne peut ni choisir l'adresse ni fournir le fichier. Les releases sont
construites et signées sur le poste du mainteneur (`npm run release`), la clé privée ne quitte jamais ce poste et
n'est ni dans le dépôt ni dans GitHub.

**Instance unique et zone de notification** : un second lancement ne rouvre pas l'app, il ramène la fenêtre existante
au premier plan. L'icône près de l'horloge fait de même au clic gauche ; son menu (clic droit) ouvre une vue prise
dans une liste fermée côté Rust, ou quitte l'app par la sortie normale (consoles et cœur arrêtés).

**Compte mcfstudio.fr (Guilde)** : OAuth 2.0 + PKCE avec redirection loopback (RFC 8252) : le navigateur du système
s'ouvre sur `<site>/autoriser`, le site renvoie vers `http://127.0.0.1:<port>/callback` où MyIA écoute le temps de
l'échange ; l'état (`state`) est vérifié (un code injecté par un tiers est refusé). Jeton d'accès 15 min en mémoire
seulement ; jeton de renouvellement (rotation) dans le coffre Windows ; déconnexion = révocation sur le site.

**Relais de la Guilde** (`wss://myia.mcfstudio.fr/guilde/v1`, `core/guild-link.ts`, spec du site
`2026-11-11-guilde-relais-design.md`) : connexion dès que le compte est lié. Clé X25519 **par appareil** dans le coffre
Windows (`guild_device_key`) ; tout contenu est scellé pour l'appareil destinataire (ECDH éphémère, HKDF-SHA256,
AES-256-GCM, données associées = demande ‖ sens) : le relais ne lit rien. Fournisseur : seules les métadonnées des
offres activées sont publiées (jamais les consignes) ; on ne se propose que si les règles locales l'autorisent, on les
réapplique sur le texte déchiffré, puis bac à sable sans outils (mode auto) ou **validation du propriétaire** (onglet
Guilde, texte affiché avant tout traitement). Demandeur : premier fournisseur qui se propose. Empreintes des clés
affichées des deux côtés (parade v1 à un relais qui substituerait les clés).

**Moteur local** (Paramètres → Système) : Ollama, ou llama.cpp directement (`core/llamacpp.ts`) : `llama-server` en
mode routeur (`--models-dir llamacpp\models`, modèles chargés à la demande), API compatible OpenAI. Build figée
(b11808, CUDA 13 / Vulkan / processeur) et modèles du catalogue vérifiés par SHA-256 ; un GGUF Hugging Face hors
catalogue est vérifié avec l'empreinte LFS publiée par Hugging Face. Écoute sur 127.0.0.1, clé d'API aléatoire dans le
coffre Windows, passée par variable d'environnement (jamais en argument). Changer de moteur échange le modèle par
défaut avec celui gardé pour l'autre moteur. Flash attention et cache de contexte compressé (q8 par défaut) pour les
deux moteurs.

**Claude Code en local** (console, modèle « Local ») : `llama-server` et Ollama (0.40+) exposent l'API Messages
d'Anthropic ; la console lance `claude` sur le moteur actif (`ANTHROPIC_BASE_URL` local, modèle par défaut, clé du
coffre pour llama.cpp), tout étant lu **côté Rust** (config + coffre) : l'interface ne peut pas rediriger Claude Code
vers un autre serveur. Contexte fixé à 32 k (le prompt de Claude Code fait ~15 k tokens) : variante Ollama
`myia-claude:<modèle>` (mêmes poids, `num_ctx` 32 768), `--fit-ctx 32768` pour llama.cpp, et
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` pour que Claude Code compacte à temps ; réflexion coupée. Si le modèle déborde de la VRAM,
la console prévient (très lent).
`ANTHROPIC_API_KEY` est retirée de l'environnement de la console, le trafic non essentiel coupé.

**Coach des sessions Claude** : le modèle local évalue la difficulté d'une tâche (1 à 5) et choisit Haiku, Sonnet ou
Opus, pour `claude_delegate` (modèle affiché dans la confirmation) comme pour l'ouverture d'une console. Fable se
choisit à la main, jamais automatiquement (quota) ; en délégation il a Opus en repli (`--fallback-model`). La liste des
alias est fermée côté Rust et identique à celle du cœur (test). L'abonnement affiché vient de `claude auth status`,
dont le cœur ne garde que le type d'abonnement et la date de fin de connexion (ni e-mail, ni jeton). Dans une
console : changement de modèle (`/model`, affiché seulement une fois confirmé par la sortie de Claude Code), `/compact`, et « résumer et repartir » (Claude écrit une passation dans
`<projet>/.myia/handoff-*.md`, la session est vidée par `/clear`, puis reprise depuis la passation ; le cœur ne surveille
ce fichier que dans le workspace et les dossiers de projets). L'alerte « session longue » est une **estimation** (durée,
volume affiché), pas une mesure du contexte réel.

**Agent confié à Claude** (modèle `claude:<alias>` dans un profil) : Claude sert seulement de modèle. Chaque tour
lance `claude -p` sans aucun outil intégré, sans réglages, sans serveur MCP et sans session enregistrée ; il répond par
une sortie structurée (texte ou appels d'outils) et les outils restent ceux de MyIA, exécutés par MyIA avec les règles
du §3. La conversation et les résultats d'outils de cet agent partent chez Anthropic (abonnement Claude Code) : c'est
dit dans l'écran Agents. Il ne reçoit ni le contexte de mémoire ni les outils `memory_*` (test), et la Guilde refuse
un tel modèle (un membre extérieur ne consomme pas l'abonnement de l'utilisateur).

**Agent sur l'API Claude** (modèle `claude-api:<alias>` dans un profil ; alias `haiku`, `sonnet`, `opus`, `fable`
→ `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-2`, liste fermée) : même principe que
l'agent confié à Claude, mais par l'API Messages avec la clé d'API de l'utilisateur, facturée à l'usage. Les outils de
MyIA sont décrits en appel d'outils natif et exécutés par MyIA avec les règles du §3 ; aucun outil serveur d'Anthropic
n'est activé. Il fonctionne dans les équipes comme n'importe quel agent (le budget d'appels de l'équipe borne aussi
le coût), ne reçoit ni la mémoire ni les outils `memory_*`, et la Guilde le refuse (tests).
- *Qui voit quoi* : la clé n'est connue que du cœur. L'interface l'envoie une fois (`claudeApi.setKey`), le cœur la
  vérifie (`GET /v1/models`, sans jeton consommé) puis la range dans le coffre Windows (`anthropic_api_key`) ; aucune
  méthode ne la renvoie, seuls ses 4 derniers caractères sont affichés. Anthropic reçoit le prompt système, la
  conversation et les résultats d'outils de cet agent, rien d'autre.
- *Menaces et mesures* : clé détournée vers un autre serveur → adresse `https://api.anthropic.com` figée,
  `ANTHROPIC_BASE_URL` ignorée ; clé dans un journal ou un message d'erreur → erreurs passées par `redact`, audit
  limité à l'action (`claude_api_key` set/delete) ; dépense incontrôlée → `claudeApi.maxTokens` par réponse,
  `maxSteps` par demande, budget d'appels des équipes, consommation de chaque appel au journal d'audit
  (`claude_api_usage`), et limite de dépense à fixer sur platform.claude.com (rappelé dans Paramètres) ; injection
  par un résultat d'outil → mêmes confirmations qu'un agent local, résultats d'outils traités comme des données ;
  appel d'outil tronqué (`max_tokens`) → rien n'est exécuté.
- *Réflexions signées* : le prompt système est figé pour toute une demande ; les blocs d'origine (réflexion comprise)
  ne sont renvoyés que pour la demande en cours et jamais persistés, ce qui revient à retirer toutes les réflexions
  de tête, comme l'API le permet. Repli côté serveur (`fallbacks: "default"`) en cas de refus de sécurité, sauf Haiku.

**Installation d'Ollama** (Paramètres → Système, Windows) : le script officiel `https://ollama.com/install.ps1` est
enregistré puis lancé seulement si sa signature Authenticode est valide et au nom d'Ollama Inc. ; les variables qui le
détournent (`OLLAMA_DOWNLOAD_URL`…) ne lui sont pas transmises. Avant un téléchargement de modèle, le registre Ollama
est interrogé pour refuser tout de suite un nom inexistant.

**Dictée** : whisper.cpp (MIT) et son modèle se téléchargent à la demande, en versions figées dont l'empreinte SHA-256
est vérifiée avant usage (fichier rejeté sinon) ; archives extraites avec protection « zip slip » et plafond de taille.
L'audio (WAV 16 kHz) est transcrit localement dans un fichier temporaire supprimé ensuite ; rien ne sort de la machine.

**Photos d'agents** : PNG, JPEG ou WebP en data URL, recadrées et réduites à 256 px par l'app (le passage par un canvas
retire les métadonnées). Pas de SVG ni d'URL : une image ne peut ni exécuter de script ni appeler un serveur.

**Profils d'agents** : des données validées par schéma. Un profil peut seulement **restreindre** les services d'un agent ;
ses consignes s'ajoutent au prompt système sans remplacer les règles (§3), qui sont de toute façon appliquées par le
code, pas par le prompt. Les profils sont locaux (`config/agents.json`, hors git).

**Thèmes** : une liste fermée de couleurs (`#hex` ou `rgb()/rgba()`), un rayon parmi trois valeurs. Pas de CSS libre,
pas d'URL, pas de police distante : un thème ne peut ni exécuter de code ni appeler un serveur.

**Mémoire** : dossiers de documents texte (`.md`, `.txt`) choisis par l'utilisateur (Paramètres → Général,
`memory.folders` dans `config/agent.json`, hors git). À chaque demande, l'index des documents et les passages les
plus pertinents (recherche par mots-clés, sans réseau) sont joints au prompt ; les outils `memory_search` et
`memory_read` (lecture seule) donnent le reste. Limites : 300 fichiers, 200 Ko par fichier, 2 Mo au total. La
mémoire ne quitte jamais le PC : ni l'agent de la Guilde (bac à sable) ni un agent confié à Claude ne la reçoivent,
ce que vérifient des tests.

**Agent MASTER** (profil `master: true`, un seul à la fois ; il garde son nom) : l'assistant du quotidien, qui pilote
l'app. En plus de ses services, il reçoit les outils `app_*` :
- lecture, sans confirmation : agents, équipes, conversations, Guilde (état, offres publiées), marketplace (il dit ce
  qui existe, sans rien lister ni installer : jamais de contenu inventé) ;
- créer une conversation : sans confirmation (rien ne sort, rien n'est détruit) ;
- créer ou supprimer un agent, publier une offre sur la Guilde : **confirmation à chaque fois**, avec le contenu
  complet dans la confirmation (nom, modèle, consignes, services ; texte de l'offre) ;
- `app_agent_message` : écrire à un autre agent et récupérer sa réponse. L'échange se fait dans une vraie
  conversation « MASTER ↔ agent », visible dans l'app (messages marqués « de MASTER »). Les confirmations demandées
  par l'agent appelé remontent dans la conversation de MASTER. Sans confirmation seulement si l'agent appelé n'a pas
  plus de pouvoirs que MASTER ; confirmé s'il a des services que MASTER n'a pas, ou si l'un tourne sur Claude et
  l'autre en local (ce qui passe entre eux, mémoire ou fichiers compris, partirait chez Anthropic). Un message
  venu de MASTER n'ajoute pas ses liens aux liens de confiance (ce n'est pas l'utilisateur). Le rôle MASTER ne
  s'attribue que dans l'écran Agents, jamais par un fichier importé.
*Qui voit quoi* : MASTER voit les noms, descriptions, modèles et consignes des agents, les titres des conversations et
l'état de la Guilde ; il ne lit pas le contenu des autres conversations (seulement les réponses aux messages qu'il
envoie). Il n'a **aucun** outil pour les réglages : clés d'API, accès à tout le PC, mode bypass, dossiers de mémoire,
mises à jour.
*Menaces et mesures* : injection par un résultat d'outil (page web, fichier) qui pousse MASTER à créer, supprimer ou
publier → ces actions sont toujours confirmées, contenu complet affiché ; un agent créé par MASTER ne peut pas être
MASTER et ne peut pas recevoir un modèle hors liste ; boucle ou coût incontrôlé entre agents → 6 messages à d'autres
agents au plus par demande, l'agent appelé n'a pas `app_agent_message` (profondeur 1), MASTER ne s'écrit pas à
lui-même, une conversation déjà occupée est refusée ; suppression de MASTER par lui-même → refusée ; offre de la Guilde
→ mêmes règles que l'écran Guilde (modèle local seulement, schéma `OfferSchema`).

**Touche « parler à MASTER »** (par défaut F9, Paramètres → Son et voix) : appuyer pour parler, même fenêtre cachée.
La touche est enregistrée côté Rust (`src-tauri/src/ptt.rs`) ; la page n'a PAS la permission des raccourcis globaux
(elle ne peut pas écouter le clavier hors de l'app) et ne reçoit que « enfoncée / relâchée » pour cette touche. Touches
permises : F1–F24, Pause, Inser, Arrêt défil, ou Ctrl/Alt/Maj + lettre, chiffre ou espace (jamais Alt+F4, jamais une
lettre seule qui volerait la frappe). La voix est transcrite en local (whisper.cpp) puis envoyée comme un message
normal dans la conversation de MASTER (créée au besoin) : mêmes confirmations que si la demande était tapée.

**Carte des agents de mcfstudio.fr** (Paramètres → Carte des agents, désactivée par défaut ; spec du site
`docs/superpowers/specs/2026-11-13-carte-agents-design.md`) : MyIA envoie au site les **noms** des agents cochés,
rien d'autre (ni consignes, ni modèle, ni conversations), avec une autorisation OAuth de portée `map` distincte de
celle de la Guilde (jeton de renouvellement dans le coffre : `mcfstudio_map_refresh`). Envois : au démarrage si le
dernier date de plus de 12 h, puis toutes les 12 h, et quand l'utilisateur change sa sélection (le site en refuse plus
de 4 par jour). Un nom hors des règles du site est signalé et n'est pas envoyé. Désactiver retire les agents du site
tout de suite puis révoque l'autorisation. Chaque envoi est journalisé (nombre de noms, jamais les noms).

**Accès aux fichiers** : par défaut, les agents lisent, cherchent (`files_find`, `folder_list`, `file_read`) et
écrivent (`file_write`, confirmé hors Documents\MyIA) dans les dossiers habituels, les projets et les dossiers de
mémoire. L'option « Accès à tout le PC » (`files.fullAccess`, désactivée par défaut, Paramètres → Accès aux fichiers,
journalisée) étend ces outils à tous les disques locaux fixes ; l'activer demande une confirmation qui rappelle que
l'utilisateur est seul responsable des consignes données à son IA et que MyIA / MCF Studio ne récoltent rien (un agent
sur Claude envoie toutefois à Anthropic ce qu'il lit, c'est écrit à côté de l'option). Restent fermés dans tous les cas
: Windows, Program Files, ProgramData, AppData (profils de navigateur, jetons), les clés (`.ssh`, `.aws`, `.claude`…) —
sauf dossier choisi explicitement par l'utilisateur — et, sans exception, `config/` et `data/` de MyIA (tests). Les
réglages s'appliquent sans redémarrage : la configuration est mise à jour en place pour tous les services.

**Workflows et marketplace** ([WORKFLOWS.md](WORKFLOWS.md)) : une équipe s'exporte en workflow (`myia/workflow@1` :
arbre, budgets, profils de ses agents, scripts), en fichier ou sur le marketplace de mcfstudio.fr. Ni espace de travail,
ni rôle MASTER, ni conversation, ni mémoire n'en sortent. À l'import, le contenu est montré avant toute écriture
(agents et consignes, code des scripts, manques) ; rien n'est écrasé (un id pris par un contenu différent donne un
nouvel id) ; l'installation porte sur exactement ce qui a été montré (empreinte) ; les scripts restent en attente si
l'utilisateur ne coche pas l'accord. Marketplace : lecture sans compte ; publication avec une autorisation OAuth de
portée `workflows` (jeton dans le coffre) ; l'auteur choisit privé ou public, et un workflow public n'est listé
qu'après validation par un admin du site. Rien de ce qui vient du site n'est de confiance : empreinte du paquet
recalculée et comparée à celle de la liste, champs affichés bornés, validation complète du format. Agents, thèmes,
modèles et extensions ne sont pas dans le registre en ligne : pour eux, seule l'installation depuis un fichier local
est proposée, et l'app n'affiche aucun contenu fictif.

## 4. Secrets

Jetons (bot Telegram, bot Discord) dans le **Gestionnaire d'identification Windows** (service `MyIA`), saisis via
`myia secret set <nom>` (saisie masquée). Jamais dans `config\agent.json`, jamais dans les journaux, jamais envoyés au
modèle.

## 5. Menaces et mesures

| Menace                                                                              | Mesure                                                                                 |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Le modèle local se trompe (mauvais destinataire, mauvais texte)                     | Destinations fermées + confirmation avec le texte exact avant tout envoi               |
| Injection de prompt via un résultat d'outil (description d'addon, sortie de Claude) | Les actions `external` exigent toujours la confirmation humaine, quel que soit le prompt |
| Exécution de commande arbitraire                                                    | Pas d'outil « shell libre » ; builds = argv fixés en config, sans shell                |
| Fuite de jeton                                                                      | Coffre Windows, redaction dans le journal, jamais dans le contexte du modèle           |
| Archive d'addon malveillante (chemins `..`)                                         | Extraction limitée à `addons/`, chemins normalisés et vérifiés                         |
| Addon Godot piégé (code GDScript)                                                   | Source affichée (titre, auteur, URL) dans la confirmation ; Asset Library officielle   |
| Accès réseau à l'agent ou à Ollama                                                  | Rien en écoute hors 127.0.0.1 ; `OLLAMA_HOST=127.0.0.1:11434`                          |
| Page web piégée (« ouvre ce lien », « envoie ce message »)                          | Contenu marqué comme donnée ; envois toujours confirmés ; `browser_open` confirme les liens venus d'une page |
| Lecture web vers le réseau local (Ollama, box, NAS), y compris par DNS rebinding     | `web_read` refuse toute IP non publique, vérifiée à chaque redirection ET au moment de la connexion (résolution épinglée) |
| Agent ou thème partagé piégé                                                        | Formats = données validées par schéma ; un profil ne peut que restreindre ; règles appliquées dans le code |
| Journal d'équipe empoisonné (un agent trompé par une page y écrit de fausses consignes) | Écriture sans confirmation limitée à `journal/` ; règles et fiches toujours confirmées ; l'état est joint au prompt comme des notes à vérifier ; les confirmations ne dépendent d'aucun texte |
| Espace de coordination détourné pour écrire sans confirmation dans un projet          | Refusé s'il est un dépôt git ou s'il recoupe l'espace de travail ; recontrôlé à chaque demande ; formats texte seulement |
| Workflow piégé (consignes d'agent malveillantes, écrasement d'un agent existant)     | Contenu montré avant installation ; rien n'est écrasé ; ni MASTER ni espace de travail importés ; les confirmations ne dépendent pas des consignes |
| Script d'équipe malveillant reçu dans un workflow                                    | Code affiché, accord explicite lié à l'empreinte, en attente par défaut ; chaque appel d'outil confirmé ; validation d'un admin avant toute publication publique. **Pas de bac à sable** : un script accepté a les droits de l'utilisateur |
| Script modifié après l'accord (par un autre programme, ou par un agent)              | Empreinte recalculée à chaque lancement et à chaque vérification ; `data\` fermé aux outils de fichiers |
| Script qui lit les secrets de l'environnement de MyIA                                | Environnement réduit à une liste fermée de variables système                              |
| Fichier de script qui sort de son dossier, ou binaire déguisé                        | Chemins relatifs validés, extensions texte seulement, contrôle du chemin résolu avant écriture |
| Site ou réseau qui sert un autre paquet que celui annoncé                            | Empreinte SHA-256 recalculée et comparée à celle de la liste ; https ; redirections refusées |
| Moteur Python piégé (uv modifié)                                                     | Version figée, empreinte SHA-256 vérifiée au téléchargement                             |
| Réponse du modèle contenant du HTML/script (page web lue)                           | Markdown rendu avec HTML échappé ; CSP sans script inline ; liens ouverts hors de l'app |
| Crash silencieux de la console ou du sidecar                                        | Erreurs fatales journalisées (event `crash`) avec la pile d'appel                       |
| L'IA fait lancer un programme dangereux ou un shell                                 | Liste fermée de programmes enregistrés ; ajout confirmé ; shells/interpréteurs bloqués |
| Ouverture d'un fichier piégé (script, raccourci) proposée par une page lue           | Extensions exécutables refusées ; hors dossiers habituels, confirmation                |
| Fuite de la mémoire (présentations, projets) vers un autre membre via la Guilde      | Le bac à sable de la Guilde est construit sans mémoire ni services ; test dédié          |
| Écriture de fichier détournée (chemin « C:dossier », lien, flux alternatif)          | Chemins relatifs au lecteur refusés ; chemin réel contrôlé avant ET après écriture       |
| Mise à jour piégée (release ou compte GitHub compromis, réseau détourné)             | Signature vérifiée avec la clé publique embarquée ; clé privée hors dépôt et hors GitHub ; https |
| Mode bypass activé à l'insu de l'utilisateur                                         | Désactivé par défaut ; réglage dans la config, lu côté Rust ; consoles limitées aux dossiers autorisés |
| Le relais (ou MCF Studio) lit une demande de la Guilde                               | Chiffrement de bout en bout par appareil ; le relais ne voit que des métadonnées        |
| Demande de la Guilde piégée (« lis mes fichiers », « envoie… »)                       | Bac à sable sans outils ni mémoire ; validation du propriétaire hors mode auto          |
| Moteur ou modèle local piégé (build ou GGUF modifié)                                 | Build figée et empreintes SHA-256 ; GGUF hors catalogue vérifié par l'empreinte Hugging Face |
| Page web ou programme local qui appelle le serveur llama.cpp                          | 127.0.0.1 seulement ; clé d'API aléatoire (coffre), hors ligne de commande              |
| Console « Local » détournée vers un serveur tiers (fuite du code du projet)           | Adresse, modèle et clé lus côté Rust ; jamais fournis par l'interface                   |
| Perte de traçabilité                                                                | Journal JSONL horodaté de chaque appel d'outil, décision et résultat                   |

## 6. Isolation

Mono-utilisateur, donc pas d'isolation entre clients à gérer en v1. Si l'agent touche un jour à des données clients
(projets clients, mcfstudio.fr), chaque client sera un projet séparé de la config, avec ses propres destinations
et outils autorisés. Aucune donnée d'un projet ne sera passée en contexte à un autre.

## 7. Feuille de route

1. **v1 (ici)** : console, Telegram, Discord, builds, Godot, délégation Claude Code, serveurs MCP externes.
2. WhatsApp (API Cloud officielle de Meta, numéro dédié).
3. **App Tauri 2 + Vue 3 (v0.1, ici)** : vue d'ensemble, conversations onglets/grille, agents, modèles, réglages.
4. Installateur autonome (Node embarqué), registre Marketplace sur mcfstudio.fr.
5. Voix locale de qualité (Whisper en entrée, Piper en sortie ; la synthèse Windows sert en attendant).
