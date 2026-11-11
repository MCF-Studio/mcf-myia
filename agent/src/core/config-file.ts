import fs from "node:fs";
import { loadConfig, parseConfig, type Config } from "./config.js";
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
