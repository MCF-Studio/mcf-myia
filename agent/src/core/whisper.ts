import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { download, extractZip, type Progress } from "./fetch-verified.js";
import { paths } from "./paths.js";

export type { Progress };

/**
 * Dictée locale avec whisper.cpp (MIT). Rien n'est livré avec l'app : moteur et modèle se téléchargent à la demande.
 * Chaîne d'approvisionnement : versions FIGÉES et empreintes SHA-256 vérifiées avant tout usage ; un fichier qui ne
 * correspond pas est supprimé. L'audio reste sur la machine (fichier temporaire supprimé après transcription).
 */

const RELEASE = "b5454";
const GH = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}`;

export const ENGINES = {
  cpu: {
    label: "CPU",
    file: "whisper-bin-x64.zip",
    url: `${GH}/whisper-bin-x64.zip`,
    sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
    sizeMb: 8,
  },
  cuda: {
    label: "GPU NVIDIA (CUDA 12)",
    file: "whisper-bin-win-cuda-12.4.0-x64.zip",
    url: `${GH}/whisper-bin-win-cuda-12.4.0-x64.zip`,
    sha256: "afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a",
    sizeMb: 653,
  },
} as const;
export type Engine = keyof typeof ENGINES;

export const MODELS = {
  "large-v3-turbo": {
    label: "large-v3-turbo (q8)",
    file: "ggml-large-v3-turbo-q8_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin",
    sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
    sizeMb: 834,
  },
  small: {
    label: "small",
    file: "ggml-small.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    sizeMb: 466,
  },
} as const;
export type WhisperModel = keyof typeof MODELS;

const root = () => path.join(paths.home, "runtime", "whisper");
const engineDir = (e: Engine) => path.join(root(), `engine-${e}`);
const modelPath = (m: WhisperModel) => path.join(root(), "models", MODELS[m].file);

function findCli(dir: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/^whisper-cli(\.exe)?$/i.test(e.name)) return full;
    }
  }
  return undefined;
}

export interface WhisperStatus {
  engines: Record<Engine, boolean>;
  models: Record<WhisperModel, boolean>;
  ready: boolean;
  active?: { engine: Engine; model: WhisperModel };
}

/** Moteur GPU prioritaire s'il est installé, sinon CPU ; modèle large-v3-turbo prioritaire. */
export function whisperStatus(): WhisperStatus {
  const engines = { cpu: !!findCli(engineDir("cpu")), cuda: !!findCli(engineDir("cuda")) };
  const models = { "large-v3-turbo": fs.existsSync(modelPath("large-v3-turbo")), small: fs.existsSync(modelPath("small")) };
  const engine: Engine | undefined = engines.cuda ? "cuda" : engines.cpu ? "cpu" : undefined;
  const model: WhisperModel | undefined = models["large-v3-turbo"] ? "large-v3-turbo" : models.small ? "small" : undefined;
  return { engines, models, ready: !!engine && !!model, active: engine && model ? { engine, model } : undefined };
}

export async function installWhisper(engine: Engine, model: WhisperModel, onProgress: (p: Progress) => void, signal?: AbortSignal) {
  if (process.platform !== "win32") throw new Error("dictée : Windows uniquement pour l'instant");
  const st = whisperStatus();
  if (!st.engines[engine]) {
    const e = ENGINES[engine];
    const zip = path.join(root(), "downloads", e.file);
    await download(e.url, zip, e.sha256, onProgress, `moteur ${e.label}`, signal);
    onProgress({ what: "extraction du moteur", received: 0 });
    extractZip(zip, engineDir(engine));
    fs.rmSync(zip, { force: true });
    if (!findCli(engineDir(engine))) throw new Error("whisper-cli introuvable dans l'archive");
  }
  if (!st.models[model]) {
    const m = MODELS[model];
    await download(m.url, modelPath(model), m.sha256, onProgress, `modèle ${m.label}`, signal);
  }
  return whisperStatus();
}

export function uninstallWhisper() {
  fs.rmSync(root(), { recursive: true, force: true });
}

const MAX_AUDIO = 8 * 1024 * 1024;

/** Transcrit un WAV (16 kHz mono conseillé). L'audio est écrit dans un fichier temporaire supprimé ensuite. */
export async function transcribe(wav: Buffer, language = "fr", signal?: AbortSignal): Promise<string> {
  const st = whisperStatus();
  if (!st.active) throw new Error("dictée non installée : Paramètres → Son et voix");
  if (wav.length > MAX_AUDIO) throw new Error("enregistrement trop long");
  if (wav.subarray(0, 4).toString("ascii") !== "RIFF" || wav.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new Error("audio invalide (WAV attendu)");
  }
  if (!/^(auto|[a-z]{2})$/.test(language)) throw new Error("langue invalide");
  const cli = findCli(engineDir(st.active.engine))!;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myia-dictee-"));
  const input = path.join(tmpDir, "audio.wav");
  const outBase = path.join(tmpDir, "texte");
  fs.writeFileSync(input, wav);
  try {
    const threads = String(Math.max(2, Math.min(8, os.cpus().length - 2)));
    const args = ["-m", modelPath(st.active.model), "-f", input, "-l", language, "-t", threads, "-nt", "-np", "-otxt", "-of", outBase];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cli, args, { cwd: path.dirname(cli), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
      const timer = setTimeout(() => child.kill(), 180_000);
      const onAbort = () => child.kill();
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        code === 0 ? resolve() : reject(new Error(`whisper a échoué (code ${code}) ${err.split("\n").slice(-3).join(" ")}`));
      });
    });
    return cleanTranscript(fs.readFileSync(`${outBase}.txt`, "utf8"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Nettoie la sortie : balises ([BLANK_AUDIO], (musique)…) et phrases « fantômes » que Whisper invente sur un silence
 * (génériques de sous-titres vus à l'entraînement).
 */
export function cleanTranscript(raw: string): string {
  let t = raw.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ").replace(/\s+/g, " ").trim();
  const ghosts = [
    /^sous-titr(age|es?)( réalisés?)?( par)?[^.]*\.?$/i,
    /^merci d'avoir regardé( cette vidéo)?[ !.]*$/i,
    /^merci( beaucoup)?[ !.]*$/i,
    /^thank you( for watching)?[ !.]*$/i,
    /^\.+$/,
  ];
  if (ghosts.some((g) => g.test(t))) t = "";
  return t;
}
