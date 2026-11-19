import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { paths } from "../core/paths.js";
import { writeJsonAtomic } from "../core/profiles.js";

/**
 * Thème installable (téléchargé ou partagé). Un thème est UNIQUEMENT une liste de couleurs et de réglages fermés :
 * pas de CSS libre, pas d'URL, pas de police distante. Impossible d'y glisser du script ou un traceur.
 * Les jetons correspondent aux variables CSS de l'app (app/src/styles/tokens.css).
 */
export const THEME_TOKENS = [
  "bg",
  "bg-elevated",
  "surface",
  "surface-2",
  "border",
  "text",
  "text-muted",
  "accent",
  "accent-2",
  "accent-contrast",
  "glow",
  "success",
  "warning",
  "danger",
] as const;

const COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;

export const ThemeSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
  name: z.string().trim().min(1).max(40),
  author: z.string().trim().max(60).optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).default("1.0.0"),
  mode: z.enum(["dark", "light"]),
  colors: z.strictObject(Object.fromEntries(THEME_TOKENS.map((t) => [t, z.string().regex(COLOR)])) as Record<
    (typeof THEME_TOKENS)[number],
    z.ZodString
  >),
  radius: z.enum(["sharp", "normal", "round"]).default("normal"),
});

export type Theme = z.infer<typeof ThemeSchema>;

const dir = () => path.join(paths.home, "data", "themes");

/** Ids réservés aux thèmes intégrés à l'app. */
const BUILTIN = new Set(["volcano", "ember-light", "midnight", "abysses", "neon-nuit", "sauge", "fusion-nuit", "lin"]);

export function listThemes(): Theme[] {
  if (!fs.existsSync(dir())) return [];
  const out: Theme[] = [];
  for (const f of fs.readdirSync(dir())) {
    if (!f.endsWith(".json")) continue;
    try {
      const res = ThemeSchema.safeParse(JSON.parse(fs.readFileSync(path.join(dir(), f), "utf8")));
      if (res.success) out.push(res.data);
    } catch {
      // fichier illisible : ignoré (l'app ne doit pas refuser de démarrer pour un thème cassé)
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Valide un thème (texte JSON ou objet) sans l'enregistrer. Les clés inconnues (ex. `aide` du modèle) sont ignorées. */
export function parseTheme(raw: unknown): Theme {
  if (typeof raw === "string") {
    if (raw.length > 32_000) throw new Error("fichier de thème trop gros");
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      throw new Error(`JSON invalide : ${(e as Error).message}`);
    }
  }
  const res = ThemeSchema.safeParse(raw);
  if (!res.success) {
    throw new Error("Thème invalide : " + res.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(" ; "));
  }
  return res.data;
}

/**
 * Lit un fichier de thème choisi par l'utilisateur, pour l'essayer (aperçu) sans l'installer. L'app relit le même
 * fichier à intervalle régulier : on modifie les couleurs dans son éditeur et on voit le résultat aussitôt.
 * Seul un .json de 32 Ko au plus est lu ; le contenu passe par la même validation que l'installation.
 */
export function readThemeFile(file: string): { theme: Theme; mtimeMs: number } {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".json") throw new Error("fichier .json attendu");
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error("ce n'est pas un fichier");
  if (st.size > 32_000) throw new Error("fichier de thème trop gros (32 Ko max)");
  return { theme: parseTheme(fs.readFileSync(file, "utf8")), mtimeMs: st.mtimeMs };
}

/** Date de modification d'un fichier de thème en aperçu (pour ne le relire que s'il a changé). */
export function themeFileMtime(file: string): number {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".json") throw new Error("fichier .json attendu");
  return fs.statSync(file).mtimeMs;
}

export function installTheme(raw: unknown): Theme {
  const theme = parseTheme(raw);
  if (BUILTIN.has(theme.id)) throw new Error(`l'id « ${theme.id} » est réservé à un thème intégré`);
  writeJsonAtomic(path.join(dir(), `${theme.id}.json`), theme);
  return theme;
}

export function deleteTheme(id: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) throw new Error("id invalide");
  const f = path.join(dir(), `${id}.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
