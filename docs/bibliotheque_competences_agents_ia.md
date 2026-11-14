# Bibliothèque de compétences pour agents IA locaux

**Document de conception --- catalogue initial d'outils Python et de
compétences**

## 1. Objectif du projet

Cette bibliothèque doit permettre à des agents IA locaux --- y compris
des modèles modestes --- d'accomplir des tâches concrètes en s'appuyant
sur des outils déterministes.

L'agent reste responsable de comprendre la demande, de choisir une
stratégie et d'interpréter les résultats. Les outils exécutent les
opérations spécialisées : lire un projet, lancer une application,
vérifier un build, analyser une scène 3D, convertir une texture,
produire un rapport, etc.

La bibliothèque doit être :

-   **Modulaire :** chaque outil réalise une opération claire.
-   **Découvrable :** l'application peut inventorier les outils et
    présenter leurs descriptions aux agents.
-   **Prévisible :** entrées et sorties suivent un format commun.
-   **Extensible :** ajouter un outil ne nécessite pas de modifier le
    cœur du système.
-   **Orientée création et développement :** Godot, Blender, textures,
    objets 3D, applications Rust et automatisation du poste de travail
    sont prioritaires.
-   **Indépendante du modèle :** un agent utilisant un modèle local ou
    une API doit pouvoir appeler les mêmes outils.

Les outils liés spécifiquement à Arma 3 / SQF ne font pas partie du
périmètre.

## 2. PowerShell et Python : qui fait quoi ?

Les agents disposent déjà de PowerShell. C'est un avantage important :
il sait déjà effectuer beaucoup d'opérations système et lancer des
commandes natives.

Il ne faut donc pas réécrire en Python tout ce que PowerShell sait
faire.

### Utiliser PowerShell directement pour

-   Lancer une application ou un exécutable.
-   Ouvrir un dossier ou une URL dans le navigateur.
-   Exécuter `cargo`, `rustc`, `git`, `godot` ou d'autres outils en
    ligne de commande.
-   Lister des processus et vérifier si une application tourne.
-   Lire des informations système simples.
-   Exécuter des commandes ponctuelles de diagnostic.
-   Ouvrir un fichier avec son application par défaut.

### Créer un outil Python lorsque

-   L'opération doit avoir une interface stable et simple pour tous les
    agents.
-   Il faut valider les paramètres avant d'agir.
-   Il faut transformer une sortie console en résultat structuré.
-   Plusieurs commandes doivent être enchaînées dans un processus
    reproductible.
-   Il faut gérer des erreurs, des délais d'attente, des journaux ou des
    permissions.
-   Une bibliothèque Python spécialisée apporte une vraie valeur.
-   La tâche est métier : inspecter un projet Godot, analyser un fichier
    Blender, préparer un rapport de build, etc.

### Principe recommandé

**PowerShell est le bras d'exécution du poste de travail ; Python
fournit les outils spécialisés, les garde-fous et les résultats
structurés.**

Un outil Python peut parfaitement appeler PowerShell ou un programme
externe, puis analyser son résultat. L'agent n'a pas besoin de connaître
tous les détails de la commande sous-jacente.

Éviter de donner à chaque agent un accès illimité à toutes les commandes
système. Prévoir des permissions, des dossiers autorisés et une
validation humaine pour les actions sensibles.

## 3. Contrat commun des outils

Chaque outil devrait respecter une convention commune afin que le
gestionnaire d'outils puisse les découvrir et les exécuter
automatiquement.

### Structure conseillée

``` text
tools/
  system/
    system_info/
      tool.py
      manifest.json
  files/
    file_search/
      tool.py
      manifest.json
  godot/
    project_inspector/
      tool.py
      manifest.json
  blender/
    scene_inspector/
      tool.py
      manifest.json
```

Le nom des dossiers et la structure peuvent évoluer, mais chaque outil
doit avoir un identifiant unique et un manifeste descriptif.

### Exemple de manifeste

``` json
{
  "name": "file_search",
  "version": "1.0.0",
  "description": "Recherche des fichiers dans un dossier selon un nom ou une extension.",
  "category": "files",
  "entrypoint": "tool.py",
  "function": "execute",
  "parameters": {
    "query": {
      "type": "string",
      "description": "Nom ou fragment de nom à rechercher."
    },
    "directory": {
      "type": "string",
      "description": "Dossier de départ."
    }
  },
  "permissions": ["filesystem.read"]
}
```

### Format de réponse commun

``` python
def execute(params: dict) -> dict:
    try:
        result = {"count": 0, "items": []}

        return {
            "success": True,
            "data": result,
            "error": None,
            "warnings": []
        }

    except Exception as exc:
        return {
            "success": False,
            "data": None,
            "error": {
                "type": type(exc).__name__,
                "message": str(exc)
            },
            "warnings": []
        }
```

Règles recommandées :

-   Ne jamais retourner uniquement une phrase libre si des données
    structurées sont possibles.
-   Distinguer une opération réussie d'un résultat vide.
-   Renvoyer des erreurs compréhensibles et exploitables par le modèle.
-   Limiter la taille des sorties : proposer pagination, résumé ou
    export de rapport.
-   Définir les chemins de fichiers de façon explicite.
-   Prévoir un délai maximal pour les processus externes.
-   Journaliser les actions importantes.
-   Ne pas exposer les clés API, mots de passe ou variables secrètes
    dans les logs.

## 4. Catalogue des outils atomiques

Les outils atomiques sont des briques simples, appelables séparément.
Les compétences composées de la section 5 pourront les combiner.

### 4.1 Système et poste de travail

  -----------------------------------------------------------------------
  Identifiant suggéré                 Fonction
  ----------------------------------- -----------------------------------
  `system_info`                       Informations sur Windows, CPU, RAM,
                                      GPU, stockage et versions utiles.

  `process_list`                      Lister les processus en cours.

  `process_monitor`                   Vérifier la présence et la
                                      consommation d'un processus.

  `process_stop`                      Fermer un processus après contrôle
                                      des permissions et confirmation si
                                      nécessaire.

  `disk_analyzer`                     Analyser l'espace occupé par les
                                      dossiers.

  `environment_check`                 Vérifier la présence et les
                                      versions de Python, Rust, Cargo,
                                      Git, Godot, Blender, etc.

  `port_checker`                      Vérifier si un port local est
                                      disponible.

  `clipboard_read`                    Lire le presse-papiers, avec
                                      permission explicite.

  `clipboard_write`                   Copier du texte dans le
                                      presse-papiers.

  `screenshot_capture`                Effectuer une capture d'écran.

  `window_list`                       Lister les fenêtres ouvertes et
                                      leurs titres.

  `notification_send`                 Afficher une notification Windows.

  `archive_create`                    Créer une archive ZIP.

  `archive_extract`                   Extraire une archive dans un
                                      dossier autorisé.
  -----------------------------------------------------------------------

### 4.2 Lancement d'applications, fichiers et pages web

Ces outils sont essentiels pour des demandes naturelles telles que «
lance Godot », « ouvre mon projet », « lance le lecteur de musique » ou
« mets YouTube ».

  -----------------------------------------------------------------------
  Identifiant suggéré                 Fonction
  ----------------------------------- -----------------------------------
  `app_catalog`                       Lister les applications connues et
                                      leurs alias.

  `app_launch`                        Lancer une application enregistrée
                                      dans le catalogue.

  `app_close`                         Demander la fermeture d'une
                                      application connue.

  `app_focus`                         Mettre une fenêtre existante au
                                      premier plan si possible.

  `url_open`                          Ouvrir une URL dans le navigateur
                                      par défaut.

  `website_catalog`                   Lister les sites favoris ou
                                      raccourcis enregistrés.

  `file_open_default`                 Ouvrir un fichier avec son
                                      application par défaut.

  `folder_open`                       Ouvrir un dossier dans
                                      l'explorateur.

  `media_player_control`              Contrôler la lecture multimédia via
                                      les interfaces Windows disponibles.

  `media_now_playing`                 Obtenir les informations du média
                                      en cours si elles sont accessibles.
  -----------------------------------------------------------------------

#### Catalogue d'applications

Plutôt que de laisser l'agent deviner les chemins des exécutables,
prévoir un catalogue configurable :

``` json
{
  "godot": {
    "label": "Godot Engine",
    "executable": "C:/Tools/Godot/Godot.exe",
    "arguments": [],
    "aliases": ["godot", "éditeur godot"],
    "permissions": ["app.launch"]
  },
  "music_player": {
    "label": "Lecteur de musique",
    "executable": "C:/Program Files/ExamplePlayer/player.exe",
    "arguments": [],
    "aliases": ["lecteur de musique", "musique"],
    "permissions": ["app.launch"]
  }
}
```

Les chemins sont des exemples à remplacer par ceux de la machine. Le
catalogue réel doit être configuré par l'utilisateur ou détecté puis
confirmé.

Pour les sites :

``` json
{
  "youtube": {
    "label": "YouTube",
    "url": "https://www.youtube.com",
    "aliases": ["youtube", "vidéos"]
  }
}
```

Ne pas autoriser l'agent à transformer arbitrairement une phrase en
commande shell. Résoudre les demandes courantes via un catalogue
d'applications et de sites autorisés.

### 4.3 Fichiers et documents

  -----------------------------------------------------------------------
  Identifiant suggéré                 Fonction
  ----------------------------------- -----------------------------------
  `file_search`                       Rechercher des fichiers par nom,
                                      extension ou motif.

  `file_metadata`                     Lire taille, dates, format et
                                      métadonnées disponibles.

  `folder_tree`                       Générer l'arborescence d'un
                                      dossier.

  `text_read`                         Lire un fichier texte.

  `text_write`                        Créer un fichier texte.

  `text_patch`                        Appliquer une modification ciblée à
                                      un fichier, avec vérification du
                                      contexte.

  `text_diff`                         Comparer deux versions d'un
                                      fichier.

  `json_read`                         Lire et valider un JSON.

  `json_edit`                         Modifier un JSON en conservant sa
                                      structure.

  `yaml_read`                         Lire et valider un YAML.

  `csv_manager`                       Lire, filtrer et modifier des CSV.

  `markdown_manager`                  Créer, lire et mettre à jour des
                                      fichiers Markdown.

  `pdf_reader`                        Extraire le texte d'un PDF.

  `document_summary`                  Préparer une extraction structurée
                                      d'un document.

  `duplicate_finder`                  Détecter des fichiers en double.

  `image_metadata`                    Lire dimensions, format et
                                      métadonnées d'une image.

  `image_convert`                     Convertir des images entre formats.
  -----------------------------------------------------------------------

### 4.4 Recherche et Internet

  -----------------------------------------------------------------------
  Identifiant suggéré                 Fonction
  ----------------------------------- -----------------------------------
  `web_search`                        Effectuer une recherche via un
                                      moteur ou une API configurée.

  `webpage_read`                      Récupérer le contenu textuel d'une
                                      page.

  `url_check`                         Vérifier qu'une URL répond.

  `website_metadata`                  Extraire titre, description et
                                      métadonnées Open Graph.

  `http_request`                      Effectuer une requête HTTP avec
                                      domaines et méthodes autorisés.

  `rss_reader`                        Lire un flux RSS.

  `github_search`                     Rechercher des dépôts GitHub.

  `github_release`                    Consulter les versions publiées
                                      d'un projet.

  `download_file`                     Télécharger depuis une source
                                      autorisée vers un dossier défini.

  `website_change_detector`           Comparer le contenu d'une page à
                                      une version précédente.
  -----------------------------------------------------------------------

### 4.5 Développement général

  -----------------------------------------------------------------------
  Identifiant suggéré                 Fonction
  ----------------------------------- -----------------------------------
  `code_search`                       Rechercher une fonction, classe,
                                      variable ou chaîne dans un projet.

  `code_symbols`                      Extraire classes, fonctions,
                                      méthodes et imports.

  `code_analyzer`                     Produire une vue structurelle d'un
                                      projet.

  `syntax_check`                      Vérifier la syntaxe d'un langage
                                      pris en charge.

  `dependency_check`                  Repérer les dépendances manquantes
                                      ou incohérentes.

  `project_scan`                      Inventorier les dossiers, fichiers
                                      et points d'entrée d'un projet.

  `todo_scan`                         Rechercher TODO, FIXME et
                                      commentaires similaires.

  `log_analyzer`                      Regrouper les erreurs et
                                      avertissements de journaux.

  `server_check`                      Vérifier qu'un serveur ou service
                                      local répond.

  `code_format`                       Formater un fichier avec l'outil
                                      adapté au langage.
  -----------------------------------------------------------------------

### 4.6 Git

  -----------------------------------------------------------------------
  Identifiant suggéré                 Fonction
  ----------------------------------- -----------------------------------
  `git_status`                        Lire l'état du dépôt.

  `git_diff`                          Afficher les changements non
                                      validés.

  `git_log`                           Lire l'historique des commits.

  `git_branch_list`                   Lister les branches.

  `git_branch_create`                 Créer une branche.

  `git_commit`                        Créer un commit après validation.

  `git_restore_preview`               Présenter les changements qui
                                      seraient annulés avant toute
                                      restauration.
  -----------------------------------------------------------------------

Les opérations destructrices ou difficiles à annuler doivent toujours
être protégées par une confirmation.

### 4.7 Godot

Les outils Godot doivent aider l'agent à comprendre un projet,
travailler sur ses ressources et lancer des tests.

  -----------------------------------------------------------------------
  Identifiant suggéré                 Fonction
  ----------------------------------- -----------------------------------
  `godot_project_inspector`           Analyser `project.godot`, dossiers,
                                      scènes, scripts et ressources.

  `godot_scene_inventory`             Lister les scènes et leurs
                                      ressources associées.

  `godot_scene_inspector`             Lire la structure d'une scène
                                      `.tscn` lorsque son format le
                                      permet.

  `godot_script_inventory`            Inventorier les scripts GDScript et
                                      leurs relations.

  `godot_signal_scanner`              Repérer les signaux déclarés,
                                      connectés et émis.

  `godot_resource_scan`               Inventorier textures, sons,
                                      polices, matériaux et autres
                                      ressources.

  `godot_missing_resource_check`      Détecter des références de
                                      ressources manquantes.

  `godot_project_settings`            Lire les paramètres principaux du
                                      projet.

  `godot_import_check`                Vérifier l'état des imports de
                                      ressources.

  `godot_headless_check`              Lancer une vérification sans
                                      interface lorsque la version de
                                      Godot le permet.

  `godot_run_project`                 Lancer un projet précis dans Godot.

  `godot_run_scene`                   Lancer une scène précise pour test.

  `godot_export`                      Déclencher un export avec un preset
                                      existant.

  `godot_log_read`                    Récupérer et analyser les logs
                                      d'exécution.

  `godot_error_parser`                Transformer les erreurs Godot en
                                      données structurées.
  -----------------------------------------------------------------------

### 4.8 Blender et création 3D

Blender offre une interface Python particulièrement intéressante :
beaucoup d'opérations peuvent être automatisées par des scripts exécutés
dans Blender en mode interface ou en arrière-plan.

  -----------------------------------------------------------------------
  Identifiant suggéré                 Fonction
  ----------------------------------- -----------------------------------
  `blender_version`                   Détecter la version et le chemin de
                                      Blender.

  `blender_scene_inspector`           Inventorier objets, collections,
                                      caméras, lumières et scènes.

  `blender_object_inspector`          Lire nom, type, dimensions,
                                      transformations et données d'un
                                      objet.

  `blender_mesh_stats`                Obtenir le nombre de sommets,
                                      arêtes, faces et triangles.

  `blender_material_inspector`        Inventorier matériaux et paramètres
                                      accessibles.

  `blender_texture_inventory`         Lister les textures utilisées et
                                      leurs chemins.

  `blender_missing_assets`            Repérer les ressources externes
                                      manquantes.

  `blender_scene_cleanup_report`      Signaler objets inutilisés,
                                      doublons potentiels et éléments
                                      suspects.

  `blender_render`                    Lancer un rendu avec une caméra et
                                      des paramètres définis.

  `blender_preview_render`            Générer un rendu rapide de
                                      prévisualisation.

  `blender_export_model`              Exporter un modèle dans un format
                                      autorisé, par exemple GLB, glTF ou
                                      FBX selon les besoins.

  `blender_batch_convert`             Convertir plusieurs fichiers 3D.

  `blender_apply_transform_check`     Repérer les transformations qui
                                      méritent vérification avant export.

  `blender_uv_inspector`              Vérifier la présence et les
                                      caractéristiques des UV.

  `blender_asset_report`              Générer un rapport sur un fichier
                                      `.blend`.

  `blender_run_script`                Exécuter un script Blender approuvé
                                      depuis un emplacement autorisé.
  -----------------------------------------------------------------------

### 4.9 Textures et images pour le jeu

Cette catégorie peut donner beaucoup d'autonomie à un agent créatif,
notamment pour préparer des ressources destinées à Godot ou Blender.

  -----------------------------------------------------------------------
  Identifiant suggéré                 Fonction
  ----------------------------------- -----------------------------------
  `texture_info`                      Lire dimensions, format, canaux et
                                      profondeur de couleur.

  `texture_resize`                    Redimensionner selon une taille
                                      cible.

  `texture_convert`                   Convertir PNG, JPEG, WebP, TIFF et
                                      autres formats pris en charge.

  `texture_compress`                  Compresser une image selon un
                                      profil de qualité.

  `texture_atlas_create`              Regrouper plusieurs images dans un
                                      atlas.

  `texture_atlas_inspect`             Lire les régions et dimensions d'un
                                      atlas.

  `texture_transparency_check`        Vérifier alpha, transparence et
                                      zones vides.

  `texture_tile_check`                Aider à détecter les raccords
                                      visibles d'une texture répétable.

  `texture_seamless_preview`          Produire une prévisualisation
                                      répétée d'une texture.

  `texture_palette_extract`           Extraire une palette de couleurs
                                      dominante.

  `texture_palette_apply`             Appliquer une palette ou une
                                      transformation de couleurs.

  `texture_normal_generate`           Générer une normal map à partir
                                      d'une source, avec paramètres
                                      explicites.

  `texture_channel_pack`              Combiner des canaux d'images dans
                                      une texture.

  `texture_mipmap_check`              Vérifier les dimensions et
                                      contraintes utiles aux mipmaps.

  `sprite_sheet_slice`                Découper une spritesheet en images
                                      individuelles.

  `sprite_sheet_build`                Assembler des images en
                                      spritesheet.

  `image_background_remove`           Détourer une image via un outil ou
                                      modèle configuré.

  `image_batch_process`               Appliquer une suite de traitements
                                      à un lot d'images.
  -----------------------------------------------------------------------

Les outils de génération d'images ou de textures par IA peuvent être
ajoutés comme fournisseurs distincts. Le catalogue doit indiquer
clairement si l'outil fonctionne en local, via une API ou via un
logiciel externe.

### 4.10 Objets 3D et ressources de jeu

  -----------------------------------------------------------------------
  Identifiant suggéré                 Fonction
  ----------------------------------- -----------------------------------
  `model_file_inspector`              Lire les informations d'un fichier
                                      3D.

  `model_format_convert`              Convertir entre formats 3D
                                      compatibles.

  `model_thumbnail_render`            Générer une vignette de
                                      prévisualisation.

  `model_dimensions`                  Lire les dimensions et l'échelle
                                      d'un modèle.

  `model_mesh_stats`                  Mesurer la complexité géométrique.

  `model_material_report`             Inventorier les matériaux et
                                      textures liés.

  `model_uv_check`                    Vérifier les UV lorsque le format
                                      ou le logiciel le permet.

  `model_export_validate`             Vérifier les points courants avant
                                      intégration dans un moteur.

  `asset_naming_check`                Contrôler les conventions de
                                      nommage.

  `asset_folder_organizer`            Proposer une organisation cohérente
                                      des ressources.

  `asset_manifest`                    Générer un inventaire JSON ou
                                      Markdown des assets.

  `asset_dependency_report`           Identifier les fichiers nécessaires
                                      à un asset.
  -----------------------------------------------------------------------

### 4.11 Rust et processus de build

Les agents doivent pouvoir compiler, tester et lancer les applications
Rust sans devoir improviser les commandes à chaque fois.

  -----------------------------------------------------------------------
  Identifiant suggéré                 Fonction
  ----------------------------------- -----------------------------------
  `rust_environment_check`            Vérifier Rust, Cargo, toolchains et
                                      cibles installées.

  `cargo_project_inspector`           Lire `Cargo.toml`, crates, binaires
                                      et structure du projet.

  `cargo_check`                       Lancer `cargo check` et structurer
                                      les diagnostics.

  `cargo_test`                        Lancer les tests et récupérer les
                                      résultats.

  `cargo_build_debug`                 Construire en mode debug.

  `cargo_build_release`               Construire en mode release.

  `cargo_run`                         Lancer le binaire ou la cible
                                      sélectionnée.

  `cargo_clippy`                      Lancer Clippy et présenter les
                                      avertissements.

  `cargo_fmt_check`                   Vérifier le formatage avec rustfmt.

  `cargo_clean_preview`               Estimer ce qui sera supprimé avant
                                      un nettoyage Cargo.

  `cargo_dependency_tree`             Afficher l'arbre des dépendances.

  `rust_log_capture`                  Capturer stdout, stderr et code de
                                      sortie d'une exécution.

  `rust_build_report`                 Générer un rapport de build avec
                                      durée, cible, erreurs et
                                      avertissements.

  `rust_app_test_launch`              Construire si nécessaire puis
                                      lancer une application en mode
                                      test.

  `rust_release_package`              Préparer les artefacts d'une
                                      release selon une configuration
                                      définie.
  -----------------------------------------------------------------------

Chaque lancement doit préciser le projet, le profil, la cible éventuelle
et les arguments. Les sorties de compilation doivent être capturées et
résumées sans perdre le détail consultable.

### 4.12 Données, calcul et texte

  Identifiant suggéré   Fonction
  --------------------- --------------------------------------------------
  `calculator`          Effectuer des calculs fiables.
  `unit_converter`      Convertir les unités.
  `date_calculator`     Calculer des dates et durées.
  `text_counter`        Compter mots, caractères et lignes.
  `text_cleaner`        Normaliser et nettoyer du texte.
  `regex_tester`        Tester des expressions régulières.
  `language_detector`   Détecter la langue.
  `data_filter`         Filtrer des données selon des critères.
  `data_sorter`         Trier des données.
  `data_statistics`     Calculer des statistiques descriptives.
  `table_export`        Exporter des données vers CSV, JSON ou Markdown.

### 4.13 Organisation du travail

  Identifiant suggéré   Fonction
  --------------------- -----------------------------------------------
  `task_manager`        Créer, modifier et terminer des tâches.
  `note_manager`        Créer et rechercher des notes.
  `reminder_manager`    Gérer des rappels.
  `project_status`      Générer un état d'avancement.
  `daily_report`        Produire un rapport quotidien.
  `decision_log`        Enregistrer les décisions importantes.
  `time_tracker`        Suivre le temps consacré à un projet.
  `knowledge_search`    Rechercher dans une base documentaire locale.

### 4.14 Communication

  -----------------------------------------------------------------------
  Identifiant suggéré                 Fonction
  ----------------------------------- -----------------------------------
  `discord_webhook`                   Envoyer un message Discord via un
                                      webhook configuré.

  `discord_embed`                     Construire un message enrichi.

  `telegram_message`                  Envoyer un message Telegram via une
                                      intégration autorisée.

  `email_sender`                      Préparer ou envoyer un email via un
                                      service configuré.

  `email_reader`                      Lire des emails via une connexion
                                      autorisée.

  `webhook_listener`                  Recevoir des événements externes.

  `webhook_sender`                    Transmettre un événement à une
                                      application.
  -----------------------------------------------------------------------

### 4.15 Gestion des agents

Ces outils dépendent de l'API interne de l'application multi-agents. Ils
ne doivent pas être implémentés comme de simples appels réseau
arbitraires : le gestionnaire doit contrôler les identifiants,
permissions et états.

  -----------------------------------------------------------------------
  Identifiant suggéré                 Fonction
  ----------------------------------- -----------------------------------
  `agent_list`                        Lister les agents disponibles.

  `agent_status`                      Consulter leur état.

  `agent_message`                     Transmettre un message à un agent.

  `agent_task_create`                 Créer une tâche pour un sous-agent.

  `agent_history`                     Consulter l'historique autorisé.

  `agent_memory_search`               Rechercher dans la mémoire d'un
                                      agent.

  `agent_memory_write`                Enregistrer une information dans sa
                                      mémoire.

  `agent_report`                      Demander un compte rendu.

  `agent_capabilities`                Lister les outils et compétences
                                      d'un agent.

  `agent_delegate`                    Déléguer une mission selon les
                                      règles de l'application.
  -----------------------------------------------------------------------

## 5. Compétences composées

Une compétence est un scénario réutilisable qui combine plusieurs outils
atomiques. Elle expose une seule mission claire à l'agent, tout en
exécutant plusieurs étapes en interne.

### 5.1 Audit de projet Godot

**Demande possible :** « Fais un état des lieux de mon projet Godot. »

Étapes possibles :

1.  Vérifier que le dossier contient un projet Godot.
2.  Lire les paramètres du projet.
3.  Scanner scènes, scripts et ressources.
4.  Repérer les ressources manquantes.
5.  Analyser les logs disponibles.
6.  Inventorier les dépendances et plugins.
7.  Rechercher TODO et FIXME.
8.  Générer un rapport Markdown avec les constats et les points à
    vérifier.

Résultat : un rapport daté, les chemins concernés et une synthèse des
problèmes potentiels. L'outil doit distinguer les erreurs confirmées des
simples avertissements.

### 5.2 Tester une modification Godot

**Demande possible :** « Lance le projet pour vérifier cette
modification. »

1.  Identifier le projet et la scène de démarrage.
2.  Vérifier les modifications Git.
3.  Lancer une validation adaptée à la version de Godot.
4.  Démarrer le projet ou une scène de test.
5.  Capturer les sorties et erreurs.
6.  Présenter un résumé et les logs utiles.

L'agent ne doit pas déclarer un test réussi si le processus a échoué ou
si aucune vérification pertinente n'a été effectuée.

### 5.3 Audit d'une scène Blender

**Demande possible :** « Analyse ma scène Blender avant export. »

1.  Ouvrir ou inspecter le fichier `.blend`.
2.  Inventorier collections et objets.
3.  Relever les dimensions et statistiques des meshes.
4.  Vérifier les matériaux et textures externes.
5.  Contrôler les UV lorsque possible.
6.  Signaler les ressources manquantes.
7.  Générer un rapport et, si demandé, une prévisualisation.

### 5.4 Préparer un asset 3D pour Godot

**Demande possible :** « Prépare ce modèle pour l'intégrer dans Godot. »

1.  Inspecter le modèle source.
2.  Vérifier dimensions, échelle et transformations.
3.  Inventorier matériaux, textures et UV.
4.  Vérifier les ressources liées.
5.  Exporter dans un format défini, par exemple GLB.
6.  Vérifier que le fichier exporté existe et peut être relu.
7.  Générer une fiche d'asset avec les caractéristiques et éventuelles
    réserves.

Cette compétence doit d'abord analyser et rapporter. Les modifications
automatiques du fichier source doivent être explicites et réversibles.

### 5.5 Préparer des textures pour un projet

**Demande possible :** « Prépare ces textures pour mon jeu. »

1.  Inventorier les images sources.
2.  Vérifier formats, dimensions et transparence.
3.  Appliquer les tailles cibles configurées.
4.  Convertir ou compresser selon le profil.
5.  Générer les variantes nécessaires.
6.  Contrôler les fichiers produits.
7.  Créer un manifeste des ressources.

Les profils peuvent être adaptés à des textures d'environnement, UI,
sprites, icônes ou matériaux 3D.

### 5.6 Build et test d'une application Rust

**Demande possible :** « Fais un nouveau build et lance l'application en
test. »

1.  Vérifier l'environnement Rust.
2.  Identifier le workspace et le binaire cible.
3.  Lire l'état Git.
4.  Lancer `cargo check`.
5.  Lancer les tests configurés.
6.  Construire en debug ou release selon la demande.
7.  Vérifier la présence du binaire.
8.  Lancer l'application avec les arguments de test.
9.  Capturer stdout, stderr, code de sortie et durée.
10. Générer un rapport.

Le build release, la publication et le remplacement d'une version
distribuée doivent être des actions distinctes.

### 5.7 Lancer une application ou un site

**Demandes possibles :**

-   « Lance Godot. »
-   « Lance le lecteur de musique. »
-   « Mets YouTube. »
-   « Ouvre mon projet Blender. »

1.  Identifier l'intention.
2.  Chercher une correspondance dans le catalogue.
3.  Vérifier que la cible est autorisée.
4.  Lancer l'application, ouvrir le fichier ou le site.
5.  Retourner le résultat de l'action.

Si plusieurs applications correspondent, demander une précision. Ne pas
deviner un exécutable ou une URL inconnue.

### 5.8 Rapport de fin de session

**Demande possible :** « Fais-moi un compte rendu de ce qu'on a fait sur
le projet. »

1.  Lire les tâches et notes du projet.
2.  Examiner les modifications Git.
3.  Consulter les rapports de build et de test.
4.  Regrouper les décisions enregistrées.
5.  Produire un résumé Markdown : réalisé, problèmes, décisions,
    prochaines étapes.

## 6. Niveaux de permission et sécurité

Les outils qui agissent sur le poste de travail doivent avoir des
permissions explicites.

  -----------------------------------------------------------------------
  Niveau                  Exemples                Règle
  ----------------------- ----------------------- -----------------------
  Lecture                 Lire un fichier,        Autorisé dans les
                          inspecter un projet,    dossiers permis.
                          lister les processus    

  Préparation             Générer un rapport, une Autorisé dans les
                          prévisualisation ou un  dossiers de sortie
                          fichier dans un espace  configurés.
                          de travail              

  Modification            Modifier un fichier,    Sauvegarde ou aperçu
                          transformer une         recommandé ;
                          texture, changer une    confirmation selon le
                          scène                   risque.

  Exécution               Lancer une application, Limiter aux programmes
                          un script, un build ou  et projets autorisés.
                          un test                 

  Action sensible         Supprimer des données,  Confirmation humaine
                          publier, envoyer un     obligatoire.
                          message externe,        
                          modifier la             
                          configuration système   
  -----------------------------------------------------------------------

Mesures complémentaires :

-   Définir des dossiers autorisés et empêcher les sorties de ces zones
    sans permission.
-   Éviter les commandes shell construites par concaténation de texte
    fourni par le modèle.
-   Préférer des arguments séparés et des exécutables connus.
-   Utiliser des délais d'attente et des limites de taille de sortie.
-   Conserver les codes de sortie des processus.
-   Ne pas exécuter automatiquement du code trouvé dans un dépôt ou
    téléchargé.
-   Séparer les actions de test, de build, de publication et de
    suppression.
-   Protéger les clés API et secrets dans un stockage adapté.
-   Demander confirmation avant toute action irréversible ou externe.

## 7. Architecture du gestionnaire d'outils

Architecture logique recommandée :

``` text
Agent
  |
  v
Tool Manager
  |-- Découverte des manifestes
  |-- Catalogue et recherche d'outils
  |-- Validation des paramètres
  |-- Vérification des permissions
  |-- Exécution et timeout
  |-- Capture des sorties
  |-- Normalisation des résultats
  |-- Journalisation
  |
  +--> Outils Python
  |
  +--> Commandes PowerShell autorisées
  |
  +--> API des logiciels (Godot, Blender, etc.)
  |
  v
Résultat structuré renvoyé à l'agent
```

### Découverte

Au démarrage ou lors d'un rafraîchissement, le gestionnaire parcourt les
dossiers d'outils, lit les manifestes et construit un catalogue. Il peut
fournir à chaque agent uniquement les outils autorisés et pertinents
pour son rôle.

### Sélection par spécialité

Exemples de profils :

-   **Développeur Godot :** outils Godot, Git, fichiers, logs, build et
    test.
-   **Artiste 3D :** Blender, modèles, textures, conversions et
    prévisualisations.
-   **Développeur Rust :** Cargo, tests, builds, logs, Git et lancement
    d'applications.
-   **Assistant système :** applications, fenêtres, fichiers, processus
    et diagnostics.
-   **Documentaliste :** recherche web, documents, notes et rapports.

Un agent peut avoir plusieurs spécialités. Le profil ne doit pas
remplacer les permissions : il ne fait que filtrer les compétences
pertinentes.

## 8. Priorités de développement

Il est préférable de construire un socle fiable avant d'ajouter des
dizaines d'outils.

### Phase 1 --- Socle et poste de travail

-   [ ] Contrat commun d'exécution et format de réponse.
-   [ ] Découverte automatique des manifestes.
-   [ ] Validation des paramètres.
-   [ ] Permissions par outil.
-   [ ] `system_info`
-   [ ] `environment_check`
-   [ ] `file_search`
-   [ ] `folder_tree`
-   [ ] `text_read`
-   [ ] `text_write`
-   [ ] `app_catalog`
-   [ ] `app_launch`
-   [ ] `url_open`
-   [ ] `folder_open`
-   [ ] `notification_send`

### Phase 2 --- Développement et Git

-   [ ] `project_scan`
-   [ ] `code_search`
-   [ ] `code_symbols`
-   [ ] `log_analyzer`
-   [ ] `git_status`
-   [ ] `git_diff`
-   [ ] `git_log`
-   [ ] `syntax_check`

### Phase 3 --- Godot et Rust

-   [ ] `godot_project_inspector`
-   [ ] `godot_scene_inventory`
-   [ ] `godot_missing_resource_check`
-   [ ] `godot_headless_check`
-   [ ] `godot_run_project`
-   [ ] `godot_log_read`
-   [ ] `cargo_project_inspector`
-   [ ] `cargo_check`
-   [ ] `cargo_test`
-   [ ] `cargo_build_debug`
-   [ ] `cargo_build_release`
-   [ ] `cargo_run`
-   [ ] `rust_build_report`

### Phase 4 --- Création 3D et textures

-   [ ] `blender_scene_inspector`
-   [ ] `blender_mesh_stats`
-   [ ] `blender_material_inspector`
-   [ ] `blender_render`
-   [ ] `blender_export_model`
-   [ ] `texture_info`
-   [ ] `texture_resize`
-   [ ] `texture_convert`
-   [ ] `texture_atlas_create`
-   [ ] `texture_seamless_preview`
-   [ ] `model_file_inspector`
-   [ ] `asset_manifest`

### Phase 5 --- Compétences composées

-   [ ] Audit de projet Godot.
-   [ ] Test d'une modification Godot.
-   [ ] Audit d'une scène Blender.
-   [ ] Préparation d'un asset 3D pour Godot.
-   [ ] Préparation de textures pour un projet.
-   [ ] Build et test d'une application Rust.
-   [ ] Lancement d'applications et de sites par alias.
-   [ ] Rapport de fin de session.

## 9. Principes à conserver

1.  **Un outil = une responsabilité claire.** Les scénarios complexes
    sont des compétences composées.
2.  **Ne pas remplacer PowerShell sans raison.** L'envelopper lorsque
    cela apporte validation, stabilité ou structuration.
3.  **Privilégier les API officielles des logiciels.** Blender Python,
    ligne de commande Godot et Cargo sont plus fiables que
    l'automatisation de clics lorsque c'est possible.
4.  **Toujours vérifier le résultat réel.** Un processus lancé n'est pas
    nécessairement un build réussi.
5.  **Conserver les détails techniques.** L'agent reçoit une synthèse,
    mais peut demander les logs ou résultats complets.
6.  **Ne pas donner tous les outils à tous les agents.** Le catalogue
    peut être filtré selon les missions et permissions.
7.  **Concevoir pour l'ajout futur.** Les outils doivent être
    versionnés, documentés et testables indépendamment.

------------------------------------------------------------------------

## 10. Vision cible

L'objectif n'est pas seulement de fournir des scripts à un modèle. C'est
de créer un environnement dans lequel un agent peut :

-   comprendre les projets présents sur la machine ;
-   lancer les logiciels et ouvrir les ressources pertinentes ;
-   inspecter, convertir et préparer des assets ;
-   construire et tester des applications ;
-   utiliser des outils créatifs spécialisés ;
-   déléguer une partie du travail à d'autres agents ;
-   produire des rapports vérifiables ;
-   agir dans les limites de permissions clairement définies.

Un modèle modeste peut alors se concentrer sur la planification et la
coordination, tandis que les outils prennent en charge les opérations
précises et répétables.
