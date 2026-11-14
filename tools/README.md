# tools/ : boîte à outils pour agents (expérimentale)

**État.** Boîte **expérimentale**, **non branchée à l'app MyIA** : rien dans `agent/` ni `app/` ne l'appelle et elle
n'est pas dans l'installateur. Un agent (ou un humain) s'en sert en lançant `tool_manager.py`. Conçue d'après
[docs/bibliotheque_competences_agents_ia.md](../docs/bibliotheque_competences_agents_ia.md). Ses règles de sécurité
sont celles de [docs/SPEC.md](../docs/SPEC.md) §3 et §5 : toute modification de ces règles met la spec à jour.

    python tools/tool_manager.py list
    python tools/tool_manager.py run <outil> '{"param": "valeur"}' [--confirmed]
    python tools/tool_manager.py run <outil> - [--confirmed]      # paramètres JSON sur l'entrée standard

Réponse : toujours du JSON `{success, tool, risk, data, error, warnings}`. Code de sortie : `0` exécuté, `1` refusé
ou en échec, `2` confirmation requise.

## Sûr par défaut

### 1. Créer sa politique locale (obligatoire)
Sans `tools/policy.json`, le gestionnaire **refuse de démarrer** (`PolicyMissing`).

    copy tools\policy.example.json tools\policy.json
    copy tools\apps.example.json tools\apps.json      (seulement pour lancer des applications)

Puis adapter `policy.json` à son poste : `allowed_dirs.read` / `allowed_dirs.write` (chemins absolus locaux ; listes
vides = aucun fichier accessible) et `granted_permissions`. Ces deux fichiers sont **locaux** (`.gitignore`) : ils
contiennent des chemins du poste et ne se publient jamais. Seuls les modèles `*.example.json` sont dans le dépôt.

### 2. Niveaux de risque et confirmation
Chaque manifeste déclare `risk`, avec les définitions de SPEC §3 :

| Niveau     | Outils                                                                                  | Règle                                         |
| ---------- | --------------------------------------------------------------------------------------- | --------------------------------------------- |
| `read`     | lecture, recherche, analyse, git en lecture, vérifications d'environnement              | exécuté sans demander                         |
| `launch`   | `folder_open`, `notification_send`                                                      | sans demander, si `app.launch` est accordée   |
| `local`    | `text_write`, `text_patch`, les 15 outils `images`, `texture_convert`, `texture_resize`, `cargo_*`, `godot_headless_check`, `app_launch` | **confirmation** |
| `external` | `url_open`                                                                              | **confirmation toujours**                     |

Un outil `local` ou `external` lancé sans `--confirmed` **n'exécute rien** : il renvoie `ConfirmationRequired` et un
aperçu (`data.preview` : ce qui serait fait, fichiers créés ou remplacés, paramètres). Les contrôles de permissions et
de dossiers ont lieu avant : un aperçu ne s'affiche que pour une action permise.

**Qui pose `--confirmed` ?** L'**appelant** (un humain, ou le harnais qui pilote le modèle), après avoir montré
l'aperçu à l'utilisateur et obtenu son accord. **Jamais le modèle de sa propre initiative.** Le drapeau n'est lu que
sur la ligne de commande, jamais dans les paramètres JSON. Un harnais qui laisse le modèle écrire librement la ligne
de commande doit donc intercepter cet argument lui-même : le gestionnaire ne peut pas savoir qui l'a tapé.

### 3. Désactivé par défaut
`policy.example.json` n'accorde que `filesystem.read` et `filesystem.write`, sans aucun dossier. Tout ce qui lance un
programme ou sort de la machine doit être ajouté **explicitement** à `granted_permissions` de la politique locale :

| Permission              | Outils                                                                 |
| ----------------------- | ---------------------------------------------------------------------- |
| `process.exec.readonly` | `git_status`, `git_log`, `git_diff`, `environment_check`, `rust_environment_check` |
| `process.exec`          | `cargo_check`, `cargo_test`, `cargo_build`, `cargo_clippy`, `cargo_fmt_check`, `godot_headless_check` (exécutent le code du projet) |
| `app.launch`            | `app_launch`, `folder_open`, `notification_send`                       |
| `url.open`              | `url_open` (ouvrir une adresse = canal de sortie de données)           |
| `network.local`         | `server_check` (127.0.0.1 uniquement)                                  |

`list` indique pour chaque outil `risk`, `needs_confirmation` et `enabled` (ses permissions sont-elles accordées).

### 4. Limites dures (dans le code, quelle que soit la politique)
- **Écriture de texte** (`text_write`, `text_patch`) : liste d'autorisation de formats texte (txt, md, csv, json, yaml,
  toml, xml, html, css, sql…), 1 Mo au plus. Jamais de code ni de script (`.rs`, `.py`, `.gd`, `.bat`, `.ps1`…), jamais
  un fichier qui pilote un outil (`Cargo.toml`, `package.json`, `CLAUDE.md`, `AGENTS.md`, `.mcp.json`…). Même liste que
  `file_write` de l'app (`agent/src/services/file-write.ts`), reprise dans `safety.py`.
- **Dossiers interdits en écriture pour tous les outils** : `.git`, `.vscode`, `.claude`, `.github`, `.cargo`,
  `.husky`, `node_modules`, dossiers de démarrage ; `tools/` lui-même ; le dépôt qui contient `tools/`, sauf son
  `workspace/`. En lecture, `data/` et `config/` de ce dépôt restent fermés.
- **Chemins** : contrôlés sur le chemin réel (liens, jonctions, noms courts résolus), et c'est ce chemin que l'outil
  reçoit. Chemins réseau, `C:dossier`, flux alternatifs `a.txt:b`, points ou espaces finaux et noms réservés refusés.
  Un paramètre est un chemin s'il est `"kind": "path"` OU s'il s'appelle path, file, project, directory, repo, output,
  folder ou dir, quel que soit son `type` (pour un texte qui porte un de ces noms : `"kind": "text"`). Il est contrôlé
  en écriture si le manifeste dit `"access": "write"`.
- **Git** : lancé comme dans l'app (`--no-pager`, `core.fsmonitor=false`, `protocol.ext.allow=never`,
  `log.showSignature=false`, `--no-ext-diff`, `--no-textconv`, pathspecs littéraux, aucune variable `GIT_*` héritée,
  pas d'invite). La config d'un dépôt ne peut faire lancer aucune commande.
- **Applications** (`app_launch`) : seulement celles de `tools/apps.json` ; **liste blanche** d'arguments par
  application (`allowed_args`, vide dans le modèle = aucun argument) ; au plus un fichier (`file`), contrôlé par la
  politique de dossiers et limité aux extensions `open_extensions` ; shells et interpréteurs refusés.
- **Manifestes** : `entrypoint` fixé à `tool.py` dans le dossier de l'outil, fonction `execute`, `name` = nom du
  dossier. Un manifeste invalide, ou deux outils de même nom, ne sont pas chargés (signalés par `list`).
- **Tailles** : images de 40 Mpx au plus, ouvertes avec une liste fermée de décodeurs (jamais EPS/Ghostscript),
  paramètres numériques plafonnés, délais plafonnés, lecture de texte en flux, expression régulière de `code_search`
  exécutée dans un processus à part, arrêté au bout de 20 s.

## Ajouter un outil
1. Créer `tools/<categorie>/<nom>/manifest.json` + `tool.py` (voir `files/text_read` comme modèle).
2. Le manifeste déclare `risk` (`read` / `launch` / `local` / `external`) et `permissions`. Le gestionnaire refuse un
   niveau trop bas pour une permission : `filesystem.write` et `process.exec` = au moins `local`, `url.open` =
   `external`. Bornes facultatives par paramètre : `min`, `max`, `max_length`.
3. `tool.py` expose `execute(params) -> {"data": ..., "warnings": [...]}` ; lever une exception pour une erreur
   (le gestionnaire la convertit en `{success: false, error: {type, message}}`).
4. Réponse toujours bornée (limite + `truncated`), jamais de shell construit par concaténation (listes d'arguments),
   délai plafonné sur tout sous-processus (`common.bounded`), ne pas conclure « ok » si la vérification est incomplète.
5. Un outil qui écrit : refuser d'écraser sans `overwrite`, ne jamais écrire sur sa source (`imaging.guard_output`,
   `safety.check_text_target`), contrôles sur le chemin FINAL.
6. Ajouter un test dans `tools/tests/` pour chaque refus.

## Existants (47)
system : environment_check, app_catalog, app_launch, url_open, folder_open, notification_send
files : file_search, folder_tree, text_read, text_write, text_patch
dev : code_search, code_symbols, project_scan, syntax_check, log_analyzer, todo_scan, server_check
git : git_status, git_log, git_diff
godot : godot_project_inspector, godot_headless_check
rust : cargo_check, cargo_test, cargo_build, cargo_clippy, cargo_fmt_check, rust_environment_check
textures : texture_info, texture_resize, texture_convert
images : image_color_replace, image_overlay, image_fit, image_adjust, image_crop, image_transform, image_text,
         image_palette, image_frame, image_generate, image_icon_create, image_sprite_sheet, image_app_icons,
         image_compare, image_optimize

## Outils `images` (Pillow : `pip install -r tools/requirements.txt`, version figée)
Un fichier OU un dossier entier en entrée (`path`), sortie (`output`) dans un autre fichier/dossier : la source n'est
jamais modifiée ni remplacée, **même avec `overwrite`**. Un fichier de sortie qui existe déjà est refusé sauf
`overwrite: true` ; en lot, le refus a lieu avant tout traitement. 500 images max par appel ; en lot, une image en
échec n'arrête pas les autres (erreurs listées).
Couleurs : `#rrggbb`, `#rrggbbaa`, nom CSS, `rgb(r,g,b)`, `transparent`. Dossier d'images -> logo sur toutes :
`run image_overlay '{"path":"d/photos","output":"d/out","overlay":"d/logo.png","position":"bottom-right"}' --confirmed`.
Un GIF animé est traité sur sa première image.

## Tests
    python -m unittest discover -s tools/tests -v

`test_images.py` (comportement des outils images), `test_images_safety.py` (écrasements, tailles, décodeurs),
`test_manager.py` (politique, niveaux de risque, confirmation, écritures interdites, git, applications). Ils tournent
dans la CI (job `tools`, Windows, Python 3.13, Pillow figé) et ne dépendent d'aucun chemin du poste.

## À faire (priorités du doc, §8)
blender_* (blender en `--background`), compétences composées (§5). Branchement éventuel à l'app : à décider, et
seulement à travers les confirmations de l'agent (un service qui appellerait le gestionnaire poserait `--confirmed`
après la confirmation de l'app, jamais avant).

## Compatibilité
Testé avec Python 3.13 (CI) et Pillow 13.0.0. Le code du gestionnaire évite ce qui demande plus que Python 3.10
(pas de `Path.read_text(newline=)`), mais seules les versions ci-dessus sont vérifiées.
