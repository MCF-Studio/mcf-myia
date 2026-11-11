import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { reactive } from "vue";
import { call, inTauri } from "./rpc";

/** Consoles Claude Code ouvertes dans l'app. Elles vivent tant que l'app est ouverte (pas de persistance). */
export interface TerminalInfo {
  key: string; // "pty:<id>" : même liste d'onglets que les conversations
  id: number;
  title: string;
  cwd: string;
  exited?: number | null;
  /** Modèle Claude demandé au lancement (ou changé ensuite via /model). */
  model?: string;
  startedAt: number;
  /** Volume de sortie : sert d'estimation grossière de la longueur de la session. */
  outBytes: number;
  /** Passation en cours : état affiché dans la barre de la console. */
  handoff?: { file: string; step: "écriture" | "nettoyage" | "reprise" | "terminée" | "échec"; detail?: string };
  coachSnoozedUntil?: number;
}

export const CLAUDE_MODELS = [
  { id: "haiku", label: "Haiku", hint: "rapide, économique" },
  { id: "sonnet", label: "Sonnet", hint: "polyvalent" },
  { id: "opus", label: "Opus", hint: "raisonnement profond" },
] as const;

export interface Triage {
  model: "haiku" | "sonnet" | "opus";
  difficulty: number;
  reason: string;
  by: "local" | "heuristique";
}

export const terminals = reactive<Record<string, TerminalInfo>>({});

type DataFn = (data: string) => void;
const sinks = new Map<number, DataFn>();
const backlog = new Map<number, string[]>();

export const isTerminalKey = (k: string) => k.startsWith("pty:");

let started = false;
export async function startTerminals() {
  if (!inTauri || started) return;
  started = true;
  await listen<{ id: number; data: string }>("pty://data", (e) => {
    const t = terminals[`pty:${e.payload.id}`];
    if (t) t.outBytes += e.payload.data.length;
    const fn = sinks.get(e.payload.id);
    if (fn) fn(e.payload.data);
    else {
      // L'onglet n'est pas encore monté : on garde la sortie pour l'afficher à l'ouverture.
      const b = backlog.get(e.payload.id) ?? [];
      b.push(e.payload.data);
      backlog.set(e.payload.id, b);
    }
  });
  await listen<{ id: number; code: number | null }>("pty://exit", (e) => {
    const t = terminals[`pty:${e.payload.id}`];
    if (t) t.exited = e.payload.code;
  });
}

export async function openClaude(cwd: string, title: string, resume: boolean, model?: string, prompt?: string): Promise<string> {
  const id = await invoke<number>("pty_spawn", { cwd, resume, cols: 120, rows: 32, model: model || null, prompt: prompt || null });
  const key = `pty:${id}`;
  terminals[key] = { key, id, title, cwd, model, startedAt: Date.now(), outBytes: 0 };
  return key;
}

/** Choix du modèle Claude par le modèle local, selon la difficulté de la tâche. */
export function triage(task: string) {
  return call<Triage>("claude.triage", { task });
}

/** Tape une ligne dans Claude Code, puis Entrée (un petit délai évite que l'Entrée soit prise pour un collage). */
export function sendLine(id: number, text: string) {
  writeTerminal(id, text);
  setTimeout(() => writeTerminal(id, "\r"), 250);
}

export function switchModel(key: string, model: string) {
  const t = terminals[key];
  if (!t) return;
  sendLine(t.id, `/model ${model}`);
  t.model = model;
}

export function compact(key: string) {
  const t = terminals[key];
  if (t) sendLine(t.id, "/compact");
}

/** Estimation de la longueur de session : volume de sortie et durée. Ce n'est PAS le remplissage réel du contexte. */
export function sessionLooksLong(t: TerminalInfo): boolean {
  if (t.exited !== undefined || t.handoff?.step === "écriture" || (t.coachSnoozedUntil ?? 0) > Date.now()) return false;
  return t.outBytes > 1_500_000 || Date.now() - t.startedAt > 90 * 60_000;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Passation : Claude écrit un résumé dans <dossier>/.myia/handoff-AAAAMMJJ-HHMM.md, on vide la session (/clear),
 * puis Claude relit la passation et reprend. On surveille le fichier côté cœur (dossiers autorisés uniquement).
 */
export async function resumeFresh(key: string) {
  const t = terminals[key];
  if (!t || t.handoff?.step === "écriture" || t.handoff?.step === "nettoyage") return;
  const d = new Date();
  const file = `.myia/handoff-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.md`;
  t.handoff = { file, step: "écriture" };
  sendLine(
    t.id,
    `Prépare une passation pour continuer ce travail dans une session vierge. Écris dans le fichier ${file} un résumé en Markdown : ` +
      "objectif, état actuel, fichiers modifiés ou importants, décisions prises et pourquoi, problèmes en cours, prochaines étapes précises " +
      "et commandes utiles. Sois complet mais concis. Ne fais rien d'autre, puis réponds en une ligne que la passation est écrite.",
  );

  const t0 = Date.now();
  let lastSize = -1;
  while (Date.now() - t0 < 10 * 60_000) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!terminals[key] || t.exited !== undefined) {
      t.handoff = { file, step: "échec", detail: "console fermée" };
      return;
    }
    let st: { exists: boolean; size?: number };
    try {
      st = await call("handoff.status", { cwd: t.cwd, file });
    } catch (e) {
      t.handoff = { file, step: "échec", detail: (e as Error).message };
      return;
    }
    // Fichier présent et taille stable sur deux relevés : Claude a fini d'écrire.
    if (st.exists && (st.size ?? 0) > 50 && st.size === lastSize) {
      t.handoff = { file, step: "nettoyage" };
      await new Promise((r) => setTimeout(r, 4000)); // laisse Claude terminer sa réponse
      sendLine(t.id, "/clear");
      await new Promise((r) => setTimeout(r, 2500));
      t.handoff = { file, step: "reprise" };
      sendLine(t.id, `Lis ${file} : c'est la passation de la session précédente. Reprends le travail à partir des prochaines étapes indiquées.`);
      t.outBytes = 0;
      t.startedAt = Date.now();
      setTimeout(() => t.handoff?.step === "reprise" && (t.handoff = { file, step: "terminée" }), 4000);
      return;
    }
    lastSize = st.exists ? (st.size ?? 0) : -1;
  }
  t.handoff = { file, step: "échec", detail: "pas de passation écrite après 10 min (Claude attend peut-être une autorisation)" };
}

export function attach(id: number, fn: DataFn) {
  sinks.set(id, fn);
  for (const chunk of backlog.get(id) ?? []) fn(chunk);
  backlog.delete(id);
}

export function detach(id: number) {
  sinks.delete(id);
}

/**
 * Saisie vers la console, DANS L'ORDRE. Chaque appel Tauri est une requête indépendante qui peut être traitée
 * dans le désordre : envoyer une frappe par appel faisait sauter ou permuter des caractères (« hello world »
 * → « hellow orld »). On garde donc un seul envoi en cours par console et on regroupe ce qui arrive entre-temps.
 */
const outbox = new Map<number, { pending: string; inFlight: boolean }>();

export function writeTerminal(id: number, data: string): void {
  const box = outbox.get(id) ?? { pending: "", inFlight: false };
  outbox.set(id, box);
  box.pending += data;
  if (!box.inFlight) void flush(id, box);
}

async function flush(id: number, box: { pending: string; inFlight: boolean }) {
  box.inFlight = true;
  try {
    while (box.pending) {
      const chunk = box.pending;
      box.pending = "";
      await invoke("pty_write", { id, data: chunk }).catch(() => undefined);
    }
  } finally {
    box.inFlight = false;
  }
}
export const resizeTerminal = (id: number, cols: number, rows: number) => invoke("pty_resize", { id, cols, rows });

export async function killTerminal(key: string) {
  const t = terminals[key];
  if (!t) return;
  await invoke("pty_kill", { id: t.id }).catch(() => undefined);
  delete terminals[key];
}
