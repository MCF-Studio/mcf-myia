import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseConfig } from "./config.js";
import { OllamaClient, type ChatMessage } from "./llm.js";
import { makeTeamRoot } from "./team-runner.js";
import { parseTeam, TeamBudget } from "./teams.js";
import { defineTool, type AgentUI, type Service } from "./types.js";

const ui: AgentUI = { confirm: async () => true, progress: () => undefined };

/** Faux claude_delegate : compte les lancements. */
function fakeClaude(launched: string[]): Service {
  return {
    id: "claude",
    label: "Claude Code",
    available: async () => ({ ok: true }),
    tools: () => [
      defineTool({
        name: "claude_delegate",
        description: "Délègue à Claude Code.",
        schema: z.object({ task: z.string() }),
        risk: "read",
        preview: () => "",
        run: async (a) => {
          launched.push(a.task);
          return "fait par Claude";
        },
      }),
    ],
  };
}

const profiles = {
  chef: { id: "chef", name: "Chef", model: "qwen3:8b" },
  dev: { id: "dev", name: "Dev", model: "qwen3:4b" },
};

function team(withMember = true) {
  return parseTeam(
    { id: "t", name: "Studio", root: { id: "root", agentId: "chef", subagents: withMember ? [{ id: "n-dev", agentId: "dev" }] : [] } },
    new Set(Object.keys(profiles)),
  );
}

const proto = OllamaClient.prototype as unknown as { chat: unknown };
const original = proto.chat;
afterEach(() => {
  proto.chat = original;
});

const call = (name: string, args: object) => ({ role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] });

describe("équipe d'abord", () => {
  it("un chef ne peut pas déléguer à Claude Code avant d'avoir sollicité un membre, puis il peut", async () => {
    const launched: string[] = [];
    const t = team();
    const root = makeTeamRoot({ cfg: parseConfig({}), services: [fakeClaude(launched)], team: t, profileOf: (id) => profiles[id as "chef"], budget: new TeamBudget(t.maxCalls, t.maxDepth) });
    await root.refreshServices();
    const seen: ChatMessage[][] = [];
    const script = [
      call("claude_delegate", { task: "code le module" }), // refusé : équipe d'abord
      call("team_ask", { member: "Dev", task: "Code le module de sauvegarde du jeu." }),
      call("claude_delegate", { task: "relis l'architecture" }), // accepté : l'équipe a été sollicitée
      { role: "assistant", content: "Terminé." },
    ];
    proto.chat = async function (this: OllamaClient, messages: ChatMessage[]) {
      // Le membre (Dev) répond directement ; le chef suit le script.
      if (this.model === "qwen3:4b") return { role: "assistant", content: "module codé" };
      seen.push(messages);
      return script.shift();
    };
    expect(await root.handle("fais le module de sauvegarde", ui)).toBe("Terminé.");
    expect(launched).toEqual(["relis l'architecture"]);
    const history = JSON.stringify(root.exportHistory());
    expect(history).toContain("tu diriges une équipe");
    expect(history).toContain("module codé");
    // le prompt du chef met l'équipe en premier
    expect(seen[0]![0]!.content).toMatch(/ÉQUIPE D'ABORD/);
  });

  it("la règle repart à zéro à chaque demande", async () => {
    const launched: string[] = [];
    const t = team();
    const root = makeTeamRoot({ cfg: parseConfig({}), services: [fakeClaude(launched)], team: t, profileOf: (id) => profiles[id as "chef"], budget: new TeamBudget(t.maxCalls, t.maxDepth) });
    await root.refreshServices();
    const script = [
      call("team_ask", { member: "Dev", task: "Première tâche pour le dev." }),
      { role: "assistant", content: "ok 1" },
      call("claude_delegate", { task: "deuxième demande directe" }),
      { role: "assistant", content: "ok 2" },
    ];
    proto.chat = async function (this: OllamaClient) {
      if (this.model === "qwen3:4b") return { role: "assistant", content: "fait" };
      return script.shift();
    };
    await root.handle("demande 1", ui);
    await root.handle("demande 2", ui);
    expect(launched).toEqual([]);
  });

  it("un agent sans équipe (ou un membre sans sous-agent) délègue librement", async () => {
    const launched: string[] = [];
    const t = team(false);
    const root = makeTeamRoot({ cfg: parseConfig({}), services: [fakeClaude(launched)], team: t, profileOf: (id) => profiles[id as "chef"], budget: new TeamBudget(t.maxCalls, t.maxDepth) });
    await root.refreshServices();
    const script = [call("claude_delegate", { task: "direct" }), { role: "assistant", content: "ok" }];
    proto.chat = async () => script.shift();
    await root.handle("vas-y", ui);
    expect(launched).toEqual(["direct"]);
  });
});
