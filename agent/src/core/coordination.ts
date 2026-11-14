import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
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

// ─── fiches : ce qui part avec l'équipe dans un workflow ──────────────────────

/**
 * Les fiches sont les fichiers texte à la RACINE de l'espace de coordination (règles, méthode, fiches par sujet).
 * Elles peuvent partir dans un workflow, une par une, au choix de l'auteur. Le sous-dossier `journal` ne part
 * jamais : c'est l'historique de travail de CETTE machine.
 */
export const FICHES_MAX = 20;
export const FICHE_MAX_CHARS = 60_000;
export const FICHES_MAX_CHARS = 200_000;

const FICHE_NAME = /^[\p{L}\p{N}_][\p{L}\p{N} ._-]{0,79}\.(md|txt)$/iu;
/** Fichiers qui pilotent un autre outil (Claude Code, autres agents) : ni exportés ni posés par un workflow. */
const FICHE_BLOCKED = new Set(["claude.md", "claude.local.md", "agents.md", "gemini.md", "copilot-instructions.md"]);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)\./i;
/** Nom qui laisse penser que la fiche décrit des accès : décochée par défaut dans l'interface (indication, pas un contrôle). */
const SENSITIVE_HINT = /cl[eé]s?\b|acc[eè]s|secret|token|jeton|mot.?de.?passe|password|credential|identifiant/i;

export function isFicheName(name: string): boolean {
  return FICHE_NAME.test(name) && !name.includes("..") && !FICHE_BLOCKED.has(name.toLowerCase()) && !WINDOWS_RESERVED.test(name);
}

const FicheSchema = z.object({
  path: z.string().refine(isFicheName, "nom de fiche refusé (fichier .md ou .txt à la racine, nom simple)"),
  content: z.string().max(FICHE_MAX_CHARS),
});

export const FichesSchema = z
  .array(FicheSchema)
  .max(FICHES_MAX)
  .superRefine((files, ctx) => {
    const seen = new Set<string>();
    for (const f of files) {
      const k = f.path.toLowerCase();
      if (seen.has(k)) ctx.addIssue({ code: "custom", message: `fiche en double : ${f.path}` });
      seen.add(k);
    }
    if (files.reduce((n, f) => n + f.content.length, 0) > FICHES_MAX_CHARS) {
      ctx.addIssue({ code: "custom", message: `fiches trop volumineuses (${FICHES_MAX_CHARS / 1000} k caractères au plus)` });
    }
  });

export type Fiche = z.infer<typeof FicheSchema>;

export interface FicheInfo {
  path: string;
  chars: number;
  /** Le nom évoque des accès ou des secrets : à ne pas joindre sans l'avoir relue. */
  sensitive: boolean;
}

function readFiche(dir: string, name: string): string | undefined {
  const file = path.join(dir, name);
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st?.isFile() || st.size > FICHE_MAX_CHARS * 4) return undefined; // ni lien, ni dossier, ni fichier énorme
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) return undefined; // binaire
  const text = buf.toString("utf8");
  return text.length > FICHE_MAX_CHARS ? undefined : text;
}

/** Fiches qui peuvent être jointes à un workflow : fichiers texte de la racine, jamais `journal`. */
export function listFiches(dir: string): FicheInfo[] {
  const out: FicheInfo[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isFile() || !isFicheName(d.name)) continue;
    const text = readFiche(dir, d.name);
    if (text === undefined) continue;
    out.push({ path: d.name, chars: text.length, sensitive: SENSITIVE_HINT.test(d.name) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path, "fr")).slice(0, 100);
}

/** Contenu des fiches choisies ; un nom qui n'est pas une fiche de ce dossier est une erreur (rien n'est deviné). */
export function readFiches(dir: string, names: readonly string[]): Fiche[] {
  const out: Fiche[] = [];
  for (const name of [...new Set(names)]) {
    if (!isFicheName(name)) throw new Error(`fiche refusée : ${name}`);
    const content = readFiche(dir, name);
    if (content === undefined) throw new Error(`fiche introuvable ou illisible : ${name}`);
    out.push({ path: name, content });
  }
  const r = FichesSchema.safeParse(out);
  if (!r.success) throw new Error(r.error.issues.map((i) => i.message).join(" ; "));
  return r.data;
}

/**
 * Pose les fiches d'un workflow dans l'espace de coordination choisi par l'utilisateur, et un état vierge s'il manque.
 * Ne remplace jamais un fichier existant.
 */
export function writeFiches(dir: string, team: string, raw: unknown, workspace?: string): CoordinationInit {
  const real = checkCoordination(dir, workspace);
  const r = FichesSchema.safeParse(raw);
  if (!r.success) throw new Error("Fiches invalides : " + r.error.issues.map((i) => i.message).join(" ; "));
  const files: [string, string][] = [...r.data.map((f): [string, string] => [f.path, f.content]), [`${COORDINATION_JOURNAL}/etat.md`, status(team.trim() || "Équipe")]];
  const created: string[] = [];
  const kept: string[] = [];
  for (const [rel, content] of files) {
    const target = path.join(real, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
      created.push(rel);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      kept.push(rel);
    }
  }
  return { dir: real, created, kept };
}
