import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkExecutable, PROGRAM_NAME } from "./programs.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myia-prog-"));
const fake = (name: string) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, "");
  return p;
};

describe("programmes lançables", () => {
  it("accepte un exécutable ordinaire", () => {
    expect(checkExecutable(fake("blender.exe"))).toBe(path.resolve(tmp, "blender.exe"));
  });

  it("refuse les shells et interpréteurs, quelle que soit la casse", () => {
    for (const n of ["cmd.exe", "PowerShell.exe", "pwsh.exe", "node.exe", "python3.exe", "python311.exe", "wscript.exe", "mshta.exe", "RunDll32.exe"]) {
      expect(() => checkExecutable(fake(n)), n).toThrow(/n'importe quelle commande/);
    }
  });

  it("refuse ce qui n'est pas un .exe existant", () => {
    if (process.platform === "win32") expect(() => checkExecutable(fake("script.bat"))).toThrow(/\.exe/);
    expect(() => checkExecutable(path.join(tmp, "absent.exe"))).toThrow(/introuvable/);
  });

  it("noms lisibles, pas de caractères spéciaux", () => {
    expect(PROGRAM_NAME.test("Blender 4.5")).toBe(true);
    expect(PROGRAM_NAME.test("Éditeur d'images")).toBe(true);
    expect(PROGRAM_NAME.test("x; rm -rf")).toBe(false);
    expect(PROGRAM_NAME.test("")).toBe(false);
  });
});
