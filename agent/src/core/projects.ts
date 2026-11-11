import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

/**
 * Registre des projets de l'utilisateur : ceux de la config + ceux trouvés automatiquement sous `projectRoots`.
 * Les commandes de build sont GÉNÉRÉES ici à partir de la structure du projet (presets d'export Godot,
 * Cargo.toml, src-tauri, package.json). Le modèle choisit un projet et une cible, jamais une commande (SPEC §3).
 */

export type Kind = "godot" | "tauri" | "rust" | "node";

export interface BuildTarget {
  argv: string[];
  cwd: string;
  /** Dossier à créer avant le build (dossier de sortie d'un export Godot). */
  ensureDir?: string;
}

export interface Project {
  name: string;
  path: string;
  kinds: Kind[];
  description?: string;
  targets: Record<string, BuildTarget>;
  /** Dossier contenant project.godot (le projet lui-même ou un sous-dossier). */
  godotDir?: string;
  godotVersion?: string;
  /** Problèmes de détection à signaler (ex. exécutable Godot absent pour la version du projet). */
  notes: string[];
  autoApprove: boolean;
  claudeAllowedTools?: string[];
  source: "config" | "auto";
}

const SKIP = new Set(["node_modules", "target", "dist", "build", "builds", "addons", "src-tauri", "vendor", "bin", "obj"]);
const IS_WIN = process.platform === "win32";

const exists = (...p: string[]) => fs.existsSync(path.join(...p));
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("$") && !SKIP.has(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// ───────────── Godot ─────────────

export interface ExportPreset {
  name: string;
  platform: string;
  exportPath: string;
}

/** Lit les sections [preset.N] de export_presets.cfg (pas les [preset.N.options]). */
export function parseExportPresets(text: string): ExportPreset[] {
  const out: ExportPreset[] = [];
  let cur: Partial<ExportPreset> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      if (cur?.name) out.push({ name: cur.name, platform: cur.platform ?? "", exportPath: cur.exportPath ?? "" });
      cur = /^\[preset\.\d+\]$/.test(line) ? {} : undefined;
      continue;
    }
    if (!cur) continue;
    const m = /^(name|platform|export_path)\s*=\s*"(.*)"$/.exec(line);
    if (!m) continue;
    if (m[1] === "name") cur.name = m[2];
    else if (m[1] === "platform") cur.platform = m[2];
    else cur.exportPath = m[2];
  }
  if (cur?.name) out.push({ name: cur.name, platform: cur.platform ?? "", exportPath: cur.exportPath ?? "" });
  return out;
}

/** Version « majeure.mineure » d'un project.godot (config/features), ex. "4.7". */
export function godotVersionOf(projectGodot: string): string | undefined {
  const m = /config\/features\s*=\s*PackedStringArray\(([^)]*)\)/.exec(projectGodot);
  return m?.[1]?.match(/"(\d+\.\d+)"/)?.[1];
}

/** Repère les exécutables Godot d'un dossier : garde le correctif le plus récent par version (4.7.2 > 4.7). */
export function detectGodotExecutables(dir: string | undefined): Record<string, string> {
  if (!dir) return {};
  const best: Record<string, { patch: number; file: string }> = {};
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return {};
  }
  for (const f of files) {
    const m = /^Godot_v(\d+)\.(\d+)(?:\.(\d+))?-stable_win64\.exe$/.exec(f);
    if (!m) continue;
    const key = `${m[1]}.${m[2]}`;
    const patch = Number(m[3] ?? 0);
    if (!best[key] || patch > best[key].patch) best[key] = { patch, file: path.join(dir, f).replaceAll("\\", "/") };
  }
  return Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.file]));
}

// ───────────── Node / Rust / Tauri ─────────────

export function packageManager(dir: string): "pnpm" | "yarn" | "bun" | "npm" {
  if (exists(dir, "pnpm-lock.yaml")) return "pnpm";
  if (exists(dir, "yarn.lock")) return "yarn";
  if (exists(dir, "bun.lockb") || exists(dir, "bun.lock")) return "bun";
  return "npm";
}

function readScripts(dir: string): Record<string, string> {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return {};
  }
}

/** Les gestionnaires Node sont des .cmd sous Windows : on passe par cmd sans shell intermédiaire, argv fixe. */
function nodeCmd(args: string[]): string[] {
  return IS_WIN ? ["cmd", "/d", "/c", ...args] : args;
}

function runScript(pm: string, script: string, extra: string[] = []): string[] {
  if (pm === "npm") return nodeCmd(["npm", "run", script, ...(extra.length ? ["--", ...extra] : [])]);
  return nodeCmd([pm, "run", script, ...extra]);
}

function tauriCli(dir: string, pm: string, args: string[]): string[] {
  if (readScripts(dir).tauri) return runScript(pm, "tauri", args);
  if (pm === "npm") return nodeCmd(["npx", "--no-install", "tauri", ...args]);
  return nodeCmd([pm, "exec", "tauri", ...args]);
}

// ───────────── Détection ─────────────

interface Component {
  kinds: Kind[];
  targets: Record<string, BuildTarget>;
  godotDir?: string;
  godotVersion?: string;
  notes: string[];
}

/** Cibles générées pour UN dossier (racine du projet ou sous-dossier type backend/, frontend/). */
export function componentAt(dir: string, godotExes: Record<string, string>): Component | undefined {
  const c: Component = { kinds: [], targets: {}, notes: [] };

  if (exists(dir, "project.godot")) {
    c.kinds.push("godot");
    c.godotDir = dir;
    c.godotVersion = godotVersionOf(fs.readFileSync(path.join(dir, "project.godot"), "utf8"));
    const exe = c.godotVersion ? godotExes[c.godotVersion] : undefined;
    const presets = exists(dir, "export_presets.cfg")
      ? parseExportPresets(fs.readFileSync(path.join(dir, "export_presets.cfg"), "utf8"))
      : [];
    if (!presets.length) c.notes.push("aucun preset d'export (Projet > Exporter dans Godot)");
    else if (!exe) c.notes.push(`pas d'exécutable Godot ${c.godotVersion ?? "?"} installé : export impossible`);
    else {
      for (const p of presets) {
        const out = p.exportPath ? path.resolve(dir, p.exportPath) : undefined;
        const base = [exe, "--headless", "--path", dir];
        const tail = out ? [out] : [];
        const ensureDir = out ? path.dirname(out) : undefined;
        c.targets[p.name] = { argv: [...base, "--export-release", p.name, ...tail], cwd: dir, ensureDir };
        c.targets[`${p.name} [debug]`] = { argv: [...base, "--export-debug", p.name, ...tail], cwd: dir, ensureDir };
      }
    }
  }

  if (exists(dir, "src-tauri", "tauri.conf.json") || exists(dir, "src-tauri", "Cargo.toml")) {
    c.kinds.push("tauri");
    const pm = packageManager(dir);
    const rs = path.join(dir, "src-tauri");
    c.targets.build = { argv: tauriCli(dir, pm, ["build"]), cwd: dir };
    c.targets["build-debug"] = { argv: tauriCli(dir, pm, ["build", "--debug"]), cwd: dir };
    c.targets.check = { argv: ["cargo", "check"], cwd: rs };
    c.targets.test = { argv: ["cargo", "test"], cwd: rs };
    if (readScripts(dir).build) c.targets.front = { argv: runScript(pm, "build"), cwd: dir };
  } else if (exists(dir, "Cargo.toml")) {
    c.kinds.push("rust");
    c.targets.build = { argv: ["cargo", "build", "--release"], cwd: dir };
    c.targets["build-debug"] = { argv: ["cargo", "build"], cwd: dir };
    c.targets.check = { argv: ["cargo", "check"], cwd: dir };
    c.targets.test = { argv: ["cargo", "test"], cwd: dir };
  } else if (exists(dir, "package.json") && !c.kinds.includes("godot")) {
    c.kinds.push("node");
    const pm = packageManager(dir);
    const scripts = readScripts(dir);
    if (scripts.build) c.targets.build = { argv: runScript(pm, "build"), cwd: dir };
    if (scripts.test) c.targets.test = { argv: runScript(pm, "test"), cwd: dir };
  }

  return c.kinds.length ? c : undefined;
}

/** Racine de projet : marqueur propre, dépôt git, ou README + sous-dossier technique (backend/, frontend/…). */
export function isProjectDir(dir: string): boolean {
  if (["project.godot", "Cargo.toml", "package.json", ".git"].some((f) => exists(dir, f))) return true;
  if (exists(dir, "src-tauri")) return true;
  if (!exists(dir, "README.md")) return false;
  return subdirs(dir).some((s) => ["project.godot", "Cargo.toml", "src-tauri"].some((f) => exists(dir, s, f)));
}

/** Assemble un projet : composant racine + composants des sous-dossiers directs (préfixés « sous-dossier: »). */
export function analyzeProject(dir: string, godotExes: Record<string, string>): Omit<Project, "name" | "source" | "autoApprove"> | undefined {
  const p: Omit<Project, "name" | "source" | "autoApprove"> = { path: dir, kinds: [], targets: {}, notes: [] };
  const add = (c: Component, prefix: string) => {
    for (const k of c.kinds) if (!p.kinds.includes(k)) p.kinds.push(k);
    for (const [t, v] of Object.entries(c.targets)) p.targets[prefix ? `${prefix}:${t}` : t] = v;
    p.notes.push(...c.notes.map((n) => (prefix ? `${prefix} : ${n}` : n)));
    if (c.godotDir && !p.godotDir) {
      p.godotDir = c.godotDir;
      p.godotVersion = c.godotVersion;
    }
  };
  const root = componentAt(dir, godotExes);
  if (root) add(root, "");
  for (const s of subdirs(dir)) {
    const c = componentAt(path.join(dir, s), godotExes);
    if (c && !(root?.kinds.includes("node") && c.kinds.includes("node"))) add(c, s);
  }
  return p.kinds.length ? p : undefined;
}

export function discoverProjectDirs(roots: { path: string; depth: number }[]): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const s of subdirs(dir)) {
      const child = path.join(dir, s);
      if (isProjectDir(child)) found.push(child);
      else if (depth > 1) walk(child, depth - 1);
    }
  };
  for (const r of roots) if (fs.existsSync(r.path)) walk(r.path, r.depth);
  return found;
}

// ───────────── Registre ─────────────

export class ProjectRegistry {
  private list: Project[] = [];
  readonly godotExes: Record<string, string>;

  constructor(private readonly cfg: Config) {
    this.godotExes = { ...detectGodotExecutables(cfg.godot.versionsDir), ...cfg.godot.executables };
    this.refresh();
  }

  get all(): readonly Project[] {
    return this.list;
  }

  refresh() {
    const byPath = new Map<string, Project>();
    const key = (p: string) => path.resolve(p).toLowerCase();

    for (const dir of discoverProjectDirs(this.cfg.projectRoots)) {
      const a = analyzeProject(dir, this.godotExes);
      if (a) byPath.set(key(dir), { ...a, name: path.basename(dir), autoApprove: false, source: "auto" });
    }
    // La config complète ou remplace : nom, description, cibles en plus, autoApprove, outils Claude.
    for (const [name, pc] of Object.entries(this.cfg.projects)) {
      const auto = byPath.get(key(pc.path)) ?? (fs.existsSync(pc.path) ? analyzeProject(pc.path, this.godotExes) : undefined);
      const targets = { ...(auto?.targets ?? {}) };
      for (const [t, argv] of Object.entries(pc.build)) targets[t] = { argv, cwd: pc.path };
      byPath.set(key(pc.path), {
        path: pc.path,
        kinds: auto?.kinds ?? [],
        notes: auto?.notes ?? [],
        godotDir: auto?.godotDir,
        godotVersion: auto?.godotVersion,
        targets,
        name,
        description: pc.description,
        autoApprove: pc.autoApprove,
        claudeAllowedTools: pc.claudeAllowedTools,
        source: "config",
      });
    }

    // Noms en double (ex. deux dossiers MCF-Tribe-V-Face) : on préfixe par le dossier parent.
    const list = [...byPath.values()];
    const counts = new Map<string, number>();
    for (const p of list) counts.set(normalize(p.name), (counts.get(normalize(p.name)) ?? 0) + 1);
    for (const p of list) {
      if (p.source === "auto" && (counts.get(normalize(p.name)) ?? 0) > 1) p.name = `${path.basename(path.dirname(p.path))}/${p.name}`;
    }
    this.list = list.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Recherche tolérante (casse, espaces, tirets) ; liste les candidats si c'est ambigu. */
  find(query: string, kind?: Kind): Project[] {
    const q = normalize(query);
    const pool = kind ? this.list.filter((p) => p.kinds.includes(kind)) : this.list;
    if (!q) return [...pool];
    const keys = (p: Project) => {
      const base = normalize(path.basename(p.path));
      return { name: normalize(p.name), base, withParent: normalize(path.basename(path.dirname(p.path))) + base };
    };
    const exact = pool.filter((p) => {
      const k = keys(p);
      return k.name === q || k.base === q || k.withParent === q;
    });
    if (exact.length) return exact;
    // Mots dans n'importe quel ordre : « launcher MCF RP » trouve « MCF RP/Launcher ».
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const partial = pool.filter((p) => {
      const k = keys(p);
      return k.name.includes(q) || k.withParent.includes(q) || (words.length > 1 && words.every((w) => k.withParent.includes(w)));
    });
    // « mcf 2d rp client » : « client » désigne la cible, pas le projet. On garde les projets qui
    // contiennent le plus de mots, s'ils en contiennent tous sauf un (au moins deux).
    let candidates = partial;
    if (!candidates.length && words.length > 2) {
      const score = (p: Project) => words.filter((w) => keys(p).withParent.includes(w)).length;
      const best = Math.max(0, ...pool.map(score));
      if (best >= Math.max(2, words.length - 1)) candidates = pool.filter((p) => score(p) === best);
    }
    // « X - Copie », « X_save »… : écartés si l'original correspond aussi.
    const COPY = /(copie|copy|save|backup|old)$/i;
    const originals = candidates.filter((p) => !COPY.test(normalize(path.basename(p.path)).replace(/\d+$/, "")));
    return originals.length ? originals : candidates;
  }

  resolve(query: string, kind?: Kind): Project {
    let res = this.find(query, kind);
    if (!res.length) {
      this.refresh(); // projet créé depuis le démarrage
      res = this.find(query, kind);
    }
    if (res.length === 1) return res[0]!;
    const what = kind ? `projet ${kind}` : "projet";
    if (!res.length) throw new Error(`aucun ${what} ne correspond à "${query}". Utilise projects_find pour chercher.`);
    throw new Error(
      `plusieurs ${what}s correspondent à "${query}" : ${res
        .slice(0, 12)
        .map((p) => p.name)
        .join(", ")}${res.length > 12 ? "…" : ""}. Demande à l'utilisateur lequel.`,
    );
  }
}

/** Cible par défaut si aucune n'est demandée : la seule existante, sinon "build". */
export function defaultTarget(p: Project): string | undefined {
  const names = Object.keys(p.targets);
  if (names.length === 1) return names[0];
  if (p.targets.build) return "build";
  return undefined;
}
