import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { CLAUDE_MODELS, fallbackFor, heuristicTriage, modelForDifficulty, parseClaudeAccount, triageTask } from "./claude-coach.js";
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

  it("Fable est proposé mais jamais choisi automatiquement", () => {
    expect(CLAUDE_MODELS).toContain("fable");
    expect([1, 2, 3, 4, 5].map(modelForDifficulty)).not.toContain("fable");
  });

  it("la liste fermée du Rust (pty.rs) est la même que celle du cœur", () => {
    const rs = fs.readFileSync(new URL("../../../app/src-tauri/src/pty.rs", import.meta.url), "utf8");
    const list = /if !\[([^\]]+)\]\.contains\(&m\.as_str\(\)\)/.exec(rs)?.[1];
    expect(list?.split(",").map((s) => s.trim().replace(/"/g, ""))).toEqual([...CLAUDE_MODELS]);
  });

  it("repli : seulement pour Fable, vers Opus", () => {
    expect(fallbackFor("fable")).toBe("opus");
    expect([fallbackFor("opus"), fallbackFor("haiku"), fallbackFor(undefined)]).toEqual([undefined, undefined, undefined]);
  });

  it("compte Claude : ne garde que l'abonnement, jamais l'e-mail", () => {
    const a = parseClaudeAccount(
      '{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.fr", "orgId": "x", "subscriptionType": "max", "planTier": "max_5x"}',
    );
    expect(a).toEqual({ loggedIn: true, subscription: "max", tier: "max_5x", authMethod: "claude.ai", expiresAt: undefined });
    expect(parseClaudeAccount('{"loggedIn": true, "loginExpiresAt": "2026-11-26T17:41:09.072Z"}').expiresAt).toBe("2026-11-26T17:41:09.072Z");
    expect(parseClaudeAccount('{"loggedIn": true, "loginExpiresAt": "demain"}').expiresAt).toBeUndefined();
    expect(parseClaudeAccount("pas du json")).toEqual({ loggedIn: false });
    expect(parseClaudeAccount('{"loggedIn": true, "subscriptionType": "<script>"}').subscription).toBeUndefined();
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
