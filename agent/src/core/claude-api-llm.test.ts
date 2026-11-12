import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { API_KEY_FORMAT, ClaudeApiClient, claudeApiAlias, describeError, replayableBlocks, toApiMessages, toApiTools } from "./claude-api-llm.js";
import { ConfigSchema } from "./config.js";
import { OfferSchema } from "./guild.js";
import { createLlm } from "./llm-factory.js";
import type { ChatMessage } from "./llm.js";
import type { Memory } from "./memory.js";
import { makeTeamRoot } from "./team-runner.js";
import { parseTeam, TeamBudget } from "./teams.js";
import type { Service } from "./types.js";

const loadConfig = () => ConfigSchema.parse({});
const ui = { confirm: async () => true, progress: () => undefined } as never;
const opts = { effort: "medium" as const, maxTokens: 4096, timeoutMinutes: 1 };

describe("agent sur l'API Claude (clé d'API)", () => {
  it("« claude-api:<alias> » seulement pour un alias connu ; la fabrique choisit l'API", () => {
    expect(claudeApiAlias("claude-api:sonnet")).toBe("sonnet");
    expect([claudeApiAlias("claude-api:gpt"), claudeApiAlias("claude-api:constructor"), claudeApiAlias("claude:opus")]).toEqual([undefined, undefined, undefined]);
    expect(createLlm(loadConfig().llm, "claude-api:opus")).toBeInstanceOf(ClaudeApiClient);
    expect(createLlm(loadConfig().llm, "claude:opus").engine).toBe("claude");
  });

  it("format de clé vérifié avant tout appel réseau", () => {
    expect(API_KEY_FORMAT.test("sk-ant-api03-" + "a".repeat(40))).toBe(true);
    expect(API_KEY_FORMAT.test("sk-proj-" + "a".repeat(40))).toBe(false);
    expect(API_KEY_FORMAT.test("sk-ant-api03-abc def" + "a".repeat(30))).toBe(false);
  });

  it("sans clé : erreur claire, aucun appel", async () => {
    const c = new ClaudeApiClient("haiku", opts, () => undefined);
    await expect(c.chat([{ role: "user", content: "x" }], [])).rejects.toThrow(/clé d'API/);
    expect(await c.ping()).toBe(false);
  });

  it("une erreur ne contient jamais la clé", () => {
    const key = "sk-ant-api03-" + "z".repeat(40);
    expect(describeError(new Error(`boom ${key}`), key)).not.toContain(key);
  });

  it("historique MyIA → messages de l'API : identifiants appariés, résultats regroupés, alternance", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "ouvre deux dossiers" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "open_path", arguments: { path: "A" } } },
          { function: { name: "open_path", arguments: '{"path":"B"}' } },
        ],
      },
      { role: "tool", tool_name: "open_path", content: "ok A" },
      { role: "tool", tool_name: "open_path", content: "ok B" },
      { role: "assistant", content: "Fait." },
      { role: "user", content: "merci" },
    ];
    const out = toApiMessages(msgs);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    const uses = (out[1]!.content as { type: string; id: string; input: unknown }[]).filter((b) => b.type === "tool_use");
    expect(uses.map((u) => u.input)).toEqual([{ path: "A" }, { path: "B" }]);
    const results = out[2]!.content as { type: string; tool_use_id: string }[];
    expect(results.map((r) => r.tool_use_id)).toEqual(uses.map((u) => u.id));
  });

  it("les blocs signés ne sont renvoyés qu'après le dernier message de l'utilisateur", () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    const old: ChatMessage = { role: "assistant", content: "ancienne", blocks: [thinking, { type: "text", text: "ancienne" }] };
    const cur: ChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "toolu_1", function: { name: "t", arguments: {} } }],
      blocks: [thinking, { type: "tool_use", id: "toolu_1", name: "t", input: {} }],
    };
    const out = toApiMessages([
      { role: "user", content: "a" },
      old,
      { role: "user", content: "b" },
      cur,
      { role: "tool", tool_name: "t", tool_call_id: "toolu_1", content: "r" },
    ]);
    expect(JSON.stringify(out[1])).not.toContain("thinking");
    expect((out[3]!.content as { type: string }[]).map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect((out[4]!.content as { tool_use_id: string }[])[0]!.tool_use_id).toBe("toolu_1");
  });

  it("un appel d'outil resté sans résultat est clos (demande interrompue)", () => {
    const out = toApiMessages([
      { role: "user", content: "a" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "t", arguments: {} } }] },
      { role: "user", content: "autre chose" },
    ]);
    const next = out[2]!.content as { type: string; is_error?: boolean }[];
    expect(next[0]).toMatchObject({ type: "tool_result", is_error: true });
    expect(next[1]).toMatchObject({ type: "text" });
  });

  it("repli en cours de réponse : réflexions et appels d'avant le bloc fallback ne sont pas renvoyés", () => {
    const blocks = [
      { type: "thinking", thinking: "", signature: "a" },
      { type: "text", text: "début" },
      { type: "tool_use", id: "x", name: "t", input: {} },
      { type: "fallback" },
      { type: "text", text: "suite" },
    ] as never;
    expect(replayableBlocks(blocks).map((b) => b.type)).toEqual(["text", "fallback", "text"]);
  });

  it("outils : schéma objet, arguments diffusés", () => {
    const [t] = toApiTools([{ type: "function", function: { name: "n", description: "d", parameters: { type: "object", properties: {} } } }]);
    expect(t).toMatchObject({ name: "n", input_schema: { type: "object" }, eager_input_streaming: true });
  });

  it("la mémoire ne part pas chez Anthropic, et les blocs d'API ne sont pas persistés", async () => {
    const svc = (id: string): Service => ({ id, label: id, available: async () => ({ ok: true }), tools: () => [] });
    let asked = 0;
    const memory = { contextFor: () => (asked++, "SECRET DE MÉMOIRE") } as unknown as Memory;
    const agent = new Agent(loadConfig(), [svc("memory"), svc("files")], { id: "c", name: "C", model: "claude-api:haiku" }, { memory });
    await agent.refreshServices();
    expect(agent.statuses.map((s) => s.service.id)).toEqual(["files"]);
    let sent = "";
    (agent.client as { chat: unknown }).chat = async (messages: { content: string }[]) => {
      sent = messages.map((m) => m.content).join("\n");
      return { role: "assistant", content: "ok", blocks: [{ type: "text", text: "ok" }] };
    };
    await agent.handle("bonjour", ui);
    expect(asked).toBe(0);
    expect(sent).not.toContain("SECRET DE MÉMOIRE");
    expect(JSON.stringify(agent.exportHistory())).not.toContain("blocks");
  });

  it("utilisable dans une équipe : le chef délègue à un membre sur l'API Claude", async () => {
    const profiles = {
      chef: { id: "chef", name: "Chef", model: "qwen3:8b" },
      redac: { id: "redac", name: "Rédac", model: "claude-api:sonnet" },
    };
    const team = parseTeam(
      { id: "t", name: "Équipe", root: { id: "root", agentId: "chef", subagents: [{ id: "n-redac", agentId: "redac" }] } },
      new Set(Object.keys(profiles)),
    );
    const root = makeTeamRoot({
      cfg: loadConfig(),
      services: [],
      team,
      profileOf: (id) => profiles[id as keyof typeof profiles],
      budget: new TeamBudget(team.maxCalls, team.maxDepth),
    });
    await root.refreshServices();
    const calls: string[] = [];
    // Le chef (local) appelle team_ask ; le membre est construit à la volée : on intercepte sa fabrique via le prototype.
    const proto = ClaudeApiClient.prototype as unknown as { chat: unknown };
    const original = proto.chat;
    proto.chat = async function (this: ClaudeApiClient) {
      calls.push(this.model);
      return { role: "assistant", content: "texte rédigé" };
    };
    let step = 0;
    (root.client as { chat: unknown }).chat = async () =>
      step++ === 0
        ? { role: "assistant", content: "", tool_calls: [{ function: { name: "team_ask", arguments: { member: "Rédac", task: "Rédige une annonce courte." } } }] }
        : { role: "assistant", content: "Voilà." };
    try {
      expect(await root.handle("fais rédiger une annonce", ui)).toBe("Voilà.");
    } finally {
      proto.chat = original;
    }
    expect(calls).toEqual(["claude-api:sonnet"]);
    expect(JSON.stringify(root.exportHistory())).toContain("texte rédigé");
  });

  it("la Guilde refuse un agent sur l'API Claude (la clé de l'utilisateur n'est pas prêtée)", () => {
    expect(OfferSchema.safeParse({ id: "redac", name: "Rédac", model: "claude-api:opus" }).success).toBe(false);
  });
});
