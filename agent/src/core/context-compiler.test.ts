import { describe, expect, it } from "vitest";
import { availableBudget, compileContext, compressText, type ContextItem } from "./context-compiler.js";
import { estimateTokens } from "./token-budget.js";

const para = (word: string, n = 60) => Array.from({ length: n }, (_, i) => `${word} ${i}`).join(" ") + ".";

describe("Context Compiler", () => {
  it("budget disponible = fenêtre − réserve de sortie − déjà pris", () => {
    expect(availableBudget(8192, 2000, 3000)).toBe(3192);
    expect(availableBudget(1000, 2000)).toBe(0);
  });

  it("L0 toujours gardé et jamais coupé, même au-delà du budget", () => {
    const big = para("consigne", 400);
    const out = compileContext([{ id: "id", level: 0, source: "profil", text: big }], { budgetTokens: 10, essentialMaxTokens: 5 });
    expect(out.text).toBe(big);
    expect(out.overBudget).toBe(true);
    expect(out.essentialOverflow).toBe(true);
    expect(out.trace[0]).toMatchObject({ id: "id", status: "full", source: "profil" });
  });

  it("bloc épinglé (instruction prioritaire) traité comme L0", () => {
    const rules = para("règle", 200);
    const out = compileContext([{ id: "r", level: 1, pinned: true, source: "LISEZ-MOI.md", text: rules }], { relevantMaxTokens: 10 });
    expect(out.text).toBe(rules);
    expect(out.trace[0]).toMatchObject({ level: 0, status: "full" });
  });

  it("L1 par pertinence, sous son plafond ; l'ordre d'origine est gardé à l'envoi", () => {
    const a = para("alpha", 20);
    const b = para("beta", 20);
    const items: ContextItem[] = [
      { id: "a", level: 1, relevance: 1, source: "mémoire", text: a },
      { id: "b", level: 1, relevance: 5, source: "registre", text: b },
    ];
    const cap = estimateTokens(b) + 10;
    const out = compileContext(items, { relevantMaxTokens: cap, minUsefulTokens: 20 });
    const ta = out.trace.find((t) => t.id === "a")!;
    expect(out.trace.find((t) => t.id === "b")!.status).toBe("full");
    expect(["dropped", "compressed"]).toContain(ta.status);
    expect(out.tokens.relevant).toBeLessThanOrEqual(cap);

    const roomy = compileContext(items, { relevantMaxTokens: 10_000 });
    expect(roomy.included.map((i) => i.id)).toEqual(["a", "b"]);
    expect(roomy.text).toBe(`${a}\n\n${b}`);
  });

  it("déduplique les blocs entiers et les paragraphes déjà présents", () => {
    const shared = "Le projet utilise Rust, Tauri 2 et Vue 3 pour son interface de bureau.";
    const out = compileContext([
      { id: "x", level: 0, source: "profil", text: `Tu es MyIA.\n\n${shared}` },
      { id: "y", level: 1, source: "mémoire", text: `  tu es myia.\n\n${shared.toUpperCase()}  ` },
      { id: "z", level: 1, source: "registre", text: `${shared}\n\nTâche en cours : corriger le build du lanceur.` },
    ]);
    expect(out.trace.find((t) => t.id === "y")).toMatchObject({ status: "duplicate", duplicateOf: "x" });
    const z = out.included.find((i) => i.id === "z")!;
    expect(z.text).toBe("Tâche en cours : corriger le build du lanceur.");
    expect(out.text.match(/Rust, Tauri/g)).toHaveLength(1);
  });

  it("L2 seulement à la demande ; sinon tracé comme disponible", () => {
    const items: ContextItem[] = [
      { id: "doc", level: 2, source: "docs/SPEC.md", text: "Spécification complète." },
      { id: "hist", level: 2, source: "historique", text: "Ancien échange." },
    ];
    const none = compileContext(items);
    expect(none.text).toBe("");
    expect(none.trace.map((t) => t.status)).toEqual(["deferred", "deferred"]);
    const one = compileContext(items, { requested: ["doc"] });
    expect(one.text).toBe("Spécification complète.");
    expect(one.trace.find((t) => t.id === "hist")!.status).toBe("deferred");
  });

  it("budget total partagé : L1 passe avant L2", () => {
    const l1 = para("utile", 30);
    const l2 = para("doc", 30);
    const out = compileContext(
      [
        { id: "l2", level: 2, source: "doc", text: l2 },
        { id: "l1", level: 1, source: "note", text: l1 },
      ],
      { budgetTokens: estimateTokens(l1) + 5, requested: ["l2"], minUsefulTokens: 50 },
    );
    expect(out.trace.find((t) => t.id === "l1")!.status).toBe("full");
    expect(out.trace.find((t) => t.id === "l2")!.status).toBe("dropped");
  });

  it("refuse deux blocs du même id", () => {
    expect(() =>
      compileContext([
        { id: "a", level: 0, source: "s", text: "1" },
        { id: "a", level: 1, source: "s", text: "2" },
      ]),
    ).toThrow(/double/);
  });

  it("résultat identique d'un appel à l'autre (déterministe)", () => {
    const items: ContextItem[] = [
      { id: "a", level: 1, relevance: 2, source: "m", text: para("a", 100) },
      { id: "b", level: 1, relevance: 2, source: "n", text: para("b", 100) },
    ];
    expect(compileContext(items, { relevantMaxTokens: 200 })).toEqual(compileContext(items, { relevantMaxTokens: 200 }));
  });
});

describe("compression déterministe", () => {
  it("texte court : inchangé", () => {
    expect(compressText("bonjour", 100)).toBe("bonjour");
  });

  it("résumé : titres et première phrase de chaque paragraphe", () => {
    const text = [
      "# Projet",
      "Première phrase importante. " + "détail ".repeat(80),
      "## État",
      "Le build passe. " + "bruit ".repeat(80),
    ].join("\n\n");
    const out = compressText(text, 60, "notes.md");
    expect(out).toContain("# Projet");
    expect(out).toContain("Première phrase importante.");
    expect(out).toContain("Le build passe.");
    expect(out).toContain("résumé automatique de notes.md");
    expect(estimateTokens(out)).toBeLessThanOrEqual(60);
  });

  it("sinon troncature début + fin, sous le budget, avec ce qui manque", () => {
    const text = "D" + "x".repeat(5000) + "F";
    const out = compressText(text, 100, "journal");
    expect(out.startsWith("D")).toBe(true);
    expect(out.endsWith("F")).toBe(true);
    expect(out).toMatch(/caractères omis de journal/);
    expect(estimateTokens(out)).toBeLessThanOrEqual(100);
  });
});
