import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessageParam, BetaToolResultBlockParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ChatMessage, LlmClient, ModelInfo, RunningModel, ToolCall, ToolSpec } from "./llm.js";
import { getSecret, redact } from "./secrets.js";

/**
 * Un agent MyIA dont le « cerveau » est l'API Claude, payée avec la clé d'API de l'utilisateur (console Anthropic),
 * au lieu de l'abonnement Claude Code (claude-llm.ts) ou du modèle local.
 *
 * Comme pour claude-llm.ts, Claude ne sert QUE de modèle : seuls les outils de MyIA lui sont décrits (appel d'outils
 * natif de l'API), MyIA les exécute avec ses règles de confirmation (SPEC §3). Aucun outil serveur (web, code) n'est
 * activé côté Anthropic.
 *
 * La clé vit dans le coffre Windows (secret `anthropic_api_key`), n'est jamais renvoyée à l'interface ni écrite dans un
 * fichier, et part uniquement vers https://api.anthropic.com (adresse figée : ANTHROPIC_BASE_URL est ignorée, pour
 * qu'une variable d'environnement ne puisse pas détourner la clé).
 */

export const CLAUDE_API_PREFIX = "claude-api:";
export const API_KEY_SECRET = "anthropic_api_key";
const API_BASE_URL = "https://api.anthropic.com";

/** Alias proposés → identifiants exacts de l'API. Liste fermée : un profil ne peut pas viser un autre modèle. */
export const CLAUDE_API_MODELS = {
  haiku: { id: "claude-haiku-5-5", label: "Haiku 5.5", hint: "rapide, le moins cher (0,10 $ / 0,50 $ par million de jetons)" },
  sonnet: { id: "claude-sonnet-5-5", label: "Sonnet 5.5", hint: "polyvalent (2 $ / 10 $)" },
  opus: { id: "claude-opus-5-5", label: "Opus 5.5", hint: "raisonnement profond (4 $ / 20 $)" },
  fable: { id: "claude-fable-5-2", label: "Fable 5.2", hint: "le plus capable, le plus cher (8 $ / 40 $)" },
} as const;
export type ClaudeApiAlias = keyof typeof CLAUDE_API_MODELS;

/** « claude-api:sonnet » → « sonnet » ; undefined pour tout autre nom. */
export function claudeApiAlias(model: string | undefined): ClaudeApiAlias | undefined {
  if (!model?.startsWith(CLAUDE_API_PREFIX)) return undefined;
  const alias = model.slice(CLAUDE_API_PREFIX.length);
  return Object.hasOwn(CLAUDE_API_MODELS, alias) ? (alias as ClaudeApiAlias) : undefined;
}

/** Forme d'une clé d'API Anthropic (vérifiée avant tout appel réseau). */
export const API_KEY_FORMAT = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;

export function apiKeyStatus(): { configured: boolean; hint?: string } {
  const k = getSecret(API_KEY_SECRET);
  // Seuls les 4 derniers caractères sont montrés, pour reconnaître la clé sans l'exposer.
  return k ? { configured: true, hint: `…${k.slice(-4)}` } : { configured: false };
}

export function makeClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, baseURL: API_BASE_URL, maxRetries: 2 });
}

/** Vérifie une clé auprès de l'API sans consommer de jetons (liste des modèles). */
export async function verifyApiKey(apiKey: string, signal?: AbortSignal): Promise<void> {
  if (!API_KEY_FORMAT.test(apiKey)) throw new Error("ce n'est pas une clé d'API Anthropic (elle commence par sk-ant-)");
  try {
    await makeClient(apiKey).models.list({ limit: 1 }, { signal, timeout: 15_000 });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error("clé refusée par Anthropic (révoquée ou mal copiée)");
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error("cette clé n'a pas accès à l'API Messages");
    throw new Error(`vérification impossible : ${redact((e as Error).message, apiKey)}`);
  }
}

/** Modèles qui acceptent le repli côté serveur en cas de refus de sécurité (pas Haiku). */
const SERVER_FALLBACK: ReadonlySet<ClaudeApiAlias> = new Set(["sonnet", "opus", "fable"]);

/** Blocs à ne pas renvoyer s'ils précèdent un bloc `fallback` (repli en cours de réponse). */
const DROP_BEFORE_FALLBACK = new Set(["thinking", "redacted_thinking", "tool_use", "server_tool_use"]);

/** Contenu de la réponse tel qu'il doit être renvoyé à l'API au tour suivant. */
export function replayableBlocks(content: BetaContentBlock[]): BetaContentBlock[] {
  const boundary = content.map((b) => b.type as string).lastIndexOf("fallback");
  if (boundary < 0) return content;
  return content.filter((b, i) => i >= boundary || !DROP_BEFORE_FALLBACK.has(b.type));
}

const toolId = (i: number, j: number) => `toolu_myia_${i}_${j}`;

/**
 * Historique MyIA → messages de l'API.
 * - Les blocs d'origine (réflexion signée comprise) ne sont renvoyés que pour les réponses qui suivent le DERNIER
 *   message de l'utilisateur : le prompt système change d'une demande à l'autre (date, services), ce qui invaliderait
 *   les réflexions plus anciennes. Retirer toutes les réflexions de tête est permis par l'API.
 * - Un historique sans identifiants d'appel (conversation commencée sur un autre moteur) reçoit des identifiants
 *   synthétiques, appariés dans l'ordre.
 */
export function toApiMessages(messages: ChatMessage[]): BetaMessageParam[] {
  const history = messages.filter((m) => m.role !== "system");
  let lastUser = -1;
  history.forEach((m, i) => m.role === "user" && (lastUser = i));

  const out: BetaMessageParam[] = [];
  const push = (role: "user" | "assistant", blocks: BetaMessageParam["content"] & unknown[]) => {
    if (!blocks.length) return;
    const prev = out.at(-1);
    // Deux messages consécutifs du même rôle sont fusionnés (l'API veut une alternance).
    if (prev && prev.role === role && Array.isArray(prev.content)) (prev.content as unknown[]).push(...blocks);
    else out.push({ role, content: blocks } as BetaMessageParam);
  };

  let pending: { ids: string[]; next: number } = { ids: [], next: 0 };
  history.forEach((m, i) => {
    if (m.role === "user") {
      push("user", m.content.trim() ? [{ type: "text", text: m.content }] : []);
      return;
    }
    if (m.role === "tool") {
      const id = m.tool_call_id ?? pending.ids[pending.next];
      pending.next++;
      if (!id) {
        // Résultat sans appel correspondant : passé en texte pour ne pas casser la requête.
        push("user", [{ type: "text", text: `<resultat_outil nom="${m.tool_name ?? "?"}">\n${m.content}\n</resultat_outil>` }]);
        return;
      }
      const block: BetaToolResultBlockParam = { type: "tool_result", tool_use_id: id, content: m.content || "(vide)" };
      push("user", [block]);
      return;
    }
    // Assistant.
    if (i > lastUser && Array.isArray(m.blocks) && m.blocks.length) {
      const blocks = m.blocks as BetaContentBlock[];
      pending = { ids: blocks.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id), next: 0 };
      push("assistant", blocks as never);
      return;
    }
    const calls = m.tool_calls ?? [];
    const ids = calls.map((c, j) => c.id ?? toolId(i, j));
    pending = { ids, next: 0 };
    push("assistant", [
      ...(m.content.trim() ? [{ type: "text" as const, text: m.content }] : []),
      ...calls.map((c, j) => ({
        type: "tool_use" as const,
        id: ids[j]!,
        name: c.function.name,
        input: (typeof c.function.arguments === "string" ? safeJson(c.function.arguments) : c.function.arguments) ?? {},
      })),
    ]);
  });
  // Un appel d'outil resté sans résultat (demande interrompue) ferait refuser la requête : on le clôt.
  return closeDanglingToolUses(out);
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function closeDanglingToolUses(msgs: BetaMessageParam[]): BetaMessageParam[] {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const uses = (m.content as { type: string; id?: string }[]).filter((b) => b.type === "tool_use").map((b) => b.id!);
    if (!uses.length) continue;
    const next = msgs[i + 1];
    const answered = new Set(
      next && Array.isArray(next.content) ? (next.content as { type: string; tool_use_id?: string }[]).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id) : [],
    );
    const missing = uses.filter((id) => !answered.has(id));
    if (!missing.length) continue;
    const results = missing.map((id) => ({ type: "tool_result" as const, tool_use_id: id, content: "(interrompu)", is_error: true }));
    if (next && next.role === "user" && Array.isArray(next.content)) (next.content as unknown[]).unshift(...results);
    else msgs.splice(i + 1, 0, { role: "user", content: results });
  }
  return msgs;
}

export function toApiTools(tools: ToolSpec[]): BetaToolUnion[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: { type: "object", ...t.function.parameters } as { type: "object" },
    // Arguments diffusés au fil de l'eau : MyIA les valide de toute façon (zod) avant d'exécuter l'outil.
    eager_input_streaming: true,
  }));
}

export interface ClaudeApiOptions {
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
  timeoutMinutes: number;
  /** Consommation de chaque appel (journal d'audit). */
  onUsage?: (u: { model: string; input: number; output: number; cacheRead: number; cacheWrite: number }) => void;
}

export class ClaudeApiClient implements LlmClient {
  readonly engine = "claude-api" as const;
  readonly model: string;

  constructor(
    private readonly alias: ClaudeApiAlias,
    private readonly opts: ClaudeApiOptions,
    private readonly keyOf: () => string | undefined = () => getSecret(API_KEY_SECRET),
  ) {
    this.model = CLAUDE_API_PREFIX + alias;
  }

  private key(): string {
    const k = this.keyOf();
    if (!k) throw new Error("aucune clé d'API Anthropic : ajoute-la dans Paramètres → Claude (clé d'API)");
    return k;
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal): Promise<ChatMessage> {
    const key = this.key();
    const model = CLAUDE_API_MODELS[this.alias].id;
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const fallback = SERVER_FALLBACK.has(this.alias);
    try {
      const stream = makeClient(key).beta.messages.stream(
        {
          model,
          max_tokens: this.opts.maxTokens,
          ...(system ? { system } : {}),
          messages: toApiMessages(messages),
          ...(tools.length ? { tools: toApiTools(tools) } : {}),
          output_config: { effort: this.opts.effort },
          // Cache automatique du préfixe (outils + système + historique) : les étapes d'une même demande coûtent moins.
          cache_control: { type: "ephemeral" },
          ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal, timeout: this.opts.timeoutMinutes * 60_000 },
      );
      const msg = await stream.finalMessage();
      this.opts.onUsage?.({
        model: msg.model,
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens,
        cacheRead: msg.usage.cache_read_input_tokens ?? 0,
        cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
      });

      if (msg.stop_reason === "refusal") {
        throw new Error("Claude a refusé cette demande (filtre de sécurité d'Anthropic). Reformule-la ou confie-la à un autre agent.");
      }
      const blocks = replayableBlocks(msg.content);
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n")
        .trim();
      const uses = blocks.filter((b) => b.type === "tool_use") as { id: string; name: string; input: unknown }[];
      if (msg.stop_reason === "max_tokens") {
        // Réponse coupée : un appel d'outil peut être tronqué, on n'exécute rien.
        return { role: "assistant", content: (text ? text + "\n\n" : "") + "(réponse coupée : limite de longueur atteinte)" };
      }
      const calls: ToolCall[] = uses.map((u) => ({
        id: u.id,
        function: { name: u.name, arguments: u.input && typeof u.input === "object" ? (u.input as Record<string, unknown>) : {} },
      }));
      return { role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}), blocks };
    } catch (e) {
      if (signal?.aborted) throw new Error("annulé");
      throw new Error(describeError(e, key));
    }
  }

  // ─── Gestion de modèles : sans objet (rien d'installé localement) ───
  async ping(): Promise<boolean> {
    return !!this.keyOf();
  }
  async version(): Promise<string> {
    return "API Claude";
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
    throw new Error("un modèle Claude ne se télécharge pas");
  }
  async deleteModel(): Promise<void> {
    throw new Error("un modèle Claude ne se supprime pas");
  }
  async unload(): Promise<void> {}
  async ensureRunning(): Promise<void> {
    this.key();
  }
  async warmUp(): Promise<void> {}
}

/** Message d'erreur lisible, sans jamais la clé. */
export function describeError(e: unknown, key?: string): string {
  const clean = (s: string) => redact(s, key).slice(0, 400);
  if (e instanceof Anthropic.AuthenticationError) return "clé d'API Anthropic refusée (révoquée ?) : remplace-la dans Paramètres → Claude";
  if (e instanceof Anthropic.PermissionDeniedError) return "la clé d'API n'a pas accès à ce modèle";
  if (e instanceof Anthropic.RateLimitError) return "limite de débit de l'API Claude atteinte : réessaie dans un moment";
  if (e instanceof Anthropic.BadRequestError) {
    const m = (e as Error).message;
    if (/credit balance|billing/i.test(m)) return "crédit de l'API Claude épuisé : recharge-le sur platform.claude.com";
    return `requête refusée par l'API Claude : ${clean(m)}`;
  }
  if (e instanceof Anthropic.InternalServerError) return "l'API Claude est indisponible pour le moment (erreur serveur)";
  if (e instanceof Anthropic.APIConnectionError) return "impossible de joindre api.anthropic.com (réseau)";
  return clean((e as Error)?.message ?? String(e));
}
