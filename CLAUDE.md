# Règles pour les agents (Claude, Codex, autre)

Vue d'ensemble : `README.md` ; règles de fond (sécurité, périmètre des outils) : `CONTRIBUTING.md` et `docs/SPEC.md`.

## Branches et PR : obligatoire

1. Avant tout travail : `git switch main` puis `git pull --ff-only`. `main` est la source de vérité.
2. **Jamais de commit poussé directement sur `main`** (fonctionnalité, correctif, doc : tout). Un changement = une
   branche dédiée (`feat/…`, `fix/…`, `docs/…`), poussée, puis une PR vers `main` (`gh pr create`, en français :
   ce qui change, comment c'est testé).
3. Seule exception : le commit de montée de version (« Version x.y.z », les 4 fichiers + lockfiles), juste après
   une fusion, pour publier la release (`CONTRIBUTING.md`, « Publier une version »).
4. Fusion uniquement avec la CI verte (`gh pr checks <n> --watch`), par `gh pr merge <n> --merge --delete-branch`.
5. **Plus de temps ou de quota ?** Arrête-toi après avoir poussé la branche et ouvert la PR : c'est un état sûr. La
   PR sera relue, fusionnée et publiée par un autre agent de l'équipe. Ne fusionne jamais une CI rouge ou en cours
   pour gagner du temps, et ne pousse jamais sur `main` pour « finir plus vite ».

## Interdits

`git push --force`, `git reset --hard` sur une branche partagée, supprimer une branche qui a des commits hors de
`main`, mettre un secret ou une config personnelle dans le dépôt (il est public).
