import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findOllama } from "./llm.js";
import { runProcess } from "./proc.js";

/**
 * Installation (ou mise à jour) d'Ollama par son script officiel, l'équivalent de
 * `irm https://ollama.com/install.ps1 | iex`, avec une vérification en plus : le script est d'abord enregistré, et il
 * n'est lancé que si sa signature Authenticode est valide ET au nom d'Ollama Inc. Le script vérifie ensuite lui-même la
 * signature de l'installeur qu'il télécharge, puis l'exécute en silencieux (installation par utilisateur, sans droits
 * administrateur).
 */

const SCRIPT_URL = "https://ollama.com/install.ps1";
const MAX_SCRIPT_BYTES = 512 * 1024;
const SIGNER = "CN=Ollama Inc.,";

/** Variables qui détournent le script (autre source de téléchargement, désinstallation…) : jamais transmises. */
const SCRIPT_OVERRIDES = ["OLLAMA_DOWNLOAD_URL", "OLLAMA_UNINSTALL", "OLLAMA_INSTALL_DIR", "OLLAMA_VERSION", "OLLAMA_DEBUG"];

/** PowerShell de Windows par son chemin complet : pas de recherche dans le PATH. */
function powershellExe(): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Sortie « <état>|<sujet du certificat> » de la vérification : vrai seulement si valide et signé par Ollama Inc. */
export function signedByOllama(line: string): boolean {
  const i = line.indexOf("|");
  return i > 0 && line.slice(0, i).trim() === "Valid" && line.slice(i + 1).trim().startsWith(SIGNER);
}

/** Variables d'environnement du script : celles du processus, sans les détournements. */
export function installerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of Object.keys(out)) if (SCRIPT_OVERRIDES.includes(k.toUpperCase())) delete out[k];
  return out;
}

/** Télécharge le script dans `dir` et vérifie sa signature. Renvoie son chemin. */
export async function downloadVerifiedScript(dir: string, signal?: AbortSignal): Promise<string> {
  const r = await fetch(SCRIPT_URL, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`téléchargement du script d'installation d'Ollama : erreur ${r.status}`);
  const body = Buffer.from(await r.arrayBuffer());
  if (!body.length || body.length > MAX_SCRIPT_BYTES) throw new Error("script d'installation d'Ollama : taille inattendue");
  const file = path.join(dir, "install.ps1");
  fs.writeFileSync(file, body);

  const out: string[] = [];
  // Le chemin passe par une variable d'environnement : rien à échapper dans la commande.
  const check = await runProcess(
    [
      powershellExe(),
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$s = Get-AuthenticodeSignature -LiteralPath $env:MYIA_OLLAMA_PS1; \"$($s.Status)|$($s.SignerCertificate.Subject)\"",
    ],
    { cwd: dir, timeoutMs: 60_000, env: { ...process.env, MYIA_OLLAMA_PS1: file }, onLine: (l, s) => s === "out" && out.push(l), signal },
  );
  if (check.code !== 0 || !out.some(signedByOllama)) {
    throw new Error("le script d'installation d'Ollama n'est pas signé par Ollama Inc. : installation refusée");
  }
  return file;
}

export async function installOllama(onStep: (what: string) => void, signal?: AbortSignal): Promise<{ version: string; exe: string }> {
  if (process.platform !== "win32") throw new Error("installation automatique d'Ollama : Windows uniquement (voir https://ollama.com/download)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myia-ollama-"));
  try {
    onStep("téléchargement du script officiel");
    const script = await downloadVerifiedScript(dir, signal);
    onStep("script vérifié (signé par Ollama Inc.) ; téléchargement d'Ollama, plusieurs minutes");
    const r = await runProcess([powershellExe(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      cwd: dir,
      timeoutMs: 45 * 60_000,
      env: installerEnv(),
      keep: 15,
      signal,
      onLine(line, stream) {
        const t = line.replace(/^>>>\s*/, "").trim();
        if (stream === "out" && t) onStep(t.slice(0, 200));
      },
    });
    if (signal?.aborted) throw new Error("installation annulée");
    if (r.timedOut) throw new Error("installation d'Ollama interrompue après 45 min");
    if (r.code !== 0) throw new Error(`l'installation d'Ollama a échoué (code ${r.code}) : ${r.tail.slice(-3).join(" ").slice(0, 300)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const found = findOllama();
  if (!found) throw new Error("installation terminée, mais ollama.exe reste introuvable : relance MyIA");
  return { version: found.version, exe: found.exe };
}
