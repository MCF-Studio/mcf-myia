import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Registre de travail d'une équipe par le vrai sidecar (JSON-RPC sur stdio) : les appels que fait la carte
 * « Travail de l'équipe » de l'écran Équipes (components/TeamWork.vue).
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

describe("registre de travail de bout en bout (sidecar réel)", () => {
  it("créer, noter, bloquer, fermer, rouvrir ; équipe inconnue refusée", async () => {
    const s = await startSidecar();
    await s.call("agents.save", { id: "chef", name: "Chef" });
    await s.call("teams.save", { id: "studio", name: "Studio", root: { id: "n-chef", agentId: "chef", subagents: [], teammates: [] } });

    expect((await s.call("work.list", { teamId: "studio" })).items).toEqual([]);
    const a = await s.call("work.create", { teamId: "studio", title: "Modéliser le puits", description: "Avec treuil" });
    const d = await s.call("work.create", { teamId: "studio", title: "Choisir la texture", type: "decision" });
    expect(a.id).toMatch(/^t-[a-z0-9]{6}$/);
    expect(d.type).toBe("decision");

    await s.call("work.note", { teamId: "studio", id: a.id, text: "Treuil à ajouter côté MCF-RP" });
    let list = await s.call("work.list", { teamId: "studio" });
    const item = list.items.find((i: any) => i.id === a.id);
    expect(item.notes.at(-1).text).toBe("Treuil à ajouter côté MCF-RP");
    expect(item.ready).toBe(true);

    await s.call("work.close", { teamId: "studio", id: a.id, reason: "fait" });
    list = await s.call("work.list", { teamId: "studio" });
    expect(list.closedTotal).toBe(1);
    expect(list.items.find((i: any) => i.id === a.id).status).toBe("fermee");

    await s.call("work.reopen", { teamId: "studio", id: a.id, reason: "treuil manquant" });
    expect((await s.call("work.list", { teamId: "studio" })).closedTotal).toBe(0);

    // Données sur disque, dans data/ de l'installation, jamais ailleurs.
    expect(fs.readdirSync(path.join(s.home, "data"), { recursive: true }).some((f) => String(f).includes("studio"))).toBe(true);

    await expect(s.call("work.list", { teamId: "inconnue" })).rejects.toThrow(/équipe inconnue/);
    await expect(s.call("work.note", { teamId: "studio", id: "../../x", text: "a" })).rejects.toThrow();
    await expect(s.call("work.create", { teamId: "studio", title: "x" })).rejects.toThrow();
  }, 60_000);
});
