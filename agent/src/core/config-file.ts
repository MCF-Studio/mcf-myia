import fs from "node:fs";
import { configTemplate, loadConfig, parseConfig, type Config } from "./config.js";
import { paths } from "./paths.js";
import { writeJsonAtomic } from "./profiles.js";

/**
 * Modifie config/agent.json sans toucher au reste du fichier (clés inconnues, ordre, valeurs non modifiées).
 * Le résultat est validé AVANT l'écriture : une modification invalide ne casse jamais la config.
 */
export function patchConfigFile(mutate: (raw: Record<string, any>) => void, file = paths.config): Config {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
  mutate(raw);
  parseConfig(raw);
  writeJsonAtomic(file, raw);
  return loadConfig(file);
}

/** Lien vers la description de chaque option (écrit en tête du fichier, ignoré par MyIA). */
export const CONFIG_HELP = "Toutes les options sont expliquées ici : https://github.com/MCF-Studio/mcf-myia/blob/main/docs/CONFIG.md (vide = valeur par défaut)";

/** Ajoute à `raw` les clés de `tpl` qui lui manquent, sans jamais modifier une valeur existante. */
export function fillMissing(raw: Record<string, any>, tpl: Record<string, any>): boolean {
  let changed = false;
  for (const [k, v] of Object.entries(tpl)) {
    if (!(k in raw)) {
      raw[k] = structuredClone(v);
      changed = true;
    } else if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length && raw[k] && typeof raw[k] === "object" && !Array.isArray(raw[k])) {
      changed = fillMissing(raw[k], v) || changed;
    }
  }
  return changed;
}

/**
 * Complète config/agent.json avec toutes les options connues (vides ou à leur valeur par défaut), pour que
 * l'utilisateur voie tout ce qu'il peut régler sans chercher dans la doc. Rien d'existant n'est modifié ; le résultat
 * est validé avant l'écriture. Un fichier illisible ou invalide est laissé tel quel (l'erreur sera signalée au
 * chargement).
 */
export function completeConfigFile(file = paths.config): boolean {
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
    parseConfig(raw);
  } catch {
    return false;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const tpl: Record<string, any> = { _aide: CONFIG_HELP, ...configTemplate() };
  if (!fillMissing(raw, tpl)) return false;
  // L'aide en premier, pour qu'on la voie en ouvrant le fichier.
  const ordered = "_aide" in raw ? { _aide: raw._aide, ...raw } : raw;
  parseConfig(ordered);
  writeJsonAtomic(file, ordered);
  return true;
}
