import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { parseConfig } from "./config.js";
import { runSandboxed } from "./guild.js";
import type { ChatMessage } from "./llm.js";
import { chunkDoc, Memory } from "./memory.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myia-memoire-"));
fs.writeFileSync(
  path.join(dir, "01-studio.md"),
  "# MCF Studio\n\nPetit studio indépendant.\n\n## Équipe\n\n- **Joaquine** : co-fondateur et lead developer.\n\n## Sites\n\n- mcfstudio.fr : le site du studio.\n",
);
fs.writeFileSync(path.join(dir, "02-tribe.md"), "# StreamingTribe\n\nPlateforme de distribution de jeux vidéo, éditée par MCF Studio.\n");
fs.writeFileSync(path.join(dir, "image.png"), "pas du texte");

describe("mémoire", () => {
  it("liste les documents texte avec leur titre", () => {
    const m = new Memory([dir]);
    expect(m.list().map((d) => [d.name, d.title])).toEqual([
      ["01-studio.md", "MCF Studio"],
      ["02-tribe.md", "StreamingTribe"],
    ]);
  });

  it("découpe par intertitres", () => {
    const chunks = chunkDoc({ name: "x.md", title: "MCF Studio", text: fs.readFileSync(path.join(dir, "01-studio.md"), "utf8") });
    expect(chunks.map((c) => c.heading)).toEqual(["MCF Studio", "Équipe", "Sites"]);
  });

  it("trouve le bon passage, accents et casse ignorés", () => {
    const m = new Memory([dir]);
    const [best] = m.search("qui est le lead developper de l'equipe ? joaquine");
    expect(best).toMatchObject({ heading: "Équipe" });
    expect(m.search("plateforme de distribution")[0]).toMatchObject({ title: "StreamingTribe" });
    expect(m.search("recette de la tarte aux pommes")).toEqual([]);
  });

  it("lit un document par nom de fichier ou par titre", () => {
    const m = new Memory([dir]);
    expect(m.read("02-tribe")?.title).toBe("StreamingTribe");
    expect(m.read("MCF Studio")?.name).toBe("01-studio.md");
    expect(m.read("inconnu")).toBeUndefined();
  });

  it("joint l'index et les passages liés à la demande au prompt de l'agent", async () => {
    const seen: ChatMessage[][] = [];
    const agent = new Agent(parseConfig({}), [], undefined, { memory: new Memory([dir]) });
    (agent.client as unknown as { chat: unknown }).chat = async (messages: ChatMessage[]) => {
      seen.push(messages);
      return { role: "assistant", content: "ok" };
    };
    await agent.handle("Qui est Joaquine dans l'équipe ?", { confirm: async () => false, progress: () => {} });
    const system = seen[0]![0]!.content;
    expect(system).toContain("- MCF Studio (01-studio.md)");
    expect(system).toContain("co-fondateur et lead developer");
  });

  it("la Guilde (bac à sable) ne voit jamais la mémoire", async () => {
    const seen: ChatMessage[][] = [];
    const original = Agent.prototype.handle;
    // On observe le prompt envoyé au modèle par l'agent du bac à sable.
    const spy = async function (this: Agent, input: string, ui: never, signal?: AbortSignal) {
      (this.client as unknown as { chat: unknown }).chat = async (messages: ChatMessage[]) => {
        seen.push(messages);
        return { role: "assistant", content: "réponse" };
      };
      return original.call(this, input, ui, signal);
    };
    Agent.prototype.handle = spy as typeof original;
    try {
      const cfg = parseConfig({ memory: { folders: [dir] } });
      await runSandboxed(cfg, { id: "o", name: "Offre", description: "", tags: [], model: "qwen3:8b", instructions: "", enabled: true }, "Qui est Joaquine ?", 30);
    } finally {
      Agent.prototype.handle = original;
    }
    const system = seen[0]![0]!.content;
    expect(system).not.toContain("Mémoire");
    expect(system).not.toContain("lead developer");
  });
});
