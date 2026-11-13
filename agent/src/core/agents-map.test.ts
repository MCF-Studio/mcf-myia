import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsMap, loadMapState, mapNames, saveMapState } from "./agents-map.js";
import type { AgentProfile } from "./profiles.js";

const profiles: AgentProfile[] = [
  { id: "forgeron", name: "Forgeron", instructions: "SECRET : consignes privées", model: "qwen3:8b" },
  { id: "redac", name: "Rédac'" },
  { id: "bizarre", name: "Agent 🤖" },
];

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "myia-map-")), "agents-map.json");

function setup(state: Parameters<typeof saveMapState>[0]) {
  const file = tmpFile();
  saveMapState(state, file);
  const map = new AgentsMap("https://mcfstudio.test", () => profiles, () => undefined, file);
  const account = { accessToken: vi.fn(async () => "jeton"), login: vi.fn(async () => undefined), logout: vi.fn(async () => undefined) };
  (map as unknown as { account: typeof account }).account = account;
  const calls: { method: string; body?: string; auth?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ method: String(init.method), body: init.body as string | undefined, auth: (init.headers as Record<string, string>).authorization });
      return new Response(JSON.stringify({ agents: [], hidden: false }), { status: 200 });
    }),
  );
  return { map, account, calls, file };
}

afterEach(() => vi.unstubAllGlobals());

describe("carte des agents (MyIA)", () => {
  it("désactivée par défaut, et un fichier illisible vaut « désactivée »", () => {
    expect(loadMapState(tmpFile())).toEqual({ enabled: false, agents: [] });
    const f = tmpFile();
    fs.writeFileSync(f, "pas du json");
    expect(loadMapState(f).enabled).toBe(false);
  });

  it("seuls les noms des agents cochés partent ; un nom hors règles du site est signalé, pas envoyé", () => {
    expect(mapNames(profiles, ["forgeron", "bizarre", "inconnu", "redac"])).toEqual({ names: ["Forgeron", "Rédac'"], refused: ["Agent 🤖"] });
  });

  it("l'envoi ne contient que les noms (ni consignes ni modèle), avec le jeton map", async () => {
    const { map, calls } = setup({ enabled: true, agents: ["forgeron"] });
    await map.sync(true);
    expect(calls).toEqual([{ method: "PUT", body: JSON.stringify({ agents: ["Forgeron"] }), auth: "Bearer jeton" }]);
    expect(calls[0]!.body).not.toContain("SECRET");
  });

  it("au plus un envoi par 12 h hors changement de sélection ; rien si l'option est désactivée", async () => {
    const { map, calls } = setup({ enabled: true, agents: ["forgeron"] });
    await map.sync();
    await map.sync();
    expect(calls).toHaveLength(1);
    const off = setup({ enabled: false, agents: ["forgeron"] });
    await off.map.sync(true);
    expect(off.calls).toHaveLength(0);
  });

  it("activer demande l'autorisation map si besoin ; désactiver retire du site puis révoque", async () => {
    const { map, account, calls, file } = setup({ enabled: false, agents: [] });
    account.accessToken.mockResolvedValueOnce(undefined as never);
    await map.enable(["redac"]);
    expect(account.login).toHaveBeenCalledOnce();
    expect(loadMapState(file)).toMatchObject({ enabled: true, agents: ["redac"] });
    await map.disable();
    expect(calls.map((c) => c.method)).toEqual(["PUT", "DELETE"]);
    expect(account.logout).toHaveBeenCalledOnce();
    expect(loadMapState(file).enabled).toBe(false);
  });
});
