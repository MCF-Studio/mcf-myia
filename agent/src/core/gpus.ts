import { runProcess } from "./proc.js";

/**
 * Plusieurs cartes graphiques (ou une carte à deux GPU, vue comme deux périphériques) pour les modèles locaux.
 *
 * - `auto` : rien n'est imposé, chaque moteur décide (llama.cpp répartit déjà sur tous les GPU visibles ; Ollama ne
 *   déborde sur un 2e GPU que si le modèle ne tient pas sur un seul) ;
 * - `single` : une seule carte (llama.cpp : `--device <nom>` ; Ollama : `CUDA_VISIBLE_DEVICES=<uuid>`, NVIDIA) ;
 * - `split` : le modèle réparti sur toutes les cartes (llama.cpp : `--split-mode`, `--tensor-split` facultatif ;
 *   Ollama : `OLLAMA_SCHED_SPREAD=1`).
 */

export interface GpuSetting {
  mode: "auto" | "single" | "split";
  /** Périphérique llama.cpp choisi en mode `single` (ex. CUDA0, Vulkan1 : liste de `llama-server --list-devices`). */
  device?: string;
  /** GPU NVIDIA choisi pour Ollama en mode `single` (UUID de nvidia-smi : l'ordre des index CUDA peut différer). */
  uuid?: string;
  /** Répartition llama.cpp : par couches (sûr, conseillé) ou par lignes / tenseurs (cartes NVIDIA identiques). */
  splitMode: "layer" | "row" | "tensor";
  /** Part du modèle par carte (ex. [3, 1] = 75 % / 25 %) ; vide = selon la mémoire de chaque carte. */
  ratios?: number[];
}

export interface GpuDevice {
  /** Nom llama.cpp (CUDA0, Vulkan0…) ; absent si la carte vient seulement de nvidia-smi. */
  device?: string;
  uuid?: string;
  name: string;
  memoryMb?: number;
}

/** `llama-server --list-devices` : «   CUDA0: NVIDIA GeForce RTX 3060 Ti (8191 MiB, 7140 MiB free) ». */
export function parseLlamaDevices(text: string): GpuDevice[] {
  const out: GpuDevice[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]+\d+):\s*(.+?)\s*\((\d+)\s*MiB/.exec(line);
    if (m) out.push({ device: m[1]!, name: m[2]!, memoryMb: Number(m[3]) });
  }
  return out;
}

/** `nvidia-smi --query-gpu=index,uuid,name,memory.total --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(text: string): GpuDevice[] {
  const out: GpuDevice[] = [];
  for (const line of text.split(/\r?\n/)) {
    const p = line.split(",").map((x) => x.trim());
    if (p.length >= 4 && /^GPU-[0-9a-f-]+$/i.test(p[1]!)) out.push({ uuid: p[1]!, name: p[2]!, memoryMb: Number(p[3]) || undefined });
  }
  return out;
}

async function capture(argv: string[]): Promise<string> {
  const lines: string[] = [];
  try {
    await runProcess(argv, { cwd: process.cwd(), timeoutMs: 20_000, keep: 2, onLine: (l) => void (lines.length < 200 && lines.push(l)) });
  } catch {
    return "";
  }
  return lines.join("\n");
}

/** Cartes vues par llama.cpp (si `llamaServer` est donné) et par le pilote NVIDIA. */
export async function listGpus(llamaServer?: string): Promise<{ llama: GpuDevice[]; nvidia: GpuDevice[] }> {
  const [llama, nvidia] = await Promise.all([
    llamaServer ? capture([llamaServer, "--list-devices"]).then(parseLlamaDevices) : Promise.resolve([]),
    capture(["nvidia-smi", "--query-gpu=index,uuid,name,memory.total", "--format=csv,noheader,nounits"]).then(parseNvidiaSmi),
  ]);
  return { llama, nvidia };
}

/** Arguments de llama-server pour le réglage. */
export function llamaGpuArgs(gpu: GpuSetting): string[] {
  if (gpu.mode === "single" && gpu.device) return ["--device", gpu.device, "--split-mode", "none"];
  if (gpu.mode === "split") {
    return ["--split-mode", gpu.splitMode, ...(gpu.ratios?.length ? ["--tensor-split", gpu.ratios.join(",")] : [])];
  }
  return [];
}

/**
 * Variables d'environnement d'Ollama pour le réglage (quand MyIA démarre Ollama). Une variable déjà posée dans Windows
 * garde la priorité : c'est un choix explicite de l'utilisateur.
 */
export function ollamaGpuEnv(gpu: GpuSetting, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  if (gpu.mode === "single" && gpu.uuid && env.CUDA_VISIBLE_DEVICES === undefined) out.CUDA_VISIBLE_DEVICES = gpu.uuid;
  if (gpu.mode === "split" && env.OLLAMA_SCHED_SPREAD === undefined) out.OLLAMA_SCHED_SPREAD = "1";
  return out;
}
