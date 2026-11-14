import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { childEnv, runProcess } from "./proc.js";

describe("programmes lancés par MyIA", () => {
  const before = process.env.MYIA_HOME;
  afterEach(() => {
    if (before === undefined) delete process.env.MYIA_HOME;
    else process.env.MYIA_HOME = before;
  });

  it("childEnv retire MYIA_HOME et garde le reste, sans toucher à l'environnement d'origine", () => {
    const env = { MYIA_HOME: "C:\\donnees", PATH: "C:\\bin", AUTRE: "x" };
    expect(childEnv(env)).toEqual({ PATH: "C:\\bin", AUTRE: "x" });
    expect(env.MYIA_HOME).toBe("C:\\donnees");
  });

  it("un programme lancé n'hérite pas du dossier de données de l'app", async () => {
    process.env.MYIA_HOME = "C:\\donnees-de-l-installation";
    const out: string[] = [];
    const print = "process.stdout.write(`home=${process.env.MYIA_HOME ?? ''};path=${process.env.PATH ? 'oui' : 'non'}\\n`)";
    const r = await runProcess([process.execPath, "-e", print], { cwd: os.tmpdir(), timeoutMs: 30_000, onLine: (l) => out.push(l) });
    expect(r.code).toBe(0);
    expect(out).toEqual(["home=;path=oui"]);
  });

  it("un environnement fourni explicitement est transmis tel quel", async () => {
    const out: string[] = [];
    const r = await runProcess([process.execPath, "-e", "process.stdout.write(`${process.env.MYIA_HOME}\\n`)"], {
      cwd: os.tmpdir(),
      timeoutMs: 30_000,
      env: { ...process.env, MYIA_HOME: "choisi" },
      onLine: (l) => out.push(l),
    });
    expect(r.code).toBe(0);
    expect(out).toEqual(["choisi"]);
  });
});
