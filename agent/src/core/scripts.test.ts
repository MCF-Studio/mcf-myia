import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptService } from "../services/scripts.js";
import { ECHO_SERVER } from "./scripts.fixture.js";
import { findRuntime, isSafeRelPath, ScriptPackSchema, ScriptStore, scriptEnv, scriptHash, type ScriptPack } from "./scripts.js";

const pack = (over: Partial<ScriptPack> = {}): ScriptPack => ({
  id: "echo",
  name: "Écho",
  entry: "server.py",
  files: [{ path: "server.py", content: ECHO_SERVER }],
  ...over,
});

const dirs: string[] = [];
function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myia-scripts-"));
  dirs.push(dir);
  return { dir, store: new ScriptStore({ file: path.join(dir, "config", "scripts.json"), root: path.join(dir, "data", "scripts") }) };
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("format d'un script", () => {
  it("accepte des fichiers texte en chemin relatif", () => {
    for (const p of ["server.py", "lib/outils.py", "notes.md", "a/b/c/d.json"]) expect(isSafeRelPath(p), p).toBe(true);
  });

  it("refuse tout chemin qui sort du dossier, un exécutable ou un nom réservé", () => {
    for (const p of ["../x.py", "a/../../x.py", "/abs.py", "C:/x.py", "a\\b.py", "x.exe", "x.bat", "x.ps1", "x.dll", "nul.py", "con.txt", ".env", "a/b/c/d/e.py", "x.py.", "x"]) {
      expect(isSafeRelPath(p), p).toBe(false);
    }
  });

  it("exige un point d'entrée .py présent, sans doublon de fichier", () => {
    expect(ScriptPackSchema.safeParse(pack()).success).toBe(true);
    expect(ScriptPackSchema.safeParse(pack({ entry: "autre.py" })).success).toBe(false);
    expect(ScriptPackSchema.safeParse(pack({ entry: "notes.md", files: [{ path: "notes.md", content: "x" }] })).success).toBe(false);
    expect(ScriptPackSchema.safeParse(pack({ files: [{ path: "server.py", content: "a" }, { path: "SERVER.py", content: "b" }] })).success).toBe(false);
    expect(ScriptPackSchema.safeParse(pack({ id: "../x" })).success).toBe(false);
  });

  it("l'empreinte ne dépend que du contenu, pas de l'ordre des fichiers ni du nom", () => {
    const a = pack({ files: [{ path: "server.py", content: "x" }, { path: "lib/a.py", content: "y" }] });
    const b = pack({ id: "autre", name: "Autre", files: [{ path: "lib/a.py", content: "y" }, { path: "server.py", content: "x" }] });
    expect(scriptHash(a)).toBe(scriptHash(b));
    expect(scriptHash(a)).not.toBe(scriptHash(pack({ files: [{ path: "server.py", content: "x" }, { path: "lib/a.py", content: "y " }] })));
    // Un contenu ne peut pas « glisser » d'un fichier à l'autre sans changer l'empreinte.
    expect(scriptHash({ entry: "a.py", files: [{ path: "a.py", content: "xy" }, { path: "b.py", content: "" }] })).not.toBe(
      scriptHash({ entry: "a.py", files: [{ path: "a.py", content: "x" }, { path: "b.py", content: "y" }] }),
    );
  });
});

describe("accord de l'utilisateur", () => {
  it("un script installé sans accord ne peut pas être lancé", () => {
    const { store } = tmpStore();
    store.install(pack(), { approved: false, origin: "workflow « Test »" });
    expect(store.blocked("echo")).toMatch(/accord/);
    expect(store.get("echo")?.approvedSha256).toBeUndefined();
  });

  it("l'accord porte sur une empreinte : un fichier modifié ensuite bloque le script", () => {
    const { store } = tmpStore();
    const e = store.install(pack(), { approved: false });
    store.approve("echo", e.sha256);
    expect(store.blocked("echo")).toBeUndefined();

    fs.appendFileSync(path.join(store.dir("echo"), "server.py"), "\nimport os\n");
    expect(store.blocked("echo")).toMatch(/modifié/);
  });

  it("un fichier ajouté à côté (même d'un type refusé) bloque aussi le script", () => {
    const { store } = tmpStore();
    store.install(pack(), { approved: true });
    expect(store.blocked("echo")).toBeUndefined();
    fs.writeFileSync(path.join(store.dir("echo"), "sitecustomize.py"), "print('x')");
    expect(store.blocked("echo")).toMatch(/modifié/);
    fs.rmSync(path.join(store.dir("echo"), "sitecustomize.py"));
    fs.writeFileSync(path.join(store.dir("echo"), "charge.dll"), "x");
    expect(store.blocked("echo")).toMatch(/modifié/);
  });

  it("refuse un accord donné sur une empreinte qui n'est plus celle du disque", () => {
    const { store } = tmpStore();
    const e = store.install(pack(), { approved: false });
    fs.appendFileSync(path.join(store.dir("echo"), "server.py"), "# changé\n");
    expect(() => store.approve("echo", e.sha256)).toThrow(/changé/);
  });

  it("retirer l'accord, puis supprimer", () => {
    const { store } = tmpStore();
    store.install(pack(), { approved: true });
    store.revoke("echo");
    expect(store.blocked("echo")).toMatch(/accord/);
    store.delete("echo");
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(store.dir("echo"))).toBe(false);
  });

  it("relit les fichiers tels qu'ils sont sur le disque", () => {
    const { store } = tmpStore();
    store.install(pack({ files: [{ path: "server.py", content: "a" }, { path: "lib/b.py", content: "b" }] }), { approved: true });
    expect(store.read("echo").files.map((f) => f.path)).toEqual(["lib/b.py", "server.py"]);
  });
});

describe("environnement d'un script", () => {
  it("ne transmet ni les variables de MyIA ni des secrets d'autres outils", () => {
    const env = scriptEnv({ PATH: "C:\\bin", Path: undefined, MYIA_HOME: "C:\\myia", ANTHROPIC_API_KEY: "sk-x", GITHUB_TOKEN: "ghp_x", USERPROFILE: "C:\\Users\\x" });
    expect(env.PATH).toBe("C:\\bin");
    expect(env.USERPROFILE).toBe("C:\\Users\\x");
    expect(Object.keys(env).some((k) => /MYIA|ANTHROPIC|TOKEN/i.test(k))).toBe(false);
  });
});

describe("service d'un script (vrai processus)", async () => {
  const rt = await findRuntime();

  it.skipIf(!rt)("ne se lance qu'après accord, expose ses outils en `external`, s'arrête si le fichier change", async () => {
    const { dir, store } = tmpStore();
    const e = store.install(pack(), { approved: false });
    const service = scriptService(store, "echo", dir);
    try {
      expect(await service.available()).toMatchObject({ ok: false, reason: expect.stringMatching(/accord/) });
      expect(service.tools()).toEqual([]);

      store.approve("echo", e.sha256);
      expect(await service.available()).toEqual({ ok: true });
      const [tool] = service.tools();
      expect(tool?.name).toBe("script_echo__dire");
      expect(tool?.risk).toBe("external");
      expect(await tool!.preview({ texte: "salut" })).toMatch(/Script « Écho », outil dire/);
      expect(await tool!.run({ texte: "salut" }, {} as never)).toBe("echo : salut");

      fs.appendFileSync(path.join(store.dir("echo"), "server.py"), "\n# modifié après l'accord\n");
      expect(await service.available()).toMatchObject({ ok: false, reason: expect.stringMatching(/modifié/) });
      expect(service.tools()).toEqual([]);
      await expect(tool!.run({ texte: "encore" }, {} as never)).rejects.toThrow(/plus lancé/);
    } finally {
      await service.close?.();
    }
  }, 240_000);
});
