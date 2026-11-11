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
| `external` | message Telegram/Discord, tout outil MCP non déclaré | **confirmation toujours**, avec le contenu exact       |

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
- Écriture de fichiers : `file_write` crée, remplace ou complète des fichiers **texte** (pas d'exécutable ni de script),
  uniquement dans les dossiers de l'utilisateur ; jamais dans un dossier qui exécute du code automatiquement
  (`.git`, `.vscode`, `.claude`, `.github`…), ni via un lien qui en sortirait. Nouveau fichier dans `Documents\MyIA`
  (dossier par défaut) ou le workspace : direct ; remplacer, compléter ou écrire ailleurs : confirmation avec aperçu.
  `file_read` lit un fichier texte des mêmes dossiers (contenu traité comme une donnée).
- Délégation Claude Code : `cwd` = projet de la config ou `workspace\`, outils autorisés listés par projet.
- Addons Godot : extraits seulement sous `addons/`, avec protection contre le « zip slip » (chemin qui sort du dossier).
- Web : `web_read` ne lit que des adresses **publiques** (IP vérifiées à chaque redirection : ni 127.0.0.1, ni LAN,
  ni 169.254.169.254), taille plafonnée. `web_research` lance Claude Code avec **seulement** WebSearch et WebFetch,
  dans `workspace\` : aucun accès aux fichiers ni aux commandes.

## 3 bis. App de bureau et contenus partagés

**Fenêtre (Tauri 2)** : CSP stricte (`script-src 'self'`, aucune connexion réseau depuis la page, `object-src 'none'`),
capacités limitées à : relais du sidecar, métriques, notifications, ouverture de liens **http/https**
dans le navigateur système. La page n'ouvre jamais de lien elle-même ; les réponses sont rendues en Markdown avec le
HTML échappé. (`freezePrototype` est désactivé : incompatible avec xterm.js, le terminal des consoles.)

**Consoles Claude Code** : seule la commande `claude` peut être lancée dans un pseudo-terminal (pas de shell
libre), uniquement dans le workspace ou un dossier de `projectRoots`/`projects` (vérifié côté Rust à partir de la
config, pas de l'interface) ; Claude Code y applique ses propres règles de permission. Les consoles meurent avec l'app.
**Compromis assumé** : une page compromise pourrait taper dans une console ouverte, et Claude Code peut exécuter
des commandes. La défense repose donc sur l'impossibilité d'injecter du script dans la page (CSP sans inline, HTML
des réponses échappé, liens ouverts hors de l'app), et `freezePrototype` est désactivé à cause d'xterm.js.

**Coach des sessions Claude** : le modèle local évalue la difficulté d'une tâche (1 à 5) et choisit Haiku, Sonnet ou
Opus, pour `claude_delegate` (modèle affiché dans la confirmation) comme pour l'ouverture d'une console. Dans une
console : changement de modèle (`/model`), `/compact`, et « résumer et repartir » (Claude écrit une passation dans
`<projet>/.myia/handoff-*.md`, la session est vidée par `/clear`, puis reprise depuis la passation ; le cœur ne surveille
ce fichier que dans le workspace et les dossiers de projets). L'alerte « session longue » est une **estimation** (durée,
volume affiché), pas une mesure du contexte réel.

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

**Marketplace (à venir)** : registre sur mcfstudio.fr, publications par des membres certifiés. Tant qu'il n'existe pas,
l'app n'affiche aucun contenu fictif ; seule l'installation depuis un fichier local est proposée.

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
| Réponse du modèle contenant du HTML/script (page web lue)                           | Markdown rendu avec HTML échappé ; CSP sans script inline ; liens ouverts hors de l'app |
| Crash silencieux de la console ou du sidecar                                        | Erreurs fatales journalisées (event `crash`) avec la pile d'appel                       |
| L'IA fait lancer un programme dangereux ou un shell                                 | Liste fermée de programmes enregistrés ; ajout confirmé ; shells/interpréteurs bloqués |
| Ouverture d'un fichier piégé (script, raccourci) proposée par une page lue           | Extensions exécutables refusées ; hors dossiers habituels, confirmation                |
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
