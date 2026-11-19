import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent } from "./agent.js";
import { ConfigSchema, parseConfig } from "./config.js";
import type { ChatMessage, LlmClient } from "./llm.js";
import { llmStats } from "./llm-stats.js";
import type { Memory } from "./memory.js";
import { routerHistory } from "./model-router.js";
import { defineTool, type Service } from "./types.js";

// Le journal d'audit (budget_stop) part dans un dossier temporaire.
process.env.MYIA_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), "myia-opti-"));

// Événements d'audit relevés pour vérifier que l'arrêt de budget passe par budgetStop (rien n'est écrit sur disque).
const audited = vi.hoisted(() => [] as { event: string; args?: unknown }[]);
vi.mock("./audit.js", () => ({ audit: (ev: { event: string; args?: unknown }) => void audited.push(ev) }));
const budgetStops = () => audited.filter((e) => e.event === "budget_stop");

const lister: Service = {
  id: "essai",
  label: "Essai",
  available: async () => ({ ok: true }),
  tools: () => [
    defineTool({
      name: "lister",
      description: "liste un dossier",
      risk: "read",
      schema: z.object({}),
      preview: () => "lister",
      run: async () => "a.txt\nb.txt",
    }),
  ],
};

const callTool: ChatMessage = { role: "assistant", content: "", tool_calls: [{ function: { name: "lister", arguments: {} } }] };
const ui = { confirm: async () => true, progress: () => {} };

async function agentWith(chat: (m: ChatMessage[]) => ChatMessage, cfg: object = {}, opts = {}) {
  const agent = new Agent(parseConfig(cfg), [lister], undefined, opts);
  await agent.refreshServices();
  (agent.client as unknown as { chat: unknown }).chat = async (m: ChatMessage[]) => chat(m);
  return agent;
}

/** Faux client d'un autre modèle, injecté là où le routeur range ses clients. */
function fakeClient(model: string, chat: (m: ChatMessage[]) => ChatMessage): LlmClient {
  return { engine: "ollama", model, chat: async (m: ChatMessage[]) => chat(m) } as unknown as LlmClient;
}
const inject = (agent: Agent, c: LlmClient) => (agent as unknown as { routed: Map<string, LlmClient> }).routed.set(c.model, c);

beforeEach(() => {
  llmStats.clear();
  routerHistory.clear();
  audited.length = 0;
});

describe("optimisation : rien ne change sans réglage", () => {
  it("tout est désactivé par défaut, sauf les statistiques en mémoire", () => {
    const o = ConfigSchema.parse({}).optimization;
    expect(o.stats).toEqual({ enabled: true, maxRecords: 2000, journal: false });
    expect(o.budget.enabled).toBe(false);
    expect(o.context.enabled).toBe(false);
    expect(o.router.enabled).toBe(false);
  });

  it("même déroulé qu'avant : pas de budget, pas de trace, le modèle de l'agent", async () => {
    let n = 0;
    const agent = await agentWith(() => (n++ < 2 ? callTool : { role: "assistant", content: "fini" }));
    expect(await agent.handle("liste", ui)).toBe("fini");
    expect(agent.lastBudget).toBeUndefined();
    expect(agent.lastContextTrace).toEqual([]);
    expect(n).toBe(3);
  });
});

describe("statistiques centralisées", () => {
  it("chaque appel est enregistré avec agent, demande, modèle, jetons estimés et outils", async () => {
    let n = 0;
    const agent = await agentWith(() => (n++ === 0 ? callTool : { role: "assistant", content: "ok" }));
    await agent.handle("liste le dossier", ui);
    const recs = llmStats.records({ agent: "myia" });
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ model: agent.model, engine: "ollama", ok: true, tools: ["lister"] });
    expect(recs[0]!.estimatedInput).toBeGreaterThan(0);
    expect(recs[0]!.billed).toBeUndefined();
    expect(recs[0]!.task).toBe(recs[1]!.task);
    expect(llmStats.aggregate("task")[recs[0]!.task]!.calls).toBe(2);
  });

  it("un appel en échec est enregistré, l'erreur remonte comme avant", async () => {
    const agent = await agentWith(() => {
      throw new Error("Ollama 500");
    });
    await expect(agent.handle("salut", ui)).rejects.toThrow("Ollama 500");
    expect(llmStats.records()[0]).toMatchObject({ ok: false, error: "Ollama 500" });
  });

  it("désactivables", async () => {
    const agent = await agentWith(() => ({ role: "assistant", content: "ok" }), { optimization: { stats: { enabled: false } } });
    await agent.handle("salut", ui);
    expect(llmStats.records()).toHaveLength(0);
    // Remis pour les autres tests (instance partagée).
    llmStats.configure({ enabled: true });
  });
});

describe("budget d'une demande", () => {
  it("limite d'appels : arrêt propre sans nouvel appel, travail gardé pour « continue »", async () => {
    let n = 0;
    const agent = await agentWith(
      () => {
        n++;
        return callTool;
      },
      { optimization: { budget: { enabled: true, maxLlmCalls: 3 } } },
    );
    const r = await agent.handle("range", ui);
    expect(r).toMatch(/budget de cette demande.*3 appels.*continue/);
    expect(n).toBe(3);
    expect(agent.lastBudget).toMatchObject({ llmCalls: 3 });
    expect(agent.exportHistory().at(-1)).toMatchObject({ role: "assistant", content: r });
  });

  it("budget de jetons : l'appel n'est pas lancé s'il ne reste pas la réserve de sortie", async () => {
    let n = 0;
    const agent = await agentWith(
      () => {
        n++;
        return { role: "assistant", content: "ok" };
      },
      { optimization: { budget: { enabled: true, maxTokens: 100, reserveForOutput: 2000 } } },
    );
    expect(await agent.handle("salut", ui)).toMatch(/budget de 100 jetons insuffisant/);
    expect(n).toBe(0);
  });

  it("itérations : 25 par défaut comme maxSteps, puis le point d'étape habituel", async () => {
    let n = 0;
    const agent = await agentWith(
      (m) => {
        n++;
        return m.at(-1)?.content.startsWith("(note automatique) Limite") ? { role: "assistant", content: "Fait : tout. Reste : rien." } : callTool;
      },
      { maxSteps: 3, optimization: { budget: { enabled: true } } },
    );
    const r = await agent.handle("range", ui);
    expect(r).toContain("Fait : tout");
    expect(n).toBe(4);
    expect(agent.lastBudget).toMatchObject({ iterations: 3, llmCalls: 4 });
    expect(agent.lastBudget!.estimatedTokens).toBeGreaterThan(0);
    expect(agent.lastBudget!.billedTokens).toBe(0);
  });
});

describe("arrêt de budget unifié (budgetStop)", () => {
  it("BudgetExceededError dans la boucle : budgetStop, événement budget_stop, pas de point d'étape", async () => {
    let n = 0;
    const agent = await agentWith(
      () => {
        n++;
        return callTool;
      },
      { maxSteps: 5, optimization: { budget: { enabled: true, maxIterations: 2 } } },
    );
    const r = await agent.handle("range", ui);
    expect(r).toMatch(/budget de cette demande.*2 itérations.*continue/);
    expect(n).toBe(2);
    expect(budgetStops()).toHaveLength(1);
    expect(budgetStops()[0]!.args).toMatchObject({ reason: "iterations" });
    expect(agent.exportHistory().some((m) => m.content.startsWith("(note automatique) Limite"))).toBe(false);
    expect(agent.exportHistory().at(-1)).toMatchObject({ role: "assistant", content: r });
  });

  it("stepsExhausted sans budget pour le point d'étape : budgetStop, pas la réponse de repli", async () => {
    let n = 0;
    const agent = await agentWith(
      () => {
        n++;
        return callTool;
      },
      // 3 étapes et 3 appels : le point d'étape (4e appel) est refusé par le budget.
      { maxSteps: 3, optimization: { budget: { enabled: true, maxLlmCalls: 3 } } },
    );
    const r = await agent.handle("range", ui);
    expect(n).toBe(3);
    expect(r).toMatch(/budget de cette demande.*3 appels.*continue/);
    expect(r).not.toMatch(/limite de 3 étapes/);
    expect(budgetStops()).toHaveLength(1);
    expect(budgetStops()[0]!.args).toMatchObject({ reason: "llm_calls" });
    const hist = agent.exportHistory();
    // La note « n'appelle plus d'outil » ne reste pas pour le « continue » ; la réponse finale est celle de budgetStop.
    expect(hist.some((m) => m.content.startsWith("(note automatique) Limite"))).toBe(false);
    expect(hist.at(-1)).toMatchObject({ role: "assistant", content: r });
    expect(agent.lastBudget).toMatchObject({ llmCalls: 3, iterations: 3 });
  });

  it("stepsExhausted avec routeur : un seul échec noté pour le modèle", async () => {
    const agent = await agentWith(() => callTool, {
      maxSteps: 2,
      optimization: { router: { enabled: true, light: "petit:1b" }, budget: { enabled: true, maxLlmCalls: 2 } },
    });
    inject(agent, fakeClient("petit:1b", () => callTool));
    expect(await agent.handle("merci", ui)).toMatch(/budget de cette demande/);
    expect(routerHistory.stats("conversation", "petit:1b")).toMatchObject({ ok: 0, fail: 1 });
  });
});

describe("Context Compiler dans le prompt", () => {
  const memory = (text: string) => ({ contextFor: () => text }) as unknown as Memory;

  it("désactivé : la mémoire est jointe telle quelle", async () => {
    const big = "Note : " + "souvenir ".repeat(3000);
    let sys = "";
    const agent = await agentWith((m) => ((sys = m[0]!.content), { role: "assistant", content: "ok" }), {}, { memory: memory(big) });
    await agent.handle("salut", ui);
    expect(sys).toContain(big);
  });

  it("activé : la mémoire trop longue est compressée sous le plafond, avec sa trace", async () => {
    const big = "Note : " + "souvenir ".repeat(3000);
    let sys = "";
    const agent = await agentWith(
      (m) => ((sys = m[0]!.content), { role: "assistant", content: "ok" }),
      { optimization: { context: { enabled: true, relevantMaxTokens: 200 } } },
      { memory: memory(big), liveNote: () => "Registre : tâche T-12 en cours." },
    );
    await agent.handle("salut", ui);
    expect(sys).not.toContain(big);
    expect(sys).toContain("Registre : tâche T-12 en cours.");
    expect(sys).toMatch(/omis de mémoire|résumé automatique de mémoire/);
    const t = agent.lastContextTrace;
    expect(t.find((x) => x.id === "memoire")).toMatchObject({ status: "compressed", source: "mémoire" });
    expect(t.find((x) => x.id === "travail")).toMatchObject({ status: "full" });
  });
});

describe("Model Router dans la boucle", () => {
  const routerCfg = { optimization: { router: { enabled: true, light: "petit:1b", strong: "fort:14b" } } };

  it("demande simple : modèle léger, sans changer le modèle de l'agent", async () => {
    let usedLight = 0;
    const agent = await agentWith(() => ({ role: "assistant", content: "standard" }), routerCfg);
    inject(agent, fakeClient("petit:1b", () => (usedLight++, { role: "assistant", content: "léger" })));
    expect(await agent.handle("merci", ui)).toBe("léger");
    expect(usedLight).toBe(1);
    expect(agent.model).toBe(ConfigSchema.parse({}).llm.model);
    expect(llmStats.records()[0]!.model).toBe("petit:1b");
    expect(routerHistory.stats("conversation", "petit:1b")).toMatchObject({ ok: 1, fail: 0 });
  });

  it("réponse insuffisante : escalade vers le palier suivant, échec noté dans l'historique", async () => {
    const seen: string[] = [];
    const agent = await agentWith(() => ({ role: "assistant", content: "réponse du standard" }), routerCfg);
    inject(agent, fakeClient("petit:1b", () => ({ role: "assistant", content: "" })));
    const r = await agent.handle("merci", { ...ui, progress: (m: string) => seen.push(m) });
    expect(r).toBe("réponse du standard");
    expect(seen.some((s) => /je passe au modèle/.test(s))).toBe(true);
    expect(routerHistory.stats("conversation", "petit:1b")).toMatchObject({ fail: 1 });
    // La réponse vide n'est pas restée dans l'historique.
    expect(agent.exportHistory().filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["réponse du standard"]);
  });

  it("escalades limitées par le budget (maxEscalations = 0 : pas d'escalade)", async () => {
    const agent = await agentWith(() => ({ role: "assistant", content: "standard" }), {
      optimization: { ...routerCfg.optimization, budget: { maxEscalations: 0 } },
    });
    inject(agent, fakeClient("petit:1b", () => ({ role: "assistant", content: "" })));
    expect(await agent.handle("merci", ui)).toBe("(pas de réponse)");
  });

  it("agent local : un modèle en ligne n'est jamais proposé (la mémoire ne quitte pas le PC)", async () => {
    let calls = 0;
    const agent = await agentWith(() => (calls++, { role: "assistant", content: "local" }), {
      optimization: { router: { enabled: true, light: "claude-api:haiku" } },
    });
    expect(await agent.handle("merci", ui)).toBe("local");
    expect(calls).toBe(1);
  });

  it("agent au modèle fixé par son profil : jamais routé", async () => {
    const agent = new Agent(parseConfig(routerCfg), [lister], { id: "dev", name: "Dev", model: "qwen3:8b" });
    await agent.refreshServices();
    (agent.client as unknown as { chat: unknown }).chat = async () => ({ role: "assistant", content: "fixé" });
    inject(agent, fakeClient("petit:1b", () => ({ role: "assistant", content: "léger" })));
    expect(await agent.handle("merci", ui)).toBe("fixé");
  });
});
