import fs from "node:fs";
import path from "node:path";
import { runProcess } from "./proc.js";

/**
 * Mise en place de la boîte à outils `tools/` pour un nouvel utilisateur, sans rien copier à la main :
 *
 * - **app installée** : les outils sont livrés dans l'installateur (resources/sidecar/tools) et copiés dans
 *   `<MYIA_HOME>/tools` au premier démarrage, puis à chaque nouvelle version. Les fichiers propres au poste
 *   (`policy.json`, `apps.json`, `blender.json`, outils importés) ne sont jamais touchés ;
 * - **politique par défaut** : sans `tools/policy.json`, une politique est créée avec UN dossier ouvert en lecture et
 *   en écriture, `Documents\MyIA` (créé s'il manque, c'est déjà le dossier par défaut de file_write). Elle n'accorde
 *   que `filesystem.read` et `filesystem.write` : toute écriture reste confirmée par l'utilisateur, et rien qui lance
 *   un programme ou ouvre une adresse n'est accordé (SPEC §5). Une politique existante n'est jamais réécrite.
 */

/** Fichiers et dossiers de `tools/` propres au poste : jamais remplacés ni supprimés par une mise à jour. */
export const LOCAL_ENTRIES = new Set(["policy.json", "apps.json", "blender.json", "imports"]);
/** Jamais copiés depuis l'installateur. */
const SKIP = new Set([...LOCAL_ENTRIES, "__pycache__", "tests"]);
const MARKER = ".myia-version";

/** Copie les outils livrés `src` dans `dest` si sa version diffère. Renvoie true si une copie a eu lieu. */
export function installBundledTools(src: string, dest: string, version: string): boolean {
  if (!fs.existsSync(path.join(src, "tool_manager.py"))) return false;
  const marker = path.join(dest, MARKER);
  const managed = fs.existsSync(marker);
  if (managed && fs.readFileSync(marker, "utf8").trim() === version) return false;
  fs.mkdirSync(dest, { recursive: true });
  // Dossier déjà géré par MyIA : les outils livrés de la version précédente partent (un outil retiré ne doit pas
  // rester), le local reste. Dossier rempli à la main avant (pas de marqueur) : on écrase sans rien supprimer.
  if (managed) {
    for (const e of fs.readdirSync(dest)) {
      if (!LOCAL_ENTRIES.has(e)) fs.rmSync(path.join(dest, e), { recursive: true, force: true });
    }
  }
  for (const e of fs.readdirSync(src)) {
    if (SKIP.has(e)) continue;
    fs.cpSync(path.join(src, e), path.join(dest, e), { recursive: true, filter: (f) => path.basename(f) !== "__pycache__" });
  }
  fs.writeFileSync(marker, version + "\n", "utf8");
  return true;
}

/** Politique de départ : `dirs` en lecture et en écriture, fichiers seulement. */
export function defaultPolicy(dirs: string[]) {
  const list = dirs.map((d) => path.resolve(d).replace(/\\/g, "/"));
  return {
    _doc: [
      "Politique créée automatiquement par MyIA au premier démarrage (modèle complet : policy.example.json).",
      "allowed_dirs : dossiers que les outils peuvent lire (read) et écrire (write). Ajoute ici tes dossiers de projets.",
      "granted_permissions : fichiers seulement. Toute écriture est confirmée par toi. Pour lancer des programmes (git, cargo, Blender…), " +
        "ajouter en connaissance de cause : process.exec.readonly, process.exec, app.launch, url.open, network.local.",
    ],
    allowed_dirs: { read: list, write: list },
    granted_permissions: ["filesystem.read", "filesystem.write"],
  };
}

export interface ToolboxSetup {
  dir: string;
  /** Outils copiés depuis l'installateur à ce démarrage. */
  installed: boolean;
  /** Politique par défaut créée à ce démarrage. */
  policyCreated: boolean;
}

/**
 * Prépare `dir` : outils livrés (si `bundled` est donné et que `dir` est le dossier géré par MyIA), dossiers par
 * défaut créés, politique créée si absente. Ne lève jamais : une erreur ici ne doit pas empêcher MyIA de démarrer.
 */
export function ensureToolbox(opts: { dir: string; bundled?: string; version?: string; defaultDirs: string[] }): ToolboxSetup & { error?: string } {
  const out: ToolboxSetup & { error?: string } = { dir: opts.dir, installed: false, policyCreated: false };
  try {
    if (opts.bundled && opts.version) out.installed = installBundledTools(opts.bundled, opts.dir, opts.version);
    if (!fs.existsSync(path.join(opts.dir, "tool_manager.py"))) return out;
    for (const d of opts.defaultDirs) fs.mkdirSync(d, { recursive: true });
    const policy = path.join(opts.dir, "policy.json");
    if (!fs.existsSync(policy)) {
      fs.writeFileSync(policy, JSON.stringify(defaultPolicy(opts.defaultDirs), null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      out.policyCreated = true;
    }
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}

/**
 * Python qui lance la boîte : la valeur du réglage, ou, s'il vaut « python » (défaut) et que ce n'est pas un vrai
 * Python (alias du Microsoft Store sur un Windows neuf), le lanceur `py -3`. Renvoie le début de la ligne de commande.
 */
export async function resolvePython(setting: string, probe = probePython): Promise<string[]> {
  if (setting !== "python") return [setting];
  if (await probe(["python"])) return ["python"];
  if (process.platform === "win32" && (await probe(["py", "-3"]))) return ["py", "-3"];
  return ["python"];
}

async function probePython(cmd: string[]): Promise<boolean> {
  try {
    const r = await runProcess([...cmd, "-c", "import sys; print(sys.version_info[0])"], { cwd: process.cwd(), timeoutMs: 10_000, keep: 3 });
    return r.code === 0 && r.tail.some((l) => l.trim() === "3");
  } catch {
    return false;
  }
}

export interface PythonInfo {
  command: string[];
  version?: string;
  pillow?: string;
}

/** Version de Python et de Pillow (outils images) ; `version` absent = Python introuvable. */
export async function pythonInfo(command: string[]): Promise<PythonInfo> {
  const script =
    "import sys\ntry:\n import PIL; p = PIL.__version__\nexcept Exception:\n p = ''\nprint(sys.version.split()[0] + '|' + p)";
  try {
    const r = await runProcess([...command, "-c", script], { cwd: process.cwd(), timeoutMs: 15_000, keep: 5 });
    const line = r.code === 0 ? r.tail.find((l) => /^\d+\.\d+/.test(l)) : undefined;
    if (!line) return { command };
    const [version, pillow] = line.trim().split("|");
    return { command, version, ...(pillow ? { pillow } : {}) };
  } catch {
    return { command };
  }
}
