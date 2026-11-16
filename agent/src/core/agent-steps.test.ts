import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "./agent.js";
import { ConfigSchema, parseConfig } from "./config.js";
import type { ChatMessage } from "./llm.js";
import { defineTool, type Service } from "./types.js";

/** Service d'essai : un outil de lecture qui renvoie un long texte. */
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
      run: async () => "x".repeat(10_000),
    }),
  ],
};

const callTool = { role: "assistant", content: "", tool_calls: [{ function: { name: "lister", arguments: {} } }] };
const ui = { confirm: async () => true, progress: () => {} };

async function agentWith(chat: (m: ChatMessage[]) => unknown, cfg: object = {}) {
  const agent = new Agent(parseConfig(cfg), [lister]);
  await agent.refreshServices();
  (agent.client as unknown as { chat: unknown }).chat = async (m: ChatMessage[]) => chat(m);
  return agent;
}

describe("limites d'une demande", () => {
  it("25 étapes par défaut", () => {
    expect(ConfigSchema.parse({}).maxSteps).toBe(25);
  });

  it("le rognage de l'historique ne fait jamais oublier la demande en cours", async () => {
    let calls = 0;
    const seen: ChatMessage[][] = [];
    const agent = await agentWith(
      (m) => {
        seen.push(m);
        return calls++ < 20 ? callTool : { role: "assistant", content: "rangé" };
      },
      { historyMessages: 10, maxSteps: 30 },
    );
    expect(await agent.handle("range le dossier sons", ui)).toBe("rangé");
    for (const m of seen) expect(m.some((x) => x.role === "user" && x.content === "range le dossier sons")).toBe(true);
  });

  it("limite atteinte : point d'étape du modèle au lieu de jeter le travail", async () => {
    const agent = await agentWith((m) =>
      m.at(-1)?.content.startsWith("(note automatique) Limite") ? { role: "assistant", content: "Fait : 3 dossiers. Reste : 2." } : callTool,
      { maxSteps: 3 },
    );
    const r = await agent.handle("range", ui);
    expect(r).toContain("Fait : 3 dossiers");
    expect(r).toContain("continue");
  });

  it("limite atteinte et le modèle insiste pour appeler un outil : message de repli", async () => {
    const agent = await agentWith(() => callTool, { maxSteps: 2 });
    expect(await agent.handle("range", ui)).toMatch(/limite de 2 étapes.*continue/);
  });

  it("modèle local : résultat d'outil coupé à 4000 caractères", async () => {
    let n = 0;
    let tool: ChatMessage | undefined;
    const agent = await agentWith((m) => {
      tool = m.find((x) => x.role === "tool");
      return n++ === 0 ? callTool : { role: "assistant", content: "ok" };
    });
    await agent.handle("liste", ui);
    expect(tool!.content.length).toBeLessThan(4200);
  });
});
