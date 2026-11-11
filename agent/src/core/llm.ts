import { spawn } from "node:child_process";
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

/** Nom de modèle Ollama accepté (ex. qwen3:8b, hf.co/org/repo:Q4_K_M). Bloque tout ce qui ressemble à une URL ou un chemin. */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)*(:[A-Za-z0-9._-]+)?$/;

/** Ollama à lancer : celui de runtime\ollama s'il existe, sinon une installation standard (dossier par défaut ou PATH). */
export function findOllama(): { exe: string; bundled: boolean } | undefined {
  if (fs.existsSync(paths.ollamaExe)) return { exe: paths.ollamaExe, bundled: true };
  const exe = process.platform === "win32" ? "ollama.exe" : "ollama";
  const candidates = [
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", exe)] : []),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe)),
  ];
  const hit = candidates.find((c) => fs.existsSync(c));
  return hit ? { exe: hit, bundled: false } : undefined;
}

/** Client minimal de l'API native d'Ollama (/api/chat). */
export class OllamaClient {
  constructor(private readonly cfg: Config["llm"]) {}

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
    if (await this.ping()) return;
    if (!this.cfg.autoStart) throw new Error(`Ollama ne répond pas sur ${this.cfg.baseUrl}`);
    const found = findOllama();
    if (!found) {
      throw new Error("Ollama introuvable : installe-le depuis https://ollama.com (ou place ollama.exe dans runtime\ollama)");
    }
    const host = new URL(this.cfg.baseUrl).host;
    fs.mkdirSync(path.dirname(paths.ollamaLog), { recursive: true });
    const log = fs.openSync(paths.ollamaLog, "a");
    const child = spawn(found.exe, ["serve"], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
      // Ollama autonome de MyIA : ses modèles dans ollama\models. Ollama installé : on garde ses réglages.
      env: { ...process.env, OLLAMA_HOST: host, ...(found.bundled ? { OLLAMA_MODELS: paths.ollamaModels } : {}) },
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
    if (!r.ok) throw new Error(`Ollama ${r.status} : ${(await r.text()).slice(0, 500)}`);
    const data = (await r.json()) as { message?: ChatMessage };
    if (!data.message) throw new Error("Réponse Ollama sans message");
    return data.message;
  }
}
