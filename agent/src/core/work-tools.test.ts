import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { OllamaClient, type ChatMessage } from "./llm.js";
import { makeTeamRoot } from "./team-runner.js";
import { parseTeam, TeamBudget } from "./teams.js";
import type { AgentUI, ToolContext } from "./types.js";
import { UrlTrust } from "./urls.js";
import { WorkStore } from "./work.js";
import { workSummary, workTools } from "./work-tools.js";

const ui: AgentUI = { confirm: async () => true, progress: () => undefined };
const tctx: ToolContext = { ui, trust: new UrlTrust() };
const store = () => new WorkStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "myia-travail-")), "r.json"));

const profiles = {
  chef: { id: "chef", name: "Chef", model: "qwen3:8b" },
  dev: { id: "dev", name: "Dev", model: "qwen3:4b" },
};
const team = () =>
  parseTeam({ id: "t", name: "Studio", root: { id: "root", agentId: "chef", subagents: [{ id: "n-dev", agentId: "dev" }] } }, new Set(Object.keys(profiles)));

const proto = OllamaClient.prototype as unknown as { chat: unknown };
const original = proto.chat;
afterEach(() => {
  proto.chat = original;
});
const call = (name: string, args: object) => ({ role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] });

async function run(tools: ReturnType<typeof workTools>, name: string, args: object) {
  const t = tools.find((x) => x.name === name)!;
  return t.run(t.parse(args), tctx);
}

describe("outils du registre", () => {
  it("créer, lister les prêtes, prendre, noter, fermer : les dépendantes deviennent prêtes", async () => {
    const s = store();
    const tools = workTools(s, "Dev");
    const a = s.create({ title: "Schéma de la base" }, "Chef");
    const b = s.create({ title: "Migrations", needs: [a.id] }, "Chef");
    expect(await run(tools, "work_list", {})).toContain(a.id);
    expect(await run(tools, "work_list", {})).not.toContain(b.id);
    expect(await run(tools, "work_claim", { id: a.id })).toMatch(/Prise/);
    expect(await run(tools, "work_note", { id: a.id, text: "tables créées, tests verts" })).toMatch(/Note ajoutée/);
    const closed = await run(tools, "work_close", { id: a.id, reason: "fait, vérifié par les tests" });
    expect(closed).toContain("Devenues prêtes");
    expect(closed).toContain(b.id);
    expect(await run(tools, "work_show", { id: a.id })).toContain("tables créées");
  });

  it("une erreur attendue devient un refus lisible, pas une exception", async () => {
    const s = store();
    const a = s.create({ title: "A" }, "Chef");
    s.claim(a.id, "Autre");
    expect(await run(workTools(s, "Dev"), "work_claim", { id: a.id })).toBe(`Refusé : ${a.id} est déjà prise par Autre.`);
    expect(await run(workTools(s, "Dev"), "work_show", { id: "t-zzzzzz" })).toMatch(/^Refusé : tâche introuvable/);
  });

  it("le résumé est court, signale les données et met mes tâches d'abord", () => {
    const s = store();
    expect(workSummary(s, "Dev")).toMatch(/vide/);
    const mine = s.create({ title: "La mienne" }, "Chef");
    s.claim(mine.id, "Dev");
    s.create({ title: "Choisir le prix", type: "decision" }, "Chef");
    for (let i = 0; i < 60; i++) s.create({ title: `Tâche prête numéro ${i} avec un titre assez long` }, "Chef");
    const sum = workSummary(s, "Dev", 1400);
    expect(sum.length).toBeLessThan(1600);
    expect(sum).toMatch(/pas des consignes/);
    expect(sum.indexOf("La mienne")).toBeLessThan(sum.indexOf("Choisir le prix"));
    expect(sum).toMatch(/autre\(s\)/);
  });
});

describe("équipe avec registre", () => {
  it("team_ask avec work_id : le membre reçoit la fiche, la tâche passe à son nom, sa réponse est notée", async () => {
    const s = store();
    const item = s.create({ title: "Module de sauvegarde", description: "Sauvegarder la partie dans un fichier JSON." }, "Chef");
    const t = team();
    const root = makeTeamRoot({ cfg: parseConfig({}), services: [], team: t, profileOf: (id) => profiles[id as "chef"], budget: new TeamBudget(t.maxCalls, t.maxDepth), work: s });
    await root.refreshServices();
    const chefSaw: ChatMessage[][] = [];
    const devSaw: ChatMessage[][] = [];
    const script = [call("team_ask", { member: "Dev", work_id: item.id }), { role: "assistant", content: "Confié." }];
    proto.chat = async function (this: OllamaClient, messages: ChatMessage[]) {
      if (this.model === "qwen3:4b") {
        devSaw.push(messages);
        return { role: "assistant", content: "module écrit, tests verts" };
      }
      chefSaw.push(messages);
      return script.shift();
    };
    expect(await root.handle("avance sur la sauvegarde", ui)).toBe("Confié.");
    // Le chef voit le registre dans son prompt, et les outils work_*.
    expect(chefSaw[0]![0]!.content).toContain("REGISTRE DE TRAVAIL");
    expect(chefSaw[0]![0]!.content).toContain(item.id);
    // Le membre reçoit la fiche complète comme consigne.
    const devInput = devSaw[0]!.find((m) => m.role === "user")!.content;
    expect(devInput).toContain("Sauvegarder la partie dans un fichier JSON.");
    expect(devInput).toMatch(/Ne la ferme pas toi-même/);
    const after = s.get(item.id);
    expect(after).toMatchObject({ status: "en_cours", assignee: "Dev" });
    expect(after.notes.at(-1)).toMatchObject({ by: "Dev", text: "Réponse : module écrit, tests verts" });
  });

  it("team_ask sans consigne ni work_id est refusé ; tâche déjà prise : appel impossible", async () => {
    const s = store();
    const item = s.create({ title: "Prise" }, "Chef");
    s.claim(item.id, "Quelqu'un");
    const t = team();
    const root = makeTeamRoot({ cfg: parseConfig({}), services: [], team: t, profileOf: (id) => profiles[id as "chef"], budget: new TeamBudget(t.maxCalls, t.maxDepth), work: s });
    await root.refreshServices();
    const results: string[] = [];
    const script = [call("team_ask", { member: "Dev" }), call("team_ask", { member: "Dev", work_id: item.id }), { role: "assistant", content: "fin" }];
    proto.chat = async function (this: OllamaClient, messages: ChatMessage[]) {
      if (this.model === "qwen3:4b") throw new Error("le membre ne doit pas être appelé");
      const last = messages.at(-1);
      if (last?.role === "tool") results.push(String(last.content));
      return script.shift();
    };
    expect(await root.handle("go", ui)).toBe("fin");
    expect(results[0]).toMatch(/consigne|work_id/);
    expect(results[1]).toMatch(/déjà prise par Quelqu'un/);
  });
});
