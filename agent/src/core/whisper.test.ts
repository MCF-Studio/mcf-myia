import { describe, expect, it } from "vitest";
import { cleanTranscript, ENGINES, MODELS, transcribe } from "./whisper.js";

describe("dictée", () => {
  it("retire balises et phrases fantômes de Whisper sur un silence", () => {
    expect(cleanTranscript("[BLANK_AUDIO]")).toBe("");
    expect(cleanTranscript(" Sous-titrage ST' 501 ")).toBe("");
    expect(cleanTranscript("Merci d'avoir regardé !")).toBe("");
    expect(cleanTranscript("(musique) Lance le build du projet. [rires]")).toBe("Lance le build du projet.");
  });

  it("garde une vraie phrase qui contient « merci »", () => {
    expect(cleanTranscript("Merci de lancer le build")).toBe("Merci de lancer le build");
  });

  it("chaque fichier téléchargé a une empreinte SHA-256 figée et une source officielle", () => {
    for (const f of [...Object.values(ENGINES), ...Object.values(MODELS)]) {
      expect(f.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(f.url).toMatch(/^https:\/\/(github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/|huggingface\.co\/ggerganov\/whisper\.cpp\/)/);
    }
  });

  it("refuse un audio qui n'est pas un WAV", async () => {
    await expect(transcribe(Buffer.from("pas un wav du tout"), "fr")).rejects.toThrow(/WAV|installée/);
  });
});
