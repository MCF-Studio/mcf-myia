import { z } from "zod";
import type { OllamaClient } from "./llm.js";

/**
 * Coach des sessions Claude : choisit le modèle Claude adapté à une tâche (Haiku, Sonnet, Opus) d'après sa difficulté.
 * Le modèle LOCAL fait le tri (gratuit, rapide) ; une heuristique prend le relais s'il ne répond pas correctement.
 */

export const CLAUDE_MODELS = ["haiku", "sonnet", "opus"] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

export interface Triage {
  model: ClaudeModel;
  difficulty: 1 | 2 | 3 | 4 | 5;
  reason: string;
  /** "local" = modèle local ; "heuristique" = règle de secours. */
  by: "local" | "heuristique";
}

export const MODEL_LABEL: Record<ClaudeModel, string> = {
  haiku: "Haiku (rapide, économique)",
  sonnet: "Sonnet (polyvalent)",
  opus: "Opus (raisonnement profond)",
};

export function modelForDifficulty(d: number): ClaudeModel {
  return d <= 2 ? "haiku" : d === 3 ? "sonnet" : "opus";
}

const TRIAGE_PROMPT = `Tu évalues la difficulté d'une tâche confiée à un assistant de code (Claude Code) pour choisir le bon modèle.
Échelle :
1 = mécanique : renommer, reformater, petite correction évidente, question factuelle courte.
2 = simple : petite fonction, script court, doc, modification localisée dans un ou deux fichiers.
3 = standard : fonctionnalité ordinaire, débogage classique, refactorisation modérée, plusieurs fichiers.
4 = difficile : bug subtil ou intermittent, conception d'une architecture, migration, sécurité, performance.
5 = très difficile : système complexe de bout en bout, problème profond sans piste, décisions lourdes et risquées.
Réponds UNIQUEMENT en JSON : {"difficulty": <1-5>, "reason": "<une phrase courte en français>"}`;

const TriageOut = z.object({ difficulty: z.coerce.number().int().min(1).max(5), reason: z.string().min(3).max(300) });

/** Règle de secours, sans modèle : mots-clés et longueur. */
export function heuristicTriage(task: string): Triage {
  const t = task.toLowerCase();
  let d = 3;
  if (/(architect|conception|concevoir|migr|sécurité|securite|faille|performance|optimis|concurren|race condition|intermittent|refonte|from scratch|de zéro)/.test(t)) d = 4;
  if (/(renomm|reformat|typo|faute|indent|commentaire|traduis|traduire|explique|qu'est-ce que|c'est quoi)/.test(t) && t.length < 400) d = 2;
  if (t.length < 80 && d === 3) d = 2;
  if (t.length > 2500) d = Math.max(d, 4);
  const difficulty = d as Triage["difficulty"];
  return { model: modelForDifficulty(difficulty), difficulty, reason: "estimation par mots-clés (modèle local indisponible)", by: "heuristique" };
}

export async function triageTask(llm: OllamaClient, task: string, signal?: AbortSignal): Promise<Triage> {
  const text = task.trim().slice(0, 6000);
  if (!text) throw new Error("tâche vide");
  try {
    const reply = await llm.chat(
      [
        { role: "system", content: TRIAGE_PROMPT },
        { role: "user", content: `Tâche :\n"""\n${text}\n"""` },
      ],
      [],
      signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      { format: "json", temperature: 0 },
    );
    const parsed = TriageOut.parse(JSON.parse(reply.content));
    const difficulty = parsed.difficulty as Triage["difficulty"];
    return { model: modelForDifficulty(difficulty), difficulty, reason: parsed.reason, by: "local" };
  } catch {
    return heuristicTriage(text);
  }
}

/** Consigne de passation : Claude résume la session dans un fichier pour la reprendre après /clear. */
export function handoffPrompt(file: string): string {
  return (
    `Prépare une passation pour continuer ce travail dans une session vierge. Écris dans le fichier ${file} un résumé en Markdown : ` +
    "objectif, état actuel, fichiers modifiés ou importants, décisions prises et pourquoi, problèmes en cours, prochaines étapes précises " +
    "et commandes utiles. Sois complet mais concis. Ne fais rien d'autre, puis réponds en une ligne que la passation est écrite."
  );
}

export function resumePrompt(file: string): string {
  return `Lis ${file} : c'est la passation de la session précédente. Reprends le travail à partir des prochaines étapes indiquées.`;
}
