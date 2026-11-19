import { estimateTokens } from "./token-budget.js";

/**
 * Context Compiler (opti.md §2.2, phase 1) : assemble le contexte d'un appel à partir de blocs classés en trois niveaux,
 * sous un budget de jetons, de façon entièrement déterministe (aucun appel au modèle).
 *
 * - L0 essentiel : identité, consignes, objectif, contraintes. Toujours gardé, jamais coupé.
 * - L1 pertinent : résumé du projet, notes utiles, résultats précédents. Gardé par ordre de pertinence tant qu'il tient
 *   dans `relevantMaxTokens`, résumé ou tronqué sinon.
 * - L2 à la demande : historique complet, documentation, fichiers. Seulement s'il est demandé (`requested`) et qu'il
 *   reste de la place ; sinon signalé comme disponible dans la trace.
 *
 * Un bloc `pinned` (instructions prioritaires) est traité comme L0 quel que soit son niveau. Les doublons (bloc entier
 * ou paragraphe déjà présent) sont retirés. Chaque bloc laisse une trace : source, jetons, sort.
 */

export type ContextLevel = 0 | 1 | 2;

export interface ContextItem {
  id: string;
  level: ContextLevel;
  /** D'où vient le bloc (fichier, mémoire, registre…) : tracé, jamais envoyé au modèle. */
  source: string;
  text: string;
  /** Pertinence pour la demande (plus grand = gardé en premier). */
  relevance?: number;
  /** Instruction prioritaire : jamais coupée ni retirée. */
  pinned?: boolean;
}

export type ContextStatus = "full" | "compressed" | "duplicate" | "dropped" | "deferred";

export interface ContextTrace {
  id: string;
  source: string;
  level: ContextLevel;
  status: ContextStatus;
  /** Jetons estimés du bloc d'origine, puis de ce qui est envoyé. */
  originalTokens: number;
  tokens: number;
  /** Doublon : bloc qui contenait déjà ce texte. */
  duplicateOf?: string;
}

export interface CompileOptions {
  /** Budget total du contexte en jetons (undefined = somme des plafonds par niveau, sans autre limite). */
  budgetTokens?: number;
  /** Plafond indicatif de L0 : dépassé, il est signalé (`essentialOverflow`) mais rien n'est coupé. */
  essentialMaxTokens?: number;
  /** Plafond de L1. */
  relevantMaxTokens?: number;
  /** Plafond de L2. */
  onDemandMaxTokens?: number;
  /** Blocs L2 demandés explicitement (ids). */
  requested?: string[];
  /** En dessous de ce reste, un bloc n'est pas résumé mais écarté. */
  minUsefulTokens?: number;
  separator?: string;
}

export interface CompiledContext {
  text: string;
  /** Blocs envoyés, dans l'ordre (L0, puis L1, puis L2, chacun dans l'ordre d'origine). */
  included: { id: string; level: ContextLevel; text: string }[];
  trace: ContextTrace[];
  tokens: { essential: number; relevant: number; onDemand: number; total: number };
  essentialOverflow: boolean;
  /** Vrai si L0 seul dépasse le budget total : rien n'a été coupé, à l'appelant de décider. */
  overBudget: boolean;
}

/** Budget disponible pour le contexte : fenêtre du modèle − réserve de sortie − ce qui est déjà pris (outils, historique). */
export function availableBudget(contextWindow: number, reserveForOutput: number, alreadyUsed = 0): number {
  return Math.max(0, contextWindow - reserveForOutput - alreadyUsed);
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const paragraphs = (s: string) => s.split(/\n\s*\n/);

/** Paragraphes trop courts pour être dédupliqués (titres, lignes vides). */
const DEDUP_MIN_CHARS = 40;

/**
 * Compression déterministe d'un texte à `maxTokens` : d'abord un résumé (titres et première phrase de chaque
 * paragraphe), sinon une troncature début + fin. Le marqueur dit ce qui manque, pour que le modèle sache le demander.
 */
export function compressText(text: string, maxTokens: number, source = "source"): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const summary = paragraphs(text)
    .map((p) => {
      const t = p.trim();
      if (!t) return "";
      if (/^#{1,6}\s/.test(t)) return t.split("\n")[0]!;
      const first = t.split("\n")[0]!;
      const sentence = /^(.+?[.!?…])(\s|$)/.exec(first)?.[1] ?? first;
      return sentence.length < t.length ? `${sentence} …` : sentence;
    })
    .filter(Boolean)
    .join("\n");
  const marker = `[résumé automatique de ${source} : lis la source pour le détail]`;
  if (estimateTokens(summary) + estimateTokens(marker) + 1 <= maxTokens && summary.length < text.length) return `${summary}\n${marker}`;
  // Troncature : 70 % début, 30 % fin (le début porte le sujet, la fin l'état le plus récent).
  const omittedMarker = (n: number) => `\n… [${n} caractères omis de ${source}] …\n`;
  const budgetChars = Math.max(0, Math.floor(maxTokens * 3.5) - omittedMarker(text.length).length);
  if (budgetChars <= 0) return "";
  const head = Math.floor(budgetChars * 0.7);
  const tail = budgetChars - head;
  return text.slice(0, head) + omittedMarker(text.length - head - tail) + (tail > 0 ? text.slice(text.length - tail) : "");
}

export function compileContext(items: ContextItem[], opts: CompileOptions = {}): CompiledContext {
  const sep = opts.separator ?? "\n\n";
  const minUseful = opts.minUsefulTokens ?? 50;
  const requested = new Set(opts.requested ?? []);
  const trace = new Map<string, ContextTrace>();
  const seenWhole = new Map<string, string>();
  const seenParas = new Set<string>();
  const kept = new Map<string, string>();

  const ids = new Set<string>();
  for (const it of items) {
    if (ids.has(it.id)) throw new Error(`bloc de contexte en double : ${it.id}`);
    ids.add(it.id);
  }

  const level = (it: ContextItem): ContextLevel => (it.pinned ? 0 : it.level);
  const setTrace = (it: ContextItem, status: ContextStatus, text: string, duplicateOf?: string) =>
    trace.set(it.id, {
      id: it.id,
      source: it.source,
      level: level(it),
      status,
      originalTokens: estimateTokens(it.text),
      tokens: estimateTokens(text),
      ...(duplicateOf ? { duplicateOf } : {}),
    });

  /** Retire d'un bloc ce qui est déjà présent ; undefined = doublon complet. */
  const dedup = (it: ContextItem): { text?: string; duplicateOf?: string } => {
    const whole = normalize(it.text);
    if (!whole) return {};
    const prior = seenWhole.get(whole);
    if (prior) return { duplicateOf: prior };
    const ps = paragraphs(it.text).filter((p) => {
      const n = normalize(p);
      return !(n.length >= DEDUP_MIN_CHARS && seenParas.has(n));
    });
    const text = ps.join("\n\n").trim();
    if (!text) return { duplicateOf: "(paragraphes déjà présents)" };
    return { text };
  };
  const remember = (it: ContextItem, text: string) => {
    seenWhole.set(normalize(it.text), it.id);
    for (const p of paragraphs(text)) {
      const n = normalize(p);
      if (n.length >= DEDUP_MIN_CHARS) seenParas.add(n);
    }
    kept.set(it.id, text);
  };

  // L0 (et blocs épinglés) : dans l'ordre, intégralement.
  let essential = 0;
  for (const it of items.filter((i) => level(i) === 0)) {
    const d = dedup(it);
    if (d.text === undefined) {
      setTrace(it, "duplicate", "", d.duplicateOf);
      continue;
    }
    remember(it, d.text);
    essential += estimateTokens(d.text);
    setTrace(it, "full", d.text);
  }
  const total = opts.budgetTokens ?? Infinity;
  let left = total - essential;

  // L1 puis L2 : par pertinence décroissante (ordre d'origine à égalité), sous leur plafond et le budget restant.
  const fill = (lvl: 1 | 2, cap: number): number => {
    let used = 0;
    const pool = items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => level(it) === lvl)
      .sort((a, b) => (b.it.relevance ?? 0) - (a.it.relevance ?? 0) || a.i - b.i);
    for (const { it } of pool) {
      if (lvl === 2 && !requested.has(it.id)) {
        setTrace(it, "deferred", "");
        continue;
      }
      const d = dedup(it);
      if (d.text === undefined) {
        setTrace(it, "duplicate", "", d.duplicateOf);
        continue;
      }
      const room = Math.min(cap - used, left);
      const need = estimateTokens(d.text);
      if (need <= room) {
        remember(it, d.text);
        used += need;
        left -= need;
        setTrace(it, "full", d.text);
        continue;
      }
      if (room < minUseful) {
        setTrace(it, "dropped", "");
        continue;
      }
      const short = compressText(d.text, room, it.source);
      const n = estimateTokens(short);
      if (!short || n > room) {
        setTrace(it, "dropped", "");
        continue;
      }
      remember(it, short);
      used += n;
      left -= n;
      setTrace(it, "compressed", short);
    }
    return used;
  };
  const relevant = fill(1, opts.relevantMaxTokens ?? Infinity);
  const onDemand = fill(2, opts.onDemandMaxTokens ?? Infinity);

  const order = (lvl: ContextLevel) => items.filter((it) => level(it) === lvl && kept.has(it.id));
  const included = ([0, 1, 2] as const).flatMap((lvl) => order(lvl).map((it) => ({ id: it.id, level: lvl, text: kept.get(it.id)! })));
  return {
    text: included.map((i) => i.text).join(sep),
    included,
    trace: items.map((it) => trace.get(it.id)!),
    tokens: { essential, relevant, onDemand, total: essential + relevant + onDemand },
    essentialOverflow: opts.essentialMaxTokens !== undefined && essential > opts.essentialMaxTokens,
    overBudget: essential > total,
  };
}
