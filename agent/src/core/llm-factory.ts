import { ProviderClient, providerModel, type ProviderOptions } from "./api-providers.js";
import { ClaudeApiClient, claudeApiAlias, type ClaudeApiOptions } from "./claude-api-llm.js";
import { ClaudeChatClient, claudeAlias } from "./claude-llm.js";
import type { Config } from "./config.js";
import { LlamaCppClient } from "./llamacpp.js";
import { OllamaClient, type LlmClient } from "./llm.js";

/**
 * Client du moteur actif (llm.engine) ; `model` : modèle d'un agent, sinon celui par défaut.
 * Un modèle d'agent « claude:<alias> » passe par Claude Code (`claudeCommand`), « claude-api:<alias> » par l'API
 * Claude avec la clé de l'utilisateur (`claudeApi`), « <fournisseur>-api:<modèle> » par l'API de ce fournisseur
 * (`providers`), quel que soit le moteur local.
 */
export function createLlm(
  llm: Config["llm"],
  model?: string,
  claudeCommand?: string,
  claudeApi?: ClaudeApiOptions,
  providers?: ProviderOptions,
): LlmClient {
  const other = providerModel(model);
  if (other) return new ProviderClient(other.provider, other.model, providers ?? { maxTokens: 8192, timeoutMinutes: 10 });
  const api = claudeApiAlias(model);
  if (api) return new ClaudeApiClient(api, claudeApi ?? { effort: "medium", maxTokens: 32_000, timeoutMinutes: 10 });
  const alias = claudeAlias(model);
  if (alias) return new ClaudeChatClient(alias, claudeCommand);
  return llm.engine === "llamacpp" ? new LlamaCppClient(llm, model ?? llm.model) : new OllamaClient({ ...llm, model: model ?? llm.model });
}
