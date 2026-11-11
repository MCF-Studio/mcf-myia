import { describe, expect, it } from "vitest";
import { engineEnv } from "./llm.js";

describe("réglages du moteur llama.cpp d'Ollama", () => {
  it("par défaut : flash attention et contexte compressé en q8", () => {
    expect(engineEnv({ flashAttention: true, kvCache: "q8_0" }, {})).toEqual({ OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0" });
  });

  it("la compression impose flash attention ; sans compression, flash attention peut être coupée", () => {
    expect(engineEnv({ flashAttention: false, kvCache: "q4_0" }, {})).toEqual({ OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q4_0" });
    expect(engineEnv({ flashAttention: false, kvCache: "f16" }, {})).toEqual({ OLLAMA_FLASH_ATTENTION: "0" });
  });

  it("une variable déjà posée dans Windows reste prioritaire", () => {
    expect(engineEnv({ flashAttention: true, kvCache: "q8_0" }, { OLLAMA_KV_CACHE_TYPE: "f16", OLLAMA_FLASH_ATTENTION: "1" })).toEqual({});
  });
});
