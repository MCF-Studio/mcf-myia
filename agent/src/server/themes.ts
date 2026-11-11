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
const BUILTIN = new Set(["volcano", "ember-light", "midnight"]);

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

export function installTheme(raw: unknown): Theme {
  if (typeof raw === "string") {
    if (raw.length > 32_000) throw new Error("fichier de thème trop gros");
    raw = JSON.parse(raw);
  }
  const res = ThemeSchema.safeParse(raw);
  if (!res.success) {
    throw new Error("Thème invalide : " + res.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(" ; "));
  }
  if (BUILTIN.has(res.data.id)) throw new Error(`l'id « ${res.data.id} » est réservé à un thème intégré`);
  writeJsonAtomic(path.join(dir(), `${res.data.id}.json`), res.data);
  return res.data;
}

export function deleteTheme(id: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) throw new Error("id invalide");
  const f = path.join(dir(), `${id}.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
