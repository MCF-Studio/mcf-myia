import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertLocalPath, checkExecutable, PROGRAM_NAME } from "./programs.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myia-prog-"));
const fake = (name: string) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, "");
  return p;
};

describe("programmes lançables", () => {
  it("accepte un exécutable ordinaire", () => {
    expect(checkExecutable(fake("blender.exe")).toLowerCase()).toBe(fs.realpathSync.native(path.join(tmp, "blender.exe")).toLowerCase());
  });

  it("refuse les shells et interpréteurs, quelle que soit la casse", () => {
    for (const n of ["cmd.exe", "PowerShell.exe", "pwsh.exe", "node.exe", "python3.exe", "python311.exe", "wscript.exe", "mshta.exe", "RunDll32.exe"]) {
      expect(() => checkExecutable(fake(n)), n).toThrow(/n'importe quelle commande/);
    }
  });

  it("refuse les interpréteurs tiers et outils détournables connus", () => {
    for (const n of ["AutoHotkey64.exe", "dotnet.exe", "msbuild.exe", "node18.exe", "InstallUtil.exe"]) {
      expect(() => checkExecutable(fake(n)), n).toThrow(/n'importe quelle commande/);
    }
  });

  it("refuse ce qui n'est pas un .exe existant", () => {
    if (process.platform === "win32") expect(() => checkExecutable(fake("script.bat"))).toThrow(/\.exe/);
    expect(() => checkExecutable(path.join(tmp, "absent.exe"))).toThrow(/introuvable/);
  });

  it("refuse les chemins réseau avant tout accès disque", () => {
    for (const p of [String.raw`\\evil.example\share\x.exe`, "//evil.example/share/x.exe", String.raw`\\?\C:\x.exe`, String.raw`\\.\pipe\x`]) {
      expect(() => assertLocalPath(p), p).toThrow(/réseau/);
    }
  });

  it.runIf(process.platform === "win32")("exige un chemin complet sur un lecteur", () => {
    expect(() => assertLocalPath(String.raw`tools\x.exe`)).toThrow(/chemin complet/);
    expect(assertLocalPath(String.raw`C:\Program Files\x.exe`)).toBe(String.raw`C:\Program Files\x.exe`);
  });

  it.runIf(process.platform === "win32")("bloque les outils du dossier Windows, même par leur nom court", () => {
    const win = process.env.SystemRoot ?? String.raw`C:\Windows`;
    expect(() => checkExecutable(path.join(win, "System32", "certutil.exe"))).toThrow(/système Windows|n'importe quelle/);
    expect(() => checkExecutable(path.join(win, "System32", "WindowsPowerShell", "v1.0", "POWERS~1.EXE"))).toThrow();
    expect(checkExecutable(path.join(win, "System32", "notepad.exe")).toLowerCase()).toContain("notepad.exe");
  });

  it("noms lisibles, pas de caractères spéciaux", () => {
    expect(PROGRAM_NAME.test("Blender 4.5")).toBe(true);
    expect(PROGRAM_NAME.test("Éditeur d'images")).toBe(true);
    expect(PROGRAM_NAME.test("x; rm -rf")).toBe(false);
    expect(PROGRAM_NAME.test("")).toBe(false);
  });
});
