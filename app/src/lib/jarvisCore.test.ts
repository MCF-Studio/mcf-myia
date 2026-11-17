// Tests de l'assistant vocal (onglet Jarvis). Lancés par `npm test` (node --test, types retirés par Node).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_VAD, detectWake, distance, greeting, isPhantom, localIntent, normalize, vadStep, type VadState } from "./jarvisCore.ts";

describe("mot d'éveil", () => {
  it("nom en début de phrase, ponctuation retirée", () => {
    assert.deepEqual(detectWake("Jarvis, ouvre Chrome.", "JARVIS"), { woke: true, rest: "ouvre Chrome." });
    assert.deepEqual(detectWake("Hé Jarvis ! Quelle heure est-il ?", "Jarvis"), { woke: true, rest: "Quelle heure est-il ?" });
    assert.deepEqual(detectWake("Ok, Jarvis", "Jarvis"), { woke: true, rest: "" });
  });
  it("tolère les fautes de whisper", () => {
    assert.equal(detectWake("Jarvice, mets la musique", "Jarvis").woke, true);
    assert.equal(detectWake("Jervis mets la musique", "Jarvis").woke, true);
    assert.equal(detectWake("Édith, lance le build", "Edith").woke, true);
  });
  it("nom en plusieurs mots ou collé", () => {
    assert.equal(detectWake("Edith Prime, statut", "Edith Prime").rest, "statut");
    assert.equal(detectWake("Mark Deux, statut", "Mark Deux").woke, true);
  });
  it("pas de faux réveil", () => {
    assert.equal(detectWake("Ouvre Chrome", "Jarvis").woke, false);
    assert.equal(detectWake("Je parlais de Jarvis hier", "Jarvis").woke, false);
    assert.equal(detectWake("Max, viens", "Mia").woke, false);
    assert.equal(detectWake("", "Jarvis").woke, false);
  });
});

describe("commandes locales", () => {
  it("oui / non seulement si une confirmation attend", () => {
    assert.equal(localIntent("Oui, vas-y.", true), "yes");
    assert.equal(localIntent("Non merci", true), "no");
    assert.equal(localIntent("Annule !", true), "no");
    assert.equal(localIntent("oui", false), "none");
    assert.equal(localIntent("Oui mais avant ouvre Spotify et mets du jazz", true), "none");
  });
  it("stop et veille", () => {
    assert.equal(localIntent("Stop.", false), "stop");
    assert.equal(localIntent("Tais-toi", false), "stop");
    assert.equal(localIntent("Mode veille", false), "sleep");
    assert.equal(localIntent("Bonne nuit !", false), "sleep");
    assert.equal(localIntent("Stoppe la musique et ferme Chrome", false), "none");
  });
});

describe("phrases fantômes et outils", () => {
  it("whisper invente des sous-titres sur le silence", () => {
    assert.equal(isPhantom("Sous-titres réalisés par la communauté d'Amara.org"), true);
    assert.equal(isPhantom("Merci d'avoir regardé cette vidéo !"), true);
    assert.equal(isPhantom("."), true);
    assert.equal(isPhantom("Ouvre le projet Pêche"), false);
  });
  it("normalisation et distance", () => {
    assert.equal(normalize("  Ça VA, Édith ?! "), "ca va edith");
    assert.equal(distance("jarvis", "jarvice"), 2);
    assert.equal(distance("abc", "abcdefgh", 2), 3);
  });
  it("salutation selon l'heure", () => {
    assert.equal(greeting(8, "Joaquine"), "Bonjour Joaquine");
    assert.equal(greeting(20, ""), "Bonsoir");
    assert.equal(greeting(2, "J"), "Il est tard J");
  });
});

describe("détection de parole", () => {
  const run = (levels: [number, number][]) => {
    const s: VadState = { startedAt: 0, voicedMs: 0 };
    return levels.map(([t, l]) => vadStep(s, t, l));
  };
  it("fin de phrase après le silence", () => {
    const steps: [number, number][] = [];
    for (let t = 0; t <= 600; t += 20) steps.push([t, 0.5]);
    for (let t = 620; t <= 2000; t += 20) steps.push([t, 0.01]);
    const out = run(steps);
    assert.equal(out.at(-1), "end");
    assert.equal(out.indexOf("end") > 0 && steps[out.indexOf("end")]![0] >= 600 + DEFAULT_VAD.silenceMs, true);
  });
  it("un clic bref ne compte pas, silence prolongé : on relance", () => {
    const steps: [number, number][] = [[0, 0], [20, 0.9], [40, 0.01]];
    for (let t = 60; t <= DEFAULT_VAD.idleMs + 100; t += 100) steps.push([t, 0.01]);
    const out = run(steps);
    assert.equal(out.includes("end"), false);
    assert.equal(out.at(-1), "restart");
  });
});
