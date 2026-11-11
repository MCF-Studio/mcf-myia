import type { Config } from "./config.js";
import { LlamaCppClient } from "./llamacpp.js";
import { OllamaClient, type LlmClient } from "./llm.js";

/** Client du moteur actif (llm.engine) ; `model` : modèle d'un agent, sinon celui par défaut. */
export function createLlm(llm: Config["llm"], model?: string): LlmClient {
  return llm.engine === "llamacpp" ? new LlamaCppClient(llm, model ?? llm.model) : new OllamaClient({ ...llm, model: model ?? llm.model });
}
