import { z } from "zod";
import type { LlmClient } from "./llm.js";
import { runProcess } from "./proc.js";

/**
 * Coach des sessions Claude : choisit le modèle Claude adapté à une tâche (Haiku, Sonnet, Opus) d'après sa difficulté.
 * Fable n'est jamais choisi automatiquement : seulement sur demande.
 * Le modèle LOCAL fait le tri (gratuit, rapide) ; une heuristique prend le relais s'il ne répond pas correctement.
 */

/**
 * Alias acceptés par `claude --model`. L'interface reçoit cette liste (claude.models) ; le Rust garde la sienne en dur
 * (pty.rs, barrière de sécurité), et un test vérifie que les deux sont identiques.
 */
export const CLAUDE_MODELS = ["haiku", "sonnet", "opus", "fable"] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

export const CLAUDE_MODEL_INFO: Record<ClaudeModel, { label: string; hint: string }> = {
  haiku: { label: "Haiku", hint: "rapide, économique" },
  sonnet: { label: "Sonnet", hint: "polyvalent" },
  opus: { label: "Opus", hint: "raisonnement profond" },
  fable: { label: "Fable", hint: "le plus capable ; consomme le plus de quota, jamais choisi par Auto" },
};

export const MODEL_LABEL = Object.fromEntries(
  CLAUDE_MODELS.map((m) => [m, `${CLAUDE_MODEL_INFO[m].label} (${CLAUDE_MODEL_INFO[m].hint})`]),
) as Record<ClaudeModel, string>;

/** Modèle de repli (`--fallback-model`) si le modèle demandé est surchargé : évite l'échec sec d'une tâche longue. */
export function fallbackFor(model: string | undefined): ClaudeModel | undefined {
  return model === "fable" ? "opus" : undefined;
}

/** Compte Claude Code connecté sur cette machine : uniquement ce qui sert à l'affichage (ni e-mail, ni jeton). */
export interface ClaudeAccount {
  loggedIn: boolean;
  /** Ex. "pro", "max", "team" ; absent avec une clé d'API. */
  subscription?: string;
  /** Ex. "max_5x". */
  tier?: string;
  /** Ex. "claude.ai" (abonnement) ou une clé d'API. */
  authMethod?: string;
  /** Fin de validité de la connexion (date ISO), si Claude Code la donne. */
  expiresAt?: string;
}

const isoDate = (v: unknown) => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);

const short = (v: unknown) => (typeof v === "string" && /^[\w .-]{1,40}$/.test(v) ? v : undefined);

/** Lit la sortie JSON de `claude auth status` et n'en garde que l'abonnement. */
export function parseClaudeAccount(stdout: string): ClaudeAccount {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return { loggedIn: false };
  }
  if (!j || typeof j !== "object") return { loggedIn: false };
  return {
    loggedIn: j.loggedIn === true,
    subscription: short(j.subscriptionType),
    tier: short(j.planTier),
    authMethod: short(j.authMethod),
    expiresAt: isoDate(j.loginExpiresAt),
  };
}

export async function claudeAccount(command: string, cwd: string): Promise<ClaudeAccount> {
  const out: string[] = [];
  const r = await runProcess([command, "auth", "status"], {
    cwd,
    timeoutMs: 15_000,
    keep: 2,
    onLine: (line, stream) => stream === "out" && out.length < 200 && out.push(line),
  });
  // Non connecté : code de sortie non nul, mais la sortie reste du JSON ({"loggedIn": false, …}).
  return r.timedOut ? { loggedIn: false } : parseClaudeAccount(out.join("\n"));
}

export interface Triage {
  model: ClaudeModel;
  difficulty: 1 | 2 | 3 | 4 | 5;
  reason: string;
  /** "local" = modèle local ; "heuristique" = règle de secours. */
  by: "local" | "heuristique";
}

/** Le choix automatique s'arrête à Opus : Fable pèse lourd sur le quota, il reste un choix explicite. */
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

export async function triageTask(llm: LlmClient, task: string, signal?: AbortSignal): Promise<Triage> {
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
