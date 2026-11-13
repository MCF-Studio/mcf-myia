import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { paths } from "./paths.js";
import { writeJsonAtomic } from "./profiles.js";

/**
 * Équipes d'agents : un arbre dont chaque nœud est un agent (profil).
 * - sous-agents (branche vers le bas) : le nœud leur DÉLÈGUE une partie du travail ;
 * - coéquipiers (branche horizontale) : même niveau, ils viennent en RENFORT avec leurs propres sous-agents.
 * Un agent ne peut appeler que ses sous-agents et ses coéquipiers directs, jamais un agent déjà dans la chaîne
 * d'appels (pas de boucle). Un budget par message (appels, profondeur) borne le coût.
 *
 * Fichier : config/teams.json (hors git, comme les profils).
 */

export interface TeamNode {
  id: string;
  agentId: string;
  subagents: TeamNode[];
  teammates: TeamNode[];
}

const NodeSchema: z.ZodType<TeamNode> = z.lazy(() =>
  z.object({
    id: z.string().regex(/^[a-z0-9-]{4,40}$/),
    agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    subagents: z.array(NodeSchema).max(12).default([]),
    teammates: z.array(NodeSchema).max(12).default([]),
  }),
) as z.ZodType<TeamNode>;

export const TeamSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(60),
  description: z.string().max(300).optional(),
  /** Espace de travail de l'équipe : tous ses membres y travaillent (il remplace celui de chaque agent). */
  workspace: z.string().trim().min(3).max(500).optional(),
  root: NodeSchema,
  /** Appels d'agents autorisés par message de l'utilisateur (coût maximal d'un message). */
  maxCalls: z.number().int().min(1).max(50).default(8),
  /** Profondeur maximale de délégation (1 = le chef appelle ses agents directs, qui n'appellent personne). */
  maxDepth: z.number().int().min(1).max(6).default(3),
});

export type Team = z.infer<typeof TeamSchema>;

const MAX_NODES = 40;

export function countNodes(n: TeamNode): number {
  return 1 + n.subagents.reduce((s, c) => s + countNodes(c), 0) + n.teammates.reduce((s, c) => s + countNodes(c), 0);
}

export function* walk(n: TeamNode): Generator<TeamNode> {
  yield n;
  for (const c of n.subagents) yield* walk(c);
  for (const c of n.teammates) yield* walk(c);
}

export function parseTeam(raw: unknown, knownAgents?: Set<string>): Team {
  const res = TeamSchema.safeParse(raw);
  if (!res.success) {
    throw new Error("Équipe invalide : " + res.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(" ; "));
  }
  const t = res.data;
  if (countNodes(t.root) > MAX_NODES) throw new Error(`une équipe est limitée à ${MAX_NODES} agents`);
  const ids = new Set<string>();
  for (const n of walk(t.root)) {
    if (ids.has(n.id)) throw new Error(`nœud en double : ${n.id}`);
    ids.add(n.id);
    if (knownAgents && !knownAgents.has(n.agentId)) throw new Error(`agent inconnu dans l'équipe : ${n.agentId}`);
  }
  return t;
}

export const newNodeId = () => crypto.randomUUID().slice(0, 8);

export const teamsFile = () => path.join(paths.home, "config", "teams.json");

export function loadTeams(file = teamsFile()): Team[] {
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { teams?: unknown[] };
  const out: Team[] = [];
  for (const t of raw.teams ?? []) {
    try {
      out.push(parseTeam(t));
    } catch (e) {
      process.stderr.write(`[équipes] ignorée : ${(e as Error).message}\n`);
    }
  }
  return out;
}

export function saveTeams(teams: Team[], file = teamsFile()) {
  writeJsonAtomic(file, { teams });
}

/** Agents qu'un nœud peut appeler : ses sous-agents et ses coéquipiers, hors de la chaîne d'appels en cours. */
export function reachable(node: TeamNode, chain: ReadonlySet<string>): { node: TeamNode; relation: "sous-agent" | "coéquipier" }[] {
  return [
    ...node.subagents.filter((n) => !chain.has(n.id)).map((n) => ({ node: n, relation: "sous-agent" as const })),
    ...node.teammates.filter((n) => !chain.has(n.id)).map((n) => ({ node: n, relation: "coéquipier" as const })),
  ];
}

/** Budget partagé par tous les agents pendant le traitement d'UN message de l'utilisateur. */
export class TeamBudget {
  calls = 0;
  constructor(
    readonly maxCalls: number,
    readonly maxDepth: number,
  ) {}

  take(depth: number): string | undefined {
    if (depth > this.maxDepth) return `profondeur maximale atteinte (${this.maxDepth}) : fais-le toi-même ou réponds avec ce que tu as`;
    if (this.calls >= this.maxCalls) return `budget de l'équipe épuisé (${this.maxCalls} appels pour ce message) : réponds avec ce que tu as`;
    this.calls++;
    return undefined;
  }
}
