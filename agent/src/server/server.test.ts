import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AgentProfileSchema } from "../core/profiles.js";
import { RpcPeer } from "./rpc.js";
import { ThemeSchema, THEME_TOKENS } from "./themes.js";

const colors = Object.fromEntries(THEME_TOKENS.map((t) => [t, "#ff7a1a"]));
const theme = { id: "test-theme", name: "Test", mode: "dark", colors };

describe("thèmes partagés", () => {
  it("accepte un thème de couleurs", () => {
    expect(ThemeSchema.safeParse(theme).success).toBe(true);
    expect(ThemeSchema.safeParse({ ...theme, colors: { ...colors, glow: "rgba(255, 122, 26, 0.4)" } }).success).toBe(true);
  });
  it("refuse une URL ou du CSS déguisé en couleur", () => {
    for (const bad of ["url(https://evil.example/x.png)", "red; background: url(x)", "expression(alert(1))", "var(--x)"]) {
      expect(ThemeSchema.safeParse({ ...theme, colors: { ...colors, bg: bad } }).success).toBe(false);
    }
  });
  it("refuse les clés inconnues dans les couleurs", () => {
    expect(ThemeSchema.safeParse({ ...theme, colors: { ...colors, "font-face": "#fff" } }).success).toBe(false);
  });
  it("refuse un id qui sort du dossier des thèmes", () => {
    expect(ThemeSchema.safeParse({ ...theme, id: "../config/agent" }).success).toBe(false);
  });
});

describe("profils d'agents", () => {
  it("valide un profil minimal", () => {
    expect(AgentProfileSchema.safeParse({ id: "forgeron", name: "Forgeron" }).success).toBe(true);
  });
  it("refuse un id ou un modèle douteux", () => {
    expect(AgentProfileSchema.safeParse({ id: "../x", name: "x" }).success).toBe(false);
    expect(AgentProfileSchema.safeParse({ id: "x", name: "x", model: "http://evil/model" }).success).toBe(false);
  });
});

describe("RPC sur stdio", () => {
  function pair() {
    const input = new PassThrough();
    const out: string[] = [];
    const peer = new RpcPeer((l) => out.push(l), input);
    const sendLine = (o: unknown) => input.write(JSON.stringify(o) + "\n");
    const next = () => new Promise<any>((r) => setTimeout(() => r(JSON.parse(out.shift() ?? "null")), 20));
    return { peer, sendLine, next, out };
  }

  it("répond aux méthodes et signale les inconnues", async () => {
    const { peer, sendLine, next } = pair();
    peer.method("add", (p: any) => p.a + p.b);
    sendLine({ jsonrpc: "2.0", id: 1, method: "add", params: { a: 2, b: 3 } });
    expect((await next()).result).toBe(5);
    sendLine({ jsonrpc: "2.0", id: 2, method: "rm_rf" });
    expect((await next()).error.code).toBe(-32601);
  });

  it("renvoie une erreur propre sur JSON invalide", async () => {
    const { sendLine, next } = pair();
    sendLine("pas du json" as unknown);
    expect((await next()).error).toBeDefined();
  });

  it("appelle l'app et reçoit sa réponse (confirmation)", async () => {
    const { peer, sendLine, out } = pair();
    const p = peer.call<boolean>("ui.confirm", { title: "x" });
    const req = JSON.parse(out.shift()!);
    sendLine({ jsonrpc: "2.0", id: req.id, result: true });
    expect(await p).toBe(true);
  });

  it("une confirmation annulée vaut refus", async () => {
    const { peer } = pair();
    const ac = new AbortController();
    const p = peer.call("ui.confirm", {}, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});
