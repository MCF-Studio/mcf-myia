# tools/ — bibliothèque d'outils pour agents

Conçue d'après `bibliotheque_competences_agents_ia.md` (à la racine).

    python tools/tool_manager.py list
    python tools/tool_manager.py run <outil> '{"param": "valeur"}'

## Ajouter un outil
1. Créer `tools/<categorie>/<nom>/manifest.json` + `tool.py` (voir `files/text_read` comme modèle).
2. `tool.py` expose `execute(params) -> {"data": ..., "warnings": [...]}` ; lever une exception pour une erreur
   (le gestionnaire la convertit en `{success: false, error: {type, message}}`).
3. Réponse toujours bornée (limite + `truncated`), jamais de shell construit par concaténation (listes d'arguments),
   timeout sur tout sous-processus, ne pas conclure « ok » si la vérification est incomplète.
4. Aides partagées dans `common.py` (`iter_files`, catalogue d'applis). Applis lançables : `apps.json` uniquement.

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

## Outils `images` (Pillow : `pip install -r tools/requirements.txt`)
Un fichier OU un dossier entier en entrée (`path`), sortie (`output`) dans un autre fichier/dossier : la source n'est
jamais modifiée. 500 images max par appel ; en lot, une image en échec n'arrête pas les autres (erreurs listées).
Couleurs : `#rrggbb`, `#rrggbbaa`, nom CSS, `rgb(r,g,b)`, `transparent`. Dossier d'images -> logo sur toutes :
`run image_overlay '{"path":"d/photos","output":"d/out","overlay":"d/logo.png","position":"bottom-right"}'`.
Tests : `python -m unittest discover -s tools/tests -v`. Un GIF animé est traité sur sa première image.

## À faire (priorités du doc, §8)
blender_* (blender 4.5 en `--background`),
compétences composées (§5).

## Politique (appliquée par tool_manager.py)
- `policy.json` : `granted_permissions` (permissions des manifestes accordées) et `allowed_dirs` (lecture / écriture).
- Mode fermé : un paramètre est contrôlé comme chemin s'il est `"kind": "path"` OU s'il s'appelle path, file, project,
  directory, repo, output, folder ou dir. Pour un texte qui n'est pas un chemin et porte un de ces noms : `"kind": "text"`.
  Dans un outil `filesystem.write`, `output` (ou `path` s'il n'y a pas d'`output`) est vérifié en écriture, les autres en lecture.
- Écriture : `text_write` refuse d'écraser sans `overwrite=true` ; `text_write`/`text_patch` gardent un `.bak`.
- Compatibilité : Python 3.10 (pas de `Path.read_text(newline=)`).
