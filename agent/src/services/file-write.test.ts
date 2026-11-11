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

  it("refuse les contournements Windows : flux alternatif, point ou espace final, nom court, nom réservé", () => {
    for (const n of ["notes.txt:cache.exe", "run.bat.", "run.bat ", "CONFIG~1.md", "con.txt", "dossier./a.md"]) {
      expect(() => resolveWritable(cfg, n), JSON.stringify(n)).toThrow();
    }
  });

  it("liste d'autorisation : texte seulement ; le code passe par Claude Code", () => {
    for (const n of ["script.py", "main.gd", "app.js", "page.svg"]) expect(() => resolveWritable(cfg, n), n).toThrow(/format texte autorisé/);
    for (const n of ["notes.txt", "doc.md", "data.csv", "conf.yaml", "page.html"]) expect(() => resolveWritable(cfg, n), n).not.toThrow();
  });

  it("refuse les fichiers qui pilotent d'autres outils (agents IA, npm, Windows)", () => {
    for (const n of ["CLAUDE.md", "projet/AGENTS.md", ".mcp.json", "desktop.ini", "projet/package.json"]) {
      expect(() => resolveWritable(cfg, n), n).toThrow(/pilote un autre outil|format texte/);
    }
  });

  it("la lecture garde les contrôles de chemin mais accepte tout nom", () => {
    expect(() => resolveWritable(cfg, "projet/package.json", { read: true })).not.toThrow();
    expect(() => resolveWritable(cfg, String.raw`\\evil.example\share\x.txt`, { read: true })).toThrow(/réseau/);
  });
});
