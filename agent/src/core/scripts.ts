import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { download, extractZip, type Progress } from "./fetch-verified.js";
import { isInside, paths } from "./paths.js";
import { runProcess } from "./proc.js";
import { writeJsonAtomic } from "./profiles.js";

/**
 * Scripts d'équipe : des serveurs MCP en Python (stdio) rattachés à une équipe, qui voyagent avec elle dans un
 * workflow (core/workflow.ts). C'est le SEUL contenu partagé qui contient du code exécuté (SPEC §3 bis) :
 *
 * - un script ne tourne jamais sans l'ACCORD de l'utilisateur, donné après affichage de son code, et lié à
 *   l'empreinte SHA-256 de ses fichiers : un script modifié depuis l'accord ne se lance plus ;
 * - ses fichiers vivent dans data\scripts\<id>, fermé aux outils de fichiers des agents (core/access.ts) ;
 * - il est lancé sans shell, avec un environnement réduit (ni secrets ni variables de MyIA) ;
 * - ses outils sont de risque `external` : chaque appel est confirmé, avec ses arguments exacts ;
 * - seuls les membres de l'équipe qui le porte le voient.
 *
 * Il n'y a PAS de bac à sable : un script accepté a les droits de l'utilisateur sur la machine. C'est écrit en
 * toutes lettres dans la fenêtre d'accord.
 */

export const SCRIPT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SCRIPT_MAX_FILES = 20;
export const SCRIPT_MAX_FILE_CHARS = 200_000;
export const SCRIPT_MAX_CHARS = 400_000;
export const SCRIPTS_PER_TEAM = 8;

/** Fichiers texte acceptés dans un script (jamais de binaire ni d'exécutable). */
const EXTENSIONS = new Set([".py", ".pyi", ".txt", ".md", ".json", ".toml", ".yaml", ".yml", ".cfg", ".ini", ".csv"]);
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/** Chemin relatif sûr (« server.py », « lib/outils.py ») : ni absolu, ni « .. », ni nom réservé de Windows. */
export function isSafeRelPath(p: string): boolean {
  if (p.length > 200 || p.includes("\\")) return false;
  const parts = p.split("/");
  if (parts.length > 4) return false;
  if (!parts.every((s) => SEGMENT.test(s) && !s.endsWith(".") && !RESERVED.test(s))) return false;
  return EXTENSIONS.has(path.posix.extname(p).toLowerCase());
}

const FileSchema = z.object({
  path: z.string().refine(isSafeRelPath, "chemin de fichier refusé (relatif, sans « .. », extension texte connue)"),
  content: z.string().max(SCRIPT_MAX_FILE_CHARS),
});

/** Un script tel qu'il voyage dans un workflow : des fichiers texte et un point d'entrée Python. */
export const ScriptPackSchema = z
  .object({
    id: z.string().regex(SCRIPT_ID, "id : minuscules, chiffres et tirets (40 max)"),
    name: z.string().trim().min(1).max(60),
    description: z.string().max(300).optional(),
    /** Fichier lancé : un serveur MCP sur l'entrée/sortie standard. */
    entry: z.string(),
    files: z.array(FileSchema).min(1).max(SCRIPT_MAX_FILES),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    for (const f of s.files) {
      const k = f.path.toLowerCase();
      if (seen.has(k)) ctx.addIssue({ code: "custom", message: `fichier en double : ${f.path}` });
      seen.add(k);
    }
    if (!s.entry.toLowerCase().endsWith(".py") || !s.files.some((f) => f.path === s.entry)) {
      ctx.addIssue({ code: "custom", message: "le point d'entrée doit être un fichier .py du script" });
    }
    if (s.files.reduce((n, f) => n + f.content.length, 0) > SCRIPT_MAX_CHARS) {
      ctx.addIssue({ code: "custom", message: `script trop volumineux (${SCRIPT_MAX_CHARS / 1000} k caractères au plus)` });
    }
  });

export type ScriptPack = z.infer<typeof ScriptPackSchema>;

/** Empreinte du CONTENU d'un script (point d'entrée et fichiers) : ni son id ni son nom n'y entrent. */
export function scriptHash(s: Pick<ScriptPack, "entry" | "files">): string {
  const h = crypto.createHash("sha256");
  h.update(`entry\0${s.entry}\0`);
  for (const f of [...s.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(`${f.path}\0${f.content.length}\0${f.content}\0`);
  }
  return h.digest("hex");
}

const EntrySchema = z.object({
  id: z.string().regex(SCRIPT_ID),
  name: z.string().trim().min(1).max(60),
  description: z.string().max(300).optional(),
  entry: z.string(),
  /** Empreinte des fichiers au moment de l'installation. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Empreinte acceptée par l'utilisateur ; absente = jamais lancé. */
  approvedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** D'où il vient (affiché) : « écrit sur ce PC », « workflow « X » »… */
  origin: z.string().max(120).optional(),
  addedAt: z.string(),
});

export type ScriptEntry = z.infer<typeof EntrySchema>;

const registryFile = () => path.join(paths.home, "config", "scripts.json");
const scriptsRoot = () => path.join(paths.home, "data", "scripts");
export const scriptDir = (id: string, root = scriptsRoot()) => path.join(root, id);

export interface ScriptStoreOptions {
  file?: string;
  root?: string;
}

/** Registre des scripts installés (config\scripts.json) et leurs fichiers (data\scripts\<id>). */
export class ScriptStore {
  private readonly file: string;
  private readonly root: string;

  constructor(opts: ScriptStoreOptions = {}) {
    this.file = opts.file ?? registryFile();
    this.root = opts.root ?? scriptsRoot();
  }

  list(): ScriptEntry[] {
    if (!fs.existsSync(this.file)) return [];
    let raw: { scripts?: unknown[] };
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { scripts?: unknown[] };
    } catch {
      return [];
    }
    const out: ScriptEntry[] = [];
    for (const s of raw.scripts ?? []) {
      const r = EntrySchema.safeParse(s);
      if (r.success) out.push(r.data);
    }
    return out;
  }

  get(id: string): ScriptEntry | undefined {
    return this.list().find((s) => s.id === id);
  }

  private save(list: ScriptEntry[]) {
    writeJsonAtomic(this.file, { scripts: list });
  }

  dir(id: string): string {
    if (!SCRIPT_ID.test(id)) throw new Error("id de script invalide");
    return scriptDir(id, this.root);
  }

  /** Fichiers du script tels qu'ils sont SUR LE DISQUE (ce qui serait réellement lancé). */
  read(id: string): ScriptPack {
    const entry = this.get(id);
    if (!entry) throw new Error(`script inconnu : ${id}`);
    const dir = this.dir(id);
    const files: ScriptPack["files"] = [];
    const walk = (rel: string) => {
      for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const p = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) walk(p);
        else if (d.isFile()) files.push({ path: p, content: fs.readFileSync(path.join(dir, p), "utf8") });
      }
    };
    if (fs.existsSync(dir)) walk("");
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    return { id: entry.id, name: entry.name, description: entry.description, entry: entry.entry, files };
  }

  /** Empreinte de ce qui est sur le disque ; undefined si les fichiers ont disparu ou ne sont plus un script valide. */
  diskHash(id: string): string | undefined {
    try {
      const pack = this.read(id);
      if (!ScriptPackSchema.safeParse(pack).success) return undefined;
      return scriptHash(pack);
    } catch {
      return undefined;
    }
  }

  /** Installe (ou remplace) un script. `approved` : l'utilisateur vient d'en accepter le code. */
  install(raw: unknown, opts: { approved: boolean; origin?: string }): ScriptEntry {
    const r = ScriptPackSchema.safeParse(raw);
    if (!r.success) throw new Error("Script invalide : " + r.error.issues.map((i) => i.message).join(" ; "));
    const pack = r.data;
    const dir = this.dir(pack.id);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const f of pack.files) {
      const target = path.resolve(dir, f.path);
      if (!isInside(dir, target)) throw new Error(`chemin suspect dans le script : ${f.path}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content, "utf8");
    }
    const sha256 = scriptHash(pack);
    const entry: ScriptEntry = {
      id: pack.id,
      name: pack.name,
      ...(pack.description ? { description: pack.description } : {}),
      entry: pack.entry,
      sha256,
      ...(opts.approved ? { approvedSha256: sha256 } : {}),
      ...(opts.origin ? { origin: opts.origin.slice(0, 120) } : {}),
      addedAt: new Date().toISOString(),
    };
    this.save([...this.list().filter((s) => s.id !== pack.id), entry]);
    return entry;
  }

  /**
   * Accord de l'utilisateur pour CE contenu : `sha256` est l'empreinte du code qu'on lui a montré. Si le disque ne
   * correspond plus (fichier modifié entre l'affichage et le clic), l'accord est refusé.
   */
  approve(id: string, sha256: string): ScriptEntry {
    const entry = this.get(id);
    if (!entry) throw new Error(`script inconnu : ${id}`);
    if (this.diskHash(id) !== sha256) throw new Error("le script a changé depuis son affichage : relis-le avant de l'accepter");
    const next = { ...entry, sha256, approvedSha256: sha256 };
    this.save(this.list().map((s) => (s.id === id ? next : s)));
    return next;
  }

  revoke(id: string): ScriptEntry {
    const entry = this.get(id);
    if (!entry) throw new Error(`script inconnu : ${id}`);
    const { approvedSha256: _a, ...next } = entry;
    this.save(this.list().map((s) => (s.id === id ? next : s)));
    return next;
  }

  delete(id: string) {
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    this.save(this.list().filter((s) => s.id !== id));
  }

  /** Pourquoi ce script ne peut pas être lancé, ou undefined s'il le peut (hors moteur Python). */
  blocked(id: string): string | undefined {
    const entry = this.get(id);
    if (!entry) return "script supprimé";
    if (!entry.approvedSha256) return "en attente de ton accord (Équipes → Scripts)";
    if (this.diskHash(id) !== entry.approvedSha256) return "modifié depuis ton accord : relis-le et accepte-le de nouveau (Équipes → Scripts)";
    return undefined;
  }
}

// ─── moteur Python ───────────────────────────────────────────────────────────

/** uv (Astral) : lance un script Python avec ses dépendances déclarées, et installe Python s'il manque. Version figée. */
export const UV = {
  version: "0.13.8",
  url: "https://github.com/astral-sh/uv/releases/download/0.13.8/uv-x86_64-pc-windows-msvc.zip",
  sha256: "529e78a9cec6cd7e3e014f7ecd8bda0c113969d4ed0f2efeedb85c30943325b8",
  sizeMb: 24,
} as const;

const uvDir = () => path.join(paths.home, "runtime", "uv");
const bundledUv = () => path.join(uvDir(), process.platform === "win32" ? "uv.exe" : "uv");

export interface Runtime {
  kind: "uv" | "python";
  /** Exécutable (chemin complet). */
  path: string;
  label: string;
}

/** Cherche un exécutable dans le PATH (sans shell), hors alias du Microsoft Store (qui ouvrent le Store). */
function findOnPath(names: string[]): string[] {
  const out: string[] = [];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (/[\\/]WindowsApps[\\/]?$/i.test(dir)) continue;
    for (const n of names) {
      const full = path.join(dir, n);
      try {
        if (fs.statSync(full).isFile()) out.push(full);
      } catch {
        /* absent */
      }
    }
  }
  return out;
}

async function versionOf(exe: string, args: string[]): Promise<string | undefined> {
  try {
    const r = await runProcess([exe, ...args], { cwd: paths.home, timeoutMs: 15_000, keep: 3 });
    return r.code === 0 ? r.tail.join(" ").trim() : undefined;
  } catch {
    return undefined;
  }
}

let runtimeCache: { at: number; value: Runtime | undefined } | undefined;

/** Moteur utilisé pour lancer les scripts : uv (fourni par MyIA ou déjà installé), sinon un Python 3 du PATH. */
export async function findRuntime(fresh = false): Promise<Runtime | undefined> {
  if (!fresh && runtimeCache && Date.now() - runtimeCache.at < 60_000) return runtimeCache.value;
  const win = process.platform === "win32";
  let value: Runtime | undefined;
  for (const exe of [bundledUv(), ...findOnPath(win ? ["uv.exe"] : ["uv"])]) {
    if (!fs.existsSync(exe)) continue;
    const v = await versionOf(exe, ["--version"]);
    if (v) {
      value = { kind: "uv", path: exe, label: v };
      break;
    }
  }
  if (!value) {
    for (const exe of findOnPath(win ? ["python.exe"] : ["python3", "python"])) {
      const v = await versionOf(exe, ["--version"]);
      if (v && /^Python 3\./.test(v)) {
        value = { kind: "python", path: exe, label: v };
        break;
      }
    }
  }
  runtimeCache = { at: Date.now(), value };
  return value;
}

export function scriptCommand(rt: Runtime, entryAbs: string): { command: string; args: string[] } {
  // uv : « --script » lit les dépendances déclarées en tête du fichier (PEP 723) ; « --no-project » ignore tout
  // pyproject.toml voisin. Python seul : le script n'a que la bibliothèque standard et les paquets déjà installés.
  return rt.kind === "uv" ? { command: rt.path, args: ["run", "--no-project", "--script", entryAbs] } : { command: rt.path, args: [entryAbs] };
}

const ENV_KEEP = [
  "PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "OS", "USERNAME", "HOME", "LANG", "LC_ALL", "TMPDIR",
];

/**
 * Environnement d'un script : le strict nécessaire pour que Python et uv fonctionnent. Aucune variable de MyIA ni
 * d'un autre outil (jetons d'API, clés) n'est transmise.
 */
export function scriptEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const byLower = new Map(Object.keys(env).filter((k) => env[k] !== undefined).map((k) => [k.toLowerCase(), k]));
  for (const k of ENV_KEEP) {
    const real = byLower.get(k.toLowerCase());
    const v = real ? env[real] : undefined;
    if (v !== undefined) out[real!] = v;
  }
  out.PYTHONUTF8 = "1";
  out.PYTHONIOENCODING = "utf-8";
  out.PYTHONDONTWRITEBYTECODE = "1";
  return out;
}

/** Télécharge uv (version figée, empreinte vérifiée) dans runtime\uv. */
export async function installUv(onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<Runtime> {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("installation automatique : Windows 64 bits uniquement (installe uv ou Python 3 toi-même)");
  const zip = path.join(paths.home, "runtime", "downloads", "uv.zip");
  await download(UV.url, zip, UV.sha256, onProgress, `uv ${UV.version}`, signal);
  onProgress({ what: "extraction", received: 0 });
  extractZip(zip, uvDir());
  fs.rmSync(zip, { force: true });
  const rt = await findRuntime(true);
  if (!rt || rt.kind !== "uv") throw new Error("uv introuvable après installation");
  return rt;
}
