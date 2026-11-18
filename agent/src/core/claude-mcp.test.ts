import { describe, expect, it } from "vitest";
import { listMcpServers } from "./claude-mcp";

describe("listMcpServers", () => {
  it("rend les noms des portées utilisateur et locale, jamais la configuration", () => {
    const r = listMcpServers({
      mcpServers: { blender: { command: "uvx", env: { TOKEN: "secret" } }, playwright: { command: "npx" } },
      projects: { "G:/Jeu": { mcpServers: { godot: { command: "x" }, blender: { command: "y" } } }, "G:/Vide": {} },
    });
    expect(r).toEqual([
      { name: "blender", scope: "utilisateur" },
      { name: "godot", scope: "local", projects: ["G:/Jeu"] },
      { name: "playwright", scope: "utilisateur" },
    ]);
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("ignore les noms invalides et les fichiers mal formés", () => {
    expect(listMcpServers({ mcpServers: { "a b": {}, "ok-1": {} } })).toEqual([{ name: "ok-1", scope: "utilisateur" }]);
    expect(listMcpServers(null)).toEqual([]);
    expect(listMcpServers({ mcpServers: [], projects: "x" })).toEqual([]);
  });
});

describe("importableServers", () => {
  it("reprend les serveurs lancés par une commande, pas les serveurs distants", async () => {
    const { importableServers, mcpSecretName } = await import("./claude-mcp");
    const r = importableServers({
      mcpServers: {
        blender: { command: "uvx", args: ["blender-mcp"] },
        site: { type: "http", url: "https://x" },
        mcfstudio: { type: "stdio", command: "node", args: ["s.js"], env: { MCF_TOKEN: "abc", "bad key": "x" } },
      },
    });
    expect(r.map((s) => s.name)).toEqual(["blender", "mcfstudio"]);
    expect(r[1]!.env).toEqual({ MCF_TOKEN: "abc" });
    expect(mcpSecretName("mcf-studio", "MCF_TOKEN")).toBe("mcp_mcf_studio_mcf_token");
  });
});
