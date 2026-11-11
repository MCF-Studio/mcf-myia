import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { isInside } from "../core/paths.js";

const ASSET_API = "https://godotengine.org/asset-library/api";
const MAX_ZIP_BYTES = 300 * 1024 * 1024;

export interface AddonInfo {
  spec: string;
  title: string;
  author: string;
  license: string;
  version: string;
  godotVersion: string;
  source: string;
  downloadUrl: string;
}

export interface AssetSummary {
  asset_id: string;
  title: string;
  author: string;
  godot_version: string;
  version_string: string;
  cost: string;
  category: string;
}

/** Recherche dans l'Asset Library officielle (addons compatibles avec la version donnée). */
export async function searchAddons(query: string, godotVersion: string, max = 8): Promise<AssetSummary[]> {
  const u = new URL(`${ASSET_API}/asset`);
  u.searchParams.set("filter", query);
  u.searchParams.set("type", "addon");
  u.searchParams.set("godot_version", godotVersion);
  u.searchParams.set("max_results", String(max));
  const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Asset Library : HTTP ${r.status}`);
  const data = (await r.json()) as { result: AssetSummary[] };
  return data.result;
}

const GITHUB = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@([A-Za-z0-9_./-]+))?$/;

/** Résout "1234" (id Asset Library) ou "github:auteur/depot[@ref]" en source téléchargeable. */
export async function resolveAddon(spec: string): Promise<AddonInfo> {
  const s = spec.trim();
  if (/^\d+$/.test(s)) {
    const r = await fetch(`${ASSET_API}/asset/${s}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`asset ${s} introuvable (HTTP ${r.status})`);
    const a = (await r.json()) as Record<string, string>;
    if (a.type && a.type !== "addon") throw new Error(`asset ${s} n'est pas un addon (type ${a.type})`);
    return {
      spec: s,
      title: a.title ?? s,
      author: a.author ?? "?",
      license: a.cost ?? "?",
      version: a.version_string ?? "?",
      godotVersion: a.godot_version ?? "?",
      source: a.browse_url ?? `https://godotengine.org/asset-library/asset/${s}`,
      downloadUrl: a.download_url ?? "",
    };
  }
  const m = GITHUB.exec(s);
  if (m) {
    const [, owner, repo, ref] = m;
    return {
      spec: s,
      title: `${owner}/${repo}`,
      author: owner!,
      license: "voir le dépôt",
      version: ref ?? "HEAD",
      godotVersion: "?",
      source: `https://github.com/${owner}/${repo}`,
      downloadUrl: `https://github.com/${owner}/${repo}/archive/${ref ?? "HEAD"}.zip`,
    };
  }
  throw new Error(`addon "${spec}" : attendu un id de l'Asset Library (ex. 1234) ou "github:auteur/depot"`);
}

export async function downloadZip(url: string): Promise<Buffer> {
  if (!/^https:\/\//.test(url)) throw new Error(`URL de téléchargement refusée (https requis) : ${url}`);
  const r = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!r.ok || !r.body) throw new Error(`téléchargement échoué (HTTP ${r.status}) : ${url}`);
  const declared = Number(r.headers.get("content-length") ?? 0);
  if (declared > MAX_ZIP_BYTES) throw new Error(`archive trop grosse (${declared} octets)`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_ZIP_BYTES) throw new Error("archive trop grosse (> 300 Mo)");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Calcule le chemin cible d'une entrée d'archive, ou null si elle doit être ignorée.
 * Seul le premier dossier `addons/` au niveau `depth` est retenu. Tout chemin qui sortirait
 * du projet (zip slip : "..", chemin absolu, lecteur) est rejeté.
 */
export function addonTarget(entryName: string, depth: number): string | null {
  const norm = entryName.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return null;
  const parts = norm.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === ".." || p.includes(":"))) return null;
  if (parts[depth] !== "addons" || parts.length < depth + 3) return null;
  return parts.slice(depth).join("/");
}

/** Profondeur du dossier `addons/` le moins profond de l'archive, ou -1. */
export function addonsDepth(entryNames: string[]): number {
  let best = -1;
  for (const n of entryNames) {
    const parts = n.replace(/\\/g, "/").split("/");
    const i = parts.indexOf("addons");
    if (i >= 0 && i < parts.length - 2 && (best < 0 || i < best)) best = i;
  }
  return best;
}

export interface ExtractResult {
  folders: string[];
  plugins: string[];
  files: number;
}

/** Extrait uniquement `addons/**` de l'archive dans le projet. Refuse d'écraser un addon existant. */
export function extractAddons(zip: Buffer, projectDir: string): ExtractResult {
  const archive = new AdmZip(zip);
  const entries = archive.getEntries().filter((e) => !e.isDirectory);
  const depth = addonsDepth(entries.map((e) => e.entryName));
  if (depth < 0) throw new Error("l'archive ne contient pas de dossier addons/ (ce n'est peut-être pas un addon)");

  const planned: { target: string; data: () => Buffer }[] = [];
  const folders = new Set<string>();
  for (const e of entries) {
    const rel = addonTarget(e.entryName, depth);
    if (!rel) continue;
    const abs = path.resolve(projectDir, rel);
    if (!isInside(path.join(projectDir, "addons"), abs)) throw new Error(`chemin suspect dans l'archive : ${e.entryName}`);
    folders.add(rel.split("/")[1]!);
    planned.push({ target: abs, data: () => e.getData() });
  }
  for (const f of folders) {
    if (fs.existsSync(path.join(projectDir, "addons", f))) throw new Error(`addons/${f} existe déjà dans le projet`);
  }
  for (const p of planned) {
    fs.mkdirSync(path.dirname(p.target), { recursive: true });
    fs.writeFileSync(p.target, p.data());
  }
  const plugins = [...folders]
    .filter((f) => fs.existsSync(path.join(projectDir, "addons", f, "plugin.cfg")))
    .map((f) => `res://addons/${f}/plugin.cfg`);
  return { folders: [...folders], plugins, files: planned.length };
}

export type Renderer = "forward_plus" | "mobile" | "gl_compatibility";
const FEATURE: Record<Renderer, string> = {
  forward_plus: "Forward Plus",
  mobile: "Mobile",
  gl_compatibility: "GL Compatibility",
};

export function newProjectGodot(name: string, version: string, renderer: Renderer): string {
  const lines = [
    "; Engine configuration file.",
    "; Généré par MyIA. Godot complétera ce fichier à la première ouverture.",
    "",
    "config_version=5",
    "",
    "[application]",
    "",
    `config/name="${name.replace(/"/g, '\\"')}"`,
    `config/features=PackedStringArray("${version}", "${FEATURE[renderer]}")`,
    "",
  ];
  if (renderer !== "forward_plus") {
    lines.push("[rendering]", "", `renderer/rendering_method="${renderer}"`, "");
  }
  return lines.join("\n");
}

/** Ajoute des plugins à [editor_plugins] enabled=PackedStringArray(...) sans doublon. */
export function enablePlugins(projectGodot: string, plugins: string[]): string {
  if (plugins.length === 0) return projectGodot;
  const re = /^enabled=PackedStringArray\((.*)\)\s*$/m;
  const section = /^\[editor_plugins\]\s*$/m;
  const quote = (p: string) => `"${p}"`;

  if (section.test(projectGodot) && re.test(projectGodot)) {
    return projectGodot.replace(re, (_m, inner: string) => {
      const existing = [...inner.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
      const all = [...existing, ...plugins.filter((p) => !existing.includes(p))];
      return `enabled=PackedStringArray(${all.map(quote).join(", ")})`;
    });
  }
  const line = `enabled=PackedStringArray(${plugins.map(quote).join(", ")})`;
  if (section.test(projectGodot)) {
    return projectGodot.replace(section, (s) => `${s}\n\n${line}`);
  }
  return projectGodot.replace(/\s*$/, "") + `\n\n[editor_plugins]\n\n${line}\n`;
}
