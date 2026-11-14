import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { cleanSummary, Market } from "./market.js";
import type { TokenStore } from "./mcf-account.js";
import { sha256Text } from "./workflow.js";

const PACKAGE = JSON.stringify({ $schema: "myia/workflow@1", name: "Studio 3D" });
const SHA = sha256Text(PACKAGE);
const summary = (over: object = {}) => ({
  id: 7,
  name: "Studio 3D",
  description: "Scènes Godot",
  author: { id: 42, name: "Léa", certified: true },
  agents: 2,
  scripts: 1,
  sha256: SHA,
  visibility: "public",
  review: "approved",
  rejectReason: null,
  downloads: 3,
  updatedAt: "2026-11-14T08:00:00.000Z",
  ...over,
});

/** Faux mcfstudio.fr : marketplace public + routes de l'app protégées par un jeton. */
function fakeSite(opts: { tamper?: boolean } = {}) {
  const seen: { method: string; url: string; auth?: string; body?: any }[] = [];
  const jwt = `e30.${Buffer.from(JSON.stringify({ sub: "42", name: "Léa", certified: true })).toString("base64url")}.sig`;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (status: number, data?: object) => res.writeHead(status, { "content-type": "application/json" }).end(data ? JSON.stringify(data) : undefined);
      const url = req.url ?? "";
      const parsed = body ? JSON.parse(body) : undefined;
      seen.push({ method: req.method!, url, auth: req.headers.authorization, body: parsed });
      if (url === "/api/oauth/token") return json(200, { access_token: jwt, refresh_token: "r2", expires_in: 900 });
      if (url.startsWith("/api/workflows?")) return json(200, { workflows: [summary(), { id: "x" }].slice(0, 1), page: 1, pages: 1, total: 1 });
      if (url === "/api/workflows/7/package") return json(200, { package: opts.tamper ? PACKAGE.replace("Studio", "Piège") : PACKAGE, sha256: SHA });
      if (url === "/api/workflows/9/package") return json(404, { code: "workflow_not_found", message: "Workflow introuvable." });
      if (url.startsWith("/api/apps/workflows")) {
        if (req.headers.authorization !== `Bearer ${jwt}`) return json(401, { code: "unauthorized", message: "Jeton refusé." });
        if (req.method === "GET") return json(200, { workflows: [summary({ visibility: "private", review: "none" })] });
        if (req.method === "POST") return json(201, { workflow: summary({ id: 8, visibility: parsed.visibility, review: "pending" }) });
        if (req.method === "PUT") return json(200, { workflow: summary({ visibility: parsed.visibility ?? "public", review: "pending" }) });
        if (req.method === "DELETE") return json(204);
      }
      json(404, { code: "not_found" });
    });
  });
  return {
    seen,
    server,
    start: () => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`))),
  };
}

const memoryStore = (value?: string): TokenStore => ({ get: () => value, set: (t) => (value = t), clear: () => (value = undefined) });

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
async function setup(opts: { tamper?: boolean; refresh?: string } = {}) {
  const site = fakeSite(opts);
  servers.push(site.server);
  const url = await site.start();
  return { site, market: new Market(url, () => undefined, memoryStore(opts.refresh)) };
}

describe("marketplace : lecture publique", () => {
  it("liste sans compte et ne garde que les champs attendus", async () => {
    const { site, market } = await setup();
    const page = await market.list("  godot ", 1);
    expect(page.workflows).toHaveLength(1);
    expect(page.workflows[0]).toMatchObject({ id: 7, name: "Studio 3D", author: { name: "Léa", certified: true }, scripts: 1 });
    expect(site.seen[0]!.url).toBe("/api/workflows?page=1&q=godot");
    expect(site.seen[0]!.auth).toBeUndefined();
  });

  it("télécharge un paquet dont l'empreinte est celle annoncée", async () => {
    const { market } = await setup();
    expect(await market.download(7, SHA)).toEqual({ json: PACKAGE, sha256: SHA });
  });

  it("refuse un paquet qui ne correspond pas à l'empreinte annoncée", async () => {
    const { market } = await setup({ tamper: true });
    await expect(market.download(7, SHA)).rejects.toThrow(/empreinte/);
    const { market: ok } = await setup();
    await expect(ok.download(7, "0".repeat(64))).rejects.toThrow(/empreinte/);
  });

  it("rend le message du site quand le workflow n'existe plus", async () => {
    const { market } = await setup();
    await expect(market.download(9)).rejects.toThrow(/introuvable/);
  });

  it("borne et nettoie ce que le site renvoie", () => {
    const s = cleanSummary(summary({ name: "x".repeat(500), review: "n'importe quoi", visibility: "autre", downloads: -4, extra: "<script>" }));
    expect(s.name).toHaveLength(60);
    expect(s.review).toBe("none");
    expect(s.visibility).toBe("private");
    expect(s.downloads).toBe(0);
    expect(s).not.toHaveProperty("extra");
    expect(() => cleanSummary({ id: 1, sha256: "pas-une-empreinte" })).toThrow(/illisible/);
  });
});

describe("marketplace : publication", () => {
  it("exige d'être connecté", async () => {
    const { site, market } = await setup();
    await expect(market.publish(PACKAGE, "private")).rejects.toThrow(/connecte/);
    expect(site.seen).toEqual([]);
  });

  it("publie, met à jour, change la visibilité et retire avec le jeton de portée workflows", async () => {
    const { site, market } = await setup({ refresh: "r1" });
    expect((await market.publish(PACKAGE, "public")).review).toBe("pending");
    expect((await market.publish(PACKAGE, "public", 7)).id).toBe(7);
    expect((await market.setVisibility(7, "private")).visibility).toBe("private");
    await market.remove(7);
    expect((await market.mine())[0]!.visibility).toBe("private");

    const calls = site.seen.filter((c) => c.url.startsWith("/api/apps/workflows"));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/apps/workflows",
      "PUT /api/apps/workflows/7",
      "PUT /api/apps/workflows/7",
      "DELETE /api/apps/workflows/7",
      "GET /api/apps/workflows",
    ]);
    expect(calls.every((c) => c.auth?.startsWith("Bearer "))).toBe(true);
    expect(calls[0]!.body).toEqual({ package: PACKAGE, visibility: "public" });
    expect(calls[2]!.body).toEqual({ visibility: "private" });
  });
});
