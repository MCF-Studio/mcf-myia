import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";
import { billedTotal, type BilledUsage } from "./token-budget.js";

/**
 * Statistiques centralisées des appels au modèle (opti.md §6, phase 1) : chaque appel fait par un agent est enregistré
 * ici (modèle, agent, demande, jetons, durée, outils demandés, erreur), puis agrégé par agent, par demande ou par modèle.
 *
 * Rien du contenu des échanges n'est gardé : seulement des compteurs, des noms d'outils et un début de message d'erreur.
 * En mémoire (les `maxRecords` derniers appels) ; en option, un fichier JSONL par mois dans data/stats.
 */

export interface LlmCallRecord {
  ts: string;
  agent: string;
  /** Identifiant de la demande (une demande = un appel à Agent.handle). */
  task: string;
  model: string;
  engine: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  /** Outils que la réponse demande d'appeler. */
  tools: string[];
  /** Jetons estimés avant l'appel (requête) et depuis la réponse. */
  estimatedInput: number;
  estimatedOutput: number;
  /** Jetons facturés renvoyés par le moteur (API Claude, autres fournisseurs) ; absent en local. */
  billed?: BilledUsage;
}

export interface LlmAggregate {
  calls: number;
  errors: number;
  /** Meilleure valeur connue : facturée quand le moteur la donne, estimée sinon. */
  inputTokens: number;
  outputTokens: number;
  estimatedInput: number;
  estimatedOutput: number;
  billedInput: number;
  billedOutput: number;
  billedTotal: number;
  billedCalls: number;
  durationMs: number;
  avgDurationMs: number;
  /** Nombre de demandes d'appel par outil. */
  tools: Record<string, number>;
}

export type LlmStatsKey = "agent" | "task" | "model";

export interface LlmStatsOptions {
  enabled: boolean;
  maxRecords: number;
  /** Dossier du journal JSONL ; undefined = rien sur disque. */
  journalDir?: string;
}

const ERROR_MAX = 300;

function emptyAggregate(): LlmAggregate {
  return {
    calls: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedInput: 0,
    estimatedOutput: 0,
    billedInput: 0,
    billedOutput: 0,
    billedTotal: 0,
    billedCalls: 0,
    durationMs: 0,
    avgDurationMs: 0,
    tools: {},
  };
}

function add(a: LlmAggregate, r: LlmCallRecord): void {
  a.calls++;
  if (!r.ok) a.errors++;
  a.estimatedInput += r.estimatedInput;
  a.estimatedOutput += r.estimatedOutput;
  if (r.billed) {
    const inTok = r.billed.input + r.billed.cacheRead + r.billed.cacheWrite;
    a.billedInput += inTok;
    a.billedOutput += r.billed.output;
    a.billedTotal += billedTotal(r.billed);
    a.billedCalls++;
    a.inputTokens += inTok;
    a.outputTokens += r.billed.output;
  } else {
    a.inputTokens += r.estimatedInput;
    a.outputTokens += r.estimatedOutput;
  }
  a.durationMs += r.durationMs;
  a.avgDurationMs = Math.round(a.durationMs / a.calls);
  for (const t of r.tools) a.tools[t] = (a.tools[t] ?? 0) + 1;
}

export class LlmStats {
  private items: LlmCallRecord[] = [];

  constructor(private opts: LlmStatsOptions = { enabled: true, maxRecords: 2000 }) {}

  configure(opts: Partial<LlmStatsOptions>): void {
    this.opts = { ...this.opts, ...opts };
    if (this.items.length > this.opts.maxRecords) this.items = this.items.slice(-this.opts.maxRecords);
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** Enregistre un appel. Ne lève jamais : les statistiques ne doivent pas faire échouer une demande. */
  record(r: Omit<LlmCallRecord, "ts"> & { ts?: string }): void {
    if (!this.opts.enabled) return;
    const rec: LlmCallRecord = {
      ...r,
      ts: r.ts ?? new Date().toISOString(),
      tools: [...r.tools],
      ...(r.error ? { error: r.error.slice(0, ERROR_MAX) } : {}),
    };
    this.items.push(rec);
    if (this.items.length > this.opts.maxRecords) this.items.splice(0, this.items.length - this.opts.maxRecords);
    if (this.opts.journalDir) this.writeJournal(rec, this.opts.journalDir);
  }

  private writeJournal(rec: LlmCallRecord, dir: string): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${rec.ts.slice(0, 7)}.jsonl`), JSON.stringify(rec) + "\n", "utf8");
    } catch (e) {
      process.stderr.write(`[stats] écriture impossible : ${(e as Error).message}\n`);
    }
  }

  records(filter: Partial<Pick<LlmCallRecord, LlmStatsKey>> = {}): LlmCallRecord[] {
    return this.items.filter((r) => (Object.keys(filter) as LlmStatsKey[]).every((k) => r[k] === filter[k])).map((r) => structuredClone(r));
  }

  /** Agrégats par agent, par demande ou par modèle. */
  aggregate(by: LlmStatsKey, filter: Partial<Pick<LlmCallRecord, LlmStatsKey>> = {}): Record<string, LlmAggregate> {
    const out: Record<string, LlmAggregate> = {};
    for (const r of this.records(filter)) add((out[r[by]] ??= emptyAggregate()), r);
    return out;
  }

  totals(filter: Partial<Pick<LlmCallRecord, LlmStatsKey>> = {}): LlmAggregate {
    const a = emptyAggregate();
    for (const r of this.records(filter)) add(a, r);
    return a;
  }

  clear(): void {
    this.items = [];
  }
}

/** Instance partagée par tous les agents du processus (lue par le serveur pour l'affichage). */
export const llmStats = new LlmStats();

/** Applique les réglages `optimization.stats` de la config à l'instance partagée. */
export function configureLlmStats(c: { enabled: boolean; maxRecords: number; journal: boolean }, dir = paths.stats): void {
  llmStats.configure({ enabled: c.enabled, maxRecords: c.maxRecords, journalDir: c.journal ? dir : undefined });
}
