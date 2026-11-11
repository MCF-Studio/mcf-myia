# Contribuer à MyIA

Merci de ton intérêt ! Quelques règles pour que ça reste simple.

## Proposer une modification

1. Ouvre d'abord une issue pour discuter d'un changement important (nouvelle catégorie, nouveau service…).
2. Fork, branche dédiée, commits clairs.
3. Avant la pull request :
   ```bash
   cd agent && npm run typecheck && npm test
   cd ../app && npm run typecheck && cd src-tauri && cargo clippy
   ```
4. Décris ce qui change et comment tu l'as testé.

## Règles de fond

- **Sécurité d'abord** : le modèle ne doit jamais pouvoir lancer une commande libre, écrire hors des dossiers prévus ni
  envoyer quelque chose hors de la machine sans confirmation. Toute modification de ces règles met à jour
  [docs/SPEC.md](docs/SPEC.md) (§3 et §5) dans la même pull request.
- **Pas de secret ni de donnée personnelle** dans le dépôt : `config/agent.json`, `config/agents.json` et `data/`
  restent locaux.
- **Agents et thèmes = données** : un format partagé ne doit jamais pouvoir contenir de code exécuté.
- Interface en français, code et commentaires en français, TypeScript strict.

## Ajouter un service

Un fichier dans `agent/src/services/` qui exporte un `Service` (voir `types.ts`), puis une ligne dans
`services/index.ts`. Chaque outil déclare son niveau de risque (`read`, `launch`, `local`, `external`). Pour un outil
externe sans code : une entrée `mcpServers` dans la config suffit.

## Licence

En contribuant, tu acceptes que ta contribution soit publiée sous [AGPL-3.0](LICENSE).
