import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { completeConfigFile, fillMissing } from "./config-file.js";
import { configTemplate, ConfigSchema, parseConfig } from "./config.js";

const tmp = (content: unknown) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "myia-cfg-")), "agent.json");
  fs.writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content));
  return f;
};
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

describe("config/agent.json complet (toutes les options, vides si non remplies)", () => {
  it("le modèle complet est valide et donne exactement les valeurs par défaut", () => {
    const tpl = configTemplate();
    const { site: _site, ...defaults } = ConfigSchema.parse({});
    const { site: _s2, ...parsed } = parseConfig(tpl);
    expect(parsed).toEqual(defaults);
    expect(tpl).not.toHaveProperty("site");
  });

  it("vide = valeur par défaut, même pour un champ qui refuse une chaîne vide", () => {
    const c = parseConfig({ toolbox: { dir: "" }, llm: { gpu: { device: "", ratios: [] }, llamacpp: { backend: "" } }, claude: { defaultAllowedTools: [] } });
    expect(c.toolbox.dir).toBeUndefined();
    expect(c.llm.gpu.device).toBeUndefined();
    expect(c.llm.gpu.ratios).toBeUndefined();
    expect(c.claude.defaultAllowedTools).toContain("Read");
    // Une destination ou un salon vide n'existe pas encore.
    expect(parseConfig({ discord: { channels: { annonces: "" } } }).discord.channels).toEqual({});
    // Les serveurs MCP gardent leurs valeurs telles quelles.
    expect(parseConfig({ mcpServers: { x: { command: "a", args: [""], env: { K: "" } } } }).mcpServers.x!.env).toEqual({ K: "" });
  });

  it("complète le fichier sans rien modifier de ce que l'utilisateur a écrit", () => {
    const f = tmp({ user: { name: "Aroun" }, telegram: { destinations: { a: "-1" } }, llm: { model: "Qwen3-8B-Q4_K_M", engine: "llamacpp" }, inconnu: 1 });
    expect(completeConfigFile(f)).toBe(true);
    const out = read(f);
    expect(Object.keys(out)[0]).toBe("_aide");
    expect(out.user.name).toBe("Aroun");
    expect(out.telegram.destinations).toEqual({ a: "-1" });
    expect(out.llm.model).toBe("Qwen3-8B-Q4_K_M");
    expect(out.llm.engine).toBe("llamacpp");
    expect(out.inconnu).toBe(1);
    expect(out.discord).toEqual({ channels: {} });
    expect(out.godot.projectsRoot).toBe("");
    expect(out.apiProviders.maxTokens).toBe(8192);
    // Deuxième passage : rien à ajouter.
    expect(completeConfigFile(f)).toBe(false);
    expect(parseConfig(read(f)).llm.model).toBe("Qwen3-8B-Q4_K_M");
  });

  it("un fichier invalide ou illisible n'est jamais touché", () => {
    const bad = tmp("{ pas du json");
    expect(completeConfigFile(bad)).toBe(false);
    expect(fs.readFileSync(bad, "utf8")).toBe("{ pas du json");
    const invalid = tmp({ llm: { baseUrl: "http://exemple.com" } });
    expect(completeConfigFile(invalid)).toBe(false);
    expect(read(invalid)).toEqual({ llm: { baseUrl: "http://exemple.com" } });
  });

  it("fillMissing n'entre pas dans les listes et ne remplace pas une valeur", () => {
    const raw: Record<string, any> = { a: [1], b: { c: 2 } };
    fillMissing(raw, { a: [], b: { c: 3, d: "" }, e: {} });
    expect(raw).toEqual({ a: [1], b: { c: 2, d: "" }, e: {} });
  });
});

describe("identifiants longs écrits sans guillemets", () => {
  it("passent en texte, chiffres exacts, sans toucher aux chaînes ni aux petits nombres", async () => {
    const { quoteLongIntegers, parseConfig } = await import("./config.js");
    const raw = '{"discord":{"channels":{"maj":1566995561155133470}},"telegram":{"destinations":{"moi":-1003782138337123}},"note":"id 12345678901234567890 dans un texte","web":{"maxPageBytes":2000000},"x":1.5e3}';
    const fixed = quoteLongIntegers(raw);
    const json = JSON.parse(fixed);
    expect(json.discord.channels.maj).toBe("1566995561155133470");
    expect(json.telegram.destinations.moi).toBe("-1003782138337123");
    expect(json.note).toBe("id 12345678901234567890 dans un texte");
    expect(json.web.maxPageBytes).toBe(2000000);
    expect(json.x).toBe(1500);
    expect(parseConfig(JSON.parse(quoteLongIntegers('{"discord":{"channels":{"maj":1566995561155133470}}}'))).discord.channels.maj).toBe("1566995561155133470");
    expect(quoteLongIntegers('{"a":"\\"1234567890123456789\\""}')).toBe('{"a":"\\"1234567890123456789\\""}');
  });
});
