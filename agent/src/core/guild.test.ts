import { describe, expect, it } from "vitest";
import { decide, GuildSchema, type Guild } from "./guild.js";

const base = (over: Partial<Guild> = {}): Guild =>
  GuildSchema.parse({
    enabled: true,
    serve: "everyone",
    whitelist: [{ id: 42, name: "Lea" }],
    offers: [{ id: "redac", name: "Rédac'", model: "qwen3:8b" }],
    auto: { enabled: true, whitelistOnly: true, from: "23:00", to: "08:00", gpuMax: 50 },
    ...over,
  });

const at = (h: number, m = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
};
const IDS: Record<string, number> = { lea: 42, inconnu: 7, bob: 8 };
const req = (name = "Lea", certified = false, text = "résume ce texte") => ({
  from: { id: IDS[name.toLowerCase()], name, certified },
  offerId: "redac",
  text,
});
const idle = { memberLastHour: 0, today: 0 };

describe("Guilde : décision sur une demande", () => {
  it("interrupteur coupé : tout est refusé, même la liste blanche", () => {
    expect(decide(base({ enabled: false }), req(), idle, at(2), 10).kind).toBe("refuse");
  });

  it("la nuit, liste blanche, GPU libre : acceptation automatique", () => {
    expect(decide(base(), req("lea"), idle, at(2), 10)).toMatchObject({ kind: "auto" });
  });

  it("plage horaire qui passe minuit : 23h30 dedans, 12h dehors", () => {
    expect(decide(base(), req(), idle, at(23, 30), 10).kind).toBe("auto");
    expect(decide(base(), req(), idle, at(12), 10)).toMatchObject({ kind: "ask" });
  });

  it("GPU occupé (tu joues) ou charge inconnue : on te demande", () => {
    expect(decide(base(), req(), idle, at(2), 85).kind).toBe("ask");
    expect(decide(base(), req(), idle, at(2), undefined).kind).toBe("ask");
  });

  it("hors liste blanche : jamais d'auto, mais demande possible si on sert tout le monde", () => {
    expect(decide(base(), req("Inconnu"), idle, at(2), 10).kind).toBe("ask");
  });

  it("filtres d'accès : certifiés seulement, liste blanche seulement", () => {
    expect(decide(base({ serve: "certified" }), req("Bob", false), idle, at(2), 10).kind).toBe("refuse");
    expect(decide(base({ serve: "certified" }), req("Bob", true), idle, at(2), 10).kind).toBe("ask");
    expect(decide(base({ serve: "whitelist" }), req("Bob", true), idle, at(2), 10).kind).toBe("refuse");
  });

  it("quotas et taille : refus même pour la liste blanche", () => {
    expect(decide(base(), req(), { memberLastHour: 5, today: 0 }, at(2), 10).kind).toBe("refuse");
    expect(decide(base(), req(), { memberLastHour: 0, today: 50 }, at(2), 10).kind).toBe("refuse");
    expect(decide(base(), req("Lea", false, "x".repeat(7000)), idle, at(2), 10).kind).toBe("refuse");
  });

  it("offre désactivée ou inconnue : refus", () => {
    const g = base();
    g.offers[0]!.enabled = false;
    expect(decide(g, req(), idle, at(2), 10).kind).toBe("refuse");
    expect(decide(base(), { ...req(), offerId: "nope" }, idle, at(2), 10).kind).toBe("refuse");
  });

  it("liste blanche liée au compte : un autre membre qui prend le même pseudo n'en profite pas", () => {
    const usurpateur = { from: { id: 999, name: "Lea", certified: true }, offerId: "redac", text: "x" };
    expect(decide(base(), usurpateur, idle, at(2), 10)).toMatchObject({ kind: "ask", reason: "mode auto réservé à ta liste blanche" });
    expect(decide(base({ serve: "whitelist" }), usurpateur, idle, at(2), 10).kind).toBe("refuse");
  });

  it("pseudo seul (ancien format) : filtre, mais jamais d'auto tant qu'il n'est pas lié au compte", () => {
    const g = base({ whitelist: ["Lea"] as never });
    expect(g.whitelist).toEqual([{ name: "Lea" }]);
    expect(decide(g, req(), idle, at(2), 10)).toMatchObject({ kind: "ask", reason: expect.stringMatching(/pas encore associé/) });
    expect(decide({ ...g, serve: "whitelist" }, req(), idle, at(2), 10).kind).toBe("ask");
  });

  it("par défaut (nouvelle installation) : coupé, certifiés seulement, pas d'auto", () => {
    const g = GuildSchema.parse({});
    expect([g.enabled, g.serve, g.auto.enabled]).toEqual([false, "certified", false]);
  });
});
