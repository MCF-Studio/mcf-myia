import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../core/config.js";
import { isInside, paths } from "../core/paths.js";
import { childEnv, runProcess } from "../core/proc.js";
import { resolvePython } from "../core/toolbox-setup.js";
import { defineTool, type Risk, type Service, type ToolScope } from "../core/types.js";

/**
 * Boîte à outils `tools/` (SPEC §3, tools/README.md) branchée aux agents.
 *
 * Le gestionnaire Python (`tools/tool_manager.py`) applique sa propre politique (dossiers, permissions, écritures
 * interdites). Ce service ajoute les règles de l'app par-dessus :
 * - un outil que le manifeste déclare `local` ou `external` passe par la confirmation de l'interface de MyIA, et
 *   `--confirmed` n'est posé qu'APRÈS cette confirmation (jamais par le modèle : il ne voit pas la ligne de commande) ;
 * - l'aperçu montré est celui du gestionnaire (essai sans `--confirmed`, qui n'exécute rien) ;
 * - deux outils seulement sont montrés au modèle (toolbox_find, toolbox_run) : les 47 manifestes complets ne
 *   tiennent pas dans le contexte d'un petit modèle local ;
 * - tous les agents de l'app y ont accès (pas la Guilde, qui n'a aucun service) ; un agent confié à Claude ne peut
 *   viser aucun chemin dans les dossiers de mémoire (la mémoire ne quitte jamais le PC) ;
 * - les outils qui doublent un outil de l'app mieux intégré (git, lecture/écriture de texte, lancement) sont exclus.
 */

/** Outils de la boîte que l'app fournit déjà, avec ses propres contrôles : jamais exposés par ce service. */
export const TOOLBOX_EXCLUDED = new Set([
  "git_status", // git_* de l'app (services/git.ts)
  "git_log",
  "git_diff",
  "text_read", // file_read / file_write de l'app (formats, mémoire, espace de travail)
  "text_write",
  "app_catalog", // program_launch / open_path / browser_open de l'app
  "app_launch",
  "folder_open",
  "url_open",
]);

/** Noms de paramètres traités comme des chemins par le gestionnaire (tools/safety.py), sauf `kind: "text"`. */
const PATH_NAMES = new Set(["path", "file", "project", "directory", "repo", "output", "folder", "dir"]);

const OUTPUT_MAX = 400_000;
const LIST_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 15 * 60_000;

export interface ToolboxParam {
  type?: string;
  required?: boolean;
  description?: string;
  kind?: string;
  access?: string;
  enum?: unknown[];
}

export interface ToolboxEntry {
  name: string;
  category: string;
  description: string;
  risk: Risk;
  needs_confirmation: boolean;
  enabled: boolean;
  permissions: string[];
  parameters: Record<string, ToolboxParam>;
}

export interface ManagerReply {
  success: boolean;
  data: unknown;
  error: { type?: string; message?: string } | null;
  warnings: string[];
  /** Code de sortie : 0 exécuté, 1 refusé ou en échec, 2 confirmation requise. */
  code: number | null;
}

/** Lance le gestionnaire : `args` après `tool_manager.py`, paramètres JSON sur l'entrée standard. */
export type ManagerRunner = (args: string[], stdin: string | undefined, timeoutMs: number, signal?: AbortSignal) => Promise<ManagerReply>;

/** Dossier de la boîte à outils : cfg.toolbox.dir, sinon <MYIA_HOME>/tools. */
export function toolboxDir(cfg: Config): string {
  return path.resolve(cfg.toolbox.dir ?? path.join(paths.home, "tools"));
}

/** Gestionnaire de la boîte pour l'interface (liste, import) : jamais exposé aux agents. */
export function toolboxManager(cfg: Config): ManagerRunner {
  return realRunner(cfg.toolbox.python, toolboxDir(cfg));
}

/** Python trouvé une fois par réglage (« python », ou `py -3` sur un Windows où « python » est l'alias du Store). */
const pythonCache = new Map<string, Promise<string[]>>();
export function toolboxPython(setting: string): Promise<string[]> {
  let p = pythonCache.get(setting);
  if (!p) {
    p = resolvePython(setting);
    pythonCache.set(setting, p);
  }
  return p;
}

function realRunner(python: string, dir: string): ManagerRunner {
  const script = path.join(dir, "tool_manager.py");
  return async (args, stdin, timeoutMs, signal) => {
    let out = "";
    const r = await runProcess([...(await toolboxPython(python)), "-X", "utf8", script, ...args], {
      cwd: path.dirname(dir),
      timeoutMs,
      ...(stdin !== undefined ? { stdin } : {}),
      env: { ...childEnv(), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
      keep: 20,
      signal,
      onLine: (line, stream) => {
        if (stream === "out" && out.length < OUTPUT_MAX) out += line + "\n";
      },
    });
    if (r.timedOut) throw new Error(`la boîte à outils n'a pas répondu en ${Math.round(timeoutMs / 1000)} s`);
    let parsed: Partial<ManagerReply>;
    try {
      parsed = JSON.parse(out) as Partial<ManagerReply>;
    } catch {
      const err = r.tail.filter((l) => l.trim()).slice(-3).join(" | ");
      throw new Error(`réponse illisible de la boîte à outils (code ${r.code})${err ? ` : ${err}` : ""}`);
    }
    return {
      success: parsed.success === true,
      data: parsed.data ?? null,
      error: parsed.error ?? null,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
      code: r.code,
    };
  };
}

function isPathParam(name: string, p: ToolboxParam): boolean {
  if (p.kind === "text") return false;
  return p.kind === "path" || PATH_NAMES.has(name);
}

/** Première phrase d'une description, pour la liste courte. */
function shortText(s: string, max = 140): string {
  const first = s.split(/(?<=\.)\s/)[0] ?? s;
  return first.length > max ? first.slice(0, max - 1) + "…" : first;
}

function describeParams(t: ToolboxEntry): string {
  const lines = Object.entries(t.parameters).map(([n, p]) => {
    const tags = [p.type ?? "?", p.required ? "obligatoire" : "", isPathParam(n, p) ? (p.access === "write" ? "chemin écrit" : "chemin") : ""]
      .filter(Boolean)
      .join(", ");
    return `    - ${n} (${tags})${p.description ? ` : ${p.description}` : ""}`;
  });
  return lines.length ? lines.join("\n") : "    (aucun paramètre)";
}

function formatError(r: ManagerReply): string {
  const type = r.error?.type ?? "Erreur";
  return `${type} : ${r.error?.message ?? "échec sans message"}`;
}

/** Aperçu lisible du gestionnaire (data.preview) : ce qui sera fait, puis les paramètres. */
export function formatPreview(tool: string, data: unknown): string {
  const prev = (data as { preview?: { action?: string; params?: unknown } } | null)?.preview;
  if (!prev) return `Lancer l'outil ${tool} de la boîte à outils.`;
  const lines = [prev.action ?? `Outil ${tool}`];
  if (prev.params && typeof prev.params === "object") {
    lines.push("", "Paramètres :");
    for (const [k, v] of Object.entries(prev.params as Record<string, unknown>)) lines.push(`  ${k} = ${JSON.stringify(v)}`);
  }
  return lines.join("\n");
}

/** Données renvoyées au modèle : JSON compact, avertissements à la fin. */
function formatResult(r: ManagerReply): string {
  const body = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
  return r.warnings.length ? `${body}\nAvertissements : ${r.warnings.join(" ; ")}` : body;
}

export interface ToolboxOptions {
  /** Dossier `tools/` ; défaut : cfg.toolbox.dir, sinon <MYIA_HOME>/tools. */
  dir?: string;
  /** Remplace le lancement réel de Python (tests). */
  runner?: ManagerRunner;
}

export function toolboxService(cfg: Config, opts: ToolboxOptions = {}): Service {
  const dir = opts.dir ? path.resolve(opts.dir) : toolboxDir(cfg);
  const runner = opts.runner ?? realRunner(cfg.toolbox.python, dir);
  let catalog: ToolboxEntry[] = [];
  /** Aperçus calculés par check(), relus par preview() : la même demande ne relance pas le gestionnaire. */
  const previews = new Map<string, string>();

  const visible = () => catalog.filter((t) => t.enabled && !TOOLBOX_EXCLUDED.has(t.name));

  const find = (name: string): ToolboxEntry => {
    const t = visible().find((e) => e.name === name);
    if (t) return t;
    const known = catalog.find((e) => e.name === name);
    if (!known) throw new Error(`l'outil « ${name} » n'existe pas dans la boîte à outils : cherche-le avec toolbox_find`);
    if (TOOLBOX_EXCLUDED.has(name)) throw new Error(`« ${name} » n'est pas proposé ici : utilise l'outil équivalent de l'app (git_*, file_read, file_write, program_launch, open_path, browser_open)`);
    throw new Error(`« ${name} » est désactivé : sa permission (${known.permissions.join(", ")}) n'est pas accordée dans tools/policy.json`);
  };

  /** Chemin tel que demandé et chemin réel (liens, jonctions) ; un fichier à créer n'a que le premier. */
  const forms = (p: string): string[] => {
    const abs = path.resolve(p);
    try {
      return [abs, fs.realpathSync.native(abs)];
    } catch {
      return [abs];
    }
  };

  /**
   * Agent sur un modèle en ligne : les dossiers de mémoire sont passés au gestionnaire (`--deny`), qui les ferme sur
   * ses chemins réels et pendant ses parcours (la règle qui fait foi). SPEC : la mémoire ne quitte jamais le PC.
   */
  const denyArgs = (scope: ToolScope): string[] =>
    scope.cloud ? cfg.memory.folders.flatMap((f) => ["--deny", path.resolve(f)]) : [];

  /** Refus anticipé, avec un message clair, avant de lancer le gestionnaire (qui refuserait de toute façon). */
  const checkCloudPaths = (t: ToolboxEntry, params: Record<string, unknown>, scope: ToolScope) => {
    if (!scope.cloud || !cfg.memory.folders.length) return;
    const memory = cfg.memory.folders.flatMap(forms);
    for (const [name, spec] of Object.entries(t.parameters)) {
      const v = params[name];
      if (typeof v !== "string" || !isPathParam(name, spec)) continue;
      for (const target of forms(v)) {
        if (memory.some((m) => isInside(m, target) || isInside(target, m))) {
          throw new Error(`${name} : ce chemin contient ou touche la mémoire, fermée aux agents sur un modèle en ligne`);
        }
      }
    }
  };

  /**
   * Chemins relatifs résolus dans l'espace de travail de l'agent. Sans espace de travail, un chemin relatif est refusé :
   * il serait contrôlé ici et interprété ailleurs (dossier courant du gestionnaire).
   */
  const resolveParams = (t: ToolboxEntry, params: Record<string, unknown>, scope: ToolScope = {}): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...params };
    for (const [name, spec] of Object.entries(t.parameters)) {
      const v = out[name];
      if (typeof v !== "string" || !isPathParam(name, spec)) continue;
      // Windows : « \dossier » dépend du disque courant, différent ici et chez le gestionnaire. Seul « X:\… » est complet.
      if (process.platform === "win32" && path.isAbsolute(v) && !/^[A-Za-z]:[\\/]/.test(v)) {
        throw new Error(`${name} : chemin complet avec la lettre du disque attendu (ex. I:/dossier), pas « ${v} »`);
      }
      if (path.isAbsolute(v)) continue;
      if (!scope.workspace) throw new Error(`${name} : chemin complet attendu (ex. I:/dossier/image.png), « ${v} » est relatif`);
      out[name] = path.resolve(scope.workspace, v);
    }
    return out;
  };

  const key = (tool: string, params: unknown, scope: ToolScope = {}) => JSON.stringify([tool, params, scope.workspace ?? ""]);

  return {
    id: "toolbox",
    label: "Boîte à outils",
    async available() {
      if (!fs.existsSync(path.join(dir, "tool_manager.py"))) {
        return { ok: false, reason: `tool_manager.py introuvable dans ${dir} (réglage toolbox.dir de config/agent.json)` };
      }
      let r: ManagerReply;
      try {
        r = await runner(["list"], undefined, LIST_TIMEOUT_MS);
      } catch (e) {
        return { ok: false, reason: `${(e as Error).message} (Python : réglage toolbox.python)` };
      }
      if (!r.success || !Array.isArray(r.data)) return { ok: false, reason: formatError(r) };
      catalog = (r.data as ToolboxEntry[]).filter((t) => t && typeof t.name === "string" && /^[a-z0-9_]+$/.test(t.name));
      previews.clear();
      return visible().length ? { ok: true } : { ok: false, reason: "aucun outil activé (tools/policy.json)" };
    },
    tools() {
      const categories = [...new Set(visible().map((t) => t.category))].sort();
      return [
        defineTool({
          name: "toolbox_find",
          description:
            `Cherche dans la boîte à outils locale (${categories.join(", ")}) l'outil qui fait ce qu'on demande : retoucher, recadrer, ` +
            "recolorer, redimensionner ou convertir des images et textures, construire, contrôler, rendre ou exporter (.glb) un modèle 3D avec Blender, " +
            "trouver une texture Poly Haven, chercher dans du code, vérifier un projet Rust ou Godot… " +
            "Renvoie les outils correspondants avec leurs paramètres. Ensuite, exécute avec toolbox_run.",
          schema: z.object({
            query: z.string().max(120).optional().describe("Mots-clés de ce qu'il faut faire, ex. « couleur image », « redimensionner texture »"),
            category: z.string().max(30).optional().describe(`Catégorie : ${categories.join(", ")}`),
          }),
          risk: "read",
          preview: () => "",
          async run(a) {
            let list = visible();
            if (a.category) list = list.filter((t) => t.category === a.category);
            const words = (a.query ?? "")
              .toLowerCase()
              .normalize("NFD")
              .replace(/[̀-ͯ]/g, "")
              .split(/[^a-z0-9_]+/)
              .filter((w) => w.length > 2);
            const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
            const scored = list
              .map((t) => {
                const hay = norm(`${t.name} ${t.category} ${t.description}`);
                return { t, score: words.reduce((n, w) => n + (hay.includes(w) || hay.includes(w.replace(/s$/, "")) ? 1 : 0), 0) };
              })
              .filter((x) => !words.length || x.score > 0)
              .sort((x, y) => y.score - x.score);
            if (!scored.length) {
              return `Aucun outil pour « ${a.query ?? ""} ». Outils disponibles :\n` + list.map((t) => `- ${t.name} (${t.category}) : ${shortText(t.description)}`).join("\n");
            }
            const detailed = scored.slice(0, words.length ? 3 : 0);
            const rest = scored.slice(detailed.length);
            const parts = detailed.map(
              ({ t }) =>
                `${t.name} (${t.category}, ${t.needs_confirmation ? "confirmation de l'utilisateur" : "sans confirmation"}) : ${t.description}\n  Paramètres :\n${describeParams(t)}`,
            );
            if (rest.length) parts.push("Autres : " + rest.map(({ t }) => `${t.name} (${shortText(t.description, 80)})`).join(" ; "));
            parts.push('Exécute avec toolbox_run {"tool": "<nom>", "params": {…}}. Chemins absolus (ou relatifs à ton espace de travail).');
            return parts.join("\n\n");
          },
        }),
        defineTool({
          name: "toolbox_run",
          description:
            "Exécute un outil de la boîte à outils locale (nom et paramètres donnés par toolbox_find). " +
            "Les outils qui modifient des fichiers demandent la confirmation de l'utilisateur par l'interface : appelle directement.",
          schema: z.object({
            tool: z.string().regex(/^[a-z0-9_]+$/).max(60).describe("Nom exact de l'outil"),
            params: z.record(z.string(), z.unknown()).default({}).describe("Paramètres de l'outil (objet JSON)"),
          }),
          // `local` + confirmIf : la confirmation suit le manifeste (read/launch : non ; local/external : oui).
          risk: "local",
          confirmIf: (a) => find(a.tool).needs_confirmation,
          async check(a, scope) {
            const t = find(a.tool);
            checkCloudPaths(t, resolveParams(t, a.params, scope), scope);
            const missing = Object.entries(t.parameters)
              .filter(([n, p]) => p.required && (a.params[n] === undefined || a.params[n] === null || a.params[n] === ""))
              .map(([n]) => n);
            if (missing.length) throw new Error(`paramètres obligatoires manquants pour ${t.name} : ${missing.join(", ")}\nParamètres :\n${describeParams(t)}`);
            const unknown = Object.keys(a.params).filter((n) => !(n in t.parameters));
            if (unknown.length) throw new Error(`paramètres inconnus pour ${t.name} : ${unknown.join(", ")}\nParamètres :\n${describeParams(t)}`);
            if (!t.needs_confirmation) return;
            // Essai sans --confirmed : le gestionnaire vérifie dossiers et permissions et renvoie l'aperçu, sans rien exécuter.
            const params = resolveParams(t, a.params, scope);
            const r = await runner(["run", t.name, "-", ...denyArgs(scope)], JSON.stringify(params), LIST_TIMEOUT_MS);
            if (r.code === 2 && r.error?.type === "ConfirmationRequired") {
              previews.set(key(t.name, a.params, scope), formatPreview(t.name, r.data));
              return;
            }
            if (!r.success) throw new Error(formatError(r));
            throw new Error(`réponse inattendue du gestionnaire pour ${t.name} (aucune confirmation demandée)`);
          },
          preview: (a, scope) => previews.get(key(a.tool, a.params, scope)) ?? `Lancer l'outil ${a.tool} de la boîte à outils.`,
          async run(a, ctx) {
            const t = find(a.tool);
            const params = resolveParams(t, a.params, ctx);
            checkCloudPaths(t, params, ctx);
            previews.delete(key(t.name, a.params, ctx));
            // Ce run() n'est appelé par l'agent qu'après la confirmation de l'interface quand le manifeste l'exige
            // (core/agent.ts → needsConfirmation) : c'est seulement là que --confirmed est posé.
            const args = ["run", t.name, "-", ...denyArgs(ctx), ...(t.needs_confirmation ? ["--confirmed"] : [])];
            ctx.ui.progress(`Boîte à outils : ${t.name}…`);
            const r = await runner(args, JSON.stringify(params), RUN_TIMEOUT_MS, ctx.signal);
            if (!r.success) throw new Error(formatError(r));
            return formatResult(r);
          },
        }),
      ];
    },
  };
}
