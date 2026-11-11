import { execFile, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { download, extractZip, type Progress } from "./fetch-verified.js";
import type { ChatMessage, LlmClient, ModelInfo, PullProgress, RunningModel, ToolSpec } from "./llm.js";
import { isInside, paths } from "./paths.js";
import { getSecret, setSecret } from "./secrets.js";

/**
 * Moteur llama.cpp direct (MIT) : `llama-server` en mode routeur (--models-dir), qui charge à la demande le modèle
 * nommé dans chaque requête, comme Ollama. API compatible OpenAI (/v1/chat/completions, outils compris).
 * Chaîne d'approvisionnement : build FIGÉE (b11808) et modèles du catalogue avec empreintes SHA-256 vérifiées ; un
 * modèle Hugging Face hors catalogue est vérifié avec l'empreinte publiée par Hugging Face (LFS).
 * Sécurité : écoute sur 127.0.0.1 seulement, clé d'API aléatoire (coffre Windows) passée par variable d'environnement
 * (jamais en argument : visible dans la liste des processus).
 */

const RELEASE = "b11808";
const GH = `https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE}`;

export const BUILDS = {
  cuda: {
    label: "GPU NVIDIA (CUDA 13, pilote 580 ou plus)",
    sizeMb: 584,
    zips: [
      { file: `llama-${RELEASE}-bin-win-cuda-13.4-x64.zip`, sha256: "6a25d4a04f37f53acad0ba5d4a52c79d607492c0dfcd1fd7589c93c33b05df65" },
      { file: "cudart-llama-bin-win-cuda-13.4-x64.zip", sha256: "738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668" },
    ],
  },
  vulkan: {
    label: "Tout GPU (Vulkan : NVIDIA, AMD, Intel)",
    sizeMb: 37,
    zips: [{ file: `llama-${RELEASE}-bin-win-vulkan-x64.zip`, sha256: "a889a1f529ee8e69756f28efd5dd3e42db03f09dc88687047187ae1d4715f429" }],
  },
  cpu: {
    label: "Processeur seul",
    sizeMb: 24,
    zips: [{ file: `llama-${RELEASE}-bin-win-cpu-x64.zip`, sha256: "62645783bca4669dcacc8db8e67cda67cd35b5b0d27156c3c23f6666fbd7b03c" }],
  },
} as const;
export type Build = keyof typeof BUILDS;

/** Modèles proposés (GGUF officiels de Qwen). Identifiant = nom du fichier sans « .gguf ». */
export const CATALOG = {
  "Qwen3-8B-Q4_K_M": {
    label: "Qwen3 8B (Q4_K_M)",
    note: "Recommandé avec 8 Go de VRAM",
    repo: "Qwen/Qwen3-8B-GGUF",
    sha256: "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785",
    size: 5_027_783_488,
  },
  "Qwen3-8B-Q5_K_M": {
    label: "Qwen3 8B (Q5_K_M)",
    note: "Un peu plus précis, un peu plus lourd",
    repo: "Qwen/Qwen3-8B-GGUF",
    sha256: "068bae163faa96ad48032daf4e071a6a28fe67d8dcc95367609c2ff165e52738",
    size: 5_851_112_224,
  },
  "Qwen3-4B-Q4_K_M": {
    label: "Qwen3 4B (Q4_K_M)",
    note: "Rapide et léger",
    repo: "Qwen/Qwen3-4B-GGUF",
    sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
    size: 2_497_280_256,
  },
  "Qwen3-14B-Q4_K_M": {
    label: "Qwen3 14B (Q4_K_M)",
    note: "Plus intelligent ; au-delà de 8 Go de VRAM, une partie tourne sur le processeur (plus lent)",
    repo: "Qwen/Qwen3-14B-GGUF",
    sha256: "500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0",
    size: 9_001_752_960,
  },
} as const;

/** Modèle Hugging Face hors catalogue : hf.co/<organisation>/<dépôt>/<fichier>.gguf (branche main). */
const HF_MODEL = /^hf\.co\/([A-Za-z0-9][A-Za-z0-9._-]{0,95})\/([A-Za-z0-9][A-Za-z0-9._-]{0,95})\/([A-Za-z0-9][A-Za-z0-9._-]{0,150}\.gguf)$/;
/** Identifiant d'un modèle local (nom de fichier sans extension). */
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const MAX_MODEL_BYTES = 40 * 1024 ** 3;

const buildDir = (b: Build) => path.join(paths.llamacppRoot, b);
const modelFile = (id: string) => path.join(paths.llamacppModels, `${id}.gguf`);

function findServer(dir: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/^llama-server(\.exe)?$/i.test(e.name)) return full;
    }
  }
  return undefined;
}

export function installedBuilds(): Record<Build, boolean> {
  return { cuda: !!findServer(buildDir("cuda")), vulkan: !!findServer(buildDir("vulkan")), cpu: !!findServer(buildDir("cpu")) };
}

/** Build à utiliser : celle choisie si installée, sinon la meilleure installée (CUDA, puis Vulkan, puis processeur). */
export function activeBuild(cfg: Config["llm"]): Build | undefined {
  const inst = installedBuilds();
  if (cfg.llamacpp.backend && inst[cfg.llamacpp.backend]) return cfg.llamacpp.backend;
  return (["cuda", "vulkan", "cpu"] as const).find((b) => inst[b]);
}

export async function installBuild(build: Build, onProgress: (p: Progress) => void, signal?: AbortSignal) {
  if (process.platform !== "win32") throw new Error("llama.cpp : Windows uniquement pour l'instant");
  const b = BUILDS[build];
  const dir = buildDir(build);
  for (const [i, z] of b.zips.entries()) {
    const zip = path.join(paths.llamacppRoot, "downloads", z.file);
    await download(`${GH}/${z.file}`, zip, z.sha256, onProgress, `llama.cpp ${b.label}`, signal);
    onProgress({ what: "extraction", received: 0 });
    extractZip(zip, dir, i === 0);
    fs.rmSync(zip, { force: true });
  }
  if (!findServer(dir)) throw new Error("llama-server introuvable dans l'archive");
}

export function uninstallBuild(build: Build) {
  stopLlamaServer();
  fs.rmSync(buildDir(build), { recursive: true, force: true });
}

export function localModels(): ModelInfo[] {
  if (!fs.existsSync(paths.llamacppModels)) return [];
  return fs
    .readdirSync(paths.llamacppModels, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".gguf"))
    .map((e) => {
      const st = fs.statSync(path.join(paths.llamacppModels, e.name));
      const name = e.name.slice(0, -5);
      return {
        name,
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
        parameterSize: /(\d+(?:\.\d+)?)B\b/i.exec(name)?.[1]?.concat("B"),
        quantization: /\b(I?Q\d[A-Z0-9_]*|F16|BF16)\b/i.exec(name.replace(/-/g, " "))?.[1]?.toUpperCase(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Clé d'API du serveur local : créée une fois, gardée dans le coffre (un serveur resté ouvert se réutilise). */
function apiKey(): string {
  let k = getSecret("llamacpp_api_key");
  if (!k) {
    k = crypto.randomBytes(24).toString("base64url");
    setSecret("llamacpp_api_key", k);
  }
  return k;
}

let server: ChildProcess | undefined;

/**
 * Le programme qui écoute sur le port est-il bien NOTRE llama-server (un exécutable des builds de MyIA) ? Vérifié
 * AVANT d'envoyer la clé ou un prompt : un autre programme qui aurait pris le port ne reçoit rien. Résultat gardé
 * 30 s pour le même processus.
 */
let verified: { port: number; pid: number; at: number } | undefined;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? "" : String(out))));
}

export async function listenerIsOurs(port: number): Promise<"ours" | "other" | "none"> {
  if (process.platform !== "win32") return "other";
  const out = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$c = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${Math.trunc(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
      `if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; "$($c.OwningProcess)|$($p.Path)" }`,
  ]);
  const [pidText, exe] = out.trim().split("|");
  const pid = Number(pidText);
  if (!pid) return "none";
  if (verified && verified.port === port && verified.pid === pid && Date.now() - verified.at < 30_000) return "ours";
  const ok = !!exe && /^llama-server\.exe$/i.test(path.basename(exe)) && isInside(paths.llamacppRoot, path.resolve(exe));
  if (ok) verified = { port, pid, at: Date.now() };
  return ok ? "ours" : "other";
}

export function stopLlamaServer() {
  server?.kill();
  server = undefined;
}

// ─── conversion des messages (format Ollama de MyIA ↔ format OpenAI de llama-server) ─────────────────────────────

interface OaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
}

/** Les résultats d'outils de MyIA portent le nom de l'outil ; l'API OpenAI veut l'identifiant de l'appel : on le recrée. */
export function toOpenAI(messages: ChatMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [];
  let pending: { id: string; name: string }[] = [];
  let n = 0;
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c) => ({
        id: `appel_${n++}`,
        type: "function" as const,
        function: { name: c.function.name, arguments: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments) },
      }));
      pending = calls.map((c) => ({ id: c.id, name: c.function.name }));
      out.push({ role: "assistant", content: m.content ?? "", tool_calls: calls });
    } else if (m.role === "tool") {
      const i = Math.max(0, pending.findIndex((p) => p.name === m.tool_name));
      const hit = pending.splice(i, 1)[0];
      out.push({ role: "tool", content: m.content, tool_call_id: hit?.id ?? `appel_${n++}` });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export function fromOpenAI(msg: { content?: string | null; tool_calls?: { function: { name: string; arguments: string } }[] }): ChatMessage {
  const calls = (msg.tool_calls ?? []).map((c) => {
    let args: Record<string, unknown> | string = c.function.arguments;
    try {
      args = JSON.parse(c.function.arguments) as Record<string, unknown>;
    } catch {
      /* argument non JSON : laissé tel quel, l'agent le signalera au modèle */
    }
    return { function: { name: c.function.name, arguments: args } };
  });
  return { role: "assistant", content: msg.content ?? "", ...(calls.length ? { tool_calls: calls } : {}) };
}

// ─── client ──────────────────────────────────────────────────────────────────

export class LlamaCppClient implements LlmClient {
  readonly engine = "llamacpp" as const;

  constructor(
    private readonly cfg: Config["llm"],
    private readonly wanted: string = cfg.model,
  ) {}

  private get base() {
    return `http://127.0.0.1:${this.cfg.llamacpp.port}`;
  }

  /**
   * Modèle utilisé : celui demandé s'il est installé ; sinon (ex. agent réglé sur un nom Ollama) le modèle par défaut
   * du moteur llama.cpp.
   */
  get model(): string {
    if (LOCAL_ID.test(this.wanted) && fs.existsSync(modelFile(this.wanted))) return this.wanted;
    return this.cfg.model;
  }

  private async api(p: string, init: RequestInit & { timeoutMs?: number } = {}) {
    const timeout = AbortSignal.timeout(init.timeoutMs ?? 10_000);
    return fetch(this.base + p, {
      ...init,
      headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json", ...(init.headers ?? {}) },
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  }

  async ping(): Promise<boolean> {
    // D'abord l'identité du serveur (exécutable de MyIA), ensuite seulement la clé.
    if ((await listenerIsOurs(this.cfg.llamacpp.port)) !== "ours") return false;
    try {
      return (await this.api("/models", { timeoutMs: 2000 })).ok;
    } catch {
      return false;
    }
  }

  async version(): Promise<string> {
    return `llama.cpp ${RELEASE}`;
  }

  async hasModel(model = this.cfg.model): Promise<boolean> {
    return LOCAL_ID.test(model) && fs.existsSync(modelFile(model));
  }

  async listModels(): Promise<ModelInfo[]> {
    return localModels();
  }

  async runningModels(): Promise<RunningModel[]> {
    if (!(await this.ping())) return [];
    const r = await this.api("/models");
    const data = (await r.json()) as { data?: { id: string; status?: { value?: string } }[] };
    const sizes = new Map(localModels().map((m) => [m.name, m.size]));
    return (data.data ?? [])
      .filter((m) => m.status?.value === "loaded")
      .map((m) => ({ name: m.id, size: sizes.get(m.id) ?? 0, sizeVram: sizes.get(m.id) ?? 0 }));
  }

  /** Catalogue (empreinte connue) ou hf.co/org/dépôt/fichier.gguf (empreinte publiée par Hugging Face). */
  async pull(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    let id: string;
    let url: string;
    let sha256: string;
    let size: number;
    const known = CATALOG[model as keyof typeof CATALOG];
    if (known) {
      id = model;
      url = `https://huggingface.co/${known.repo}/resolve/main/${model}.gguf`;
      sha256 = known.sha256;
      size = known.size;
    } else {
      const m = HF_MODEL.exec(model);
      if (!m) throw new Error("modèle inconnu : choisis-en un du catalogue, ou hf.co/organisation/dépôt/fichier.gguf");
      const [, org, repo, file] = m as unknown as [string, string, string, string];
      const r = await fetch(`https://huggingface.co/api/models/${org}/${repo}/tree/main`, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`dépôt Hugging Face introuvable : ${org}/${repo}`);
      const entries = (await r.json()) as { path: string; size?: number; lfs?: { oid?: string; size?: number } }[];
      const e = entries.find((x) => x.path === file);
      if (!e?.lfs?.oid || !/^[0-9a-f]{64}$/.test(e.lfs.oid)) throw new Error(`fichier ${file} introuvable (ou sans empreinte) dans ${org}/${repo}`);
      id = file.slice(0, -5);
      url = `https://huggingface.co/${org}/${repo}/resolve/main/${file}`;
      sha256 = e.lfs.oid;
      size = e.lfs.size ?? e.size ?? 0;
    }
    if (!LOCAL_ID.test(id)) throw new Error(`nom de fichier refusé : ${id}`);
    if (size > MAX_MODEL_BYTES) throw new Error("modèle trop gros (40 Go au plus)");
    fs.mkdirSync(paths.llamacppModels, { recursive: true });
    const free = fs.statfsSync(paths.llamacppModels);
    if (size && free.bavail * free.bsize < size + 1024 ** 3) {
      throw new Error(`pas assez de place sur le disque (${Math.ceil(size / 1024 ** 3)} Go nécessaires)`);
    }
    await download(url, modelFile(id), sha256, (p) => onProgress({ status: p.what, total: p.total ?? size, completed: p.received }), id, signal);
  }

  async deleteModel(model: string): Promise<void> {
    if (!LOCAL_ID.test(model)) throw new Error("nom de modèle invalide");
    const f = modelFile(model);
    if (!isInside(paths.llamacppModels, f)) throw new Error("chemin refusé");
    await this.unload(model).catch(() => undefined);
    fs.rmSync(f, { force: true });
  }

  async unload(model: string): Promise<void> {
    if (!(await this.ping())) return;
    await this.api("/models/unload", { method: "POST", body: JSON.stringify({ model }) });
  }

  async ensureRunning(): Promise<void> {
    if (await this.ping()) return;
    if ((await listenerIsOurs(this.cfg.llamacpp.port)) === "other") {
      throw new Error(`le port ${this.cfg.llamacpp.port} est pris par un autre programme : rien ne lui est envoyé (change llm.llamacpp.port)`);
    }
    if (!this.cfg.autoStart) throw new Error(`llama-server ne répond pas sur le port ${this.cfg.llamacpp.port}`);
    const build = activeBuild(this.cfg);
    const exe = build && findServer(buildDir(build));
    if (!exe) throw new Error("llama.cpp n'est pas installé : Paramètres → Système → Moteur");
    fs.mkdirSync(paths.llamacppModels, { recursive: true });
    fs.mkdirSync(path.dirname(paths.llamacppLog), { recursive: true });
    const log = fs.openSync(paths.llamacppLog, "a");
    const flash = this.cfg.flashAttention || this.cfg.kvCache !== "f16";
    const args = [
      "--models-dir", paths.llamacppModels,
      "--models-max", String(this.cfg.llamacpp.modelsMax),
      "--host", "127.0.0.1",
      "--port", String(this.cfg.llamacpp.port),
      "--no-webui",
      "--jinja",
      ...(this.cfg.llamacpp.ctx === "auto" ? ["--fit-ctx", "32768"] : ["-c", String(this.cfg.llamacpp.ctx)]),
      "-fa", flash ? "on" : "off",
      ...(flash ? ["-ctk", this.cfg.kvCache, "-ctv", this.cfg.kvCache] : []),
    ];
    stopLlamaServer();
    server = spawn(exe, args, {
      windowsHide: true,
      stdio: ["ignore", log, log],
      cwd: path.dirname(exe),
      env: { ...process.env, LLAMA_API_KEY: apiKey() },
    });
    server.once("exit", () => (server = undefined));
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await this.ping()) return;
      if (!server) break;
    }
    throw new Error(`llama-server lancé mais ne répond pas (voir ${paths.llamacppLog})`);
  }

  /** Charge le modèle (le premier chargement peut prendre une minute). */
  async warmUp(): Promise<void> {
    const model = this.model;
    await this.api("/models/load", { method: "POST", body: JSON.stringify({ model }), timeoutMs: 30_000 });
    for (let i = 0; i < 300; i++) {
      if ((await this.runningModels()).some((m) => m.name === model)) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal, opts: { format?: "json"; temperature?: number } = {}): Promise<ChatMessage> {
    const model = this.model;
    if (!(await this.hasModel(model))) throw new Error(`aucun modèle llama.cpp installé (${model}) : onglet Modèles`);
    const r = await this.api("/v1/chat/completions", {
      method: "POST",
      timeoutMs: 300_000,
      signal,
      body: JSON.stringify({
        model,
        messages: toOpenAI(messages),
        ...(tools.length ? { tools } : {}),
        stream: false,
        temperature: opts.temperature ?? this.cfg.temperature,
        // Comme `think: false` côté Ollama : pas de phase de réflexion (Qwen3), réponses directes.
        chat_template_kwargs: { enable_thinking: false },
        ...(opts.format === "json" ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!r.ok) throw new Error(`llama.cpp ${r.status} : ${(await r.text()).slice(0, 500)}`);
    const data = (await r.json()) as { choices?: { message?: Parameters<typeof fromOpenAI>[0] }[] };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("réponse de llama.cpp sans message");
    return fromOpenAI(msg);
  }
}
