import type { ChatMessage, LlmClient, ModelInfo, RunningModel, ToolSpec } from "./llm.js";
import { fromOpenAI, toOpenAI } from "./llamacpp.js";
import { getSecret, redact } from "./secrets.js";

/**
 * Agents dont le « cerveau » est l'API d'un autre fournisseur d'IA (OpenAI, Google Gemini, Mistral, OpenRouter, Groq,
 * DeepSeek, xAI), payée avec la clé d'API de l'utilisateur. Tous parlent le format « chat completions » d'OpenAI.
 *
 * Même principe que l'agent sur l'API Claude (claude-api-llm.ts, SPEC §3 bis) :
 * - le modèle distant ne fait que CHOISIR des outils de MyIA ; MyIA les exécute avec ses règles de confirmation ;
 * - la clé vit dans le coffre Windows (`<fournisseur>_api_key`), n'est jamais renvoyée à l'interface ni écrite dans un
 *   fichier, et ne part que vers l'adresse FIGÉE du fournisseur (liste fermée ci-dessous : ni la config, ni une variable
 *   d'environnement, ni le modèle ne peuvent la détourner vers un autre serveur) ;
 * - un agent sur ces modèles est « en ligne » : ni mémoire, ni Guilde (isCloudModel).
 *
 * Nom de modèle dans un profil : « <fournisseur>-api:<identifiant du modèle> », ex. « openai-api:gpt-4.1-mini ».
 * Le suffixe « -api » évite toute confusion avec un modèle Ollama (« mistral:7b » est un modèle local).
 */

export interface ApiProvider {
  label: string;
  /** Adresse de base de l'API compatible OpenAI (https, sans / final). Figée. */
  baseUrl: string;
  /** Où créer une clé (affiché dans Paramètres). */
  keysUrl: string;
  /** Vérification de la clé : GET relatif à baseUrl, sans consommer de jetons. */
  verifyPath: string;
  /** Nom du paramètre de longueur de réponse (OpenAI a renommé max_tokens). */
  maxTokensParam: "max_tokens" | "max_completion_tokens";
  hint: string;
}

export const API_PROVIDERS = {
  openai: {
    label: "OpenAI (ChatGPT)",
    baseUrl: "https://api.openai.com/v1",
    keysUrl: "https://platform.openai.com/api-keys",
    verifyPath: "/models",
    maxTokensParam: "max_completion_tokens",
    hint: "modèles GPT ; facturé à l'usage",
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keysUrl: "https://aistudio.google.com/apikey",
    verifyPath: "/models",
    maxTokensParam: "max_tokens",
    hint: "palier gratuit limité chez Google AI Studio",
  },
  mistral: {
    label: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    keysUrl: "https://console.mistral.ai/api-keys",
    verifyPath: "/models",
    maxTokensParam: "max_tokens",
    hint: "fournisseur français",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keysUrl: "https://openrouter.ai/settings/keys",
    // La liste des modèles d'OpenRouter est publique : on vérifie la clé elle-même.
    verifyPath: "/key",
    maxTokensParam: "max_tokens",
    hint: "une seule clé pour des centaines de modèles",
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keysUrl: "https://console.groq.com/keys",
    verifyPath: "/models",
    maxTokensParam: "max_tokens",
    hint: "modèles ouverts très rapides",
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keysUrl: "https://platform.deepseek.com/api_keys",
    verifyPath: "/models",
    maxTokensParam: "max_tokens",
    hint: "peu coûteux",
  },
  xai: {
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    keysUrl: "https://console.x.ai",
    verifyPath: "/models",
    maxTokensParam: "max_tokens",
    hint: "modèles Grok",
  },
} as const satisfies Record<string, ApiProvider>;

export type ProviderId = keyof typeof API_PROVIDERS;
export const PROVIDER_IDS = Object.keys(API_PROVIDERS) as ProviderId[];

/** Identifiant de modèle chez un fournisseur (ex. gpt-4.1-mini, mistral-large-latest, meta-llama/llama-3.3-70b). */
export const PROVIDER_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,119}$/;
/** Forme d'une clé d'API : pas d'espace ni de caractère de contrôle (les préfixes changent d'un fournisseur à l'autre). */
export const PROVIDER_KEY_FORMAT = /^[A-Za-z0-9_.\-]{16,400}$/;

export const providerSecret = (p: ProviderId) => `${p}_api_key`;

/** « mistral-api:mistral-large-latest » → { provider: "mistral", model: "mistral-large-latest" } ; undefined sinon. */
export function providerModel(model: string | undefined): { provider: ProviderId; model: string } | undefined {
  const m = /^([a-z]+)-api:(.+)$/.exec(model ?? "");
  if (!m) return undefined;
  const [, provider, id] = m as unknown as [string, string, string];
  if (!Object.hasOwn(API_PROVIDERS, provider) || !PROVIDER_MODEL_ID.test(id)) return undefined;
  return { provider: provider as ProviderId, model: id };
}

/** Préfixe « <fournisseur>-api: » connu (même si l'identifiant du modèle est invalide) : sert à classer « en ligne ». */
export function hasProviderPrefix(model: string | undefined): boolean {
  const m = /^([a-z]+)-api:/.exec(model ?? "");
  return !!m && Object.hasOwn(API_PROVIDERS, m[1]!);
}

export function providerKeyStatus(p: ProviderId, keyOf = getSecret): { configured: boolean; hint?: string } {
  const k = keyOf(providerSecret(p));
  return k ? { configured: true, hint: `…${k.slice(-4)}` } : { configured: false };
}

type Fetch = typeof fetch;

async function call(p: ProviderId, key: string, path: string, init: RequestInit & { timeoutMs: number }, doFetch: Fetch = fetch): Promise<Response> {
  const timeout = AbortSignal.timeout(init.timeoutMs);
  return doFetch(API_PROVIDERS[p].baseUrl + path, {
    ...init,
    // Pas de redirection suivie : la clé ne doit partir que vers l'adresse figée.
    redirect: "error",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
}

/** Vérifie une clé auprès du fournisseur sans consommer de jetons. */
export async function verifyProviderKey(p: ProviderId, key: string, doFetch: Fetch = fetch): Promise<void> {
  if (!PROVIDER_KEY_FORMAT.test(key)) throw new Error("ce n'est pas une clé d'API valide (copie-la sans espace)");
  let r: Response;
  try {
    r = await call(p, key, API_PROVIDERS[p].verifyPath, { method: "GET", timeoutMs: 15_000 }, doFetch);
  } catch (e) {
    throw new Error(`vérification impossible : ${redact((e as Error).message, key)}`);
  }
  if (r.status === 401 || r.status === 403) throw new Error(`clé refusée par ${API_PROVIDERS[p].label} (révoquée ou mal copiée)`);
  if (!r.ok) throw new Error(`vérification impossible : ${API_PROVIDERS[p].label} a répondu ${r.status}`);
}

/** Modèles disponibles avec cette clé (identifiants filtrés, liste bornée). */
export async function listProviderModels(p: ProviderId, key: string, doFetch: Fetch = fetch): Promise<string[]> {
  let r: Response;
  try {
    r = await call(p, key, "/models", { method: "GET", timeoutMs: 20_000 }, doFetch);
  } catch (e) {
    throw new Error(`liste des modèles indisponible : ${redact((e as Error).message, key)}`);
  }
  if (!r.ok) throw new Error(`liste des modèles indisponible (${API_PROVIDERS[p].label} : ${r.status})`);
  const data = (await r.json()) as { data?: { id?: unknown }[] };
  const ids = (data.data ?? [])
    .map((m) => (typeof m.id === "string" ? m.id.replace(/^models\//, "") : ""))
    .filter((id) => PROVIDER_MODEL_ID.test(id) && isChatModel(id));
  return [...new Set(ids)].sort().slice(0, 1000);
}

/**
 * Les fournisseurs listent aussi des modèles qui ne discutent pas (vecteurs, images, voix, modération) : choisis pour
 * un agent, ils feraient échouer chaque demande. On ne garde que ceux qui peuvent répondre dans une conversation.
 */
export function isChatModel(id: string): boolean {
  return !/(embed|embedding|tts|whisper|transcribe|dall-e|imagen|image-generation|veo|lyria|moderation|^text-|babbage|davinci|aqa|audio|realtime|speech|rerank|ocr|guard)/i.test(id);
}

/** Un appel d'outil resté sans résultat (demande interrompue) ferait refuser la requête : on le clôt. */
function closeDangling(msgs: ReturnType<typeof toOpenAI>): ReturnType<typeof toOpenAI> {
  const out: ReturnType<typeof toOpenAI> = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < msgs.length && msgs[j]!.role === "tool"; j++) answered.add(msgs[j]!.tool_call_id ?? "");
    const missing = m.tool_calls.filter((c) => !answered.has(c.id));
    // Les résultats présents suivent ; les manquants sont ajoutés juste après eux.
    let j = i + 1;
    while (j < msgs.length && msgs[j]!.role === "tool") out.push(msgs[j++]!);
    for (const c of missing) out.push({ role: "tool", content: "(interrompu)", tool_call_id: c.id });
    i = j - 1;
  }
  return out;
}

export interface ProviderOptions {
  maxTokens: number;
  timeoutMinutes: number;
  /** Consommation de chaque appel (journal d'audit). */
  onUsage?: (u: { provider: ProviderId; model: string; input: number; output: number }) => void;
}

export class ProviderClient implements LlmClient {
  readonly engine = "api" as const;
  readonly model: string;

  constructor(
    private readonly provider: ProviderId,
    private readonly modelId: string,
    private readonly opts: ProviderOptions,
    private readonly keyOf: () => string | undefined = () => getSecret(providerSecret(provider)),
    private readonly doFetch: Fetch = fetch,
  ) {
    this.model = `${provider}-api:${modelId}`;
  }

  private key(): string {
    const k = this.keyOf();
    if (!k) throw new Error(`aucune clé d'API ${API_PROVIDERS[this.provider].label} : ajoute-la dans Paramètres → Autres IA`);
    return k;
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal, opts: { format?: "json"; temperature?: number } = {}): Promise<ChatMessage> {
    const key = this.key();
    const p = API_PROVIDERS[this.provider];
    let r: Response;
    try {
      r = await call(
        this.provider,
        key,
        "/chat/completions",
        {
          method: "POST",
          timeoutMs: this.opts.timeoutMinutes * 60_000,
          signal,
          body: JSON.stringify({
            model: this.modelId,
            messages: closeDangling(toOpenAI(messages)),
            ...(tools.length ? { tools } : {}),
            stream: false,
            [p.maxTokensParam]: this.opts.maxTokens,
            ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
            ...(opts.format === "json" ? { response_format: { type: "json_object" } } : {}),
          }),
        },
        this.doFetch,
      );
    } catch (e) {
      if (signal?.aborted) throw new Error("annulé");
      throw new Error(`impossible de joindre ${p.label} : ${redact((e as Error).message, key).slice(0, 300)}`);
    }
    if (!r.ok) throw new Error(describeStatus(this.provider, r.status, redact(await r.text().catch(() => ""), key)));
    const data = (await r.json()) as {
      choices?: { message?: Parameters<typeof fromOpenAI>[0]; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    this.opts.onUsage?.({ provider: this.provider, model: this.modelId, input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 });
    const choice = data.choices?.[0];
    if (!choice?.message) throw new Error(`réponse de ${p.label} sans message`);
    if (choice.finish_reason === "length") {
      // Réponse coupée : un appel d'outil peut être tronqué, on n'exécute rien.
      const text = (choice.message.content ?? "").trim();
      return { role: "assistant", content: (text ? text + "\n\n" : "") + "(réponse coupée : limite de longueur atteinte)" };
    }
    if (choice.finish_reason === "content_filter") throw new Error(`${p.label} a refusé cette demande (filtre de sécurité du fournisseur)`);
    return fromOpenAI(choice.message);
  }

  // ─── Gestion de modèles : sans objet (rien d'installé localement) ───
  async ping(): Promise<boolean> {
    return !!this.keyOf();
  }
  async version(): Promise<string> {
    return API_PROVIDERS[this.provider].label;
  }
  async hasModel(): Promise<boolean> {
    return true;
  }
  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
  async runningModels(): Promise<RunningModel[]> {
    return [];
  }
  async pull(): Promise<void> {
    throw new Error("un modèle en ligne ne se télécharge pas");
  }
  async deleteModel(): Promise<void> {
    throw new Error("un modèle en ligne ne se supprime pas");
  }
  async unload(): Promise<void> {}
  async ensureRunning(): Promise<void> {
    this.key();
  }
  async warmUp(): Promise<void> {}
}

/** Message d'erreur lisible (le texte du fournisseur est déjà débarrassé de la clé). */
export function describeStatus(p: ProviderId, status: number, body: string): string {
  const label = API_PROVIDERS[p].label;
  if (status === 401) return `clé d'API ${label} refusée (révoquée ?) : remplace-la dans Paramètres → Autres IA`;
  if (status === 402) return `crédit ${label} épuisé : recharge ton compte chez le fournisseur`;
  if (status === 403) return `la clé ${label} n'a pas accès à ce modèle`;
  if (status === 404) return `modèle inconnu chez ${label} : choisis-en un dans la liste de l'écran Agents`;
  if (status === 429) return `limite de débit ou quota ${label} atteint : réessaie dans un moment`;
  if (status >= 500) return `${label} est indisponible pour le moment (erreur ${status})`;
  return `requête refusée par ${label} (${status}) : ${body.slice(0, 300)}`;
}
