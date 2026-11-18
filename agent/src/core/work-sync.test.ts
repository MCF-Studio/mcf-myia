import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execRunner, launchSpec, parseProvider, scriptEnv, WorkSync, type RunResult, type Runner } from "./work-sync.js";
import { EXTERNAL_WARNING, workCard, workLine } from "./work-tools.js";
import { WorkStore } from "./work.js";

const lead = { id: "chef", name: "Chef" };
let dir: string;
let store: WorkStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-sync-"));
  store = new WorkStore(path.join(dir, "equipe-test.json"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });

function fakeRunner(reply: (op: "push" | "pull", input: any) => RunResult) {
  const calls: { op: "push" | "pull"; input: any }[] = [];
  const run: Runner = async (op, input) => {
    const parsed = JSON.parse(input);
    calls.push({ op, input: parsed });
    return reply(op, parsed);
  };
  return { run, calls };
}

function sync(run: Runner) {
  return new WorkSync({ teamId: "test", store, run, outboxFile: path.join(dir, "equipe-test.sync.json"), debounceMs: 60_000 });
}

describe("parseProvider", () => {
  it("file par défaut, exec: avec un chemin absolu et un type connu", () => {
    expect(parseProvider(undefined)).toEqual({ kind: "file" });
    expect(parseProvider({ provider: "file" })).toEqual({ kind: "file" });
    const p = parseProvider({ provider: "exec:C:\\outils\\sync.ps1", pullMinutes: 10 });
    expect(p).toMatchObject({ kind: "exec", script: "C:\\outils\\sync.ps1", pullMs: 600_000, timeoutMs: 30_000 });
  });

  it("refuse un chemin relatif, un type inconnu ou des caractères de cmd.exe", () => {
    expect(() => parseProvider({ provider: "exec:sync.ps1" })).toThrow(/absolu/);
    expect(() => parseProvider({ provider: "exec:C:\\x\\sync.vbs" })).toThrow(/type de script/);
    expect(() => parseProvider({ provider: "exec:C:\\x\\a&calc.cmd" })).toThrow(/caractère interdit/);
    expect(() => parseProvider({ provider: "bd" })).toThrow(/inconnu/);
  });
});

describe("lancement", () => {
  it("jamais de shell : le script et l'opération sont des arguments séparés", () => {
    expect(launchSpec("C:\\s\\sync.ps1", "push").args).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\s\\sync.ps1", "push"]);
    expect(launchSpec("C:\\s\\sync.exe", "pull")).toEqual({ file: "C:\\s\\sync.exe", args: ["pull"] });
  });

  it("l'environnement du script n'a pas les secrets du cœur", () => {
    const env = scriptEnv({ PATH: "p", ANTHROPIC_API_KEY: "k", GH_TOKEN: "t", DB_PASSWORD: "x" }, "eq");
    expect(env).toEqual({ PATH: "p", MYIA_TEAM: "eq" });
  });
});

describe("push", () => {
  it("envoie les changements par lot et enregistre les références renvoyées", async () => {
    const { run, calls } = fakeRunner((_op, input) => ok(JSON.stringify({ refs: { [input.events[0].item.id]: "gh#7" } })));
    const s = sync(run);
    const t = store.create({ title: "Corriger la carte" }, lead);
    store.note(t.id, "commencé", lead);
    expect(s.pending()).toBe(2);
    const r = await s.push();
    expect(r).toEqual({ ok: true, sent: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0].input.events.map((e: any) => e.kind)).toEqual(["created", "noted"]);
    expect(calls[0].input.events[0].item).not.toHaveProperty("createdById");
    expect(store.get(t.id).ext).toBe("gh#7");
    expect(s.pending()).toBe(0);
    s.stop();
  });

  it("garde les changements quand le script échoue, et sur le disque", async () => {
    const { run } = fakeRunner(() => ({ code: 1, stdout: "", stderr: "réseau coupé", timedOut: false }));
    const s = sync(run);
    store.create({ title: "A" }, lead);
    const r = await s.push();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("réseau coupé");
    s.stop();
    // Redémarrage : la file est relue.
    const again = sync(fakeRunner(() => ok()).run);
    expect(again.pending()).toBe(1);
    again.stop();
  });

  it("une réponse illisible est une erreur, pas une réussite", async () => {
    const s = sync(fakeRunner(() => ok("pas du json")).run);
    store.create({ title: "A" }, lead);
    expect((await s.push()).ok).toBe(false);
    expect(s.pending()).toBe(1);
    s.stop();
  });

  it("un changement sans effet n'est pas envoyé", async () => {
    const s = sync(fakeRunner(() => ok()).run);
    const t = store.create({ title: "A" }, lead);
    store.close(t.id, "fait", lead);
    store.close(t.id, "encore", lead); // déjà fermée : rien
    expect(s.pending()).toBe(2);
    s.stop();
  });
});

describe("pull", () => {
  it("crée, note et ferme au nom de Synchro, sans renvoyer ces changements", async () => {
    const mine = store.create({ title: "Locale" }, lead);
    const { run, calls } = fakeRunner((op) =>
      op === "pull"
        ? ok(
            JSON.stringify({
              changes: [
                { op: "create", ext: "gh#1", title: "Bug du menu", type: "bug", labels: ["ui"] },
                { op: "create", ext: "gh#1", title: "doublon" },
                { op: "note", id: mine.id, text: "Commentaire GitHub" },
                { op: "close", ext: "gh#404", reason: "inconnue" },
                { op: "create", ext: "gh#2", title: "Décision", type: "decision" },
              ],
            }),
          )
        : ok(),
    );
    const s = sync(run);
    await s.push(); // vide la file de la création locale
    const r = await s.pull();
    expect(r).toEqual({ ok: true, applied: 2, skipped: 3 });
    const imported = store.byExt("gh#1")!;
    expect(imported).toMatchObject({ title: "Bug du menu", type: "bug", createdById: "@synchro" });
    expect(imported.labels).toEqual(["ui", "externe"]);
    expect(store.get(mine.id).notes.at(-1)).toMatchObject({ by: "Synchro", text: "Commentaire GitHub" });
    expect(s.pending()).toBe(0);
    // Montrées aux agents comme des données externes, non vérifiées.
    expect(workLine(imported)).toContain("externe");
    expect(workCard(imported, [])).toContain(EXTERNAL_WARNING);
    const card = workCard(store.get(mine.id), []);
    expect(card.startsWith(EXTERNAL_WARNING)).toBe(true);
    expect(card).toContain("Synchro [externe, non vérifié] : Commentaire GitHub");
    expect(workCard(store.create({ title: "Interne" }, lead), [])).not.toContain(EXTERNAL_WARNING);
    expect(calls.find((c) => c.op === "pull")!.input.items.map((i: any) => i.id)).toContain(mine.id);
    s.stop();
  });
});

describe("vrai script", () => {
  it("lance un script Node, lui passe le JSON sur l'entrée standard et lit sa réponse", async () => {
    const script = path.join(dir, "sync.mjs");
    fs.writeFileSync(
      script,
      `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);` +
        `process.stdout.write(JSON.stringify(m.op==="push"?{refs:{[m.events[0].item.id]:"ext-"+process.argv[2]+"-"+process.env.MYIA_TEAM}}:{changes:[]}))});`,
    );
    const p = parseProvider({ provider: `exec:${script}` });
    if (p.kind !== "exec") throw new Error("exec attendu");
    const s = sync(execRunner(p, "test"));
    const t = store.create({ title: "Titre avec \"guillemets\" & ; | $(calc)" }, lead);
    expect(await s.push()).toEqual({ ok: true, sent: 1 });
    expect(store.get(t.id).ext).toBe("ext-push-test");
    expect(await s.pull()).toEqual({ ok: true, applied: 0, skipped: 0 });
    s.stop();
  });

  it("arrête un script trop long", async () => {
    const script = path.join(dir, "lent.mjs");
    fs.writeFileSync(script, "setTimeout(()=>{}, 60000);");
    const run = execRunner({ kind: "exec", script, timeoutMs: 300, pullMs: 0 }, "test");
    const r = await run("pull", "{}");
    expect(r.timedOut).toBe(true);
  });
});

describe("fournisseur livré : tableau Markdown (tools/work-sync/markdown.mjs)", () => {
  it("tâches dans le tableau, case cochée = fermée, ligne ajoutée = nouvelle tâche, sans doublon", async () => {
    const script = path.resolve(__dirname, "../../../tools/work-sync/markdown.mjs");
    const boardDir = path.join(dir, "tableaux");
    process.env.MYIA_WORK_MD_DIR = boardDir;
    try {
      const p = parseProvider({ provider: `exec:${script}` });
      if (p.kind !== "exec") throw new Error("exec attendu");
      const s = sync(execRunner(p, "test"));
      const a = store.create({ title: "Corriger la carte" }, lead);
      const b = store.create({ title: "Écrire la doc" }, lead);
      store.claim(b.id, lead);
      expect((await s.push()).ok).toBe(true);
      const file = path.join(boardDir, "test.md");
      let md = fs.readFileSync(file, "utf8");
      expect(md).toContain(`- [ ] ${b.id} Écrire la doc — Chef`);
      expect(md).toContain(`- [ ] ${a.id} Corriger la carte`);

      // L'utilisateur coche une tâche et en ajoute une.
      md = md.replace(`- [ ] ${a.id}`, `- [x] ${a.id}`).replace("## Nouvelles (seront importées dans MyIA)", "## Nouvelles (seront importées dans MyIA)\n- [ ] Préparer la démo");
      fs.writeFileSync(file, md);
      expect(await s.pull()).toEqual({ ok: true, applied: 2, skipped: 0 });
      expect(store.get(a.id).status).toBe("fermee");
      const imported = store.list({}).find((i) => i.title === "Préparer la démo")!;
      expect(imported.labels).toContain("externe");
      md = fs.readFileSync(file, "utf8");
      expect(md).toContain(`- [x] ${a.id} Corriger la carte`);

      // Relève suivante : rien en double, la nouvelle tâche a pris son identifiant dans le tableau.
      expect(await s.pull()).toEqual({ ok: true, applied: 0, skipped: 0 });
      expect(store.list({}).filter((i) => i.title === "Préparer la démo")).toHaveLength(1);
      expect(fs.readFileSync(file, "utf8")).toContain(`- [ ] ${imported.id} Préparer la démo`);
      s.stop();
    } finally {
      delete process.env.MYIA_WORK_MD_DIR;
    }
  });
});
