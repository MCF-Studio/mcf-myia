import { describe, expect, it } from "vitest";
import { MODELS, piperStatus, piperText, synthesize, VOICE_IDS, VOICES } from "./piper.js";

describe("voix Piper", () => {
  it("texte nettoyé : une ligne, sans caractères de contrôle, borné", () => {
    expect(piperText("Bonjour\n\tJoaquine\u0007 !")).toBe("Bonjour Joaquine !");
    expect(piperText("a".repeat(5000)).length).toBe(4000);
    expect(piperText("  \n ")).toBe("");
  });
  it("voix figées avec leurs empreintes", () => {
    expect(VOICE_IDS.slice(0, 3)).toEqual(["tom", "upmc", "siwis"]); // identifiants déjà enregistrés dans les réglages
    for (const m of Object.values(MODELS)) {
      expect(m.onnx).toMatch(/^[0-9a-f]{64}$/);
      expect(m.json).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const v of VOICE_IDS) expect(MODELS[VOICES[v].model]).toBeDefined();
  });
  it("modèle à plusieurs voix : locutrice ou locuteur explicite", () => {
    // upmc : 0 = Jessica (femme), 1 = Pierre (homme). Sans numéro, Piper lirait avec Jessica.
    expect(VOICES.upmc).toMatchObject({ model: "upmc", speaker: 1 });
    expect(VOICES.jessica).toMatchObject({ model: "upmc", speaker: 0 });
    for (const v of VOICE_IDS) if (VOICES[v].model === "upmc" || VOICES[v].model === "mls") expect("speaker" in VOICES[v]).toBe(true);
  });
  it("non installée : erreur lisible, rien n'est lancé", async () => {
    if (piperStatus().engine) return;
    await expect(synthesize("bonjour", "tom")).rejects.toThrow(/non installée/);
  });
});
