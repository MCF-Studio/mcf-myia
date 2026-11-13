import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWritable } from "../services/file-write.js";
import { accessRoots, isSensitive } from "./access.js";
import { ConfigSchema } from "./config.js";

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

  it("l'option est désactivée par défaut", () => {
    expect(ConfigSchema.parse({}).files.fullAccess).toBe(false);
  });
});
