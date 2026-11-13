import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWritable } from "../services/file-write.js";
import { accessRoots, checkWorkspace, isSensitive, usableWorkspace } from "./access.js";
import { ConfigSchema } from "./config.js";
import { paths } from "./paths.js";

// Chemin long réel : sur certaines machines (CI), le dossier temporaire a un nom court Windows (RUNNER~1) que
// resolveWritable refuse à juste titre.
const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myia-access-")));

describe("accès des agents aux fichiers", () => {
  it("les dossiers de mémoire sont lisibles par file_read", () => {
    const mem = tmp();
    fs.writeFileSync(path.join(mem, "studio.md"), "# Studio");
    const cfg = ConfigSchema.parse({ memory: { folders: [mem] } });
    expect(accessRoots(cfg, [])).toContain(path.resolve(mem));
    expect(resolveWritable(cfg, path.join(mem, "studio.md"), { read: true })).toBe(fs.realpathSync.native(path.join(mem, "studio.md")));
  });

  it("hors des dossiers : refusé, sauf avec l'accès à tout le PC", () => {
    const other = tmp();
    fs.writeFileSync(path.join(other, "notes.txt"), "x");
    const file = path.join(other, "notes.txt");
    expect(() => resolveWritable(ConfigSchema.parse({}), file, { read: true })).toThrow(/refusée/);
    // Le dossier temporaire est dans AppData sous Windows : toujours fermé, même avec l'option.
    const full = ConfigSchema.parse({ files: { fullAccess: true } });
    if (isSensitive(file)) expect(() => resolveWritable(full, file, { read: true })).toThrow(/protégé/);
    else expect(resolveWritable(full, file, { read: true })).toBe(fs.realpathSync.native(file));
  });

  it("emplacements toujours fermés : AppData, clés, système, config de MyIA", () => {
    const home = os.homedir();
    expect(isSensitive(path.join(home, "AppData", "Local", "Google", "Chrome", "User Data", "Login Data"))).toBe(true);
    expect(isSensitive(path.join(home, ".ssh", "id_ed25519"))).toBe(true);
    expect(isSensitive(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"))).toBe(true);
    expect(isSensitive(path.join(home, "Documents", "rapport.md"))).toBe(false);
  });

  it("un agent sur Claude ne lit jamais la mémoire, même par file_read ou avec l'accès à tout le PC", () => {
    const mem = tmp();
    fs.writeFileSync(path.join(mem, "secret.md"), "# Secret");
    const file = path.join(mem, "secret.md");
    for (const fullAccess of [false, true]) {
      const cfg = ConfigSchema.parse({ memory: { folders: [mem] }, files: { fullAccess } });
      expect(() => resolveWritable(cfg, file, { read: true, cloud: true })).toThrow();
      expect(accessRoots(cfg, [], true)).not.toContain(path.resolve(mem));
    }
    // Un agent local, lui, y a accès.
    expect(resolveWritable(ConfigSchema.parse({ memory: { folders: [mem] } }), file, { read: true })).toBeTruthy();
  });

  it("choisir un dossier large ne rouvre pas les emplacements protégés qu'il contient", () => {
    const home = os.homedir();
    expect(isSensitive(path.join(home, ".ssh", "id_ed25519"), [home])).toBe(true);
    expect(isSensitive(path.join(home, "AppData", "Roaming", "x"), [home])).toBe(true);
    // Un dossier choisi À L'INTÉRIEUR d'un emplacement protégé reste ouvert.
    const inside = path.join(home, "AppData", "Local", "MonDossier");
    expect(isSensitive(path.join(inside, "notes.md"), [inside])).toBe(false);
    expect(isSensitive(path.join(home, "AppData", "Local", "Autre", "x"), [inside])).toBe(true);
  });

  it("espace de travail d'un agent : ouvert à cet agent seulement, les chemins relatifs y vont", () => {
    const ws = tmp();
    fs.writeFileSync(path.join(ws, "plan.md"), "# Plan");
    const cfg = ConfigSchema.parse({});
    const file = fs.realpathSync.native(path.join(ws, "plan.md"));
    // Sans espace de travail : hors des dossiers de l'utilisateur.
    expect(() => resolveWritable(cfg, file, { read: true })).toThrow(/refusée/);
    expect(resolveWritable(cfg, file, { read: true, workspace: ws })).toBe(file);
    expect(resolveWritable(cfg, "plan.md", { read: true, workspace: ws })).toBe(file);
    expect(resolveWritable(cfg, "notes/todo.md", { workspace: ws })).toBe(path.join(ws, "notes", "todo.md"));
    // Les règles d'écriture restent les mêmes à l'intérieur.
    expect(() => resolveWritable(cfg, "run.bat", { workspace: ws })).toThrow();
    expect(() => resolveWritable(cfg, ".git/hooks/x.txt", { workspace: ws })).toThrow(/exécuter du code/);
    expect(() => resolveWritable(cfg, "../ailleurs.md", { workspace: ws })).toThrow();
  });

  it("espace de travail : un dossier précis, ni un disque, ni le dossier personnel, ni un emplacement protégé", () => {
    const dir = fs.mkdtempSync(path.join(paths.workspace, "test-ws-"));
    try {
      expect(checkWorkspace(dir)).toBe(fs.realpathSync.native(dir));
      expect(usableWorkspace(dir)).toBe(fs.realpathSync.native(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(usableWorkspace(dir)).toBeUndefined(); // dossier disparu (disque débranché)
    expect(usableWorkspace(undefined)).toBeUndefined();
    const home = os.homedir();
    expect(() => checkWorkspace(path.parse(home).root)).toThrow(/disque entier/);
    expect(() => checkWorkspace(home)).toThrow(/trop large/);
    expect(() => checkWorkspace(path.join(home, "AppData"))).toThrow(/protégé/);
    expect(() => checkWorkspace(path.join(paths.home, "config"))).toThrow(/protégé|introuvable/);
    expect(() => checkWorkspace(String.raw`\\serveur\partage\projet`)).toThrow(/réseau/);
    expect(() => checkWorkspace("projet")).toThrow();
  });

  it("l'option est désactivée par défaut", () => {
    expect(ConfigSchema.parse({}).files.fullAccess).toBe(false);
  });
});
