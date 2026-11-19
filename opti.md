# MyIA – Agent Optimization Architecture

**Version :** 1.0 – Étude et proposition technique  
**Objectif :** améliorer l'efficacité, l'autonomie et la consommation des agents MyIA sans remplacer le moteur existant.

---

## 1. Principes fondamentaux

MyIA doit disposer d'une couche centrale capable de piloter intelligemment ses agents.

Les principes à respecter :

1. Ne jamais envoyer inutilement l'intégralité de l'historique.
2. Ne jamais appeler un LLM lorsqu'un script déterministe suffit.
3. Utiliser le modèle le moins coûteux capable d'accomplir correctement la tâche.
4. Séparer les connaissances persistantes du contexte temporaire.
5. Ne pas mémoriser systématiquement toutes les conversations.
6. Rendre chaque exécution observable et reproductible.
7. Permettre aux agents de capitaliser sur leurs expériences.
8. Pouvoir interrompre et reprendre une tâche sans recommencer depuis zéro.

## 2. Architecture des composants

### 2.1 Model Router

Responsabilité : sélectionner le modèle adapté à chaque opération.

Critères :
- Complexité de la tâche.
- Type de tâche.
- Capacité de raisonnement nécessaire.
- Taille du contexte.
- Disponibilité du modèle.
- Latence constatée.
- Coût estimé.
- Historique de réussite du modèle sur cette catégorie.

Stratégie :
- Classification déterministe en premier.
- Modèle léger pour les tâches simples.
- Modèle plus performant pour les tâches complexes.
- Modèle spécialisé pour certaines opérations.
- Escalade uniquement lorsque le résultat est insuffisant.

Ne pas utiliser systématiquement un LLM pour choisir le LLM suivant.

### 2.2 Context Engine

Responsabilité : compiler le contexte avant chaque appel.

Trois niveaux :

**L0 – Essential**
- Identité de l'agent.
- Instructions essentielles.
- Objectif actuel.
- Contraintes importantes.

**L1 – Relevant**
- Résumé du projet.
- Informations utiles à la tâche.
- Résultats précédents.
- Outils pertinents.

**L2 – On demand**
- Historique complet.
- Documentation.
- Anciennes expériences.
- Fichiers et connaissances détaillées.

Le moteur doit :
- Calculer le budget disponible.
- Classer les informations par pertinence.
- Dédupliquer les informations.
- Préserver les instructions prioritaires.
- Éviter les répétitions.
- Compresser les contextes volumineux si nécessaire.
- Tracer les sources utilisées.

### 2.3 Memory Engine

Responsabilité : conserver les connaissances utiles.

Séparer quatre catégories :

**Identity Memory**
- Identité de l'agent.
- Rôle.
- Instructions permanentes.
- Compétences.
- Préférences de fonctionnement.

**Semantic Memory**
- Connaissances.
- Faits.
- Documentation.
- Relations entre entités.
- Informations de projets.

**Episodic Memory**
- Historique des tâches.
- Actions effectuées.
- Résultats.
- Erreurs.
- Solutions trouvées.

**Working Memory**
- Objectif courant.
- Variables de travail.
- Progression.
- Décisions temporaires.
- Résultats intermédiaires.

Chaque souvenir doit disposer de métadonnées :
- Identifiant.
- Catégorie.
- Contenu.
- Date de création.
- Date de modification.
- Source.
- Agent propriétaire.
- Projet associé.
- Score de confiance.
- Importance.
- Date éventuelle d'expiration.

### 2.4 Tool Selector

Responsabilité : fournir à l'agent uniquement les outils nécessaires.

Fonctionnement :
1. Identifier les capacités nécessaires.
2. Rechercher les outils compatibles.
3. Filtrer selon les permissions.
4. Charger les descriptions pertinentes.
5. Charger les schémas complets uniquement lorsque nécessaire.
6. Vérifier les arguments avant exécution.

Prévoir un catalogue d'outils avec :
- Nom.
- Description courte.
- Catégories.
- Capacités.
- Schéma.
- Permissions.
- Coût estimé.
- Temps moyen d'exécution.
- Historique de réussite.

### 2.5 Orchestrator

Responsabilité : piloter les workflows.

Fonctionnalités :
- Décomposition des objectifs.
- Graphe de dépendances DAG.
- Exécution parallèle.
- Attribution des tâches.
- Gestion des dépendances.
- Validation intermédiaire.
- Gestion des erreurs.
- Reprise après interruption.
- Annulation.
- Limites de consommation.

Une tâche déterministe doit pouvoir être exécutée directement par un outil sans passer par un agent conversationnel.

### 2.6 Experience Engine

Responsabilité : améliorer progressivement les méthodes de travail.

Après chaque tâche :
- Identifier les difficultés.
- Identifier les solutions efficaces.
- Enregistrer les erreurs récurrentes.
- Extraire les procédures réutilisables.
- Évaluer les résultats.
- Proposer de nouvelles compétences.
- Mettre à jour les connaissances pertinentes.

Les nouvelles compétences doivent être évaluées avant leur promotion dans le catalogue partagé.

## 3. Budget Manager

Chaque tâche possède son propre budget.

Exemple de configuration :

```yaml
budget:
  max_tokens: 12000
  max_iterations: 12
  max_llm_calls: 8
  max_cost: null
  timeout: 300

  context:
    reserve_for_output: 2000
    essential_max: 2000
    relevant_max: 4000

  escalation:
    enabled: true
    max_escalations: 2
```

Le budget doit être contrôlé :
- Avant chaque appel.
- Après chaque réponse.
- Avant une nouvelle itération.
- Avant la délégation à un autre agent.
- Avant une opération coûteuse.

Ne pas confondre tokens estimés et tokens réellement facturés.

## 4. Cache Engine

Prévoir trois caches indépendants.

**Exact Cache**
- Même modèle.
- Même prompt.
- Mêmes paramètres.
- Même contexte.
- Même version des outils.

**Semantic Cache**
- Recherche de réponses similaires.
- Score de similarité configurable.
- Vérification de compatibilité avec le contexte actuel.

**Tool Cache**
- Résultats d'outils déterministes.
- Durée de validité configurable.
- Invalidation lors d'une modification des données.

Ne jamais réutiliser aveuglément une réponse dépendant de données temps réel ou d'une action ayant des effets externes.

## 5. Checkpoint Engine

Chaque workflow doit pouvoir être sauvegardé.

Informations :
- ID du workflow.
- ID de la tâche.
- Agent responsable.
- État courant.
- Étapes terminées.
- Résultats intermédiaires.
- Budget restant.
- Historique des événements.
- Erreurs rencontrées.

Les opérations externes doivent disposer de mécanismes d'idempotence pour éviter de répéter une action lors d'une reprise.

## 6. Observability Engine

Enregistrer chaque opération :

- Model ID.
- Agent ID.
- Task ID.
- Nombre de tokens entrants.
- Nombre de tokens sortants.
- Temps de réponse.
- Coût lorsqu'il est disponible.
- Outils utilisés.
- Résultats.
- Erreurs.
- Cache hit/miss.
- Taille du contexte.
- Score de validation.

Indicateurs à afficher dans MyIA :

- Consommation par agent.
- Consommation par tâche.
- Consommation par modèle.
- Tokens économisés.
- Taux de réussite.
- Nombre moyen d'itérations.
- Temps moyen par tâche.
- Taux de récupération du cache.
- Pertinence des souvenirs retrouvés.

## 7. Structure de dossiers proposée

```text
myia/
├── core/
│   ├── orchestrator/
│   ├── task_manager/
│   ├── workflow/
│   └── checkpoint/
│
├── intelligence/
│   ├── model_router/
│   ├── complexity_analyzer/
│   ├── context_engine/
│   ├── tool_selector/
│   └── result_validator/
│
├── memory/
│   ├── manager/
│   ├── identity/
│   ├── semantic/
│   ├── episodic/
│   ├── working/
│   ├── retrieval/
│   └── consolidation/
│
├── optimization/
│   ├── token_budget/
│   ├── context_compiler/
│   ├── prompt_compression/
│   ├── cache/
│   └── deduplication/
│
├── experience/
│   ├── evaluator/
│   ├── learning/
│   ├── skill_extraction/
│   └── improvement/
│
├── observability/
│   ├── metrics/
│   ├── tracing/
│   ├── costs/
│   └── audit/
│
├── integrations/
│   ├── letta/
│   ├── mem0/
│   ├── llmlingua/
│   └── litellm/
│
└── tests/
    ├── memory/
    ├── orchestration/
    ├── optimization/
    └── benchmarks/
```

Cette structure est une proposition logique, pas une obligation de déplacer immédiatement les modules existants.

## 8. Ordre de développement

### Phase 1 – Mesure et contrôle
- Centraliser les statistiques des appels LLM.
- Créer le Token Budget Manager.
- Ajouter le Context Compiler.
- Ajouter le Model Router.

### Phase 2 – Mémoire
- Créer les quatre niveaux de mémoire.
- Ajouter la recherche sémantique.
- Ajouter l'extraction des souvenirs.
- Ajouter la déduplication.
- Ajouter la consolidation en arrière-plan.

### Phase 3 – Orchestration
- Créer le DAG Executor.
- Ajouter les checkpoints.
- Ajouter les dépendances.
- Ajouter l'exécution parallèle.
- Ajouter les mécanismes de reprise.

### Phase 4 – Optimisation
- Ajouter le cache exact.
- Ajouter le cache sémantique.
- Ajouter le Tool Selector.
- Expérimenter LLMLingua.
- Mesurer les gains réels.

### Phase 5 – Apprentissage
- Évaluation automatique des tâches.
- Extraction des expériences.
- Création de compétences.
- Évaluation des compétences.
- Promotion contrôlée dans le catalogue.

## 9. Critères de validation

Chaque fonctionnalité doit être comparée à une version de référence.

Mesures :
- Tokens consommés par tâche.
- Nombre d'appels LLM.
- Temps d'exécution.
- Taux de réussite.
- Qualité du résultat.
- Pertinence de la mémoire.
- Taux de reprise après erreur.

Une optimisation n'est validée que si elle réduit les ressources sans dégrader significativement la qualité.

## 10. Références techniques

- CEMAF : https://github.com/drchinca/cemaf
- Letta : https://github.com/letta-ai/letta
- Letta Code : https://github.com/letta-ai/letta-code
- Mem0 : https://github.com/mem0ai/mem0
- LLMLingua : https://github.com/microsoft/LLMLingua
- LangGraph : https://github.com/langchain-ai/langgraph
- LiteLLM : https://github.com/BerriAI/litellm

---

**Décision architecturale :**

MyIA doit rester maître de son orchestration et de sa mémoire.

Les projets externes servent de références et de composants optionnels. Aucun ne doit devenir une dépendance obligatoire du cœur de MyIA.

Priorité absolue : Context Engine, Memory Engine, Model Router et Token Budget Manager.
