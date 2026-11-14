import fs from "node:fs";
import path from "node:path";
import { checkCoordination, COORDINATION_JOURNAL } from "./access.js";

/**
 * Structure d'exemple d'un espace de coordination d'équipe : des règles communes, une méthode de travail, un journal
 * et un état. Les agents de l'équipe reçoivent le début de LISEZ-MOI.md et de journal/etat.md à chaque demande
 * (core/agent.ts) ; Claude Code, quand un agent lui délègue, lit methode.md (services/claude.ts).
 *
 * Ce sont des fichiers de départ, à adapter : rien n'est jamais remplacé (un fichier déjà présent est gardé).
 */

export interface CoordinationMember {
  name: string;
  description?: string;
}

const today = () => new Date().toISOString().slice(0, 10);

function readme(team: string, members: CoordinationMember[]): string {
  const who = members.length
    ? members.map((m) => `- **${m.name}** : ${m.description?.trim() || "(à compléter : ce qu'il fait, ce qu'il ne fait pas)"}`).join("\n")
    : "- (à compléter : un membre par ligne, ce qu'il fait, ce qu'il ne fait pas)";
  return `# ${team} — règles communes

Dossier local à ce PC, à part du projet. Il sert de mémoire de travail à l'équipe : ce que tout le monde doit savoir,
et où en est le travail. Si un fait écrit ici ne correspond plus à la réalité, la réalité a raison : corrige la fiche.

## Les fiches

| Fiche             | Contenu                                                        |
| ----------------- | -------------------------------------------------------------- |
| \`LISEZ-MOI.md\`    | Cette page : le projet, qui fait quoi, les règles pour tous    |
| \`methode.md\`      | Comment reprendre le fil et rendre compte (journal, état)      |
| \`journal/etat.md\` | Où en est le travail, tenu à jour par l'équipe                 |
| \`journal/\`        | Un fichier par jour : les comptes rendus, dans l'ordre         |

Ajoute une fiche par sujet qui revient (livraison, commandes utiles, emplacement des clés…), et une ligne ici.

## Le projet

(à compléter : ce que l'équipe construit, où sont les dossiers, ce qui fait foi en cas de doute)

## Qui fait quoi

${who}

## Règles pour tous

1. Avant de commencer : lire \`journal/etat.md\`, puis vérifier que le projet correspond à ce qui y est écrit.
2. On n'écrit « fait » que pour ce qu'un outil a confirmé. Un échec se rapporte tel quel, avec la sortie utile.
3. Rien ne sort du PC (envoi, publication, message) sans l'accord de l'utilisateur pour la demande en cours.
4. Les choix qui reviennent à l'utilisateur (prix, textes publics, décisions de produit) : on pose la question.
5. Aucun secret (clé, jeton, mot de passe) dans une fiche, le journal ou un compte rendu.
6. En partant : un compte rendu dans le journal du jour, et \`journal/etat.md\` à jour.

## Compte rendu attendu de chaque membre

Ce qui a été fait ; l'état du projet ; ce qui reste ; les décisions qui reviennent à l'utilisateur.
`;
}

const METHOD = `# Méthode de travail

À lire au début de chaque tâche. Tu n'as pas la mémoire des tâches précédentes : ce qui te permet de reprendre le
fil, c'est le journal. Ce qui permet au suivant de reprendre, c'est ce que tu y écris.

## 1. En arrivant

1. Lis \`journal/etat.md\` : où en est le travail, ce qui est en cours, ce qui attend une décision.
2. Lis la fin du journal du jour, \`journal/AAAA-MM-JJ.md\`, s'il existe.
3. Vérifie que le projet correspond à ce qui est écrit. S'il y a un écart, le projet a raison : note-le dans ton
   compte rendu et corrige \`etat.md\` en partant.

## 2. Aller au bout

Ta consigne décrit un but, pas une liste de gestes. Tant que tu restes dans ton rôle, tu vas jusqu'au but.

- **Une vérification échoue** : cherche la cause avant de t'arrêter. Si elle vient de ton changement, corrige et
  relance (trois tentatives au plus, puis rapporte). Si elle existait déjà, dis-le avec la preuve et continue.
- **Une information manque** : cherche-la dans le projet, les fiches et le journal avant de poser une question.
- **Tu t'arrêtes** si continuer demanderait de sortir de ton rôle, de deviner une décision qui revient à
  l'utilisateur, ou de faire un geste interdit par \`LISEZ-MOI.md\`.

## 3. En partant

1. Ajoute une entrée à la fin de \`journal/AAAA-MM-JJ.md\` (date du jour ; crée le fichier s'il manque) :

   \`\`\`
   ## HH:MM — <qui> — <sujet>
   Demande : <une phrase>
   Fait : <actions, avec leurs preuves>
   Vérifications : <commande ou contrôle → réussi / échoué>, une par ligne
   Reste : <ce qui n'est pas fait et pourquoi>
   Pour l'utilisateur : <décisions à prendre, ou « rien »>
   \`\`\`

2. Mets à jour \`journal/etat.md\` : réécris ce qui a changé, garde le fichier court (moins de 2 000 caractères).
3. Rends un compte rendu court : le résultat d'abord, puis les preuves, ce qui reste, les décisions.

N'écris dans le journal que des faits vérifiés. Jamais de clé, de jeton ni de mot de passe.
`;

const status = (team: string) => `# État du travail — ${team}

Tenu par l'équipe : chacun réécrit ce qui a changé en partant (voir \`../methode.md\`). Si ce fichier et le projet se
contredisent, le projet a raison. Moins de 2 000 caractères.

## Où on en est

- Mis à jour : ${today()}
- (à compléter : ce qui est fait, ce qui est en ligne, la version en cours)

## En cours

- Rien.

## En attente d'une décision de l'utilisateur

- Rien.
`;

export interface CoordinationInit {
  dir: string;
  created: string[];
  kept: string[];
}

/** Crée les fichiers d'exemple qui manquent dans l'espace de coordination ; ne remplace jamais un fichier existant. */
export function initCoordination(dir: string, team: string, members: CoordinationMember[], workspace?: string): CoordinationInit {
  const real = checkCoordination(dir, workspace);
  const name = team.trim() || "Équipe";
  const files: [string, string][] = [
    ["LISEZ-MOI.md", readme(name, members)],
    ["methode.md", METHOD],
    [`${COORDINATION_JOURNAL}/etat.md`, status(name)],
  ];
  const created: string[] = [];
  const kept: string[] = [];
  for (const [rel, content] of files) {
    const target = path.join(real, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      // « wx » : échoue si le fichier existe (ou si c'est un lien), au lieu de l'écraser.
      fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
      created.push(rel);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      kept.push(rel);
    }
  }
  return { dir: real, created, kept };
}
