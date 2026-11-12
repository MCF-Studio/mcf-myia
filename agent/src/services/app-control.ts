import { z } from "zod";
import { isCloudModel, MODEL_NAME } from "../core/llm.js";
import type { AgentProfile } from "../core/profiles.js";
import { defineTool, truncate, type AgentUI, type Tool } from "../core/types.js";

/**
 * Outils de l'agent MASTER : piloter l'app (SPEC, « Agent MASTER »).
 * Lecture sans confirmation ; créer/supprimer un agent et publier sur la Guilde : confirmation à chaque fois (risque
 * « external » = toujours confirmé). Aucun outil de réglage (clés, accès au PC, bypass…) : volontairement absent.
 */

export interface ConversationSummary {
  id: string;
  title: string;
  agentId: string;
  teamId?: string;
  updatedAt: string;
}

/** Ce que l'app expose à MASTER (implémenté par le serveur). */
export interface AppControl {
  agents(): AgentProfile[];
  teams(): { id: string; name: string; description?: string }[];
  conversations(): ConversationSummary[];
  installedModels(): Promise<string[]>;
  createAgent(p: AgentProfile): AgentProfile;
  deleteAgent(id: string): void;
  createConversation(agentId: string, title?: string): ConversationSummary;
  guild(): { enabled: boolean; relay: unknown; offers: { id: string; name: string; description: string; model: string; enabled: boolean }[] };
  publishOffer(offer: unknown): { id: string; name: string };
  /** Écrit à un agent dans sa conversation « MASTER ↔ agent » et rend sa réponse. */
  messageAgent(fromName: string, agentId: string, text: string, ui: AgentUI, signal?: AbortSignal): Promise<string>;
}

/** Messages à d'autres agents au plus, par demande de l'utilisateur à MASTER. */
export const MASTER_MESSAGE_BUDGET = 6;

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "agent";

export function appControlTools(ctl: AppControl, master: AgentProfile, budget: { used: number }): Tool[] {
  const byName = (name: string) => {
    const n = name.trim().toLowerCase();
    return ctl.agents().find((a) => a.name.toLowerCase() === n || a.id === n);
  };
  const others = () => ctl.agents().filter((a) => a.id !== master.id);

  return [
    defineTool({
      name: "app_agents_list",
      description: "Liste les agents de l'app (nom, id, modèle, description). À utiliser avant d'écrire à un agent ou d'en créer un.",
      schema: z.object({}),
      risk: "read",
      preview: () => "",
      async run() {
        return ctl
          .agents()
          .map((a) => `- ${a.name} (id ${a.id}${a.master ? ", c'est toi" : ""}) · modèle ${a.model ?? "par défaut"}${a.description ? ` — ${a.description}` : ""}`)
          .join("\n");
      },
    }),
    defineTool({
      name: "app_teams_list",
      description: "Liste les équipes d'agents de l'app.",
      schema: z.object({}),
      risk: "read",
      preview: () => "",
      async run() {
        const t = ctl.teams();
        return t.length ? t.map((x) => `- ${x.name} (id ${x.id})${x.description ? ` — ${x.description}` : ""}`).join("\n") : "Aucune équipe.";
      },
    }),
    defineTool({
      name: "app_conversations_list",
      description: "Liste les conversations récentes de l'app (titre, agent, date). Ne montre pas leur contenu.",
      schema: z.object({ limit: z.number().int().min(1).max(50).default(15) }),
      risk: "read",
      preview: () => "",
      async run(a) {
        const names = new Map(ctl.agents().map((x) => [x.id, x.name]));
        const list = ctl.conversations().slice(0, a.limit);
        return list.length
          ? list.map((c) => `- « ${c.title} » avec ${names.get(c.agentId) ?? c.agentId}${c.teamId ? " (équipe)" : ""} · ${c.updatedAt.slice(0, 16).replace("T", " ")}`).join("\n")
          : "Aucune conversation.";
      },
    }),
    defineTool({
      name: "app_conversation_create",
      description: "Ouvre une nouvelle conversation (vide) avec un agent, visible dans l'app.",
      schema: z.object({ agent: z.string().min(1).max(40).describe("Nom ou id de l'agent"), title: z.string().max(80).optional() }),
      risk: "local",
      confirmIf: () => false,
      preview: (a) => `Nouvelle conversation avec ${a.agent}`,
      async run(a) {
        const target = byName(a.agent);
        if (!target) return `Agent introuvable : ${a.agent}. Agents : ${ctl.agents().map((x) => x.name).join(", ")}.`;
        const c = ctl.createConversation(target.id, a.title);
        return `Conversation « ${c.title} » ouverte avec ${target.name}.`;
      },
    }),
    defineTool({
      name: "app_agent_create",
      description:
        "Crée un nouvel agent dans l'app (l'utilisateur confirme). Modèle : vide = modèle par défaut, un modèle local installé, " +
        "« claude:<haiku|sonnet|opus|fable> » (abonnement) ou « claude-api:<haiku|sonnet|opus|fable> » (clé d'API).",
      schema: z.object({
        name: z.string().trim().min(1).max(40),
        description: z.string().max(300).default(""),
        instructions: z.string().max(4000).default("").describe("Consignes propres à ce rôle"),
        model: z.string().max(120).default(""),
      }),
      risk: "external",
      async check(a) {
        if (a.model && !MODEL_NAME.test(a.model)) throw new Error(`nom de modèle invalide : ${a.model}`);
        if (a.model && !isCloudModel(a.model) && !(await ctl.installedModels()).includes(a.model)) {
          throw new Error(`modèle local non installé : ${a.model} (onglet Modèles)`);
        }
        if (byName(a.name)) throw new Error(`un agent « ${a.name} » existe déjà`);
      },
      preview: (a) =>
        [
          `Créer l'agent « ${a.name} »`,
          `Modèle : ${a.model || "par défaut"}`,
          ...(a.description ? [`Description : ${a.description}`] : []),
          "Consignes :",
          a.instructions || "(aucune)",
        ].join("\n"),
      async run(a) {
        let id = slug(a.name);
        for (let i = 2; ctl.agents().some((x) => x.id === id); i++) id = `${slug(a.name).slice(0, 36)}-${i}`;
        const p = ctl.createAgent({
          id,
          name: a.name,
          ...(a.description ? { description: a.description } : {}),
          ...(a.instructions ? { instructions: a.instructions } : {}),
          ...(a.model ? { model: a.model } : {}),
        });
        return `Agent « ${p.name} » créé (id ${p.id}).`;
      },
    }),
    defineTool({
      name: "app_agent_delete",
      description: "Supprime un agent de l'app (l'utilisateur confirme). Impossible pour toi-même ou un agent encore utilisé.",
      schema: z.object({ agent: z.string().min(1).max(40).describe("Nom ou id") }),
      risk: "external",
      check(a) {
        const t = byName(a.agent);
        if (!t) throw new Error(`agent introuvable : ${a.agent}`);
        if (t.id === master.id) throw new Error("tu ne peux pas te supprimer toi-même");
      },
      preview: (a) => {
        const t = byName(a.agent);
        return `Supprimer définitivement l'agent « ${t?.name ?? a.agent} » (id ${t?.id ?? "?"}) et son profil.`;
      },
      async run(a) {
        const t = byName(a.agent)!;
        ctl.deleteAgent(t.id);
        return `Agent « ${t.name} » supprimé.`;
      },
    }),
    defineTool({
      name: "app_guild_view",
      description: "État de la Guilde (partage d'agents entre membres de mcfstudio.fr) : activée ou non, connexion, offres publiées.",
      schema: z.object({}),
      risk: "read",
      preview: () => "",
      async run() {
        const g = ctl.guild();
        const offers = g.offers.length
          ? g.offers.map((o) => `- ${o.name} (id ${o.id}, ${o.model})${o.enabled ? "" : " [désactivée]"}${o.description ? ` — ${o.description}` : ""}`).join("\n")
          : "aucune";
        return `Guilde ${g.enabled ? "activée" : "désactivée"} · relais : ${JSON.stringify(g.relay)}\nOffres publiées :\n${offers}`;
      },
    }),
    defineTool({
      name: "app_marketplace_view",
      description: "Consulte le marketplace d'agents et de thèmes de mcfstudio.fr.",
      schema: z.object({}),
      risk: "read",
      preview: () => "",
      async run() {
        return "Le marketplace n'est pas encore ouvert : aucun contenu à consulter. Seule l'installation depuis un fichier local existe (écran Marketplace).";
      },
    }),
    defineTool({
      name: "app_guild_publish",
      description:
        "Publie (ou remplace) une offre d'agent sur la Guilde : d'autres membres pourront le solliciter (l'utilisateur confirme). Modèle local uniquement.",
      schema: z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/).describe("Identifiant de l'offre (minuscules, tirets)"),
        name: z.string().trim().min(1).max(40),
        description: z.string().max(300).default(""),
        tags: z.array(z.string().trim().min(2).max(24)).max(8).default([]),
        model: z.string().max(120).describe("Modèle LOCAL installé"),
        instructions: z.string().max(4000).default(""),
      }),
      risk: "external",
      async check(a) {
        if (isCloudModel(a.model)) throw new Error("un agent de la Guilde tourne sur un modèle local");
        if (!(await ctl.installedModels()).includes(a.model)) throw new Error(`modèle local non installé : ${a.model}`);
      },
      preview: (a) =>
        [
          `Publier sur la Guilde l'offre « ${a.name} » (id ${a.id})`,
          `Modèle : ${a.model}`,
          ...(a.tags.length ? [`Compétences : ${a.tags.join(", ")}`] : []),
          ...(a.description ? [`Description : ${a.description}`] : []),
          "Consignes :",
          a.instructions || "(aucune)",
          "Cette offre sera visible des membres de la Guilde.",
        ].join("\n"),
      async run(a) {
        const o = ctl.publishOffer({ ...a, enabled: true });
        return `Offre « ${o.name} » publiée sur la Guilde.`;
      },
    }),
    defineTool({
      name: "app_agent_message",
      description:
        "Écris à un autre agent de l'app et récupère sa réponse. L'échange apparaît dans une conversation visible par l'utilisateur. " +
        "Le message doit être complet et autonome : l'agent ne voit pas ta conversation.",
      schema: z.object({
        agent: z.string().min(1).max(40).describe("Nom ou id de l'agent"),
        message: z.string().min(2).max(6000),
      }),
      risk: "read",
      preview: (a) => `${master.name} → ${a.agent} : ${a.message}`,
      async run(a, ctx) {
        const t = byName(a.agent);
        if (!t) return `Agent introuvable : ${a.agent}. Agents : ${others().map((x) => x.name).join(", ") || "aucun"}.`;
        if (t.id === master.id) return "Tu ne peux pas t'écrire à toi-même.";
        if (budget.used >= MASTER_MESSAGE_BUDGET) {
          return `Budget atteint (${MASTER_MESSAGE_BUDGET} messages à d'autres agents pour cette demande) : réponds avec ce que tu as.`;
        }
        budget.used++;
        ctx.ui.progress(`${master.name} → ${t.name} : ${a.message.replace(/\s+/g, " ").slice(0, 140)}`);
        const answer = await ctl.messageAgent(master.name, t.id, a.message, ctx.ui, ctx.signal);
        return `Réponse de ${t.name} :\n${truncate(answer, 6000)}`;
      },
    }),
  ];
}
