import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ECHO_SERVER } from "../core/scripts.fixture.js";

/**
 * Parcours complet par le vrai sidecar (JSON-RPC sur stdio), sur deux installations séparées : A exporte une équipe
 * avec un script, B l'importe. Vérifie ce que l'interface verra réellement.
 */

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Sidecar {
  home: string;
  call<T = any>(method: string, params?: object): Promise<T>;
  stop(): void;
}

/** Dossiers ordinaires (hors AppData, hors dépôt git) pour les espaces de coordination du test. */
const scratch: string[] = [];
function plainDir(name: string): string {
  const base = path.join(agentDir, "..", "workspace");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `e2e-${name}-`));
  scratch.push(dir);
  return fs.realpathSync.native(dir);
}

const running: { child: ChildProcess; home: string }[] = [];
afterEach(() => {
  for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  for (const r of running.splice(0)) {
    r.child.kill();
    fs.rmSync(r.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

async function startSidecar(): Promise<Sidecar> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "myia-e2e-"));
  fs.mkdirSync(path.join(home, "config"), { recursive: true });
  // Pas de moteur local lancé pendant le test.
  fs.writeFileSync(path.join(home, "config", "agent.json"), JSON.stringify({ llm: { autoStart: false } }));
  const child = spawn(process.execPath, ["--import", "tsx", path.join(agentDir, "src", "server", "main.ts")], {
    cwd: agentDir,
    env: { ...process.env, MYIA_HOME: home },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  running.push({ child, home });

  let nextId = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  let ready!: () => void;
  const isReady = new Promise<void>((r) => (ready = r));
  let buf = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; result?: unknown; error?: { message: string } };
      if (msg.method === "ready") ready();
      if (msg.id !== undefined && !msg.method) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      }
    }
  });
  await isReady;
  return {
    home,
    call: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }),
    stop: () => child.kill(),
  };
}

describe("workflow de bout en bout (sidecar réel)", () => {
  it("A exporte une équipe avec un script ; B l'importe, le script attend son accord", async () => {
    // ── installation A : deux agents, un script, une équipe ──
    const a = await startSidecar();
    await a.call("agents.save", { id: "chef", name: "Chef 3D", instructions: "Tu coordonnes la scène." });
    await a.call("agents.save", { id: "modeleur", name: "Modeleur", services: ["godot", "service-inconnu"] });
    const script = await a.call("scripts.add", {
      name: "Pont Godot",
      description: "Répète un texte",
      entry: "server.py",
      files: [{ path: "server.py", content: ECHO_SERVER }],
    });
    expect(script).toMatchObject({ id: "pont-godot", state: "approved", origin: "ajouté sur ce PC" });

    await a.call("teams.save", {
      id: "studio-3d",
      name: "Studio 3D",
      description: "Scènes Godot",
      root: { id: "n-chef", agentId: "chef", subagents: [{ id: "n-mod0", agentId: "modeleur", subagents: [], teammates: [] }], teammates: [] },
      maxCalls: 5,
      maxDepth: 2,
      scripts: ["pont-godot"],
    });
    await expect(a.call("teams.save", { id: "x", name: "X", root: { id: "n-0001", agentId: "chef", subagents: [], teammates: [] }, scripts: ["absent"] })).rejects.toThrow(
      /script inconnu/,
    );
    await expect(a.call("scripts.delete", { id: "pont-godot" })).rejects.toThrow(/utilisé par : Studio 3D/);

    // Espace de coordination : le dossier venu de l'interface repasse par les contrôles (ici, un dossier sous AppData
    // ou introuvable), à l'enregistrement comme à la création de l'exemple ; rien n'est écrit en cas de refus.
    const bad = path.join(a.home, "coordination");
    fs.mkdirSync(bad);
    const team = { id: "y", name: "Y", root: { id: "n-0002", agentId: "chef", subagents: [], teammates: [] } };
    await expect(a.call("teams.save", { ...team, coordination: bad })).rejects.toThrow(/protégé|trop large/);
    await expect(a.call("teams.coordinationInit", { path: bad, name: "Y", agentIds: ["chef"] })).rejects.toThrow(/protégé|trop large/);
    expect(fs.readdirSync(bad)).toEqual([]);
    await expect(a.call("teams.coordinationInit", { path: path.join(bad, "absent"), name: "Y" })).rejects.toThrow(/introuvable/);

    const exported = await a.call<{ filename: string; json: string; scripts: number }>("teams.export", { id: "studio-3d" });
    expect(exported.filename).toBe("studio-3d.workflow.json");
    expect(exported.scripts).toBe(1);

    // Fiches de l'espace de coordination : l'auteur les choisit une par une, le journal ne part jamais.
    const coordA = plainDir("a");
    expect((await a.call("teams.coordinationInit", { path: coordA, name: "Studio 3D", agentIds: ["chef", "modeleur"] })).created).toEqual([
      "LISEZ-MOI.md",
      "methode.md",
      "journal/etat.md",
    ]);
    fs.appendFileSync(path.join(coordA, "journal", "etat.md"), "- secret de fabrication de A\n");
    fs.writeFileSync(path.join(coordA, "cles-et-acces.md"), "où sont les clés de A\n");
    const saved = await a.call("teams.list");
    await a.call("teams.save", { ...saved.find((t: { id: string }) => t.id === "studio-3d"), coordination: coordA });
    const listed = await a.call("teams.coordinationFiles", { id: "studio-3d" });
    expect(listed.files.map((f: { path: string; sensitive: boolean }) => `${f.path}:${f.sensitive}`)).toEqual([
      "cles-et-acces.md:true",
      "LISEZ-MOI.md:false",
      "methode.md:false",
    ]);
    await expect(a.call("teams.export", { id: "studio-3d", fiches: ["journal/etat.md"] })).rejects.toThrow(/refusée/);
    const withFiches = await a.call<{ json: string; fiches: number }>("teams.export", { id: "studio-3d", fiches: ["LISEZ-MOI.md", "methode.md"] });
    expect(withFiches.fiches).toBe(2);
    expect(withFiches.json).not.toContain("secret de fabrication");
    expect(withFiches.json).not.toContain("où sont les clés");
    expect(withFiches.json).not.toContain(path.basename(coordA));
    // Sans fiches cochées, l'export reste celui d'avant.
    expect(exported.json).not.toContain("coordination");

    // Sur A, tout existe déjà à l'identique : rien de nouveau, seule une seconde équipe serait créée.
    const again = await a.call("workflows.inspect", { json: exported.json });
    expect(again.agents.every((x: { reused: boolean }) => x.reused)).toBe(true);
    expect(again.scripts[0].reused).toBe(true);
    a.stop();

    // ── installation B : vierge, avec un agent « chef » différent déjà présent ──
    const b = await startSidecar();
    await b.call("agents.save", { id: "chef", name: "Mon chef à moi" });

    const preview = await b.call("workflows.inspect", { json: exported.json });
    expect(preview).toMatchObject({ name: "Studio 3D", origin: "fichier", team: { nodes: 2, maxCalls: 5 } });
    expect(preview.scripts[0]).toMatchObject({ id: "pont-godot", reused: false, entry: "server.py" });
    expect(preview.scripts[0].files[0].content).toBe(ECHO_SERVER);
    expect(preview.renamed).toEqual([{ kind: "agent", from: "chef", to: "chef-2" }]);
    expect(preview.warnings.join(" ")).toMatch(/Modeleur attend des services absents de ce PC : service-inconnu/);

    // Installer ce qui n'a pas été examiné est refusé.
    await expect(b.call("workflows.install", { sha256: "0".repeat(64), acceptScripts: true })).rejects.toThrow(/examiné/);

    const done = await b.call("workflows.install", { sha256: preview.sha256, acceptScripts: false });
    expect(done).toMatchObject({ addedAgents: ["Chef 3D", "Modeleur"], scriptsPending: 1 });
    expect(done.team).toMatchObject({ id: "studio-3d", scripts: ["pont-godot"], root: { agentId: "chef-2" } });
    expect(done.team.workspace).toBeUndefined();

    // L'agent déjà présent n'a pas été touché.
    const agents = await b.call<{ id: string; name: string }[]>("agents.list");
    expect(agents.find((x) => x.id === "chef")?.name).toBe("Mon chef à moi");
    expect(agents.find((x) => x.id === "chef-2")?.name).toBe("Chef 3D");

    // Le script est sur le disque mais en attente : il ne tourne pas tant que l'utilisateur n'a pas accepté CE code.
    const before = await b.call("scripts.get", { id: "pont-godot" });
    expect(before).toMatchObject({ state: "pending", teams: ["Studio 3D"] });
    expect(before.origin).toMatch(/workflow « Studio 3D » \(fichier\)/);
    await expect(b.call("scripts.approve", { id: "pont-godot", sha256: "0".repeat(64) })).rejects.toThrow(/changé/);
    expect(await b.call("scripts.approve", { id: "pont-godot", sha256: before.diskSha256 })).toMatchObject({ state: "approved" });

    // Un fichier modifié après l'accord : l'état repasse à « modifié ».
    fs.appendFileSync(path.join(b.home, "data", "scripts", "pont-godot", "server.py"), "\n# ajout\n");
    expect(await b.call("scripts.get", { id: "pont-godot" })).toMatchObject({ state: "changed" });

    // Réimporter le même fichier n'écrase rien : une seconde équipe, sous un autre id.
    const preview2 = await b.call("workflows.inspect", { json: exported.json });
    const done2 = await b.call("workflows.install", { sha256: preview2.sha256, acceptScripts: false });
    expect(done2.team.id).toBe("studio-3d-2");
    expect((await b.call<unknown[]>("teams.list")).length).toBe(2);

    // Workflow avec fiches : montrées avant l'installation, posées dans le dossier choisi, qui devient l'espace de
    // coordination de l'équipe. Sans dossier choisi, l'équipe est installée sans elles.
    const preview3 = await b.call("workflows.inspect", { json: withFiches.json });
    expect(preview3.fiches.map((f: { path: string }) => f.path)).toEqual(["LISEZ-MOI.md", "methode.md"]);
    expect(preview3.fiches[0].content).toContain("# Studio 3D — règles communes");
    await expect(b.call("workflows.install", { sha256: preview3.sha256, acceptScripts: false, coordinationDir: path.join(b.home, "refus") })).rejects.toThrow(
      /introuvable|protégé/,
    );
    expect((await b.call<unknown[]>("teams.list")).length).toBe(2); // rien d'installé après le refus
    const coordB = plainDir("b");
    const done3 = await b.call("workflows.install", { sha256: preview3.sha256, acceptScripts: false, coordinationDir: coordB });
    expect(done3.fiches).toEqual({ dir: coordB, created: ["LISEZ-MOI.md", "methode.md", "journal/etat.md"], kept: [] });
    expect(done3.team.coordination).toBe(coordB);
    expect(fs.readFileSync(path.join(coordB, "journal", "etat.md"), "utf8")).not.toContain("secret de fabrication");

    const preview4 = await b.call("workflows.inspect", { json: withFiches.json });
    const done4 = await b.call("workflows.install", { sha256: preview4.sha256, acceptScripts: false });
    expect(done4).toMatchObject({ fiches: null, fichesSkipped: 2 });
    expect(done4.team.coordination).toBeUndefined();
  }, 120_000);
});
