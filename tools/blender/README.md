# Outils Blender (`blender_*`, `polyhaven_find`)

Sept outils pour qu'un agent local construise, contrôle, regarde et exporte un modèle 3D **sans écrire de code** :
l'agent décrit l'objet en données (JSON) ; des scripts Blender fixes, relus et vérifiés par empreinte, font le travail.
Spécification d'origine : « Outils Blender pour les agents locaux de myia » (doc Claude du 17/11/2026).

Boucle de travail : `polyhaven_find` (matériaux) → `blender_build` → `blender_qa` → `blender_render_views` (revue) →
livraison du `.glb`. `blender_export_glb` sert à exporter un `.blend` fait à la main ; `blender_inspect` décrit un
fichier existant ; `blender_info` donne la version et le catalogue.

| Outil | Rôle | `risk` | Permissions |
| --- | --- | --- | --- |
| `blender_info` | version et chemin de Blender, formes et matériaux connus, bibliothèque | `read` | `process.exec.readonly` |
| `blender_inspect` | objets d'un `.blend` / `.glb` (≤ 200) : triangles, boîte, matériaux, collisions | `read` | `filesystem.read`, `process.exec.readonly` |
| `blender_build` | spec JSON → `<name>.blend` + `<name>.glb` optimisé | `local` | `filesystem.read`, `filesystem.write`, `process.exec` |
| `blender_qa` | contrôle d'un `.glb` (profil `game`) : z-fighting, pièces qui flottent, faces dos à dos… | `read` | `filesystem.read`, `process.exec.readonly` |
| `blender_render_views` | 4 PNG 1024 px (avant, trois-quarts, arrière, dessus) + silhouette | `local` | `filesystem.read`, `filesystem.write`, `process.exec` |
| `blender_export_glb` | `.blend` → `.glb` pour Godot, relu et comparé | `local` | `filesystem.read`, `filesystem.write`, `process.exec` |
| `polyhaven_find` | cherche un matériau dans la bibliothèque locale (mots anglais ou français) | `read` | `filesystem.read` |

## Installation sur un poste

1. Blender **5.2 LTS** : entrée `blender` de `tools/apps.json` (chemin de `blender.exe`).
2. `copy tools\blender.example.json tools\blender.json`, puis `polyhaven_library` = dossier de la bibliothèque Poly Haven
   (avec son `manifest.json`).
3. `tools/policy.json` : accorder `process.exec.readonly` et `process.exec`, et ouvrir les dossiers de travail
   (`allowed_dirs.read` / `.write`).
4. Vérifier : `python tools/tool_manager.py run blender_info`.

## La spec de `blender_build`

Unités : **mètres et degrés**, Z en haut, face avant vers **−Y** (= +Z dans Godot). Origine au sol.

```json
{
  "name": "Playground_Sandbox",
  "placement": "ground",
  "budget_tris": 5000,
  "props": {"mass_kg": 900, "destructible": false},
  "materials": {
    "W": {"kit": "Wood"},
    "sand": {"polyhaven": "sand_01"},
    "water": {"flat": [0.015, 0.025, 0.02], "rough": 0.08},
    "led": {"emissive": [0.1, 1.0, 0.3], "strength": 2}
  },
  "parts": [
    {"mirror": "y", "parts": [{"shape": "boxz", "size": [2.1, 0.04, 0.28], "loc": [0, 1.03, 0], "mat": "W", "bevel": 0.004}]}
  ],
  "collisions": [{"shape": "box", "name": "N", "size": [2.1, 0.05, 0.3], "loc": [0, 1.025, 0.15]}]
}
```

Exemples complets (traductions exactes des modèles du kit MCF) : [examples/](examples/) — bac à sable
(934 triangles), borne de recharge double (1 976), puits (712).

**Racine** : `name` (requis, `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`), `placement` (`ground` : bas à z = 0 ; `building` :
z = 0,01 ; `held` : objet tenu en main, pas de contrôle), `budget_tris` (défaut 5 000, avertissement au-delà ; plafond
dur 200 000), `props` (≤ 16 propriétés simples exportées dans les extras : `mass_kg`, `destructible`…),
`materials` (requis), `parts` (requis), `collisions`.

**Matériaux** (exactement un de ces champs) :

| Champ | Options | Notes |
| --- | --- | --- |
| `kit` | — | `Concrete`, `ConcreteDirty`, `ConcreteBlock`, `Galvanized`, `RustyMetal`, `DarkMetal`, `Wood`, `WoodDark`, `WoodRough`, `Stone`, `StoneDry`, `Plaster`, `Brick`, `Rubber`, `PlasticBlack`, `Glass`, `Painted_<Couleur>`, `Plastic_<Couleur>` (Couleur : Red, White, Yellow, Orange, Green, DarkGreen, Blue, Grey, Anthracite, Black, Brown) |
| `polyhaven` | `tint` [r,g,b], `metal`, `normal_strength`, `use_diff` | slug trouvé avec `polyhaven_find` |
| `flat` | `rough` (0,6), `metal` (0), `alpha` | couleur linéaire [r,g,b] ; composante > 0,9 signalée (peu réaliste) |
| `emissive` | `strength` (5) | lumières, écrans |

**Formes** (`"shape"`, champ `mat` requis ; `loc`/`rot` en option, `[0,0,0]` par défaut) :

| Forme | Champs | Notes |
| --- | --- | --- |
| `box` | `size`, `bevel`, `uvscale` | `loc` = centre |
| `boxz` | `size`, `bevel`, `uvscale` | `loc` = centre de la face du bas (posée) |
| `obox` | `loc`, `axes` (3 vecteurs), `half` | boîte orientée librement |
| `cyl` | `r`, `h`, `r2` (cône), `seg` (12), `caps`, `bevel` | le long de Z, `loc` = centre de la base |
| `cyl_between` | `a`, `b`, `r`, `r2`, `seg` (8), `caps` | barre, poteau, câble droit entre deux points |
| `torus` | `R`, `r`, `seg` (16), `rseg` (6), `arc` (360) | plan XY ; `arc` < 360 pour un anneau ouvert (anse) |
| `prism` | `profile` [[y,z]…], `length`, `bevel` | extrusion le long de +X |
| `lathe` | `profile` [[r,z]…] fermé, `seg` (16), `phase` (°) | solide de révolution autour de Z |
| `tube` | `points` [[x,y,z]…], `r`, `seg` (6), `sub` (4) | câble lissé, bouts fermés (à enfouir) |
| `heightfield` | `size` [x,y], `seg` (12), `bottom`, `layers` | sol en relief : couches `flat` (z), `waves` (amp, fx, fy, phase), `mound` (amp, center, radius), `hole` (depth, center, radius), additionnées |
| `mesh` | `verts` (≤ 5 000), `faces` | géométrie libre |

`seg` : 3 à 64. Dimensions : 0,5 mm à 200 m.

**Regroupements** (champ `parts` requis) :
- `{"mirror": "x" | "y", "parts": [...]}` : les pièces ET leur symétrique ;
- `{"array": {"count": 2..100, "step": [dx, dy, dz]}, "parts": [...]}` : copies décalées ;
- `{"group": {"loc": [...], "rot": [...]}, "parts": [...]}` : déplacer / tourner un ensemble ;
- `{"hinged": {"name", "pivot", "axis": "X"|"Y"|"Z", "angle", "collision"?, "handle"?}, "parts": [...]}` : pièce
  animée (porte, couvercle), au premier niveau seulement ; exportée à part avec `hinge_axis` et `open_angle_deg`.

**Collisions** : `{"shape": "box", "size", "loc", "rot"?, "name"?}` ou `{"shape": "cyl", "r", "h", "loc", "seg"?}`.
Exportées en `<name>_<nom>-col` (reconnues par Godot). Une par volume utile.

**Bornes** : 2 000 pièces une fois `mirror`/`array` dépliés, 200 000 triangles, regroupements sur 8 niveaux. Au-delà,
ou au moindre champ inconnu : erreur qui cite le chemin JSON (`parts[12].size[1] : valeur entre 0.0005 et 200.0
attendue`), rien n'est construit.

## Règles que les outils font respecter

- **5 mm** : ce qui est plaqué sur une surface en est décollé d'au moins 5 mm ou y entre ; deux pièces qui
  s'aboutent n'ont pas de bord commun, l'une entre dans l'autre. Sinon `blender_qa` échoue (z-fighting) et donne le
  centre de chaque paire (`zfighting_points`).
- Rien ne flotte : une pièce doit être reliée, de proche en proche, au corps principal.
- Pas de faces cachées dos à dos, normales cohérentes, pas de n-gones (avertissement).
- Avertissements acceptés (`accepted`) : sommets doublés, UV qui se chevauchent (textures répétées), « pas au sol »
  avec `held: true`.
- L'export optimisé (`mcf_kit`) fusionne les pièces statiques et retire les faces cachées ; les pièces nommées comme
  des pièces pilotées par le jeu (Door, Lid, Light, Screen…) et les `hinged` restent séparées.

## Sécurité (résumé, détail dans docs/SPEC.md §5)

- Chaque appel lance un Blender neuf : `-b --factory-startup --disable-autoexec --offline-mode`, ligne de commande fixe,
  environnement sans `PYTHON*` ni `BLENDER_*`. Aucune valeur du modèle n'y figure.
- Scripts (`_runners/`, `_vendor/`) copiés dans un dossier temporaire propre à l'appel, et vérifiés par empreinte
  SHA-256 (`RUNNER_DIGESTS` de `tools/blender_runtime.py`) sur cette copie. Après une modification relue :
  `python tools/blender_runtime.py --digests`, puis recopier la table (un test vérifie qu'elle est à jour).
- Blender n'écrit que dans le dossier temporaire ; l'outil recopie vers `output` après les contrôles de `safety.py`
  (jamais d'écrasement sans `overwrite`). Le dossier est supprimé même en cas d'erreur.
- `.blend` : blocs lus avant ouverture (bibliothèques liées, polices, sons, caches externes refusés), puis fichiers
  référencés contrôlés (locaux, dans `allowed_dirs.read`). `.glb` : chaque `uri` est `data:` ou un chemin relatif qui
  reste dans les dossiers autorisés.
- Délai ≤ 600 s, puis Blender est arrêté et `completed: false` ; un seul Blender à la fois par outil.
- Blender en direct (addon MCP) : hors périmètre, aucun outil ne parle à un Blender ouvert.

## Code repris

- `_vendor/mcf_kit.py` : copie adaptée de `mcf_kit.py` et de `_lathe` / `_tube` / `_obox` (dépôt MCF-RP), avec
  l'accord d'Aroun. Adaptations listées en tête du fichier, dont une correction : l'original retirait des faces
  visibles (l'axe du treuil du puits) parce qu'il ne testait que le centre et les sommets d'une face.
- `_vendor/qa_check.py`, `_vendor/_bpyx.py` : blender-agent-skills 1.3.1, licence MIT (Copyright (c) 2026 EL4CTEO,
  [LICENSE](_vendor/LICENSE-blender-agent-skills.txt)). Modifications repérées par « MyIA : » (centres des paires de
  z-fighting, pièces flottantes de proche en proche). `runner_render_views.py` est adapté de `review_shots.py`.

## Tests

    python -m unittest discover -s tools/tests -v                 (CI, sans Blender)
    set MYIA_TEST_BLENDER=1 && python -m unittest tools.tests.test_blender -v   (avec le Blender 5.2 du poste)
