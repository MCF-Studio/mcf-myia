import { z } from "zod";
import { Agent } from "./agent.js";
import type { Config } from "./config.js";
import type { AgentProfile } from "./profiles.js";
import { reachable, TeamBudget, type Team, type TeamNode } from "./teams.js";
import { defineTool, type AgentUI, type Service, type Tool } from "./types.js";

/**
 * Exécution d'une équipe : chaque nœud devient un Agent ; s'il a des sous-agents ou des coéquipiers, il reçoit
 * l'outil `team_ask` pour leur confier une tâche. L'agent appelé travaille avec SES services et SES propres
 * sous-agents/coéquipiers, puis rend sa réponse. Les confirmations remontent telles quelles à l'utilisateur.
 */

export interface TeamContext {
  cfg: Config;
  services: Service[];
  team: Team;
  profileOf(id: string): AgentProfile;
  budget: TeamBudget;
}

function describe(p: AgentProfile) {
  return p.description ? ` — ${p.description}` : "";
}

function prefixedUI(ui: AgentUI, name: string): AgentUI {
  return {
    confirm: (title, details) => ui.confirm(`${name} · ${title}`, details),
    progress: (m) => ui.progress(`${name} · ${m}`),
  };
}

function teamAskTool(node: TeamNode, ctx: TeamContext, depth: number, chain: ReadonlySet<string>): Tool | undefined {
  const targets = reachable(node, chain);
  if (!targets.length) return undefined;
  const me = ctx.profileOf(node.agentId);
  const byName = new Map(targets.map((t) => [ctx.profileOf(t.node.agentId).name, t]));
  const names = [...byName.keys()];

  return defineTool({
    name: "team_ask",
    description:
      `Confie une tâche à un membre de ton équipe et récupère sa réponse. Membres : ` +
      targets.map((t) => `${ctx.profileOf(t.node.agentId).name} (${t.relation}${describe(ctx.profileOf(t.node.agentId))})`).join(" ; ") +
      `. Chaque appel coûte du temps de calcul : ne l'utilise que si la tâche relève vraiment de ce membre. ` +
      `La consigne doit être complète et autonome : il ne voit pas ta conversation.`,
    schema: z.object({
      member: z.enum(names as [string, ...string[]]).describe("Nom du membre"),
      task: z.string().min(10).max(6000).describe("Consigne complète : contexte, ce qui est attendu, format de la réponse"),
    }),
    risk: "read",
    preview: (a) => `${me.name} → ${a.member} : ${a.task}`,
    async run(a, tctx) {
      const target = byName.get(a.member);
      if (!target) return `Erreur : ${a.member} n'est pas dans ton équipe.`;
      const refused = ctx.budget.take(depth + 1);
      if (refused) return `Appel impossible : ${refused}.`;

      const name = a.member;
      tctx.ui.progress(`${me.name} → ${name} (${target.relation}) : ${a.task.replace(/\s+/g, " ").slice(0, 140)}`);
      const sub = makeTeamAgent(target.node, ctx, depth + 1, new Set([...chain, target.node.id]), me.name);
      // Les services sont partagés entre agents : le sous-agent ne les ferme pas.
      await sub.refreshServices();
      const answer = await sub.handle(a.task, prefixedUI(tctx.ui, name), tctx.signal);
      return `Réponse de ${name} :\n${answer}`;
    },
  });
}

/** Agent d'un nœud de l'équipe (racine : depth 0, appelant absent). */
export function makeTeamAgent(node: TeamNode, ctx: TeamContext, depth: number, chain: ReadonlySet<string>, caller?: string): Agent {
  const profile = ctx.profileOf(node.agentId);
  const canDelegate = depth < ctx.team.maxDepth;
  const tool = canDelegate ? teamAskTool(node, ctx, depth, chain) : undefined;
  const lines = [`Tu fais partie de l'équipe « ${ctx.team.name} ».`];
  if (caller) {
    lines.push(
      `Cette demande vient de l'agent ${caller}, pas directement de ${ctx.cfg.user.name} : réponds-lui avec un résultat concret et complet, sans question en retour sauf blocage réel.`,
    );
  }
  if (tool) lines.push("Tu peux confier une partie du travail à ton équipe avec l'outil team_ask (sous-agents : délégation ; coéquipiers : renfort).");
  return new Agent(ctx.cfg, ctx.services, profile, {
    extraTools: tool ? [tool] : [],
    teamNote: lines.join("\n"),
    trustInput: !caller,
  });
}

export function makeTeamRoot(ctx: TeamContext): Agent {
  return makeTeamAgent(ctx.team.root, ctx, 0, new Set([ctx.team.root.id]));
}
