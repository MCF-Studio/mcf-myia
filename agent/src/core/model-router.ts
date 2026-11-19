/**
 * Model Router (opti.md §2.1, phase 1) : choisit le modèle d'une demande SANS appeler de modèle.
 *
 * 1. Classification déterministe de la demande (mots-clés, longueur, étapes, code) : catégorie et complexité.
 * 2. Palier de départ : léger pour une demande simple, standard sinon (le modèle de l'agent).
 * 3. Historique de réussite par (catégorie, modèle) : un palier qui échoue trop souvent sur une catégorie est sauté.
 * 4. Escalade vers le palier suivant seulement quand la réponse est jugée insuffisante (règles fixes, voir
 *    `insufficientReason`), dans la limite du budget d'escalades.
 *
 * Confidentialité : le choix des paliers (local ou en ligne) est fait par l'appelant (Agent), qui ne propose jamais un
 * modèle en ligne à un agent local : sa mémoire et ses notes ne doivent pas quitter le PC.
 */

export type TaskCategory = "conversation" | "question" | "action" | "code" | "analysis" | "writing";
export type Complexity = "simple" | "moderate" | "complex";

export interface TaskClass {
  category: TaskCategory;
  complexity: Complexity;
  /** Score de complexité (0 = trivial). */
  score: number;
  /** Indices retenus, pour la trace. */
  signals: string[];
}

const deaccent = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const CATEGORY_RULES: { category: TaskCategory; re: RegExp }[] = [
  { category: "code", re: /```|\b(code|bug|debug|fonction|function|compile|compilation|refactor\w*|script|stack ?trace|exception|typescript|javascript|rust|python|gdscript|commit|pull request|test unitaire|regex)\b/ },
  { category: "analysis", re: /\b(analyse\w*|compare\w*|comparaison|architecture|strategie|etude|audit\w*|optimis\w*|evalue\w*|diagnosti\w*|pourquoi .{10,}|avantages|inconvenients)\b/ },
  { category: "writing", re: /\b(redige\w*|ecris|ecrire|reformule\w*|traduis|tradui\w*|resume\w*|annonce|article|courriel|e-?mail|lettre|post)\b/ },
  { category: "action", re: /\b(ouvre|lance|envoie|cree|creer|supprime|range|deplace|installe|publie|joue|mets|demarre|arrete|copie|renomme|telecharge)\b/ },
  { category: "question", re: /^(quel|quelle|quels|quelles|combien|comment|pourquoi|ou |qui |quand|est-ce|c'est quoi|qu'est-ce)|\?\s*$/ },
];

const SMALL_TALK = /^(salut|bonjour|bonsoir|coucou|hello|merci|ok|d'accord|super|parfait|top|cool|oui|non|ca va)\b/;

/** Classe une demande. Aucun appel au modèle, résultat identique pour la même entrée. */
export function classifyTask(input: string, ctx: { contextTokens?: number } = {}): TaskClass {
  const raw = input.trim();
  const text = deaccent(raw);
  const signals: string[] = [];
  let score = 0;

  let category: TaskCategory = "conversation";
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(text)) {
      category = rule.category;
      signals.push(`catégorie:${rule.category}`);
      break;
    }
  }
  if (category === "conversation" && SMALL_TALK.test(text) && raw.length < 60) signals.push("échange court");

  if (raw.length > 1500) {
    score += 3;
    signals.push("très longue demande");
  } else if (raw.length > 400) {
    score += 2;
    signals.push("longue demande");
  } else if (raw.length > 150) {
    score += 1;
    signals.push("demande détaillée");
  }
  const steps = (text.match(/\b(puis|ensuite|apres ca|et aussi|enfin|egalement)\b/g) ?? []).length + (raw.match(/^\s*(\d+[.)]|[-*•])\s+/gm) ?? []).length;
  if (steps) {
    score += Math.min(3, steps);
    signals.push(`${steps} étape(s)`);
  }
  if (category === "code" || category === "analysis") {
    score += 2;
    signals.push("raisonnement");
  }
  if ((ctx.contextTokens ?? 0) > 8000) {
    score += 1;
    signals.push("gros contexte");
  }
  const complexity: Complexity = score <= 1 ? "simple" : score <= 3 ? "moderate" : "complex";
  return { category, complexity, score, signals };
}

/**
 * Raison pour laquelle une réponse finale est insuffisante, ou undefined si elle convient. Règles fixes : réponse vide,
 * coupée par la limite de longueur, ou action annoncée sans être faite (`announced`, calculé par l'agent).
 */
export function insufficientReason(text: string, opts: { announced?: boolean } = {}): string | undefined {
  const t = text.trim();
  if (!t || t === "(pas de réponse)") return "réponse vide";
  if (t.includes("(réponse coupée : limite de longueur atteinte)")) return "réponse coupée";
  if (opts.announced) return "action annoncée sans être faite";
  return undefined;
}

export interface RouteStats {
  ok: number;
  fail: number;
  /** Taux de réussite (1 sans aucun essai). */
  rate: number;
}

/** Historique de réussite par catégorie et par modèle. Sérialisable (toJSON / fromJSON) pour être gardé sur disque. */
export class RouterHistory {
  private data = new Map<string, { ok: number; fail: number }>();

  private key(category: TaskCategory, model: string) {
    return `${category}\u0000${model}`;
  }

  record(category: TaskCategory, model: string, ok: boolean): void {
    const k = this.key(category, model);
    const s = this.data.get(k) ?? { ok: 0, fail: 0 };
    if (ok) s.ok++;
    else s.fail++;
    this.data.set(k, s);
  }

  stats(category: TaskCategory, model: string): RouteStats {
    const s = this.data.get(this.key(category, model)) ?? { ok: 0, fail: 0 };
    const n = s.ok + s.fail;
    return { ...s, rate: n ? s.ok / n : 1 };
  }

  toJSON(): { category: string; model: string; ok: number; fail: number }[] {
    return [...this.data].map(([k, s]) => {
      const [category, model] = k.split("\u0000") as [string, string];
      return { category, model, ...s };
    });
  }

  static fromJSON(rows: unknown): RouterHistory {
    const h = new RouterHistory();
    if (!Array.isArray(rows)) return h;
    for (const r of rows as Record<string, unknown>[]) {
      if (typeof r?.category !== "string" || typeof r.model !== "string") continue;
      const ok = Number(r.ok), fail = Number(r.fail);
      if (!Number.isInteger(ok) || !Number.isInteger(fail) || ok < 0 || fail < 0) continue;
      h.data.set(h.key(r.category as TaskCategory, r.model), { ok, fail });
    }
    return h;
  }

  clear(): void {
    this.data.clear();
  }
}

/** Historique partagé par les agents du processus. */
export const routerHistory = new RouterHistory();

export interface RouterTiers {
  light?: string;
  standard: string;
  strong?: string;
}

export interface RouterOptions {
  /** Essais minimum sur une catégorie avant de juger un modèle sur son historique. */
  minSamples: number;
  /** En dessous de ce taux de réussite (après minSamples essais), le palier est sauté pour cette catégorie. */
  minSuccessRate: number;
}

export interface RouteChoice {
  model: string;
  tier: "light" | "standard" | "strong";
  reason: string;
}

export class ModelRouter {
  private readonly ladder: { tier: RouteChoice["tier"]; model: string }[];

  constructor(
    tiers: RouterTiers,
    private readonly history: RouterHistory = routerHistory,
    private readonly opts: RouterOptions = { minSamples: 5, minSuccessRate: 0.6 },
  ) {
    const all = [
      { tier: "light" as const, model: tiers.light },
      { tier: "standard" as const, model: tiers.standard },
      { tier: "strong" as const, model: tiers.strong },
    ];
    this.ladder = [];
    for (const t of all) if (t.model && !this.ladder.some((x) => x.model === t.model)) this.ladder.push({ tier: t.tier, model: t.model });
  }

  /** Modèles du plus léger au plus fort, sans doublon. */
  models(): string[] {
    return this.ladder.map((t) => t.model);
  }

  private reliable(category: TaskCategory, model: string): boolean {
    const s = this.history.stats(category, model);
    return s.ok + s.fail < this.opts.minSamples || s.rate >= this.opts.minSuccessRate;
  }

  route(cls: TaskClass): RouteChoice {
    let i = cls.complexity === "simple" ? 0 : Math.max(0, this.ladder.findIndex((t) => t.tier === "standard"));
    const why = [`${cls.category}, ${cls.complexity}`];
    while (i < this.ladder.length - 1 && !this.reliable(cls.category, this.ladder[i]!.model)) {
      why.push(`${this.ladder[i]!.model} échoue souvent sur « ${cls.category} »`);
      i++;
    }
    const t = this.ladder[i]!;
    return { model: t.model, tier: t.tier, reason: why.join(" ; ") };
  }

  /** Palier suivant (plus fort) après `model`, ou undefined s'il n'y en a pas. */
  escalate(model: string): string | undefined {
    const i = this.ladder.findIndex((t) => t.model === model);
    return i >= 0 ? this.ladder[i + 1]?.model : undefined;
  }
}
