import { describe, expect, it } from "vitest";
import { classifyTask, insufficientReason, ModelRouter, RouterHistory } from "./model-router.js";

describe("classification déterministe des demandes", () => {
  it("catégories", () => {
    expect(classifyTask("merci !").category).toBe("conversation");
    expect(classifyTask("Quelle heure est-il ?").category).toBe("question");
    expect(classifyTask("ouvre le dossier Musique").category).toBe("action");
    expect(classifyTask("Corrige ce bug dans la fonction de build").category).toBe("code");
    expect(classifyTask("Analyse l'architecture du lanceur").category).toBe("analysis");
    expect(classifyTask("Rédige une annonce pour Discord").category).toBe("writing");
  });

  it("complexité : simple, modérée, complexe", () => {
    expect(classifyTask("ouvre Spotify").complexity).toBe("simple");
    expect(classifyTask("Corrige ce bug dans la fonction de build").complexity).toBe("moderate");
    const long = "Analyse l'architecture du projet, puis compare-la à la spec, ensuite propose un plan, et enfin écris le rapport. " + "Contexte : ".repeat(60);
    const c = classifyTask(long);
    expect(c.complexity).toBe("complex");
    expect(c.signals.length).toBeGreaterThan(1);
    expect(classifyTask("ouvre Spotify", { contextTokens: 20_000 }).score).toBe(classifyTask("ouvre Spotify").score + 1);
  });

  it("même entrée, même résultat", () => {
    const q = "Range les fichiers du bureau puis envoie le résumé sur Discord";
    expect(classifyTask(q)).toEqual(classifyTask(q));
  });
});

describe("réponse insuffisante (règles fixes)", () => {
  it("vide, coupée, ou action annoncée sans être faite", () => {
    expect(insufficientReason("")).toBe("réponse vide");
    expect(insufficientReason("(pas de réponse)")).toBe("réponse vide");
    expect(insufficientReason("début\n\n(réponse coupée : limite de longueur atteinte)")).toBe("réponse coupée");
    expect(insufficientReason("Je vais chercher.", { announced: true })).toBe("action annoncée sans être faite");
    expect(insufficientReason("Voilà, c'est fait.")).toBeUndefined();
  });
});

describe("Model Router", () => {
  const tiers = { light: "qwen3:1.7b", standard: "qwen3:8b", strong: "qwen3:14b" };

  it("léger pour une demande simple, standard sinon ; le fort seulement par escalade", () => {
    const r = new ModelRouter(tiers, new RouterHistory());
    expect(r.route(classifyTask("ouvre Spotify")).model).toBe("qwen3:1.7b");
    expect(r.route(classifyTask("Corrige ce bug dans la fonction de build")).model).toBe("qwen3:8b");
    expect(r.escalate("qwen3:1.7b")).toBe("qwen3:8b");
    expect(r.escalate("qwen3:8b")).toBe("qwen3:14b");
    expect(r.escalate("qwen3:14b")).toBeUndefined();
    expect(r.escalate("inconnu")).toBeUndefined();
  });

  it("sans palier léger : le standard pour tout", () => {
    const r = new ModelRouter({ standard: "qwen3:8b", strong: "qwen3:14b" }, new RouterHistory());
    expect(r.route(classifyTask("ouvre Spotify")).model).toBe("qwen3:8b");
    expect(r.models()).toEqual(["qwen3:8b", "qwen3:14b"]);
  });

  it("paliers en double fusionnés", () => {
    expect(new ModelRouter({ light: "a", standard: "a", strong: "b" }).models()).toEqual(["a", "b"]);
  });

  it("historique : un modèle qui échoue souvent sur une catégorie est sauté, seulement après assez d'essais", () => {
    const h = new RouterHistory();
    const r = new ModelRouter(tiers, h, { minSamples: 4, minSuccessRate: 0.6 });
    const simple = classifyTask("ouvre Spotify");
    for (let i = 0; i < 3; i++) h.record("action", "qwen3:1.7b", false);
    expect(r.route(simple).model).toBe("qwen3:1.7b");
    h.record("action", "qwen3:1.7b", false);
    const choice = r.route(simple);
    expect(choice.model).toBe("qwen3:8b");
    expect(choice.reason).toMatch(/échoue souvent/);
    // Une autre catégorie n'est pas touchée.
    expect(r.route(classifyTask("merci")).model).toBe("qwen3:1.7b");
  });

  it("historique sérialisable, entrées invalides ignorées", () => {
    const h = new RouterHistory();
    h.record("code", "qwen3:8b", true);
    h.record("code", "qwen3:8b", false);
    expect(h.stats("code", "qwen3:8b")).toEqual({ ok: 1, fail: 1, rate: 0.5 });
    expect(h.stats("code", "autre").rate).toBe(1);
    const back = RouterHistory.fromJSON(JSON.parse(JSON.stringify(h)));
    expect(back.stats("code", "qwen3:8b")).toEqual({ ok: 1, fail: 1, rate: 0.5 });
    const bad = RouterHistory.fromJSON([{ category: "code", model: "x", ok: -1, fail: 0 }, { model: "y" }, null, "z"]);
    expect(bad.toJSON()).toEqual([]);
    expect(RouterHistory.fromJSON("pas une liste").toJSON()).toEqual([]);
  });
});
