import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPolicy, ensureToolbox, installBundledTools, resolvePython } from "./toolbox-setup.js";

const tmp: string[] = [];
function dir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "myia-tb-"));
  tmp.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Boîte livrée minimale : gestionnaire, un outil, plus des fichiers qui ne doivent jamais partir dans le paquet. */
function bundle(root: string, toolText = "v1") {
  fs.mkdirSync(path.join(root, "files", "text_read"), { recursive: true });
  fs.writeFileSync(path.join(root, "tool_manager.py"), "# gestionnaire");
  fs.writeFileSync(path.join(root, "files", "text_read", "tool.py"), toolText);
  fs.mkdirSync(path.join(root, "__pycache__"));
  fs.writeFileSync(path.join(root, "__pycache__", "x.pyc"), "");
  fs.writeFileSync(path.join(root, "policy.json"), "{\"de\":\"l'auteur\"}");
  return root;
}

describe("mise en place de la boîte à outils", () => {
  it("nouvel utilisateur : outils copiés, dossier par défaut créé, politique fichiers seulement", () => {
    const src = bundle(path.join(dir(), "src"));
    const dest = path.join(dir(), "tools");
    const work = path.join(dir(), "Documents", "MyIA");
    const r = ensureToolbox({ dir: dest, bundled: src, version: "1.0.0", defaultDirs: [work] });
    expect(r).toMatchObject({ installed: true, policyCreated: true });
    expect(r.error).toBeUndefined();
    expect(fs.existsSync(path.join(dest, "files", "text_read", "tool.py"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "__pycache__"))).toBe(false);
    expect(fs.existsSync(work)).toBe(true);
    const policy = JSON.parse(fs.readFileSync(path.join(dest, "policy.json"), "utf8"));
    // La politique livrée par erreur dans le paquet n'est jamais reprise : c'est la politique par défaut.
    expect(policy.granted_permissions).toEqual(["filesystem.read", "filesystem.write"]);
    expect(policy.allowed_dirs.write).toEqual([path.resolve(work).replace(/\\/g, "/")]);
  });

  it("nouvelle version : outils remplacés, fichiers du poste gardés, outil retiré supprimé", () => {
    const src = bundle(path.join(dir(), "src"));
    const dest = path.join(dir(), "tools");
    installBundledTools(src, dest, "1.0.0");
    fs.writeFileSync(path.join(dest, "policy.json"), "{\"mienne\":true}");
    fs.writeFileSync(path.join(dest, "apps.json"), "{}");
    fs.mkdirSync(path.join(dest, "imports", "mon_outil"), { recursive: true });
    fs.mkdirSync(path.join(dest, "ancien"));
    expect(installBundledTools(src, dest, "1.0.0")).toBe(false); // même version : rien
    fs.writeFileSync(path.join(src, "files", "text_read", "tool.py"), "v2");
    expect(installBundledTools(src, dest, "1.1.0")).toBe(true);
    expect(fs.readFileSync(path.join(dest, "files", "text_read", "tool.py"), "utf8")).toBe("v2");
    expect(fs.readFileSync(path.join(dest, "policy.json"), "utf8")).toBe("{\"mienne\":true}");
    expect(fs.existsSync(path.join(dest, "apps.json"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "imports", "mon_outil"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "ancien"))).toBe(false);
  });

  it("dossier rempli à la main avant MyIA : écrasé sans rien supprimer", () => {
    const src = bundle(path.join(dir(), "src"));
    const dest = path.join(dir(), "tools");
    fs.mkdirSync(path.join(dest, "perso"), { recursive: true });
    installBundledTools(src, dest, "1.0.0");
    expect(fs.existsSync(path.join(dest, "perso"))).toBe(true);
  });

  it("politique existante jamais réécrite ; sans boîte, rien n'est créé", () => {
    const dest = bundle(dir());
    fs.writeFileSync(path.join(dest, "policy.json"), "{}");
    expect(ensureToolbox({ dir: dest, defaultDirs: [path.join(dir(), "w")] }).policyCreated).toBe(false);
    expect(fs.readFileSync(path.join(dest, "policy.json"), "utf8")).toBe("{}");
    const empty = dir();
    expect(ensureToolbox({ dir: empty, defaultDirs: [path.join(empty, "w")] }).policyCreated).toBe(false);
    expect(fs.existsSync(path.join(empty, "policy.json"))).toBe(false);
  });

  it("politique par défaut : aucune permission qui lance un programme", () => {
    const p = defaultPolicy(["C:/x"]);
    for (const perm of ["process.exec", "process.exec.readonly", "app.launch", "url.open", "network.local"]) {
      expect(p.granted_permissions).not.toContain(perm);
    }
  });

  it("Python : réglage explicite gardé ; alias du Store remplacé par py -3 sous Windows", async () => {
    expect(await resolvePython("C:/Python312/python.exe", async () => false)).toEqual(["C:/Python312/python.exe"]);
    expect(await resolvePython("python", async (c) => c[0] === "python")).toEqual(["python"]);
    const fallback = await resolvePython("python", async (c) => c[0] === "py");
    expect(fallback).toEqual(process.platform === "win32" ? ["py", "-3"] : ["python"]);
  });
});
