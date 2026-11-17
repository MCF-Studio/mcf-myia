import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { download, extractZip, type Progress } from "./fetch-verified.js";
import { paths } from "./paths.js";

/**
 * Voix neuronale locale avec Piper (MIT, voix sous licences libres) : remplace la voix de Windows quand elle est
 * installée. Rien n'est livré avec l'app : moteur et voix se téléchargent à la demande, versions FIGÉES et empreintes
 * SHA-256 vérifiées (celles des voix sont aussi publiées par Hugging Face). Le texte ne quitte pas la machine.
 */

const ENGINE = {
  file: "piper_windows_amd64.zip",
  url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
  sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
  sizeMb: 22,
};

const HF = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/fr/fr_FR";

export const VOICES = {
  tom: {
    label: "Tom (voix d'homme, posée)",
    base: "fr_FR-tom-medium",
    dir: "tom/medium",
    onnx: "bf65074ccdeeeeaa832e75edb1c0a513c01c9a972bdf085ff8a6e71ea234fd41",
    json: "2f7f885ad5a0aad802e3cc24e4f57239febdcb142b4876de5d238094674361cc",
    sizeMb: 61,
  },
  upmc: {
    label: "Pierre (voix d'homme, grave)",
    base: "fr_FR-upmc-medium",
    dir: "upmc/medium",
    onnx: "9abb3800c199148897a9ed64e100d224f3de83579f100044174ad19418f1786f",
    json: "e8636ec15dfd5d72db37a02cb5320a20f2b8d339f2a0e4337da64c58a33a5868",
    sizeMb: 74,
  },
  siwis: {
    label: "Siwis (voix de femme, claire)",
    base: "fr_FR-siwis-medium",
    dir: "siwis/medium",
    onnx: "641d1ab097da2b81128c076810edb052b385decc8be3381814802a64a73baf99",
    json: "39479916c2db192b5ac9764daddd0c744d83e023ad890c6976c0633ae4df8959",
    sizeMb: 61,
  },
} as const;
export type PiperVoice = keyof typeof VOICES;
export const VOICE_IDS = Object.keys(VOICES) as [PiperVoice, ...PiperVoice[]];

const root = () => path.join(paths.home, "runtime", "piper");
const engineDir = () => path.join(root(), "engine");
const voiceFile = (v: PiperVoice, ext: "onnx" | "onnx.json") => path.join(root(), "voices", `${VOICES[v].base}.${ext}`);

function findExe(dir: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/^piper(\.exe)?$/i.test(e.name)) return full;
    }
  }
  return undefined;
}

export interface PiperStatus {
  engine: boolean;
  voices: Record<PiperVoice, boolean>;
  ready: boolean;
}

export function piperStatus(): PiperStatus {
  const engine = !!findExe(engineDir());
  const voices = Object.fromEntries(VOICE_IDS.map((v) => [v, fs.existsSync(voiceFile(v, "onnx")) && fs.existsSync(voiceFile(v, "onnx.json"))])) as Record<PiperVoice, boolean>;
  return { engine, voices, ready: engine && Object.values(voices).some(Boolean) };
}

export async function installPiper(voice: PiperVoice, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<PiperStatus> {
  if (process.platform !== "win32") throw new Error("voix neuronale : Windows uniquement pour l'instant");
  const st = piperStatus();
  if (!st.engine) {
    const zip = path.join(root(), "downloads", ENGINE.file);
    await download(ENGINE.url, zip, ENGINE.sha256, onProgress, "moteur Piper", signal);
    onProgress({ what: "extraction du moteur", received: 0 });
    extractZip(zip, engineDir());
    fs.rmSync(zip, { force: true });
    if (!findExe(engineDir())) throw new Error("piper.exe introuvable dans l'archive");
  }
  if (!st.voices[voice]) {
    const v = VOICES[voice];
    await download(`${HF}/${v.dir}/${v.base}.onnx.json`, voiceFile(voice, "onnx.json"), v.json, onProgress, `réglages de la voix ${v.label}`, signal);
    await download(`${HF}/${v.dir}/${v.base}.onnx`, voiceFile(voice, "onnx"), v.onnx, onProgress, `voix ${v.label}`, signal);
  }
  return piperStatus();
}

export function uninstallPiper() {
  fs.rmSync(root(), { recursive: true, force: true });
}

/** Texte lisible à voix haute : une ligne, sans caractères de contrôle, longueur bornée. */
export function piperText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

/**
 * Synthétise `text` avec la voix choisie, rend un WAV. Le texte passe par l'entrée standard (jamais par la ligne de
 * commande), la sortie dans un fichier temporaire supprimé ensuite. `rate` : 0.5 (lent) à 2 (rapide).
 */
export async function synthesize(text: string, voice: PiperVoice, rate = 1, signal?: AbortSignal): Promise<Buffer> {
  const st = piperStatus();
  const exe = findExe(engineDir());
  if (!exe) throw new Error("voix neuronale non installée : Paramètres → Son et voix");
  const use: PiperVoice | undefined = st.voices[voice] ? voice : VOICE_IDS.find((v) => st.voices[v]);
  if (!use) throw new Error("aucune voix Piper installée");
  const clean = piperText(text);
  if (!clean) throw new Error("rien à lire");
  const lengthScale = (1 / Math.min(2, Math.max(0.5, rate))).toFixed(2);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myia-voix-"));
  const out = path.join(tmpDir, "voix.wav");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(exe, ["-m", voiceFile(use, "onnx"), "-f", out, "--length_scale", lengthScale, "-q"], {
        cwd: path.dirname(exe),
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-1500)));
      const timer = setTimeout(() => child.kill(), 60_000);
      const onAbort = () => child.kill();
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        code === 0 ? resolve() : reject(new Error(`Piper a échoué (code ${code}) ${err.split("\n").slice(-2).join(" ")}`));
      });
      child.stdin.end(Buffer.from(clean + "\n", "utf8"));
    });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
