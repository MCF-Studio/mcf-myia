// Carte des agents (« topologie ») : graphe agents ↔ équipes et placement des nœuds. Fonctions pures, sans Vue ni DOM
// (testées par node --test) : la vue ne fait que dessiner ce qui sort d'ici.
import type { AgentProfile, Team, TeamNode } from "./types";

/** ok = prêt · busy = en train de répondre · warn = à vérifier (ex. clé manquante) · error = indisponible. */
export type NodeStatus = "ok" | "busy" | "warn" | "error";

export interface TopoNode {
  id: string;
  label: string;
  status: NodeStatus;
  /** Chef d'équipe ou MASTER : nœud plus gros. */
  major: boolean;
  agent?: Pick<AgentProfile, "id" | "name" | "color" | "avatar">;
  hint?: string;
}

/** sub = délégation chef → sous-agent · mate = coéquipiers (dans les deux sens) · pilot = MASTER → agent. */
export interface TopoEdge {
  from: string;
  to: string;
  kind: "sub" | "mate" | "pilot";
}

export interface TopoGraph {
  nodes: TopoNode[];
  edges: TopoEdge[];
}

export interface Placed extends TopoNode {
  x: number;
  y: number;
}

type StatusOf = (a: AgentProfile) => { status: NodeStatus; hint?: string };

export interface StatusContext {
  /** Nombre de conversations en cours par agent. */
  busy: Map<string, number>;
  defaultModel: string;
  /** Modèles locaux installés ; null = liste inconnue (on ne conclut rien). */
  installed: Set<string> | null;
  localEngineOk: boolean;
  claudeApiKey: boolean;
}

/** État d'un agent pour la carte : en train de répondre, modèle absent, moteur local arrêté, clé d'API manquante. */
export function agentStatus(a: AgentProfile, ctx: StatusContext): { status: NodeStatus; hint?: string } {
  if ((ctx.busy.get(a.id) ?? 0) > 0) return { status: "busy", hint: "répond en ce moment" };
  const model = a.model || ctx.defaultModel;
  if (model.startsWith("claude-api:")) return ctx.claudeApiKey ? { status: "ok" } : { status: "warn", hint: "clé d'API Claude manquante" };
  if (model.startsWith("claude:")) return { status: "ok" };
  if (!ctx.localEngineOk) return { status: "error", hint: "moteur local arrêté" };
  if (ctx.installed && model && !ctx.installed.has(model) && !ctx.installed.has(`${model}:latest`)) {
    return { status: "error", hint: `modèle ${model} non installé` };
  }
  return { status: "ok" };
}

function addEdge(edges: TopoEdge[], seen: Set<string>, e: TopoEdge) {
  if (e.from === e.to) return;
  // Une seule arête par paire, quel que soit le sens (deux équipes peuvent relier les mêmes agents).
  const key = [e.from, e.to].sort().join("→");
  if (seen.has(key)) return;
  seen.add(key);
  edges.push(e);
}

function walk(node: TeamNode, visit: (parent: TeamNode, child: TeamNode, kind: "sub" | "mate") => void) {
  for (const s of node.subagents) {
    visit(node, s, "sub");
    walk(s, visit);
  }
  for (const m of node.teammates) {
    visit(node, m, "mate");
    walk(m, visit);
  }
}

/**
 * Tous les agents : les liens viennent des équipes (délégation, coéquipiers). MASTER pilote les chefs d'équipe et
 * les agents qui ne sont dans aucune équipe, pour que la carte forme un seul réseau.
 */
export function agentsGraph(agents: AgentProfile[], teams: Team[], statusOf: StatusOf): TopoGraph {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const edges: TopoEdge[] = [];
  const seen = new Set<string>();
  const inTeam = new Set<string>();
  const leads = new Set<string>();
  for (const t of teams) {
    if (!byId.has(t.root.agentId)) continue;
    leads.add(t.root.agentId);
    inTeam.add(t.root.agentId);
    walk(t.root, (p, c, kind) => {
      if (!byId.has(p.agentId) || !byId.has(c.agentId)) return;
      inTeam.add(c.agentId);
      addEdge(edges, seen, { from: p.agentId, to: c.agentId, kind });
    });
  }
  const master = agents.find((a) => a.master);
  if (master) {
    for (const a of agents) {
      if (a.id === master.id) continue;
      if (leads.has(a.id) || !inTeam.has(a.id)) addEdge(edges, seen, { from: master.id, to: a.id, kind: "pilot" });
    }
  }
  const nodes = agents.map((a) => ({
    id: a.id,
    label: a.name,
    major: !!a.master || leads.has(a.id),
    agent: a,
    ...statusOf(a),
  }));
  return { nodes, edges };
}

/** Une équipe : son chef, ses sous-agents et coéquipiers (un même agent peut apparaître plusieurs fois dans l'arbre). */
export function teamGraph(team: Team, agents: AgentProfile[], statusOf: StatusOf): TopoGraph {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];
  const seen = new Set<string>();
  const add = (n: TeamNode) => {
    if (nodes.some((x) => x.id === n.agentId)) return;
    const a = byId.get(n.agentId);
    nodes.push(
      a
        ? { id: a.id, label: a.name, major: n === team.root, agent: a, ...statusOf(a) }
        : { id: n.agentId, label: n.agentId, major: n === team.root, status: "error", hint: "agent supprimé" },
    );
  };
  add(team.root);
  walk(team.root, (p, c, kind) => {
    add(c);
    addEdge(edges, seen, { from: p.agentId, to: c.agentId, kind });
  });
  return { nodes, edges };
}

/** Générateur pseudo-aléatoire reproductible (mulberry32) : la carte ne « saute » pas d'un affichage à l'autre. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Placement par forces (Fruchterman-Reingold) dans un rectangle [0,1]², avec une marge : les nœuds se repoussent,
 * les liens les rapprochent. Déterministe (graine tirée des ids) ; la carte reste stable tant que le graphe ne change pas.
 */
export function layout(g: TopoGraph, aspect = 1.6, iterations = 320): Placed[] {
  const n = g.nodes.length;
  if (n === 0) return [];
  if (n === 1) return [{ ...g.nodes[0]!, x: 0.5, y: 0.5 }];
  const rand = seeded(hash(g.nodes.map((x) => x.id).join("|") + "#" + g.edges.map((e) => e.from + e.to).join("|")));
  const W = aspect;
  const H = 1;
  const pos = g.nodes.map(() => ({ x: rand() * W, y: rand() * H, dx: 0, dy: 0 }));
  const index = new Map(g.nodes.map((x, i) => [x.id, i]));
  const k = Math.sqrt((W * H) / n) * 0.9;
  let temp = W / 6;
  for (let it = 0; it < iterations; it++) {
    for (const p of pos) {
      p.dx = 0;
      p.dy = 0;
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos[i]!;
        const b = pos[j]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d = Math.hypot(dx, dy);
        if (d < 1e-6) {
          dx = rand() - 0.5;
          dy = rand() - 0.5;
          d = Math.hypot(dx, dy);
        }
        const f = (k * k) / d;
        a.dx += (dx / d) * f;
        a.dy += (dy / d) * f;
        b.dx -= (dx / d) * f;
        b.dy -= (dy / d) * f;
      }
    }
    for (const e of g.edges) {
      const a = pos[index.get(e.from)!];
      const b = pos[index.get(e.to)!];
      if (!a || !b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.max(1e-6, Math.hypot(dx, dy));
      const f = (d * d) / k;
      a.dx -= (dx / d) * f;
      a.dy -= (dy / d) * f;
      b.dx += (dx / d) * f;
      b.dy += (dy / d) * f;
    }
    for (const p of pos) {
      // Légère attraction vers le centre : les nœuds isolés ne partent pas dans les coins.
      p.dx += (W / 2 - p.x) * 0.02 * n;
      p.dy += (H / 2 - p.y) * 0.02 * n;
      const d = Math.max(1e-6, Math.hypot(p.dx, p.dy));
      const step = Math.min(d, temp);
      p.x = Math.min(W, Math.max(0, p.x + (p.dx / d) * step));
      p.y = Math.min(H, Math.max(0, p.y + (p.dy / d) * step));
    }
    temp *= 0.985;
  }
  // Recadrage : on étire le nuage sur toute la zone (marges gérées par la vue).
  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return g.nodes.map((node, i) => ({
    ...node,
    x: x1 - x0 < 1e-6 ? 0.5 : (pos[i]!.x - x0) / (x1 - x0),
    y: y1 - y0 < 1e-6 ? 0.5 : (pos[i]!.y - y0) / (y1 - y0),
  }));
}
