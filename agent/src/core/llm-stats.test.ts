import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LlmStats, type LlmCallRecord } from "./llm-stats.js";

const call = (r: Partial<LlmCallRecord> = {}): Omit<LlmCallRecord, "ts"> => ({
  agent: "myia",
  task: "t1",
  model: "qwen3:8b",
  engine: "ollama",
  durationMs: 100,
  ok: true,
  tools: [],
  estimatedInput: 1000,
  estimatedOutput: 50,
  ...r,
});

describe("statistiques des appels au modèle", () => {
  it("agrège par agent, par demande et par modèle", () => {
    const s = new LlmStats();
    s.record(call({ tools: ["lister", "lire"] }));
    s.record(call({ durationMs: 300, tools: ["lister"] }));
    s.record(call({ agent: "dev", task: "t2", model: "claude-api:sonnet", engine: "claude-api", billed: { input: 200, output: 40, cacheRead: 800, cacheWrite: 0 } }));
    s.record(call({ agent: "dev", task: "t2", model: "claude-api:sonnet", engine: "claude-api", ok: false, error: "x".repeat(1000), estimatedOutput: 0 }));

    const byAgent = s.aggregate("agent");
    expect(Object.keys(byAgent).sort()).toEqual(["dev", "myia"]);
    expect(byAgent.myia).toMatchObject({ calls: 2, errors: 0, inputTokens: 2000, outputTokens: 100, durationMs: 400, avgDurationMs: 200, billedCalls: 0 });
    expect(byAgent.myia!.tools).toEqual({ lister: 2, lire: 1 });

    const dev = s.aggregate("task").t2!;
    expect(dev.calls).toBe(2);
    expect(dev.errors).toBe(1);
    // Appel facturé : jetons facturés (cache compris) ; appel en échec sans facture : estimation.
    expect(dev.billedInput).toBe(1000);
    expect(dev.billedOutput).toBe(40);
    expect(dev.billedTotal).toBe(1040);
    expect(dev.inputTokens).toBe(1000 + 1000);
    expect(dev.estimatedInput).toBe(2000);

    expect(Object.keys(s.aggregate("model")).sort()).toEqual(["claude-api:sonnet", "qwen3:8b"]);
    expect(s.totals().calls).toBe(4);
    expect(s.totals({ agent: "dev" }).calls).toBe(2);
    expect(s.records({ task: "t2" })[1]!.error!.length).toBe(300);
  });

  it("garde seulement les derniers appels, et rien quand c'est désactivé", () => {
    const s = new LlmStats({ enabled: true, maxRecords: 3 });
    for (let i = 0; i < 5; i++) s.record(call({ task: `t${i}` }));
    expect(s.records().map((r) => r.task)).toEqual(["t2", "t3", "t4"]);
    s.configure({ enabled: false });
    s.record(call({ task: "t9" }));
    expect(s.records()).toHaveLength(3);
    s.clear();
    expect(s.totals().calls).toBe(0);
  });

  it("les enregistrements rendus sont des copies", () => {
    const s = new LlmStats();
    s.record(call({ tools: ["a"] }));
    s.records()[0]!.tools.push("b");
    expect(s.records()[0]!.tools).toEqual(["a"]);
  });

  it("journal JSONL optionnel, sans contenu des échanges", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myia-stats-"));
    const s = new LlmStats({ enabled: true, maxRecords: 10, journalDir: dir });
    s.record(call({ ts: "2026-11-19T10:00:00.000Z" }));
    const lines = fs.readFileSync(path.join(dir, "2026-11.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ agent: "myia", model: "qwen3:8b", estimatedInput: 1000 });
    expect(Object.keys(rec)).not.toContain("content");
  });
});
