import { describe, expect, it } from "vitest";
import { UrlTrust } from "../core/urls.js";
import { shellTool } from "./shell.js";

describe.runIf(process.platform === "win32")("pc_shell (mode libre de Jarvis)", () => {
  const ctx = { ui: { confirm: async () => false, progress: () => undefined }, trust: new UrlTrust() };

  it("exécute une commande PowerShell et rend sa sortie", async () => {
    const t = shellTool();
    const out = await t.run(t.parse({ command: "Write-Output ('é' + (2+3))" }), ctx);
    expect(out).toContain("Code de retour : 0");
    expect(out).toContain("é5");
  }, 30_000);

  it("signale un échec avec son code", async () => {
    const t = shellTool();
    const out = await t.run(t.parse({ command: "exit 3" }), ctx);
    expect(out).toContain("Code de retour : 3");
  }, 30_000);
});
