import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { patchConfigFile } from "./config-file.js";

/**
 * Programmes que l'IA peut lancer : une liste nommée d'exécutables (config/agent.json → programs).
 * Règles (SPEC §3) : seul un programme enregistré se lance, sans shell ; enregistrer demande confirmation ;
 * les shells et interpréteurs ne peuvent pas être enregistrés (sinon ce serait une commande libre déguisée).
 */

export interface ProgramEntry {
  name: string;
  path: string;
  description?: string;
  /** Empreinte SHA-256 de l'exécutable à l'enregistrement : un exe modifié depuis redemande confirmation. */
  sha256?: string;
}

export interface FoundProgram {
  name: string;
  path: string;
  source: "menu Démarrer" | "bureau" | "dossier";
}

/** Exécutables qui exécutent du code fourni (shells, interpréteurs, outils Windows détournables) : jamais enregistrables. */
const BLOCKED = new Set(
  [
    // shells et terminaux
    "cmd", "powershell", "powershell_ise", "pwsh", "bash", "sh", "zsh", "wsl", "wslhost", "conhost", "wt", "windowsterminal",
    "openconsole", "mintty", "git-bash", "busybox",
    // interpréteurs et environnements d'exécution
    "node", "deno", "bun", "python", "pythonw", "py", "pyw", "java", "javaw", "ruby", "rubyw", "perl", "php", "lua", "luajit",
    "dotnet", "csi", "rcsi", "fsi", "autohotkey", "autohotkey32", "autohotkey64", "autohotkeyu64", "autoit3", "autoit3_x64",
    "wscript", "cscript", "mshta", "tclsh", "wish", "r", "rscript", "julia",
    // outils Windows détournables (exécutent un fichier, un script ou une DLL)
    "rundll32", "regsvr32", "regedit", "reg", "msiexec", "schtasks", "at", "certutil", "bitsadmin", "msbuild", "installutil",
    "regasm", "regsvcs", "hh", "mmc", "cmstp", "forfiles", "wmic", "pcalua", "msdt", "msxsl", "odbcconf", "ieexec",
    "presentationhost", "control", "infdefaultinstall", "syncappvpublishingserver", "scriptrunner", "xwizard", "appvlp",
    "csc", "vbc", "jsc", "ilasm", "te", "tracker", "dnx", "explorer", "runas", "taskkill", "sc", "net", "net1", "netsh",
    "bcdedit", "diskpart", "format", "ftp", "tftp", "curl", "wget", "msconfig", "gpedit", "eventvwr", "fodhelper",
    "computerdefaults", "sdclt", "winrm", "winrs", "psexec", "psexec64",
  ].map((s) => s.toLowerCase()),
);

/** Outils inoffensifs autorisés malgré leur emplacement dans le dossier Windows. */
const WINDOWS_ALLOWED = new Set(["notepad", "mspaint", "calc", "snippingtool", "charmap", "magnify", "osk", "write"]);

export const PROGRAM_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'+-]{0,39}$/u;

/**
 * Chemin local absolu sur un lecteur (C:\...). Refuse UNC (\\serveur\partage), préfixes \\?\ et \\.\, chemins relatifs :
 * un simple accès à un chemin réseau suffirait à envoyer le jeton NTLM de l'utilisateur à une machine distante.
 * À appeler AVANT tout accès au système de fichiers.
 */
export function assertLocalPath(p: string): string {
  const raw = p.trim();
  if (/^[\\/]{2}/.test(raw)) throw new Error("chemins réseau (\\\\serveur\\…) refusés");
  if (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(raw)) throw new Error("chemin complet attendu (ex. C:\\Program Files\\…)");
  const abs = path.resolve(raw);
  if (/^[\\/]{2}/.test(abs)) throw new Error("chemins réseau refusés");
  return abs;
}

export function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export function checkExecutable(p: string): string {
  const abs = assertLocalPath(p);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`exécutable introuvable : ${abs}`);
  // Nom réel (long) du fichier : un nom court 8.3 (POWERS~1.EXE) ou un lien ne contourne pas les règles.
  const real = fs.realpathSync.native(abs);
  if (/^[\\/]{2}/.test(real)) throw new Error("chemins réseau refusés");
  if (process.platform === "win32" && !/\.exe$/i.test(real)) throw new Error("seuls les fichiers .exe peuvent être enregistrés");
  const base = path.basename(real).replace(/\.exe$/i, "").toLowerCase();
  if (BLOCKED.has(base) || /^python\d/.test(base) || /^(node|java|ruby|perl|php|lua)\d/.test(base)) {
    throw new Error(`${path.basename(real)} ne peut pas être enregistré : il permettrait d'exécuter n'importe quelle commande`);
  }
  const winDir = process.env.SystemRoot ?? process.env.windir;
  if (winDir && real.toLowerCase().startsWith(path.resolve(winDir).toLowerCase() + path.sep) && !WINDOWS_ALLOWED.has(base)) {
    throw new Error(`${path.basename(real)} est un outil système Windows : il ne peut pas être enregistré`);
  }
  return real;
}

export function listPrograms(): ProgramEntry[] {
  const cfg = loadConfig();
  return Object.entries(cfg.programs)
    .map(([name, p]) => ({ name, path: p.path, description: p.description, sha256: p.sha256 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function findProgram(name: string): ProgramEntry | undefined {
  const n = norm(name);
  const list = listPrograms();
  return list.find((p) => p.name === name) ?? list.find((p) => norm(p.name) === n);
}

/** Vrai si l'exécutable n'a plus l'empreinte enregistrée (mise à jour ou remplacement). */
export function programChanged(p: ProgramEntry): boolean {
  if (!p.sha256) return true;
  try {
    return sha256File(p.path) !== p.sha256;
  } catch {
    return true;
  }
}

export function addProgram(name: string, exe: string, description?: string): ProgramEntry {
  if (!PROGRAM_NAME.test(name)) throw new Error("nom invalide (lettres, chiffres, espaces, 40 caractères max)");
  const real = checkExecutable(exe);
  const sha256 = sha256File(real);
  patchConfigFile((raw) => {
    raw.programs = { ...(raw.programs ?? {}), [name]: { path: real, sha256, ...(description ? { description } : {}) } };
  });
  return { name, path: real, description, sha256 };
}

/** Après un lancement confirmé d'un programme mis à jour : nouvelle empreinte. */
export function refreshProgramHash(name: string) {
  patchConfigFile((raw) => {
    const p = raw.programs?.[name];
    if (p) p.sha256 = sha256File(checkExecutable(p.path));
  });
}

export function removeProgram(name: string) {
  patchConfigFile((raw) => {
    if (raw.programs) delete raw.programs[name];
  });
}

// ─── recherche sur le PC ─────────────────────────────────────────────────────

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Exécutables sans intérêt pour l'utilisateur (désinstalleurs, mises à jour, rapports de plantage…). */
const NOISE = /^(unins|uninst|update|updater|crashpad|crash|helper|setup|install|vc_?redist|dotnet|elevat|notification|squirrel|maintenance)/i;

let shortcutsCache: { at: number; items: FoundProgram[] } | undefined;

/** Raccourcis du menu Démarrer et du bureau → cible .exe (script PowerShell FIXE : la requête n'y entre jamais). */
function startMenuShortcuts(): Promise<FoundProgram[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  if (shortcutsCache && Date.now() - shortcutsCache.at < 10 * 60_000) return Promise.resolve(shortcutsCache.items);
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$sh = New-Object -ComObject WScript.Shell
# Menu Démarrer : récursif (rapide). Bureau : premier niveau seulement (un bureau chargé prend des dizaines de secondes).
$sets = @(
  @{ src = 'menu'; rec = $true; dirs = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs") },
  @{ src = 'bureau'; rec = $false; dirs = @([Environment]::GetFolderPath('Desktop'), "$env:PUBLIC\\Desktop") }
)
$out = foreach ($s in $sets) {
  Get-ChildItem $s.dirs -Recurse:$s.rec -Filter *.lnk | ForEach-Object {
    $t = $sh.CreateShortcut($_.FullName).TargetPath
    if ($t -like '*.exe') { [pscustomobject]@{ n = $_.BaseName; p = $t; s = $s.src } }
  }
}
@($out) | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const raw = JSON.parse(stdout || "[]") as { n: string; p: string; s: string }[] | { n: string; p: string; s: string };
          const items = (Array.isArray(raw) ? raw : [raw])
            .filter((x) => x?.p && fs.existsSync(x.p))
            .map((x) => ({ name: x.n, path: x.p, source: (x.s === "bureau" ? "bureau" : "menu Démarrer") as FoundProgram["source"] }));
          shortcutsCache = { at: Date.now(), items };
          resolve(items);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

/** Parcours borné des dossiers d'installation habituels (+ dossiers de projets et de versions Godot). */
function scanDirs(query: string, limitMs: number): FoundProgram[] {
  const q = norm(query);
  const env = process.env;
  const cfg = loadConfig();
  const roots = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs"),
    cfg.godot.versionsDir,
    ...cfg.projectRoots.map((r) => r.path),
  ].filter((r): r is string => !!r && fs.existsSync(r));

  const out: FoundProgram[] = [];
  const t0 = Date.now();
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth < 0 || Date.now() - t0 > limitMs || seen > 60_000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirMatches = norm(path.basename(dir)).includes(q);
    for (const e of entries) {
      seen++;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!/^(node_modules|\.git|windowsapps|common files|microsoft\.net|windows defender|cache|temp)$/i.test(e.name)) walk(full, depth - 1);
      } else if (/\.exe$/i.test(e.name) && !NOISE.test(e.name)) {
        const base = e.name.replace(/\.exe$/i, "");
        if (norm(base).includes(q) || (dirMatches && entries.filter((x) => /\.exe$/i.test(x.name)).length <= 3)) {
          out.push({ name: base, path: full, source: "dossier" });
        }
      }
    }
  };
  for (const r of roots) walk(r, 3);
  return out;
}

/** Cherche un programme par nom : raccourcis d'abord (noms lisibles), puis dossiers d'installation. */
export async function searchPrograms(query: string, max = 12): Promise<FoundProgram[]> {
  const q = norm(query);
  if (q.length < 2) throw new Error("requête trop courte");
  // Raccourcis (processus PowerShell, asynchrone) pendant le parcours des dossiers (synchrone, borné).
  const pending = startMenuShortcuts();
  const scanned = scanDirs(query, 4000);
  const shortcuts = (await pending).filter((s) => norm(s.name).includes(q) || norm(path.basename(s.path)).includes(q));
  const seen = new Set<string>();
  const out: FoundProgram[] = [];
  for (const p of [...shortcuts, ...scanned]) {
    const k = path.resolve(p.path).toLowerCase();
    if (seen.has(k) || NOISE.test(path.basename(p.path))) continue;
    seen.add(k);
    out.push(p);
  }
  // Correspondance exacte du nom en premier.
  out.sort((a, b) => Number(norm(b.name) === q) - Number(norm(a.name) === q));
  return out.slice(0, max);
}
