# Registre de travail des équipes (branche `feat/beads-travail`)

Inspiré du modèle des « beads » de [Gas City](https://github.com/gastownhall/gascity) (MIT) : le travail en cours vit
dans un registre durable, hors du contexte du modèle, au lieu d'être porté par l'historique de la conversation ou
par un texte libre relu à chaque demande. Aucun code ni aucune base de Gas City n'est repris (pas de `bd`, pas de
Dolt) : c'est une réécriture en TypeScript, adaptée à MyIA (un seul utilisateur, un sidecar Node, des équipes).

## 1. Le problème

- L'historique d'un agent est rogné au nombre de messages (`historyMessages`) : ce qui en sort est perdu.
- `team_ask` met toute la consigne dans le contexte du membre appelé ; seule sa réponse revient, rien n'est gardé.
- L'état d'une équipe est un texte libre (`journal/etat.md`) que chaque agent relit en entier et réécrit à la main.

## 2. Le principe

Une **tâche** est une unité de travail durable :

| Champ                   | Contenu                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `id`                    | `t-` + 6 caractères, unique dans le registre                                |
| `title`, `description`  | ce qu'il faut faire (200 / 4 000 caractères)                                |
| `type`                  | `tache` (défaut), `bug`, `decision` (attend l'utilisateur), `lot` (groupe)  |
| `status`                | `ouverte` → `en_cours` → `fermee` (réouverture possible)                    |
| `assignee`              | membre de l'équipe qui la porte                                             |
| `parent`                | lot auquel elle appartient                                                  |
| `needs`                 | tâches qui doivent être fermées avant (dépendances bloquantes, sans cycle)  |
| `labels`                | étiquettes libres (ajout seulement)                                         |
| `notes`                 | comptes rendus datés et signés, en ajout seulement                          |
| `rev`                   | révision, incrémentée à chaque écriture (prise de tâche sans écrasement)    |

Une tâche est **prête** quand elle est ouverte, sans responsable, et que toutes ses dépendances sont fermées.

Invariants (tests de `core/work.test.ts`) :

1. Créer attribue un id unique, le statut `ouverte`, le type `tache` par défaut, les dates et l'auteur.
2. Une dépendance ou un parent doit exister ; une dépendance qui crée un cycle est refusée ; un parent est un `lot`.
3. Fermer est idempotent ; une tâche fermée sort des tâches prêtes et débloque celles qui l'attendaient.
4. Les étiquettes et les notes s'ajoutent, ne se remplacent jamais.
5. Prendre une tâche déjà prise par un autre membre est refusé (révision comparée, pas d'écrasement silencieux).
6. Le fichier est écrit de façon atomique (fichier temporaire puis renommage) ; un fichier illisible n'est jamais
   écrasé : il est mis de côté (`.corrompu-<date>`) et l'erreur est remontée.

## 3. Modèle de permissions (qui voit quoi)

| Acteur                                  | Accès au registre                                                         |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Utilisateur (app)                       | lecture et écriture de tous les registres de son PC                       |
| Membre d'une équipe (local ou Claude)   | lecture et écriture du registre de **son** équipe, par les outils `work_*`|
| Agent seul (hors équipe)                | aucun (étape ultérieure possible : registre propre au profil)             |
| Agent de la Guilde (bac à sable)        | **aucun**, jamais                                                         |
| Outils de fichiers des agents           | aucun : le registre est dans `data/travail/`, hors des dossiers ouverts   |

- **Isolation entre équipes** : un registre par équipe (`data/travail/equipe-<id>.json`, id validé par
  `^[a-z0-9][a-z0-9-]{0,39}$`). Les outils d'un membre sont construits avec le registre de son équipe ; aucun
  argument d'outil ne désigne un registre, il est donc impossible d'en viser un autre.
- Écrire dans le registre ne demande pas de confirmation (comme le journal de coordination) : rien ne sort du PC,
  rien n'est exécuté. Supprimer une tâche n'existe pas pour les agents (on ferme, avec une raison).

## 4. Menaces et parades

| Menace                                                                 | Parade                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Injection : une description recopiée d'une page piégée donne des ordres | Le contenu du registre est présenté comme des **données** ; les liens qu'il contient ne deviennent jamais des liens de confiance (`UrlTrust` ne lit que les messages de l'utilisateur) ; les confirmations des outils sensibles restent dues |
| Un agent invente un « fait »                                          | Fermer exige une raison ; les règles de coordination (« fait » = confirmé par un outil) s'appliquent              |
| Gonflement (boucle qui crée des tâches à l'infini)                     | 300 tâches non fermées max, 2 000 au total (les plus anciennes fermées sont retirées), 50 notes par tâche, tailles bornées par zod |
| Deux conversations de la même équipe écrivent en même temps            | Un seul processus (le sidecar) : file d'attente par registre ; relecture du fichier avant chaque écriture         |
| Fichier abîmé (coupure de courant, édition à la main ratée)            | Écriture atomique ; fichier illisible mis de côté, jamais écrasé                                                   |
| Fuite d'un registre vers un autre agent ou hors du PC                  | Registre par équipe, pas d'accès Guilde ; un membre Claude ne reçoit que le registre de son équipe, comme le journal |
| Secret écrit dans une tâche                                            | Même règle que le journal (aucune clé ni mot de passe) ; le registre n'est jamais publié ni synchronisé           |

## 5. Ce que gagnent les agents

- Le prompt système d'un membre contient un **résumé court** du registre (tâches en cours et prêtes, titres seuls,
  plafonné) au lieu de tout l'état : le détail se lit à la demande (`work_show`).
- `team_ask` accepte `work_id` : le membre reçoit la tâche du registre, elle passe `en_cours` à son nom, et sa
  réponse est ajoutée en note. Le chef ferme après vérification.
- Une demande rognée de l'historique, une conversation fermée ou un agent remplacé ne perdent plus le travail :
  il est dans le registre.

## 6. État de la branche

| Étape | Contenu                                                                                     | État     |
| ----- | ------------------------------------------------------------------------------------------- | -------- |
| 1     | Spec (ce fichier) ; `core/work.ts` : modèle, registre fichier, invariants testés             | fait     |
| 2     | Outils `work_*` pour les membres d'une équipe ; `team_ask` avec `work_id` ; résumé au prompt | à faire  |
| 3     | Écran de l'app : registre d'une équipe (lecture, fermeture, réouverture)                     | à faire  |
| 4     | Fournisseur `exec:<script>` (registre délégué à un script de l'utilisateur), si utile         | à décider |
