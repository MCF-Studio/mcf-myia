import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MODEL_NAME } from "./llm.js";
import { paths } from "./paths.js";

/**
 * Profil d'agent (« personnalité ») : nom, modèle, consignes, services autorisés.
 * Les profils sont des DONNÉES, jamais du code : un profil téléchargé ne peut que restreindre l'agent
 * (liste blanche de services), pas lui donner de nouveaux pouvoirs. Les règles de confirmation (SPEC §3)
 * s'appliquent quel que soit le profil.
 *
 * Fichier : config/agents.json (hors git, propre à chaque machine).
 */
export const AgentProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "id : minuscules, chiffres et tirets (40 max)"),
  name: z.string().trim().min(1).max(40),
  description: z.string().max(300).optional(),
  /** Modèle local, ou « claude:<alias> » pour confier l'agent à Claude (claude-llm.ts) ; absent = llm.model de la config. */
  model: z.string().max(120).regex(MODEL_NAME).optional(),
  /** Couleur d'accent dans l'interface. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Photo : image PNG/JPEG/WebP en data URL (256 px max, recadrée par l'app). Pas de SVG : il peut contenir du script. */
  avatar: z
    .string()
    .max(150_000)
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/]+={0,2}$/, "image PNG, JPEG ou WebP attendue")
    .optional(),
  /** Consignes ajoutées au prompt système (ton, rôle). Ne remplacent jamais les règles de sécurité. */
  instructions: z.string().max(4000).optional(),
  /** Agent MASTER : l'assistant principal, qui pilote l'app (un seul ; voir services/app-control.ts). */
  master: z.boolean().optional(),
  /** Ids des services autorisés ; absent = tous les services disponibles. */
  services: z.array(z.string().max(60)).max(50).optional(),
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

const FileSchema = z.object({ agents: z.array(AgentProfileSchema).max(100) });

/** Agent neutre fourni avec le code : l'app démarre même sans aucun profil installé. */
export const DEFAULT_PROFILE: AgentProfile = { id: "myia", name: "MyIA" };

export const profilesFile = () => path.join(paths.home, "config", "agents.json");

export function loadProfiles(file = profilesFile()): AgentProfile[] {
  if (!fs.existsSync(file)) return [DEFAULT_PROFILE];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`JSON invalide dans ${file} : ${(e as Error).message}`);
  }
  const res = FileSchema.safeParse(raw);
  if (!res.success) {
    throw new Error(
      `Profils invalides (${file}) : ` + res.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(" ; "),
    );
  }
  const list = res.data.agents;
  const ids = new Set<string>();
  for (const p of list) {
    if (ids.has(p.id)) throw new Error(`Profil en double : ${p.id}`);
    ids.add(p.id);
  }
  return list.length ? list : [DEFAULT_PROFILE];
}

/** Écriture atomique (fichier temporaire puis renommage) : un crash ne laisse jamais un fichier à moitié écrit. */
export function saveProfiles(list: AgentProfile[], file = profilesFile()) {
  const data = FileSchema.parse({ agents: list });
  writeJsonAtomic(file, data);
}

export function writeJsonAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}
