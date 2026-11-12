import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { paths } from "./paths.js";

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> | string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ModelInfo {
  name: string;
  size: number;
  modifiedAt: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
}

export interface RunningModel {
  name: string;
  size: number;
  sizeVram: number;
  expiresAt?: string;
}

export interface PullProgress {
  status: string;
  total?: number;
  completed?: number;
}

/**
 * Ce que MyIA attend d'un moteur (Ollama ou llama.cpp en local ; « claude » pour un agent confié à Claude, voir
 * claude-llm.ts) : mêmes messages, mêmes outils, même gestion des modèles.
 */
export interface LlmClient {
  readonly engine: "ollama" | "llamacpp" | "claude";
  /** Modèle effectivement utilisé par ce client. */
  readonly model: string;
  ping(): Promise<boolean>;
  version(): Promise<string>;
  hasModel(model?: string): Promise<boolean>;
  listModels(): Promise<ModelInfo[]>;
  runningModels(): Promise<RunningModel[]>;
  pull(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void>;
  deleteModel(model: string): Promise<void>;
  unload(model: string): Promise<void>;
  ensureRunning(): Promise<void>;
  warmUp(): Promise<void>;
  chat(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal, opts?: { format?: "json"; temperature?: number }): Promise<ChatMessage>;
}

/** Nom de modèle Ollama accepté (ex. qwen3:8b, hf.co/org/repo:Q4_K_M). Bloque tout ce qui ressemble à une URL ou un chemin. */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)*(:[A-Za-z0-9._-]+)?$/;

/** Contexte donné à Claude Code en local (son prompt seul fait ~15 k tokens). Même valeur côté Rust (pty.rs). */
export const CLAUDE_LOCAL_CTX = 32_768;

/**
 * Variante Ollama d'un modèle pour Claude Code : même poids (rien n'est copié), contexte de CLAUDE_LOCAL_CTX.
 * Même calcul côté Rust (pty.rs, local_model_name) : « myia-claude:<modèle, caractères hors [A-Za-z0-9._-] en -> ».
 */
export function claudeLocalOllamaModel(model: string): string {
  return `myia-claude:${model.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100)}`;
}

/** Version minimale d'Ollama : en dessous, les modèles récents (Qwen3…) ne se chargent pas. */
export const MIN_OLLAMA = "0.12.0";

/** Compare deux versions « a.b.c » ; texte illisible = 0.0.0. */
export function versionAtLeast(v: string, min: string): boolean {
  const n = (x: string) => (/(\d+)\.(\d+)(?:\.(\d+))?/.exec(x)?.slice(1) ?? []).map((p) => Number(p ?? 0));
  const [a, b] = [n(v), n(min)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** Version d'un exécutable Ollama (« ollama version is X » ; sans serveur lancé, « client version is X »). */
function exeVersion(exe: string): string {
  try {
    const out = execFileSync(exe, ["--version"], { timeout: 5000, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return /client version is ([\d.]+)/.exec(out)?.[1] ?? /version is ([\d.]+)/.exec(out)?.[1] ?? "0.0.0";
  } catch (e) {
    const out = String((e as { stdout?: string }).stdout ?? "") + String((e as { stderr?: string }).stderr ?? "");
    return /client version is ([\d.]+)/.exec(out)?.[1] ?? /version is ([\d.]+)/.exec(out)?.[1] ?? "0.0.0";
  }
}

/**
 * Ollama à lancer : le PLUS RÉCENT parmi celui de runtime\ollama, l'installation standard et le PATH (un vieil Ollama
 * installé sur le PC ne doit pas passer avant un récent). Undefined si aucun, ou si tous sont trop anciens.
 */
export function findOllama(): { exe: string; bundled: boolean; version: string } | undefined {
  const exe = process.platform === "win32" ? "ollama.exe" : "ollama";
  const candidates = [
    paths.ollamaExe,
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", exe)] : []),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe)),
  ];
  const seen = new Set<string>();
  let best: { exe: string; bundled: boolean; version: string } | undefined;
  for (const c of candidates) {
    const key = path.resolve(c).toLowerCase();
    if (seen.has(key) || !fs.existsSync(c)) continue;
    seen.add(key);
    const version = exeVersion(c);
    if (!best || !versionAtLeast(best.version, version)) best = { exe: c, bundled: path.resolve(c) === path.resolve(paths.ollamaExe), version };
  }
  return best;
}

/**
 * Variables du moteur llama.cpp d'Ollama (flash attention, compression du cache de contexte). Une variable déjà posée
 * dans l'environnement de Windows garde la priorité : c'est un choix explicite de l'utilisateur.
 */
export function engineEnv(cfg: Pick<Config["llm"], "flashAttention" | "kvCache">, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const flash = cfg.flashAttention || cfg.kvCache !== "f16";
  if (env.OLLAMA_FLASH_ATTENTION === undefined) out.OLLAMA_FLASH_ATTENTION = flash ? "1" : "0";
  if (env.OLLAMA_KV_CACHE_TYPE === undefined && flash) out.OLLAMA_KV_CACHE_TYPE = cfg.kvCache;
  return out;
}

function tooOld(version: string, exe?: string): string {
  return (
    `Ollama ${version} est trop ancien pour ce modèle (${MIN_OLLAMA} au moins)${exe ? ` : ${exe}` : ""}. ` +
    "Mets-le à jour depuis Paramètres → Système (bouton Mettre à jour) ou https://ollama.com/download, ou passe le moteur sur llama.cpp (Paramètres → Système)."
  );
}

/**
 * Adresse du manifeste d'un modèle sur le registre public d'Ollama. Le registre n'a pas de catalogue à lister, mais il
 * dit si un nom précis existe. `undefined` = nom hors registre Ollama (ex. hf.co/…) : pas de vérification possible.
 */
export function registryManifestUrl(model: string): string | undefined {
  if (!MODEL_NAME.test(model)) return undefined;
  const colon = model.lastIndexOf(":");
  const repo = colon >= 0 ? model.slice(0, colon) : model;
  const tag = colon >= 0 ? model.slice(colon + 1) : "latest";
  const parts = repo.split("/");
  if (parts.length > 2 || (parts.length === 2 && parts[0]!.includes("."))) return undefined;
  const [ns, name] = parts.length === 2 ? parts : ["library", parts[0]];
  return `https://registry.ollama.ai/v2/${ns}/${name}/manifests/${tag}`;
}

/** Faux seulement si le registre répond clairement que le modèle n'existe pas ; hors ligne ou erreur = on laisse Ollama décider. */
export async function existsInRegistry(model: string, signal?: AbortSignal): Promise<boolean> {
  const url = registryManifestUrl(model);
  if (!url) return true;
  try {
    const r = await fetch(url, {
      method: "HEAD",
      headers: { accept: "application/vnd.docker.distribution.manifest.v2+json" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    });
    return r.status !== 404;
  } catch {
    return true;
  }
}

/** Client minimal de l'API native d'Ollama (/api/chat). */
export class OllamaClient implements LlmClient {
  readonly engine = "ollama" as const;
  constructor(private readonly cfg: Config["llm"]) {}

  get model() {
    return this.cfg.model;
  }

  private url(p: string) {
    return this.cfg.baseUrl.replace(/\/$/, "") + p;
  }

  async ping(): Promise<boolean> {
    try {
      const r = await fetch(this.url("/api/version"), { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async version(): Promise<string> {
    const r = await fetch(this.url("/api/version"), { signal: AbortSignal.timeout(2000) });
    return ((await r.json()) as { version?: string }).version ?? "?";
  }

  async hasModel(model = this.cfg.model): Promise<boolean> {
    const models = await this.listModels();
    return models.some((m) => m.name === model || m.name === `${model}:latest`);
  }

  async listModels(): Promise<ModelInfo[]> {
    const r = await fetch(this.url("/api/tags"), { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    const data = (await r.json()) as {
      models?: {
        name: string;
        size: number;
        modified_at: string;
        details?: { family?: string; parameter_size?: string; quantization_level?: string };
      }[];
    };
    return (data.models ?? []).map((m) => ({
      name: m.name,
      size: m.size,
      modifiedAt: m.modified_at,
      family: m.details?.family,
      parameterSize: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
    }));
  }

  /** Modèles actuellement chargés en mémoire (VRAM/RAM). */
  async runningModels(): Promise<RunningModel[]> {
    const r = await fetch(this.url("/api/ps"), { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    const data = (await r.json()) as { models?: { name: string; size: number; size_vram: number; expires_at?: string }[] };
    return (data.models ?? []).map((m) => ({ name: m.name, size: m.size, sizeVram: m.size_vram, expiresAt: m.expires_at }));
  }

  /** Télécharge un modèle depuis le registre Ollama, en remontant la progression. */
  async pull(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    if (!MODEL_NAME.test(model)) throw new Error(`nom de modèle invalide : ${model}`);
    if (!(await existsInRegistry(model, signal))) {
      throw new Error("modèle introuvable sur le registre Ollama : vérifie le nom et la taille sur https://ollama.com/library");
    }
    const r = await fetch(this.url("/api/pull"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      signal,
    });
    if (!r.ok || !r.body) throw new Error(`Ollama ${r.status} : ${(await r.text()).slice(0, 300)}`);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line) as PullProgress & { error?: string };
        if (ev.error) throw new Error(ev.error);
        onProgress({ status: ev.status, total: ev.total, completed: ev.completed });
      }
    }
  }

  async deleteModel(model: string): Promise<void> {
    if (!MODEL_NAME.test(model)) throw new Error(`nom de modèle invalide : ${model}`);
    const r = await fetch(this.url("/api/delete"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status} : ${(await r.text()).slice(0, 300)}`);
  }

  /** Crée (ou remplace) une variante d'un modèle installé avec d'autres paramètres, sans copier les poids. */
  async createVariant(name: string, from: string, parameters: Record<string, number>): Promise<void> {
    const r = await fetch(this.url("/api/create"), {
      method: "POST",
      body: JSON.stringify({ model: name, from, parameters, stream: false }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`Ollama : variante ${name} impossible (${(await r.text()).slice(0, 200)})`);
  }

  /** Charge un modèle et dit quelle part tient en VRAM (le reste tourne sur le processeur, bien plus lentement). */
  async loadAndMeasure(model: string, numCtx: number): Promise<{ size: number; sizeVram: number } | undefined> {
    await fetch(this.url("/api/generate"), {
      method: "POST",
      body: JSON.stringify({ model, keep_alive: this.cfg.keepAlive, options: { num_ctx: numCtx } }),
      signal: AbortSignal.timeout(300_000),
    });
    return (await this.runningModels()).find((m) => m.name === model);
  }

  /** Décharge un modèle de la mémoire. */
  async unload(model: string): Promise<void> {
    await fetch(this.url("/api/generate"), {
      method: "POST",
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(30_000),
    });
  }

  /** Démarre l'Ollama autonome de G:\MyIALocal\runtime s'il ne répond pas. */
  async ensureRunning(): Promise<void> {
    if (await this.ping()) {
      // Un Ollama déjà lancé mais trop ancien (ex. une vieille installation) : message clair plutôt qu'une erreur au
      // premier message (« model is not supported by your version of Ollama »).
      const v = await this.version().catch(() => "0.0.0");
      if (!versionAtLeast(v, MIN_OLLAMA)) throw new Error(tooOld(v));
      return;
    }
    if (!this.cfg.autoStart) throw new Error(`Ollama ne répond pas sur ${this.cfg.baseUrl}`);
    const found = findOllama();
    if (!found) {
      throw new Error("Ollama introuvable : installe-le depuis Paramètres → Système (bouton Installer), ou depuis https://ollama.com");
    }
    if (!versionAtLeast(found.version, MIN_OLLAMA)) throw new Error(tooOld(found.version, found.exe));
    const host = new URL(this.cfg.baseUrl).host;
    fs.mkdirSync(path.dirname(paths.ollamaLog), { recursive: true });
    const log = fs.openSync(paths.ollamaLog, "a");
    const child = spawn(found.exe, ["serve"], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
      // Ollama autonome de MyIA : ses modèles dans ollama\models. Ollama installé : on garde ses réglages.
      env: { ...process.env, OLLAMA_HOST: host, ...(found.bundled ? { OLLAMA_MODELS: paths.ollamaModels } : {}), ...engineEnv(this.cfg) },
    });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await this.ping()) return;
    }
    throw new Error(`Ollama lancé mais ne répond pas (voir ${paths.ollamaLog})`);
  }

  /** Charge le modèle en VRAM sans rien générer (le premier chargement prend ~1 min). */
  async warmUp(): Promise<void> {
    await fetch(this.url("/api/generate"), {
      method: "POST",
      body: JSON.stringify({ model: this.cfg.model, keep_alive: this.cfg.keepAlive, options: { num_ctx: this.cfg.numCtx } }),
      signal: AbortSignal.timeout(300_000),
    });
  }

  /** `format: "json"` force une réponse JSON (classification, extraction). */
  async chat(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal, opts: { format?: "json"; temperature?: number } = {}): Promise<ChatMessage> {
    const timeout = AbortSignal.timeout(300_000);
    const r = await fetch(this.url("/api/chat"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        tools,
        stream: false,
        think: false,
        keep_alive: this.cfg.keepAlive,
        ...(opts.format ? { format: opts.format } : {}),
        options: { num_ctx: this.cfg.numCtx, temperature: opts.temperature ?? this.cfg.temperature },
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!r.ok) {
      const text = (await r.text()).slice(0, 500);
      if (/not supported by your version of Ollama/i.test(text)) throw new Error(tooOld(await this.version().catch(() => "?")));
      throw new Error(`Ollama ${r.status} : ${text}`);
    }
    const data = (await r.json()) as { message?: ChatMessage };
    if (!data.message) throw new Error("Réponse Ollama sans message");
    return data.message;
  }
}
