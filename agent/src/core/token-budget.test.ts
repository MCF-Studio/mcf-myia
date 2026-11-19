import { describe, expect, it } from "vitest";
import { ConfigSchema } from "./config.js";
import {
  billedTotal,
  budgetLimits,
  estimateReplyTokens,
  estimateRequestTokens,
  estimateTokens,
  TokenBudget,
  type BudgetLimits,
} from "./token-budget.js";

const limits = (l: Partial<BudgetLimits> = {}): BudgetLimits => ({
  maxTokens: 0,
  maxIterations: 25,
  maxLlmCalls: 26,
  timeoutMs: 0,
  reserveForOutput: 0,
  maxEscalations: 2,
  ...l,
});

describe("estimation des jetons", () => {
  it("déterministe, prudente, nulle pour un texte vide", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("x".repeat(35))).toBe(10);
    expect(estimateTokens("abc")).toBe(1);
    const msgs = [{ role: "user" as const, content: "x".repeat(70) }];
    expect(estimateRequestTokens(msgs)).toBe(4 + 20);
    const tools = [{ type: "function" as const, function: { name: "a", description: "b", parameters: {} } }];
    expect(estimateRequestTokens(msgs, tools)).toBeGreaterThan(24);
    expect(estimateReplyTokens({ content: "", tool_calls: [{ function: { name: "lister", arguments: {} } }] })).toBeGreaterThan(0);
  });

  it("le total facturé compte le cache, lu ou écrit", () => {
    expect(billedTotal({ input: 10, output: 5, cacheRead: 100, cacheWrite: 20 })).toBe(135);
  });
});

describe("limites par défaut", () => {
  it("alignées sur maxSteps (25) : 25 itérations, 26 appels, rien d'autre de limité", () => {
    const l = budgetLimits(ConfigSchema.parse({}));
    expect(l).toEqual({ maxTokens: 0, maxIterations: 25, maxLlmCalls: 26, timeoutMs: 0, reserveForOutput: 2000, maxEscalations: 2 });
    expect(budgetLimits(ConfigSchema.parse({ maxSteps: 10 })).maxIterations).toBe(10);
    expect(budgetLimits(ConfigSchema.parse({ optimization: { budget: { maxIterations: 4, maxLlmCalls: 3, timeoutSeconds: 60 } } }))).toMatchObject({
      maxIterations: 4,
      maxLlmCalls: 3,
      timeoutMs: 60_000,
    });
  });

  it("désactivé par défaut", () => {
    expect(ConfigSchema.parse({}).optimization.budget.enabled).toBe(false);
  });
});

describe("TokenBudget", () => {
  it("itérations : contrôlées avant chaque tour", () => {
    const b = new TokenBudget(limits({ maxIterations: 2 }));
    expect(b.beforeIteration().ok).toBe(true);
    expect(b.beforeIteration().ok).toBe(true);
    const c = b.beforeIteration();
    expect(c).toMatchObject({ ok: false, reason: "iterations" });
    expect(b.snapshot().iterations).toBe(2);
  });

  it("appels : contrôlés avant chaque appel", () => {
    const b = new TokenBudget(limits({ maxLlmCalls: 1 }));
    expect(b.beforeCall(10).ok).toBe(true);
    expect(b.beforeCall(10)).toMatchObject({ ok: false, reason: "llm_calls" });
  });

  it("jetons : l'appel est refusé s'il ne reste pas l'entrée estimée + la réserve de sortie", () => {
    const b = new TokenBudget(limits({ maxTokens: 1000, reserveForOutput: 300 }));
    expect(b.beforeCall(600).ok).toBe(true);
    b.afterResponse({ estimatedInput: 600, estimatedOutput: 50 });
    expect(b.snapshot().accountedTokens).toBe(650);
    const c = b.beforeCall(100);
    expect(c).toMatchObject({ ok: false, reason: "tokens" });
    expect(b.snapshot().llmCalls).toBe(1);
  });

  it("facturé ≠ estimé : le budget décompte le facturé quand il est connu", () => {
    const b = new TokenBudget(limits({ maxTokens: 10_000 }));
    b.beforeCall(500);
    b.afterResponse({ estimatedInput: 500, estimatedOutput: 100, billed: { input: 200, output: 80, cacheRead: 1000, cacheWrite: 0 } });
    b.beforeCall(500);
    b.afterResponse({ estimatedInput: 500, estimatedOutput: 100 });
    const s = b.snapshot();
    expect(s.estimatedTokens).toBe(1200);
    expect(s.billedTokens).toBe(1280);
    expect(s.billedCalls).toBe(1);
    expect(s.accountedTokens).toBe(1280 + 600);
    expect(s.remainingTokens).toBe(10_000 - 1880);
  });

  it("après une réponse : signale le dépassement ; l'itération suivante est refusée", () => {
    const b = new TokenBudget(limits({ maxTokens: 100 }));
    expect(b.beforeIteration().ok).toBe(true);
    expect(b.afterResponse({ estimatedInput: 90, estimatedOutput: 20 })).toMatchObject({ ok: false, reason: "tokens" });
    expect(b.beforeIteration()).toMatchObject({ ok: false, reason: "tokens" });
  });

  it("durée maximale", () => {
    let t = 0;
    const b = new TokenBudget(limits({ timeoutMs: 1000 }), () => t);
    expect(b.beforeIteration().ok).toBe(true);
    t = 1000;
    expect(b.beforeCall(1)).toMatchObject({ ok: false, reason: "timeout" });
    expect(b.beforeIteration()).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("escalades limitées", () => {
    const b = new TokenBudget(limits({ maxEscalations: 1 }));
    expect(b.canEscalate()).toBe(true);
    b.recordEscalation();
    expect(b.canEscalate()).toBe(false);
  });

  it("sans limite de jetons : reste infini", () => {
    expect(new TokenBudget(limits()).snapshot().remainingTokens).toBe(Infinity);
  });
});
