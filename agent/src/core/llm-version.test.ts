import { describe, expect, it } from "vitest";
import { findOllama, MIN_OLLAMA, versionAtLeast } from "./llm.js";

describe("version d'Ollama", () => {
  it("compare les versions numériquement, pas comme du texte", () => {
    expect(versionAtLeast("0.40.16", MIN_OLLAMA)).toBe(true);
    expect(versionAtLeast("0.12.0", "0.12.0")).toBe(true);
    expect(versionAtLeast("0.5.13", MIN_OLLAMA)).toBe(false);
    expect(versionAtLeast("0.9.6", "0.12.0")).toBe(false);
    expect(versionAtLeast("1.0", "0.12.0")).toBe(true);
    expect(versionAtLeast("illisible", "0.12.0")).toBe(false);
  });

  it("choisit l'Ollama le plus récent présent sur la machine", () => {
    const found = findOllama();
    if (found) expect(versionAtLeast(found.version, "0.0.1")).toBe(true);
  });
});
