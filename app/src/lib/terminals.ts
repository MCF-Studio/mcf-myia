import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { reactive, ref } from "vue";
import { modelSwitchVerdict } from "./model-switch";
import { call, inTauri } from "./rpc";
import { toast } from "./store";

/** Consoles Claude Code ouvertes dans l'app. Elles vivent tant que l'app est ouverte (pas de persistance). */
export interface TerminalInfo {
  key: string; // "pty:<id>" : même liste d'onglets que les conversations
  id: number;
  title: string;
  cwd: string;
  exited?: number | null;
  /** Modèle Claude demandé au lancement, ou changement via /model CONFIRMÉ par Claude Code. Absent = inconnu. */
  model?: string;
  /** Changement demandé via /model, pas encore confirmé dans la sortie de la console. */
  pendingModel?: string;
  startedAt: number;
  /** Volume de sortie : sert d'estimation grossière de la longueur de la session. */
  outBytes: number;
  /** Passation en cours : état affiché dans la barre de la console. */
  handoff?: { file: string; step: "écriture" | "nettoyage" | "reprise" | "terminée" | "échec"; detail?: string };
  coachSnoozedUntil?: number;
}

export interface ClaudeModelInfo {
  id: string;
  label: string;
  hint: string;
}

/** Modèles Claude proposés : la liste vient du cœur (claude.models), il n'y en a pas de copie ici. */
export const claudeModels = ref<ClaudeModelInfo[]>([]);
let modelsLoad: Promise<void> | undefined;
export function loadClaudeModels(): Promise<void> {
  if (claudeModels.value.length) return Promise.resolve();
  modelsLoad ??= call<ClaudeModelInfo[]>("claude.models")
    .then((m) => void (claudeModels.value = m))
    .catch(() => undefined) // cœur pas encore prêt : on réessaiera au prochain appel
    .finally(() => (modelsLoad = undefined));
  return modelsLoad;
}

/** Abonnement du compte Claude Code connecté sur cette machine. */
export interface ClaudeAccount {
  loggedIn: boolean;
  subscription?: string;
  tier?: string;
  authMethod?: string;
  /** Fin de validité de la connexion (date ISO). */
  expiresAt?: string;
}

export function claudeAccount() {
  return call<ClaudeAccount>("claude.account");
}

/** Jours restants avant la fin de la connexion Claude Code ; undefined si inconnue. */
export function loginDaysLeft(a: ClaudeAccount): number | undefined {
  if (!a.loggedIn || !a.expiresAt) return undefined;
  return Math.floor((Date.parse(a.expiresAt) - Date.now()) / 86_400_000);
}

export const LOGIN_WARN_DAYS = 5;

export function loginWarning(a: ClaudeAccount): string | undefined {
  const d = loginDaysLeft(a);
  if (d === undefined || d > LOGIN_WARN_DAYS) return undefined;
  const when = d < 0 ? "a expiré" : d === 0 ? "expire aujourd'hui" : `expire dans ${d} jour${d > 1 ? "s" : ""}`;
  return `La connexion Claude Code ${when} : lance « claude » dans un terminal puis /login pour la renouveler.`;
}

/** Au démarrage de l'app : prévient une fois si la connexion Claude Code arrive à échéance. */
let loginChecked = false;
export async function checkClaudeLogin() {
  if (loginChecked) return;
  loginChecked = true;
  const w = await claudeAccount().then(loginWarning).catch(() => undefined);
  if (w) toast(w, "error");
}

/** « Max 5x », « Pro »… à partir de ce que renvoie Claude Code. */
export function accountLabel(a: ClaudeAccount): string {
  if (!a.loggedIn) return "non connecté";
  if (!a.subscription) return a.authMethod ? `connecté (${a.authMethod})` : "connecté";
  const name = a.subscription.charAt(0).toUpperCase() + a.subscription.slice(1);
  const mult = a.tier?.match(/_(\d+x)$/)?.[1];
  return mult ? `${name} ${mult}` : name;
}

/** Claude Code sur le modèle llama.cpp de MyIA (API Anthropic de llama-server, sur 127.0.0.1). */
export const LOCAL_MODEL = {
  id: "local",
  label: "Local",
  hint: "ton modèle llama.cpp : gratuit et hors ligne, mais bien moins capable que Claude (petites tâches)",
} as const;

export interface Triage {
  model: string;
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
    const sw = switches.get(e.payload.id);
    if (sw) {
      sw.buf = (sw.buf + e.payload.data).slice(-16_000);
      const v = modelSwitchVerdict(sw.buf);
      if (v) settleSwitch(e.payload.id, v);
    }
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
    dropSwitch(e.payload.id);
  });
}

export async function openClaude(cwd: string, title: string, resume: boolean, model?: string, prompt?: string): Promise<string> {
  // Modèle local : serveur llama.cpp démarré et modèle chargé avant l'ouverture (le premier chargement prend du temps).
  if (model === "local") {
    const r = await call<{ warning?: string }>("claude.localReady");
    if (r.warning) toast(r.warning, "error");
  }
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

/** Changements de modèle en attente de confirmation : sortie de la console reçue depuis l'envoi de /model. */
const switches = new Map<number, { buf: string; timer: ReturnType<typeof setTimeout> }>();
const SWITCH_TIMEOUT_MS = 20_000;

function dropSwitch(id: number) {
  const sw = switches.get(id);
  if (sw) clearTimeout(sw.timer);
  switches.delete(id);
  const t = terminals[`pty:${id}`];
  if (t) t.pendingModel = undefined;
}

function settleSwitch(id: number, verdict: "ok" | "failed" | "timeout") {
  const t = terminals[`pty:${id}`];
  const want = t?.pendingModel;
  dropSwitch(id);
  if (!t || !want) return;
  if (verdict === "ok") t.model = want;
  else if (verdict === "failed") toast(`Claude Code a refusé le modèle ${want} : le détail est dans la console.`, "error");
  else {
    // Ni confirmation ni refus (Claude occupé, question en attente…) : on ne sait plus quel modèle est actif.
    t.model = undefined;
    toast(`Changement vers ${want} non confirmé : vérifie dans la console (/model).`, "error");
  }
}

/** Envoie /model, puis n'affiche le nouveau modèle qu'une fois le changement confirmé par Claude Code. */
export function switchModel(key: string, model: string) {
  const t = terminals[key];
  if (!t || t.pendingModel || t.exited !== undefined) return;
  t.pendingModel = model;
  switches.set(t.id, { buf: "", timer: setTimeout(() => settleSwitch(t.id, "timeout"), SWITCH_TIMEOUT_MS) });
  sendLine(t.id, `/model ${model}`);
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
  dropSwitch(t.id);
  delete terminals[key];
}
