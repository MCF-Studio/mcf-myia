import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "./agent.js";
import { ConfigSchema, parseConfig } from "./config.js";
import type { ChatMessage } from "./llm.js";
import { defineTool, type Service } from "./types.js";

/** Service d'essai : un outil `external` qui compte ses exécutions. */
function fakeService(runs: string[]): Service {
  return {
    id: "essai",
    label: "Essai",
    available: async () => ({ ok: true }),
    tools: () => [
      defineTool({
        name: "envoyer",
        description: "envoie un message",
        risk: "external",
        schema: z.object({ texte: z.string() }),
        preview: (a) => a.texte,
        run: async (a) => {
          runs.push(a.texte);
          return "envoyé";
        },
      }),
    ],
  };
}

async function runOnce(bypass: boolean) {
  const runs: string[] = [];
  const confirms: string[] = [];
  const progress: string[] = [];
  const agent = new Agent(parseConfig({ agents: { bypassConfirmations: bypass } }), [fakeService(runs)]);
  await agent.refreshServices();
  let step = 0;
  (agent.client as unknown as { chat: unknown }).chat = async (_m: ChatMessage[]) =>
    step++ === 0
      ? { role: "assistant", content: "", tool_calls: [{ function: { name: "envoyer", arguments: { texte: "salut" } } }] }
      : { role: "assistant", content: "fait" };
  await agent.handle("envoie salut", {
    confirm: async (t) => {
      confirms.push(t);
      return false;
    },
    progress: (m) => void progress.push(m),
  });
  return { runs, confirms, progress };
}

describe("mode bypass des agents", () => {
  it("désactivé par défaut", () => {
    expect(ConfigSchema.parse({}).agents.bypassConfirmations).toBe(false);
  });

  it("sans bypass : la confirmation est demandée et un refus bloque l'action", async () => {
    const r = await runOnce(false);
    expect(r.confirms).toHaveLength(1);
    expect(r.runs).toEqual([]);
  });

  it("avec bypass : exécuté sans confirmation, mais signalé", async () => {
    const r = await runOnce(true);
    expect(r.confirms).toEqual([]);
    expect(r.runs).toEqual(["salut"]);
    expect(r.progress.some((m) => m.includes("Mode bypass"))).toBe(true);
  });
});

describe("mode libre (Jarvis)", () => {
  it("exécute sans confirmation et dit au modèle qu'il a un terminal", async () => {
    const runs: string[] = [];
    const confirms: string[] = [];
    const agent = new Agent(parseConfig({}), [fakeService(runs)], undefined, { free: true, voice: true });
    await agent.refreshServices();
    let step = 0;
    let system = "";
    (agent.client as unknown as { chat: unknown }).chat = async (m: ChatMessage[]) => {
      system = m[0]!.content;
      return step++ === 0
        ? { role: "assistant", content: "", tool_calls: [{ function: { name: "envoyer", arguments: { texte: "salut" } } }] }
        : { role: "assistant", content: "fait" };
    };
    await agent.handle("envoie salut", { confirm: async (t) => (confirms.push(t), false), progress: () => undefined });
    expect(confirms).toEqual([]);
    expect(runs).toEqual(["salut"]);
    expect(system).toContain("MODE LIBRE");
    expect(system).not.toContain("tu n'as pas de terminal");
  });
});
