import { describe, expect, it } from "vitest";
import { heuristicTriage, modelForDifficulty, triageTask } from "./claude-coach.js";
import type { OllamaClient } from "./llm.js";
import { AgentProfileSchema } from "./profiles.js";

const fakeLlm = (content: string) => ({ chat: async () => ({ role: "assistant", content }) }) as unknown as OllamaClient;

describe("coach des sessions Claude", () => {
  it("difficulté → modèle", () => {
    expect([1, 2, 3, 4, 5].map(modelForDifficulty)).toEqual(["haiku", "haiku", "sonnet", "opus", "opus"]);
  });

  it("utilise la réponse du modèle local quand elle est valide", async () => {
    const t = await triageTask(fakeLlm('{"difficulty": 4, "reason": "bug intermittent"}'), "corrige la désynchro réseau");
    expect(t).toMatchObject({ model: "opus", difficulty: 4, by: "local" });
  });

  it("bascule sur l'heuristique si le modèle local répond n'importe quoi", async () => {
    const t = await triageTask(fakeLlm("je pense que c'est facile"), "Renomme la variable hp en health");
    expect(t.by).toBe("heuristique");
    expect(t.model).toBe("haiku");
  });

  it("heuristique : architecture et sécurité vont vers Opus", () => {
    expect(heuristicTriage("Conçois l'architecture du serveur et vérifie la sécurité des sessions").model).toBe("opus");
  });
});

describe("photo d'agent", () => {
  const base = { id: "forgeron", name: "Forgeron" };
  it("accepte une image raster en data URL", () => {
    expect(AgentProfileSchema.safeParse({ ...base, avatar: "data:image/webp;base64,UklGRg==" }).success).toBe(true);
  });
  it("refuse le SVG (script possible), les URL et le HTML", () => {
    for (const avatar of [
      "data:image/svg+xml;base64,PHN2Zz4=",
      "https://evil.example/a.png",
      'data:image/png;base64,AAAA"><script>alert(1)</script>',
    ]) {
      expect(AgentProfileSchema.safeParse({ ...base, avatar }).success, avatar).toBe(false);
    }
  });
});
