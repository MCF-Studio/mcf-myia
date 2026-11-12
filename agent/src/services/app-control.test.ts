import { describe, expect, it } from "vitest";
import { needsConfirmation } from "../core/agent.js";
import { ConfigSchema } from "../core/config.js";
import type { AgentProfile } from "../core/profiles.js";
import type { Tool } from "../core/types.js";
import { UrlTrust } from "../core/urls.js";
import { appControlTools, MASTER_MESSAGE_BUDGET, type AppControl } from "./app-control.js";

const master: AgentProfile = { id: "jarvis", name: "Jarvis", master: true };
const redac: AgentProfile = { id: "redac", name: "Rédac" };
const ui = { confirm: async () => true, progress: () => undefined };
const ctx = { ui, trust: new UrlTrust() };

function setup() {
  let agents: AgentProfile[] = [master, redac];
  const sent: string[] = [];
  const ctl: AppControl = {
    agents: () => agents,
    teams: () => [],
    conversations: () => [],
    installedModels: async () => ["qwen3:8b"],
    createAgent: (p) => ((agents = [...agents, p]), p),
    deleteAgent: (id) => void (agents = agents.filter((a) => a.id !== id)),
    createConversation: (agentId, title) => ({ id: "c1", title: title ?? "Nouvelle conversation", agentId, updatedAt: "2026-11-13T10:00:00Z" }),
    guild: () => ({ enabled: false, relay: { state: "off" }, offers: [] }),
    publishOffer: (o) => o as { id: string; name: string },
    messageAgent: async (_from, agentId, text) => (sent.push(`${agentId}:${text}`), "ok"),
  };
  const budget = { used: 0 };
  const tools = new Map(appControlTools(ctl, master, budget).map((t) => [t.name, t]));
  const run = (name: string, args: unknown) => {
    const t = tools.get(name)!;
    return t.run(t.parse(args), ctx);
  };
  return { tools, run, sent, budget, agents: () => agents };
}

const confirms = (t: Tool, args: unknown) => needsConfirmation(t, undefined, ConfigSchema.parse({}), args);

describe("agent MASTER", () => {
  it("créer, supprimer un agent et publier sur la Guilde : toujours confirmé ; lire : jamais", () => {
    const { tools } = setup();
    expect(confirms(tools.get("app_agent_create")!, { name: "X" })).toBe(true);
    expect(confirms(tools.get("app_agent_delete")!, { agent: "redac" })).toBe(true);
    expect(confirms(tools.get("app_guild_publish")!, {})).toBe(true);
    for (const n of ["app_agents_list", "app_conversations_list", "app_guild_view", "app_marketplace_view"]) {
      expect(confirms(tools.get(n)!, {})).toBe(false);
    }
    // Aucun outil de réglage.
    expect([...tools.keys()].some((n) => /key|setting|access|bypass|memory|config/.test(n))).toBe(false);
  });

  it("la confirmation de création montre les consignes complètes ; un agent créé n'est jamais MASTER", async () => {
    const { tools, run, agents } = setup();
    const t = tools.get("app_agent_create")!;
    const args = t.parse({ name: "Veilleur", instructions: "Surveille les sorties de jeux." });
    expect(await t.preview(args)).toContain("Surveille les sorties de jeux.");
    expect(await run("app_agent_create", { name: "Veilleur" })).toContain("créé");
    expect(agents().find((a) => a.name === "Veilleur")?.master).toBeUndefined();
  });

  it("déléguer à un agent plus puissant que MASTER est confirmé", () => {
    const tool = (m: AgentProfile, target: AgentProfile) => {
      const ctl = { agents: () => [m, target] } as unknown as AppControl;
      return appControlTools(ctl, m, { used: 0 }).find((t) => t.name === "app_agent_message")!;
    };
    const args = { agent: "Rédac", message: "résume mon dossier" };
    // MASTER sans restriction, agent local : pas de confirmation.
    expect(confirms(tool(master, redac), args)).toBe(false);
    // MASTER sur Claude, agent local (mémoire, fichiers) : confirmé.
    expect(confirms(tool({ ...master, model: "claude-api:opus" }, redac), args)).toBe(true);
    // MASTER local (mémoire), agent sur Claude : confirmé, le message partirait chez Anthropic.
    expect(confirms(tool(master, { ...redac, model: "claude:sonnet" }), args)).toBe(true);
    // Les deux sur Claude : rien de local ne passe, pas de confirmation.
    expect(confirms(tool({ ...master, model: "claude:opus" }, { ...redac, model: "claude-api:haiku" }), args)).toBe(false);
    // MASTER restreint, agent avec plus de services : confirmé.
    expect(confirms(tool({ ...master, services: ["web"] }, { ...redac, services: ["web", "files"] }), args)).toBe(true);
    expect(confirms(tool({ ...master, services: ["web"] }, { ...redac, services: ["web"] }), args)).toBe(false);
  });

  it("modèle refusé s'il n'est ni installé ni Claude", async () => {
    const t = setup().tools.get("app_agent_create")!;
    await expect(t.check!(t.parse({ name: "A", model: "llama9:400b" }))).rejects.toThrow(/non installé/);
    await expect(t.check!(t.parse({ name: "A", model: "claude-api:sonnet" }))).resolves.toBeUndefined();
  });

  it("MASTER ne se supprime pas, ne s'écrit pas, et son budget de messages est borné", async () => {
    const { tools, run, sent } = setup();
    expect(() => tools.get("app_agent_delete")!.check!({ agent: "Jarvis" })).toThrow(/toi-même/);
    expect(await run("app_agent_message", { agent: "Jarvis", message: "salut" })).toMatch(/toi-même/);
    for (let i = 0; i < MASTER_MESSAGE_BUDGET + 2; i++) await run("app_agent_message", { agent: "Rédac", message: `tâche ${i}` });
    expect(sent).toHaveLength(MASTER_MESSAGE_BUDGET);
    expect(await run("app_agent_message", { agent: "Rédac", message: "encore" })).toMatch(/Budget atteint/);
  });

  it("la Guilde refuse une offre sur Claude", async () => {
    const t = setup().tools.get("app_guild_publish")!;
    await expect(t.check!(t.parse({ id: "redac", name: "Rédac", model: "claude:opus" }))).rejects.toThrow(/local/);
  });

  it("le marketplace n'invente aucun contenu", async () => {
    expect(await setup().run("app_marketplace_view", {})).toMatch(/pas encore ouvert/);
  });
});
