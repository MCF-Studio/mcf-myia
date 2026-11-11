import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { needsConfirmation } from "../core/agent.js";
import { parseConfig } from "../core/config.js";
import { defaultWriteDir, fileWriteService, resolveWritable } from "./file-write.js";

const cfg = parseConfig({});
const tool = fileWriteService(cfg).tools().find((t) => t.name === "file_write")!;
const home = os.homedir();

describe("écriture de fichiers", () => {
  it("un simple nom va dans Documents\\MyIA", () => {
    expect(resolveWritable(cfg, "notes.md")).toBe(path.join(defaultWriteDir(), "notes.md"));
  });

  it("accepte les dossiers de l'utilisateur", () => {
    expect(() => resolveWritable(cfg, path.join(home, "Desktop", "liste.txt"))).not.toThrow();
  });

  it("refuse hors des dossiers de l'utilisateur", () => {
    const outside = process.platform === "win32" ? String.raw`C:\Windows\Temp\x.txt` : "/etc/x.txt";
    expect(() => resolveWritable(cfg, outside)).toThrow(/hors de tes dossiers|chemin complet/);
    expect(() => resolveWritable(cfg, path.join(home, "AppData", "Roaming", "x.txt"))).toThrow(/hors de tes dossiers/);
    expect(() => resolveWritable(cfg, "../../AppData/x.txt")).toThrow(/hors de tes dossiers/);
  });

  it("refuse les exécutables, scripts et fichiers sans extension", () => {
    for (const n of ["run.bat", "x.ps1", "a.exe", "l.lnk", "s.vbs", "h.hta", "Makefile"]) {
      expect(() => resolveWritable(cfg, n), n).toThrow();
    }
  });

  it("refuse les dossiers qui exécutent du code automatiquement", () => {
    for (const n of [".git/hooks/pre-commit.txt", "projet/.vscode/tasks.json", "projet/.claude/settings.json", "p/.github/workflows/ci.yml"]) {
      expect(() => resolveWritable(cfg, n), n).toThrow(/exécuter du code/);
    }
  });

  it("refuse les chemins réseau", () => {
    expect(() => resolveWritable(cfg, String.raw`\\evil.example\share\x.txt`)).toThrow(/réseau/);
  });

  it("nouveau fichier dans Documents\\MyIA : sans confirmation ; remplacer ou écrire ailleurs : confirmation", () => {
    const parse = (raw: object) => tool.parse(raw);
    expect(needsConfirmation(tool, undefined, cfg, parse({ path: "nouveau-test-xyz.md", content: "a" }))).toBe(false);
    expect(needsConfirmation(tool, undefined, cfg, parse({ path: "nouveau-test-xyz.md", content: "a", mode: "overwrite" }))).toBe(true);
    expect(needsConfirmation(tool, undefined, cfg, parse({ path: path.join(home, "Desktop", "x.md"), content: "a" }))).toBe(true);
  });
});
