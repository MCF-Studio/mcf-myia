import path from "node:path";
import { fileURLToPath } from "node:url";

// Ce fichier est dans <home>/agent/{src|dist}/core/ : on remonte de trois niveaux.
const here = path.dirname(fileURLToPath(import.meta.url));

export const MYIA_HOME = path.resolve(process.env.MYIA_HOME ?? path.join(here, "..", "..", ".."));

export const paths = {
  home: MYIA_HOME,
  config: path.join(MYIA_HOME, "config", "agent.json"),
  audit: path.join(MYIA_HOME, "data", "audit"),
  workspace: path.join(MYIA_HOME, "workspace"),
  ollamaExe: path.join(MYIA_HOME, "runtime", "ollama", "ollama.exe"),
  ollamaModels: path.join(MYIA_HOME, "ollama", "models"),
  ollamaLog: path.join(MYIA_HOME, "runtime", "ollama-serve.log"),
};

/** Vrai si `child` est `parent` ou à l'intérieur (après normalisation). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
