import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWritable } from "../services/file-write.js";
import { accessRoots, isSensitive } from "./access.js";
import { ConfigSchema } from "./config.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "myia-access-"));

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

  it("l'option est désactivée par défaut", () => {
    expect(ConfigSchema.parse({}).files.fullAccess).toBe(false);
  });
});
