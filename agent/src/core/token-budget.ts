import type { Config } from "./config.js";
import type { ChatMessage, ToolSpec } from "./llm.js";

/**
 * Token Budget Manager (opti.md §3) : chaque demande traitée par un agent a son budget (jetons, itérations, appels au
 * modèle, durée, escalades). Contrôlé avant chaque itération, avant chaque appel et après chaque réponse.
 *
 * Jetons ESTIMÉS (calculés ici depuis la taille du texte, avant l'appel) et jetons FACTURÉS (renvoyés par l'API Claude
 * ou d'un autre fournisseur, après l'appel) sont comptés à part. Le budget décompte les jetons facturés quand le moteur
 * en donne, l'estimation sinon (modèle local, Claude Code par abonnement).
 */

/** Caractères par jeton retenus pour l'estimation : prudent pour le français (un jeton ≈ 3,5 à 4 caractères). */
const CHARS_PER_TOKEN = 3.5;
/** Coût fixe estimé d'un message (rôle, séparateurs). */
const MESSAGE_OVERHEAD = 4;

/** Estimation déterministe du nombre de jetons d'un texte (sans tokenizer : aucune dépendance). */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

/** Jetons estimés d'une requête : messages, appels d'outils de l'historique et déclarations d'outils. */
export function estimateRequestTokens(messages: ChatMessage[], tools: ToolSpec[] = []): number {
  let n = 0;
  for (const m of messages) {
    n += MESSAGE_OVERHEAD + estimateTokens(m.content ?? "");
    if (m.tool_calls?.length) n += estimateTokens(JSON.stringify(m.tool_calls));
  }
  if (tools.length) n += estimateTokens(JSON.stringify(tools));
  return n;
}

/** Jetons estimés d'une réponse (texte + appels d'outils). */
export function estimateReplyTokens(reply: Pick<ChatMessage, "content" | "tool_calls">): number {
  return estimateTokens(reply.content ?? "") + (reply.tool_calls?.length ? estimateTokens(JSON.stringify(reply.tool_calls)) : 0);
}

/** Consommation renvoyée par un moteur facturé (API Claude, autres fournisseurs). */
export interface BilledUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Total facturé d'un appel : entrée (cache compris, lu ou écrit) + sortie. */
export function billedTotal(u: BilledUsage): number {
  return u.input + u.cacheRead + u.cacheWrite + u.output;
}

export interface BudgetLimits {
  /** Jetons au plus pour la demande (entrée + sortie de tous les appels) ; 0 = sans limite. */
  maxTokens: number;
  /** Itérations (tours de la boucle de l'agent) au plus. */
  maxIterations: number;
  /** Appels au modèle au plus. */
  maxLlmCalls: number;
  /** Durée au plus, en millisecondes ; 0 = sans limite. */
  timeoutMs: number;
  /** Jetons gardés pour la réponse : un appel n'est lancé que si entrée estimée + réserve tiennent dans le reste. */
  reserveForOutput: number;
  /** Changements de modèle (Model Router) au plus. */
  maxEscalations: number;
}

export type BudgetStop = "tokens" | "iterations" | "llm_calls" | "timeout";

export type BudgetCheck = { ok: true } | { ok: false; reason: BudgetStop; message: string };

export interface BudgetSnapshot {
  limits: BudgetLimits;
  iterations: number;
  llmCalls: number;
  escalations: number;
  /** Somme des estimations (entrée + sortie) de tous les appels. */
  estimatedTokens: number;
  /** Somme des jetons facturés renvoyés par les moteurs (0 si aucun moteur facturé). */
  billedTokens: number;
  /** Appels dont la consommation facturée est connue. */
  billedCalls: number;
  /** Jetons décomptés du budget : facturés quand connus, estimés sinon. */
  accountedTokens: number;
  /** Jetons restants (Infinity sans limite). */
  remainingTokens: number;
  elapsedMs: number;
}

/**
 * Limites d'une demande d'après la config. Valeurs par défaut alignées sur la boucle existante : autant d'itérations
 * que `maxSteps` (25), et un appel de plus pour le point d'étape demandé au modèle quand la limite est atteinte.
 */
export function budgetLimits(cfg: Pick<Config, "maxSteps" | "optimization">): BudgetLimits {
  const b = cfg.optimization.budget;
  return {
    maxTokens: b.maxTokens,
    maxIterations: b.maxIterations || cfg.maxSteps,
    maxLlmCalls: b.maxLlmCalls || cfg.maxSteps + 1,
    timeoutMs: b.timeoutSeconds * 1000,
    reserveForOutput: b.reserveForOutput,
    maxEscalations: b.maxEscalations,
  };
}

/** Levée quand un contrôle du budget échoue : la boucle de l'agent s'arrête proprement. */
export class BudgetExceededError extends Error {
  constructor(readonly check: Extract<BudgetCheck, { ok: false }>) {
    super(check.message);
    this.name = "BudgetExceededError";
  }
}

const OK: BudgetCheck = { ok: true };

export class TokenBudget {
  private readonly start: number;
  private iterations = 0;
  private llmCalls = 0;
  private escalations = 0;
  private estimated = 0;
  private billed = 0;
  private billedCalls = 0;
  private accounted = 0;

  constructor(
    readonly limits: BudgetLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.start = now();
  }

  private timeout(): BudgetCheck {
    if (this.limits.timeoutMs > 0 && this.now() - this.start >= this.limits.timeoutMs) {
      return { ok: false, reason: "timeout", message: `durée maximale de ${Math.round(this.limits.timeoutMs / 1000)} s atteinte` };
    }
    return OK;
  }

  /** Avant un nouveau tour de boucle. Compte l'itération si elle est accordée. */
  beforeIteration(): BudgetCheck {
    if (this.iterations >= this.limits.maxIterations) {
      return { ok: false, reason: "iterations", message: `limite de ${this.limits.maxIterations} itérations atteinte` };
    }
    const t = this.timeout();
    if (!t.ok) return t;
    if (this.limits.maxTokens > 0 && this.accounted >= this.limits.maxTokens) {
      return { ok: false, reason: "tokens", message: `budget de ${this.limits.maxTokens} jetons épuisé` };
    }
    this.iterations++;
    return OK;
  }

  /**
   * Avant un appel au modèle (aussi avant une délégation ou une opération coûteuse) : `estimatedInput` = jetons estimés
   * de la requête. Compte l'appel s'il est accordé.
   */
  beforeCall(estimatedInput: number): BudgetCheck {
    if (this.llmCalls >= this.limits.maxLlmCalls) {
      return { ok: false, reason: "llm_calls", message: `limite de ${this.limits.maxLlmCalls} appels au modèle atteinte` };
    }
    const t = this.timeout();
    if (!t.ok) return t;
    if (this.limits.maxTokens > 0 && this.accounted + estimatedInput + this.limits.reserveForOutput > this.limits.maxTokens) {
      return {
        ok: false,
        reason: "tokens",
        message: `budget de ${this.limits.maxTokens} jetons insuffisant pour un nouvel appel (${this.accounted} utilisés, ~${estimatedInput} à envoyer, ${this.limits.reserveForOutput} réservés pour la réponse)`,
      };
    }
    this.llmCalls++;
    return OK;
  }

  /** Après une réponse (ou un échec de l'appel) : décompte les jetons, facturés si connus, estimés sinon. */
  afterResponse(u: { estimatedInput: number; estimatedOutput: number; billed?: BilledUsage }): BudgetCheck {
    const est = u.estimatedInput + u.estimatedOutput;
    this.estimated += est;
    if (u.billed) {
      const b = billedTotal(u.billed);
      this.billed += b;
      this.billedCalls++;
      this.accounted += b;
    } else {
      this.accounted += est;
    }
    if (this.limits.maxTokens > 0 && this.accounted >= this.limits.maxTokens) {
      return { ok: false, reason: "tokens", message: `budget de ${this.limits.maxTokens} jetons épuisé (${this.accounted} utilisés)` };
    }
    return this.timeout();
  }

  canEscalate(): boolean {
    return this.escalations < this.limits.maxEscalations;
  }

  recordEscalation(): void {
    this.escalations++;
  }

  snapshot(): BudgetSnapshot {
    return {
      limits: { ...this.limits },
      iterations: this.iterations,
      llmCalls: this.llmCalls,
      escalations: this.escalations,
      estimatedTokens: this.estimated,
      billedTokens: this.billed,
      billedCalls: this.billedCalls,
      accountedTokens: this.accounted,
      remainingTokens: this.limits.maxTokens > 0 ? Math.max(0, this.limits.maxTokens - this.accounted) : Infinity,
      elapsedMs: this.now() - this.start,
    };
  }
}
