import { describe, expect, it } from "vitest";
import { piperStatus, piperText, synthesize, VOICE_IDS, VOICES } from "./piper.js";

describe("voix Piper", () => {
  it("texte nettoyé : une ligne, sans caractères de contrôle, borné", () => {
    expect(piperText("Bonjour\n\tJoaquine\u0007 !")).toBe("Bonjour Joaquine !");
    expect(piperText("a".repeat(5000)).length).toBe(4000);
    expect(piperText("  \n ")).toBe("");
  });
  it("voix figées avec leurs empreintes", () => {
    expect(VOICE_IDS).toEqual(["tom", "upmc", "siwis"]);
    for (const v of VOICE_IDS) {
      expect(VOICES[v].onnx).toMatch(/^[0-9a-f]{64}$/);
      expect(VOICES[v].json).toMatch(/^[0-9a-f]{64}$/);
    }
  });
  it("non installée : erreur lisible, rien n'est lancé", async () => {
    if (piperStatus().engine) return;
    await expect(synthesize("bonjour", "tom")).rejects.toThrow(/non installée/);
  });
});
