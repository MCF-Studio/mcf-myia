# La Guilde : mutualiser les agents entre membres

> Statut : conception validée le 2026-11-11. **Étape 1 faite** (partie locale, catégorie « Guilde » de l'app) ; le relais
> n'existe pas encore : l'app l'affiche « hors ligne » et personne ne peut envoyer de demande.

## 1. Idée

Plutôt que chacun refasse 50 000 agents, les membres mettent à disposition ce qu'ils veulent : un agent bien réglé,
un gros modèle qu'ils sont seuls à pouvoir faire tourner, de la puissance GPU la nuit. Quand un agent a besoin d'un
coup de main, il publie une **demande** ; les membres capables de la traiter **se proposent** ; le propriétaire de la
machine **accepte** (ou son mode automatique accepte pour lui, selon ses règles) ; le travail tourne chez lui ; la
réponse revient.

Rien n'est direct : aucune machine ne se connecte à une autre, aucune n'expose de port. Tout passe par un relais, et
rien ne s'exécute sans l'accord du propriétaire.

## 2. Vocabulaire

| Terme        | Sens                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------- |
| **Offre**    | ce qu'un membre met à disposition : un agent « guilde » (nom, modèle, rôle), ses horaires, ses quotas |
| **Demande**  | une tâche texte publiée par un agent d'un autre membre, avec le type de compétence voulu            |
| **Relais**   | serveur MCF Studio qui met en relation, sans exécuter quoi que ce soit                              |
| **Bac à sable** | mode d'exécution des demandes reçues : modèle + consignes, **aucun outil, aucun fichier**       |
| **Liste blanche** | membres dont les demandes peuvent être acceptées automatiquement                              |

## 3. Parcours

```
Agent de Léa ──demande──▶ Relais ──notification──▶ App d'Aroun (offre « Rédac' qwen3:14b »)
                                                     │
                              « Léa demande : résumer ce texte… » [Accepter] [Refuser] [Toujours pour Léa]
                                                     │ accepté (ou auto : Léa en liste blanche, 23h–8h, GPU libre)
                                                     ▼
                                     exécution EN BAC À SABLE sur la machine d'Aroun
                                                     │
Agent de Léa ◀──réponse (chiffrée)── Relais ◀────────┘
```

Côté demandeur, la réponse arrive comme le résultat d'un outil `guild_ask` : c'est une **donnée**, jamais une
instruction (même règle que les pages web).

## 4. Modèle de permissions (qui voit quoi, qui peut quoi)

| Acteur                       | Peut                                                                                   | Ne peut pas                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Demandeur (membre connecté)  | publier une demande vers une compétence ou une offre précise ; annuler ; signaler      | choisir la machine ; voir l'adresse IP ou les fichiers du fournisseur  |
| Fournisseur                  | publier/retirer ses offres ; accepter/refuser ; liste blanche ; quotas ; tout couper   | recevoir une demande hors de ses offres ; être sollicité hors horaires |
| Agent en bac à sable         | lire la demande, générer une réponse avec le modèle et les consignes de l'offre        | outils, fichiers, réseau, services, Claude Code, autres agents        |
| Relais                       | authentifier, mettre en relation, compter les quotas, transmettre                      | lire le contenu (chiffré de bout en bout), exécuter                  |
| Modérateur MCF Studio        | traiter les signalements, suspendre un membre (outils d'admin existants de mcfstudio.fr) | lire les échanges (sauf pièces jointes au signalement)                |

**Certification** : seuls les comptes mcfstudio.fr (2FA obligatoire) accèdent à la Guilde. Le rôle « certifié »
existant sur le site donne le badge et peut être exigé par un fournisseur (« seulement les certifiés »).

**Mode auto** (machine laissée à disposition la nuit) : désactivé par défaut. Quand il est actif, une demande est
acceptée sans clic **seulement si** toutes les règles passent :

1. le demandeur est dans la liste blanche (comptes nommés, ou « tous les certifiés ») ;
2. on est dans la plage horaire choisie (ex. 23h–8h) ;
3. ses quotas ne sont pas dépassés (demandes / heure, durée max par demande, taille max) ;
4. le GPU est sous le seuil choisi (si tu lances un jeu, la Guilde se met en pause) ;
5. l'interrupteur général n'est pas coupé (bouton « tout couper » visible en permanence).

Chaque demande traitée, auto ou non, est inscrite au journal d'audit avec le demandeur, la durée et la décision.

## 5. Isolation

- **Bac à sable** : une demande reçue n'a accès à aucun service (pas de Discord, pas de build, pas de fichiers, pas de
  web, pas de Claude Code) — c'est un agent sans outils, construit à partir de l'offre. Même un prompt piégé ne peut
  donc rien faire chez le fournisseur ; au pire il obtient du texte.
- Les offres sont des profils séparés des agents personnels : partager « Rédac' » ne partage pas les consignes ni
  l'historique de tes agents à toi.
- Aucune conversation du fournisseur n'est visible du demandeur, et inversement : une demande = un contexte neuf,
  détruit après la réponse.
- Pas de connexion entrante : l'app ouvre une connexion **sortante** vers le relais. Ni IP ni port exposés.

## 6. Menaces et mesures

| Menace                                                                 | Mesure                                                                                          |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Demande piégée pour faire agir la machine du fournisseur               | Bac à sable sans aucun outil ; exécution = génération de texte uniquement                       |
| Réponse piégée qui manipule l'agent du demandeur                       | Réponse traitée comme donnée ; actions sensibles toujours confirmées chez le demandeur          |
| Abus de puissance (spam de demandes, minage de GPU)                    | Quotas par membre côté relais ET côté fournisseur ; durée et taille max ; file d'attente bornée |
| Fuite de données confidentielles envoyées dans une demande             | Avertissement clair au demandeur (« lu sur la machine d'un autre membre ») ; filtre optionnel de secrets avant envoi |
| Le relais lit ou garde les échanges                                    | Chiffrement de bout en bout (clés par appareil) ; relais sans stockage du contenu               |
| Usurpation d'un membre / d'un certifié                                 | Comptes mcfstudio.fr avec 2FA ; jetons courts, révocables ; badge certifié signé par le relais  |
| Contenu illégal demandé ou produit                                     | Conditions d'utilisation, signalement en un clic, suspension par la modération ; refus libre du fournisseur |
| Le fournisseur dort et une demande abusive passe en auto               | Liste blanche nominative, quotas, plage horaire, seuil GPU, journal consultable au réveil      |
| Panne ou attaque du relais                                             | Les apps fonctionnent sans lui (la Guilde se grise) ; rien en local n'en dépend                |

## 7. Architecture technique (proposée)

- **Relais** : service conteneurisé (Node/TypeScript ou Rust), PostgreSQL (offres, quotas, réputation, signalements),
  Redis (présence, files), WebSocket TLS. Auth adossée aux comptes mcfstudio.fr. Hébergé par MCF Studio.
- **App** : nouvelle catégorie « Guilde » dans la barre latérale ; nouveau service `guild` dans le cœur (outil
  `guild_ask` côté demandeur, exécuteur bac à sable côté fournisseur) ; clés de chiffrement dans le coffre Windows.
- **Protocole** : messages signés, versionnés ; une demande = `{id, compétence, taille, chiffré}`.

## 8. Interface (catégorie « Guilde »)

- **Bandeau d'état** : en ligne / en pause / coupé, interrupteur général, nombre de membres et d'offres en ligne.
- **Mes offres** : cartes des agents partagés (modèle, horaires, quotas, compteur de demandes traitées).
- **Demandes entrantes** : file en direct avec Accepter / Refuser / Toujours pour ce membre, aperçu du texte.
- **Mode auto** : liste blanche, plage horaire, seuil GPU, quotas, journal de la nuit.
- **Explorer** : offres disponibles, filtres par compétence et modèle, badge certifié, temps de réponse moyen.
- **Mes demandes** : envoyées, en attente, répondues.

## 9. Décisions (2026-11-11)

1. **Relais hébergé par MCF Studio**, authentification par les comptes mcfstudio.fr (2FA), modération avec les outils
   d'administration existants.
2. **Texte seulement** : une demande reçue s'exécute en bac à sable (modèle + consignes), sans outil, fichier ni réseau.
3. **Accès : tout membre connecté** peut demander ; chaque fournisseur choisit qui il sert (tout le monde, certifiés
   seulement, ou sa liste blanche).
4. **Chiffrement de bout en bout** : le relais ne lit jamais le contenu ; la modération ne voit que ce qui est joint
   à un signalement.

## 10. Étapes

1. ✅ Côté app, sans réseau (`agent/src/core/guild.ts`, testé) : offres (profils « guilde »), exécuteur bac à sable, moteur de règles du mode auto (liste
   blanche, horaires, quotas, seuil GPU, interrupteur), journal, catégorie « Guilde » avec état « relais hors ligne ».
2. Relais : protocole, auth mcfstudio.fr, présence, mise en relation, quotas, signalements.
3. Chiffrement de bout en bout (clés par appareil dans le coffre Windows), puis ouverture aux membres.
