import { describe, expect, it } from "vitest";
import { registryManifestUrl } from "./llm.js";

describe("registre Ollama : adresse du manifeste", () => {
  it("modèle officiel, avec ou sans taille", () => {
    expect(registryManifestUrl("qwen3:8b")).toBe("https://registry.ollama.ai/v2/library/qwen3/manifests/8b");
    expect(registryManifestUrl("gemma3")).toBe("https://registry.ollama.ai/v2/library/gemma3/manifests/latest");
  });

  it("modèle d'un utilisateur du registre", () => {
    expect(registryManifestUrl("someone/model:q4")).toBe("https://registry.ollama.ai/v2/someone/model/manifests/q4");
  });

  it("pas de vérification hors registre Ollama ni pour un nom invalide", () => {
    expect(registryManifestUrl("hf.co/org/depot:Q4_K_M")).toBeUndefined();
    expect(registryManifestUrl("hf.co/org/depot/fichier.gguf")).toBeUndefined();
    expect(registryManifestUrl("../../etc")).toBeUndefined();
  });
});
