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
