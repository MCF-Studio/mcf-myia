/**
 * Lecture de la sortie d'une console Claude Code après un `/model <alias>` : le changement a-t-il été accepté ?
 * Messages de Claude Code (2.1) : « Set model to … », « Model set to … », « Kept model as … » ; refus : « Model switch failed: … ».
 * La console est un affichage plein écran : les mots peuvent être séparés par des déplacements de curseur au lieu
 * d'espaces. On retire donc les séquences d'échappement ET les blancs avant de chercher.
 */
export type SwitchVerdict = "ok" | "failed";

// CSI (couleurs, curseur), OSC (titre, liens) et échappements courts.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function modelSwitchVerdict(output: string): SwitchVerdict | undefined {
  const text = output.replace(ANSI, "").replace(/\s+/g, "").toLowerCase();
  if (text.includes("modelswitchfailed")) return "failed";
  if (/setmodelto|modelsetto|keptmodelas/.test(text)) return "ok";
  return undefined;
}
