import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import {
  API_PROVIDERS,
  describeStatus,
  hasProviderPrefix,
  listProviderModels,
  PROVIDER_IDS,
  ProviderClient,
  providerModel,
  verifyProviderKey,
} from "./api-providers.js";
import { ConfigSchema } from "./config.js";
import { OfferSchema } from "./guild.js";
import { createLlm } from "./llm-factory.js";
import { AGENT_MODEL_NAME, isCloudModel, MODEL_NAME, type ChatMessage } from "./llm.js";
import type { Memory } from "./memory.js";
import { AgentProfileSchema as ProfileSchema } from "./profiles.js";
import type { Service } from "./types.js";

const KEY = "sk-test-0123456789abcdefXYZ";
const opts = { maxTokens: 2048, timeoutMinutes: 1 };
const ui = { confirm: async () => true, progress: () => undefined } as never;

/** Faux fetch : garde chaque requête, renvoie la réponse donnée. */
function fakeFetch(reply: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return reply(url, init);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("autres fournisseurs d'IA (clé d'API)", () => {
  it("« <fournisseur>-api:<modèle> » seulement pour un fournisseur connu ; jamais confondu avec un modèle Ollama", () => {
    expect(providerModel("mistral-api:mistral-large-latest")).toEqual({ provider: "mistral", model: "mistral-large-latest" });
    expect(providerModel("openrouter-api:meta-llama/llama-3.3-70b-instruct")).toEqual({ provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct" });
    // « mistral:7b » est un modèle Ollama local, pas l'API Mistral.
    expect(providerModel("mistral:7b")).toBeUndefined();
    expect(isCloudModel("mistral:7b")).toBe(false);
    expect([providerModel("evil-api:x"), providerModel("constructor-api:x"), providerModel("openai-api:"), providerModel("openai-api:https://x")]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(hasProviderPrefix("openai-api:gpt-4.1")).toBe(true);
    expect(hasProviderPrefix("evil-api:x")).toBe(false);
  });

  it("adresses figées en https, et la fabrique choisit le bon client", () => {
    for (const id of PROVIDER_IDS) expect(API_PROVIDERS[id].baseUrl).toMatch(/^https:\/\/[a-z0-9.-]+(\/[a-z0-9]+)*$/);
    const c = createLlm(ConfigSchema.parse({}).llm, "gemini-api:gemini-2.5-flash");
    expect(c).toBeInstanceOf(ProviderClient);
    expect([c.engine, c.model]).toEqual(["api", "gemini-api:gemini-2.5-flash"]);
  });

  it("nom de modèle d'un profil : local ou fournisseur, jamais une URL ni un chemin", () => {
    for (const ok of ["qwen3:8b", "hf.co/org/repo:Q4_K_M", "claude-api:opus", "openai-api:gpt-4.1-mini", "openrouter-api:anthropic/claude-x"]) {
      expect(AGENT_MODEL_NAME.test(ok), ok).toBe(true);
    }
    for (const ko of ["openai-api:../x", "openai-api:a/../b", "http://x", "openai-api: gpt", "openai-api:/abs"]) expect(AGENT_MODEL_NAME.test(ko), ko).toBe(false);
    expect(ProfileSchema.safeParse({ id: "a", name: "A", model: "openrouter-api:meta-llama/llama-3.3-70b-instruct" }).success).toBe(true);
    // Le téléchargement de modèles locaux garde la règle stricte.
    expect(MODEL_NAME.test("openrouter-api:meta-llama/llama")).toBe(false);
  });

  it("chat : requête au format OpenAI vers l'adresse figée, clé en en-tête, pas de redirection suivie", async () => {
    const { f, calls } = fakeFetch(() =>
      json({
        choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "lire", arguments: '{"x":1}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }),
    );
    const usage: unknown[] = [];
    const c = new ProviderClient("openai", "gpt-4.1-mini", { ...opts, onUsage: (u) => usage.push(u) }, () => KEY, f);
    const tools = [{ type: "function" as const, function: { name: "lire", description: "d", parameters: { type: "object" } } }];
    const out = await c.chat([{ role: "system", content: "sys" }, { role: "user", content: "salut" }], tools);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.init.redirect).toBe("error");
    expect(calls[0]!.body).toMatchObject({ model: "gpt-4.1-mini", max_completion_tokens: 2048, stream: false, tools });
    expect(out.tool_calls).toEqual([{ function: { name: "lire", arguments: { x: 1 } } }]);
    expect(usage).toEqual([{ provider: "openai", model: "gpt-4.1-mini", input: 10, output: 3 }]);
  });

  it("les autres fournisseurs reçoivent max_tokens", async () => {
    const { f, calls } = fakeFetch(() => json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }));
    await new ProviderClient("mistral", "mistral-small-latest", opts, () => KEY, f).chat([{ role: "user", content: "x" }], []);
    expect(calls[0]!.url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(calls[0]!.body.max_tokens).toBe(2048);
    expect(calls[0]!.body.tools).toBeUndefined();
  });

  it("réponse coupée : aucun appel d'outil exécuté", async () => {
    const { f } = fakeFetch(() =>
      json({ choices: [{ finish_reason: "length", message: { content: "début", tool_calls: [{ id: "c", type: "function", function: { name: "envoyer", arguments: '{"te' } }] } }] }),
    );
    const out = await new ProviderClient("groq", "m", opts, () => KEY, f).chat([{ role: "user", content: "x" }], []);
    expect(out.tool_calls).toBeUndefined();
    expect(out.content).toContain("réponse coupée");
  });

  it("appel d'outil interrompu : un résultat est ajouté pour que la requête reste valide", async () => {
    const { f, calls } = fakeFetch(() => json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }));
    const history: ChatMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "t1", arguments: {} } }, { function: { name: "t2", arguments: {} } }] },
      { role: "tool", content: "r1", tool_name: "t1" },
      { role: "user", content: "b" },
    ];
    await new ProviderClient("deepseek", "m", opts, () => KEY, f).chat(history, []);
    const msgs = calls[0]!.body.messages as { role: string; tool_call_id?: string; content: string }[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);
    expect(msgs[3]).toMatchObject({ content: "(interrompu)" });
  });

  it("erreurs : la clé n'apparaît jamais, messages lisibles", async () => {
    const { f } = fakeFetch(() => new Response(`bad key ${KEY}`, { status: 400 }));
    const err = await new ProviderClient("xai", "m", opts, () => KEY, f).chat([{ role: "user", content: "x" }], []).catch((e: Error) => e.message);
    expect(err).not.toContain(KEY);
    expect(err).toContain("[secret]");
    const boom = (async () => {
      throw new Error(`réseau ${KEY}`);
    }) as unknown as typeof fetch;
    const err2 = await new ProviderClient("xai", "m", opts, () => KEY, boom).chat([{ role: "user", content: "x" }], []).catch((e: Error) => e.message);
    expect(err2).not.toContain(KEY);
    expect(describeStatus("openai", 401, "")).toContain("refusée");
    expect(describeStatus("openai", 429, "")).toContain("limite");
    await expect(new ProviderClient("openai", "m", opts, () => undefined, f).chat([], [])).rejects.toThrow(/aucune clé/);
  });

  it("vérification de clé : format, refus, et OpenRouter vérifie la clé elle-même", async () => {
    await expect(verifyProviderKey("openai", "avec espace 1234567890")).rejects.toThrow(/pas une clé/);
    const refused = fakeFetch(() => new Response("", { status: 401 }));
    await expect(verifyProviderKey("mistral", KEY, refused.f)).rejects.toThrow(/refusée/);
    const ok = fakeFetch(() => json({ data: {} }));
    await verifyProviderKey("openrouter", KEY, ok.f);
    expect(ok.calls[0]!.url).toBe("https://openrouter.ai/api/v1/key");
  });

  it("liste des modèles : identifiants filtrés (préfixe Gemini retiré, valeurs douteuses écartées)", async () => {
    const { f } = fakeFetch(() => json({ data: [{ id: "models/gemini-2.5-flash" }, { id: "../etc" }, { id: 42 }, { id: "gemini-2.5-flash" }, { id: "a b" }] }));
    expect(await listProviderModels("gemini", KEY, f)).toEqual(["gemini-2.5-flash"]);
  });

  it("liste des modèles : seulement ceux qui discutent (pas d'embeddings, d'images ni de voix)", async () => {
    const ids = ["models/gemini-2.5-pro", "models/text-embedding-004", "models/imagen-4.0-generate", "models/gemini-2.5-flash-preview-tts", "models/veo-3.0", "gpt-4.1-mini", "whisper-1", "dall-e-3", "omni-moderation-latest", "mistral-embed", "mistral-large-latest", "codestral-latest", "deepseek-chat", "llama-3.3-70b-versatile"];
    const { f } = fakeFetch(() => json({ data: ids.map((id) => ({ id })) }));
    expect(await listProviderModels("openai", KEY, f)).toEqual(["codestral-latest", "deepseek-chat", "gemini-2.5-pro", "gpt-4.1-mini", "llama-3.3-70b-versatile", "mistral-large-latest"]);
  });

  it("agent en ligne : pas de mémoire, et la Guilde le refuse", async () => {
    const svc = (id: string): Service => ({ id, label: id, available: async () => ({ ok: true }), tools: () => [] });
    let asked = 0;
    const memory = { contextFor: () => (asked++, "SECRET DE MÉMOIRE") } as unknown as Memory;
    const agent = new Agent(ConfigSchema.parse({}), [svc("memory"), svc("files")], { id: "o", name: "O", model: "openai-api:gpt-4.1-mini" }, { memory });
    await agent.refreshServices();
    expect(agent.statuses.map((s) => s.service.id)).toEqual(["files"]);
    let sent = "";
    (agent.client as { chat: unknown }).chat = async (messages: { content: string }[]) => {
      sent = messages.map((m) => m.content).join("\n");
      return { role: "assistant", content: "ok" };
    };
    await agent.handle("bonjour", ui);
    expect(asked).toBe(0);
    expect(sent).not.toContain("SECRET DE MÉMOIRE");
    expect(OfferSchema.safeParse({ id: "r", name: "R", model: "mistral-api:mistral-large-latest" }).success).toBe(false);
  });
});
