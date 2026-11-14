import crypto from "node:crypto";
import { z } from "zod";
import { AgentProfileSchema, type AgentProfile } from "./profiles.js";
import { ScriptPackSchema, scriptHash, SCRIPTS_PER_TEAM, type ScriptPack } from "./scripts.js";
import { countNodes, NodeSchema, walk, type Team, type TeamNode } from "./teams.js";

/**
 * Workflow : une équipe exportée pour être partagée (fichier .workflow.json ou marketplace de mcfstudio.fr).
 * Il contient l'équipe (arbre, budgets), les profils de ses agents et ses scripts (core/scripts.ts).
 *
 * Ce qui ne voyage JAMAIS : les espaces de travail (un accès à un dossier de la machine), le rôle MASTER, les
 * conversations, la mémoire, les secrets. À l'import, rien n'est écrasé : un agent ou un script déjà présent sous le
 * même id avec un contenu différent est installé sous un nouvel id.
 */

export const WORKFLOW_SCHEMA = "myia/workflow@1";
/** Taille maximale du fichier (octets UTF-8), identique côté site. */
export const WORKFLOW_MAX_BYTES = 512_000;
const MAX_NODES = 40;
const MAX_AGENTS = 100;

const PackAgentSchema = AgentProfileSchema.omit({ master: true, workspace: true });
export type PackAgent = z.infer<typeof PackAgentSchema>;

export const WorkflowSchema = z.object({
  $schema: z.literal(WORKFLOW_SCHEMA),
  name: z.string().trim().min(1).max(60),
  description: z.string().max(300).optional(),
  team: z.object({
    root: NodeSchema,
    maxCalls: z.number().int().min(1).max(50).default(8),
    maxDepth: z.number().int().min(1).max(6).default(3),
  }),
  agents: z.array(PackAgentSchema).min(1).max(MAX_NODES),
  scripts: z.array(ScriptPackSchema).max(SCRIPTS_PER_TEAM).default([]),
});

export type Workflow = z.infer<typeof WorkflowSchema>;

export const sha256Text = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** Lit et valide un workflow reçu (fichier ou site) : toujours traité comme une donnée non fiable. */
export function parseWorkflow(json: string): Workflow {
  if (Buffer.byteLength(json, "utf8") > WORKFLOW_MAX_BYTES) throw new Error(`workflow trop volumineux (${WORKFLOW_MAX_BYTES / 1000} Ko au plus)`);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("workflow : JSON invalide");
  }
  if (!raw || typeof raw !== "object" || (raw as { $schema?: unknown }).$schema !== WORKFLOW_SCHEMA) {
    throw new Error(`ce fichier n'est pas un workflow MyIA (${WORKFLOW_SCHEMA} attendu)`);
  }
  const res = WorkflowSchema.safeParse(raw);
  if (!res.success) {
    throw new Error("Workflow invalide : " + res.error.issues.slice(0, 6).map((i) => `${i.path.join(".")} : ${i.message}`).join(" ; "));
  }
  const wf = res.data;
  const agentIds = new Set<string>();
  for (const a of wf.agents) {
    if (agentIds.has(a.id)) throw new Error(`Workflow invalide : agent en double (${a.id})`);
    agentIds.add(a.id);
  }
  if (countNodes(wf.team.root) > MAX_NODES) throw new Error(`Workflow invalide : une équipe est limitée à ${MAX_NODES} agents`);
  const nodeIds = new Set<string>();
  for (const n of walk(wf.team.root)) {
    if (nodeIds.has(n.id)) throw new Error(`Workflow invalide : nœud en double (${n.id})`);
    nodeIds.add(n.id);
    if (!agentIds.has(n.agentId)) throw new Error(`Workflow invalide : l'équipe utilise un agent absent du fichier (${n.agentId})`);
  }
  const scriptIds = new Set<string>();
  for (const s of wf.scripts) {
    if (scriptIds.has(s.id)) throw new Error(`Workflow invalide : script en double (${s.id})`);
    scriptIds.add(s.id);
  }
  return wf;
}

const packAgent = (p: AgentProfile): PackAgent => {
  const { master: _m, workspace: _w, ...rest } = p;
  return rest;
};

export interface ExportResult {
  json: string;
  /** Vrai si les photos des agents ont été retirées pour tenir dans la taille maximale. */
  avatarsDropped: boolean;
}

/** Fabrique le workflow d'une équipe : seuls les agents de l'arbre et les scripts de l'équipe sont embarqués. */
export function exportWorkflow(team: Team, profiles: readonly AgentProfile[], scripts: readonly ScriptPack[]): ExportResult {
  const used = new Set([...walk(team.root)].map((n) => n.agentId));
  const agents = profiles.filter((p) => used.has(p.id)).map(packAgent);
  const missing = [...used].filter((id) => !agents.some((a) => a.id === id));
  if (missing.length) throw new Error(`agent introuvable : ${missing.join(", ")}`);
  const build = (withAvatars: boolean) =>
    JSON.stringify(
      {
        $schema: WORKFLOW_SCHEMA,
        name: team.name,
        ...(team.description ? { description: team.description } : {}),
        team: { root: team.root, maxCalls: team.maxCalls, maxDepth: team.maxDepth },
        agents: withAvatars ? agents : agents.map(({ avatar: _a, ...a }) => a),
        scripts: scripts.map((s) => ({ id: s.id, name: s.name, ...(s.description ? { description: s.description } : {}), entry: s.entry, files: s.files })),
      } satisfies Workflow,
      null,
      2,
    );
  let json = build(true);
  let avatarsDropped = false;
  if (Buffer.byteLength(json, "utf8") > WORKFLOW_MAX_BYTES && agents.some((a) => a.avatar)) {
    json = build(false);
    avatarsDropped = true;
  }
  parseWorkflow(json); // ce qu'on exporte doit pouvoir être réimporté
  return { json, avatarsDropped };
}

const slug = (s: string, fallback: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || fallback;

/** Premier id libre : `base`, puis `base-2`, `base-3`… (40 caractères au plus). */
export function freeId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const id = base.slice(0, 40 - suffix.length).replace(/-+$/, "") + suffix;
    if (!taken.has(id)) return id;
  }
  throw new Error("trop d'éléments portent déjà ce nom");
}

export interface ImportState {
  profiles: readonly AgentProfile[];
  teams: readonly Team[];
  /** Scripts installés : id → empreinte de leur contenu. */
  scripts: ReadonlyMap<string, string>;
}

export interface ImportPlan {
  team: Team;
  /** Profils à ajouter (ceux déjà présents à l'identique sont réutilisés et n'y figurent pas). */
  newProfiles: AgentProfile[];
  /** Scripts à installer, sous leur id final. */
  newScripts: ScriptPack[];
  /** Agents et scripts déjà présents à l'identique, réutilisés tels quels. */
  reusedAgents: string[];
  reusedScripts: string[];
  /** Renommages dus à un id déjà pris par un contenu différent : ancien → nouveau. */
  renamed: { kind: "agent" | "script"; from: string; to: string }[];
}

const sameAgent = (a: AgentProfile, b: PackAgent) => JSON.stringify(sortKeys(packAgent(a))) === JSON.stringify(sortKeys(b));
function sortKeys<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))) as T;
}

/**
 * Calcule ce que l'installation d'un workflow ajouterait, sans rien écrire. Rien n'est jamais remplacé : un id déjà
 * pris par un contenu différent donne un nouvel id.
 */
export function planImport(wf: Workflow, state: ImportState): ImportPlan {
  const renamed: ImportPlan["renamed"] = [];

  const takenAgents = new Set(state.profiles.map((p) => p.id));
  const agentMap = new Map<string, string>();
  const newProfiles: AgentProfile[] = [];
  const reusedAgents: string[] = [];
  // Réutilisé : le même contenu sous le même id, sinon sous un autre id (agent déjà reçu puis renommé à cause d'un
  // conflit : réimporter le workflow ne doit pas l'empiler une seconde fois). Un agent local ne sert qu'une fois.
  const usedAgents = new Set<string>();
  for (const a of wf.agents) {
    const existing =
      state.profiles.find((p) => p.id === a.id && !usedAgents.has(p.id) && sameAgent(p, a)) ??
      state.profiles.find((p) => !usedAgents.has(p.id) && sameAgent({ ...p, id: a.id }, a));
    if (existing) {
      usedAgents.add(existing.id);
      agentMap.set(a.id, existing.id);
      reusedAgents.push(a.id);
      continue;
    }
    const id = freeId(a.id, takenAgents);
    takenAgents.add(id);
    agentMap.set(a.id, id);
    if (id !== a.id) renamed.push({ kind: "agent", from: a.id, to: id });
    newProfiles.push({ ...a, id });
  }
  if (state.profiles.length + newProfiles.length > MAX_AGENTS) {
    throw new Error(`trop d'agents : ce workflow en ajoute ${newProfiles.length}, la limite est de ${MAX_AGENTS}`);
  }

  const takenScripts = new Set(state.scripts.keys());
  const newScripts: ScriptPack[] = [];
  const reusedScripts: string[] = [];
  const scriptIds: string[] = [];
  for (const s of wf.scripts) {
    // Même code déjà installé (l'empreinte ne dépend ni de l'id ni du nom) : on le réutilise, avec l'accord qu'il a déjà.
    const hash = scriptHash(s);
    const local = state.scripts.get(s.id) === hash ? s.id : [...state.scripts].find(([id, h]) => h === hash && !scriptIds.includes(id))?.[0];
    if (local) {
      reusedScripts.push(s.id);
      scriptIds.push(local);
      continue;
    }
    const id = freeId(s.id, takenScripts);
    takenScripts.add(id);
    if (id !== s.id) renamed.push({ kind: "script", from: s.id, to: id });
    newScripts.push({ ...s, id });
    scriptIds.push(id);
  }

  const remap = (n: TeamNode): TeamNode => ({
    id: n.id,
    agentId: agentMap.get(n.agentId)!,
    subagents: n.subagents.map(remap),
    teammates: n.teammates.map(remap),
  });
  const team: Team = {
    id: freeId(slug(wf.name, "equipe"), new Set(state.teams.map((t) => t.id))),
    name: wf.name,
    ...(wf.description ? { description: wf.description } : {}),
    root: remap(wf.team.root),
    maxCalls: wf.team.maxCalls,
    maxDepth: wf.team.maxDepth,
    ...(scriptIds.length ? { scripts: scriptIds } : {}),
  };
  return { team, newProfiles, newScripts, reusedAgents, reusedScripts, renamed };
}
