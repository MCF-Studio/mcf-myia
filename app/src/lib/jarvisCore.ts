// Assistant vocal (onglet Jarvis) : comprendre ce que whisper a entendu. Fonctions pures, sans Vue ni DOM
// (testées par node --test : voir jarvisCore.test.ts). La vue et jarvis.ts ne font qu'appliquer ce qui sort d'ici.

/** Minuscules, sans accents ni ponctuation, espaces simples : la forme sur laquelle on compare. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distance d'édition (Levenshtein), bornée : au-delà de `max`, renvoie max + 1. */
export function distance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Tolérance selon la longueur du nom : whisper écrit souvent « Jarvice », « Jervis », « Friday » → « Fridé »… */
const tolerance = (n: string) => (n.length <= 3 ? 0 : n.length <= 5 ? 1 : 2);

/** Mots de politesse ou d'appel qui peuvent précéder le nom (« hé Jarvis », « ok Jarvis »). */
const CALLS = new Set(["he", "hey", "eh", "ok", "okay", "dis", "salut", "bonjour", "allo", "yo", "oh", "alors"]);

export interface WakeResult {
  /** Le nom a été entendu (au début de la phrase, après au plus deux mots d'appel). */
  woke: boolean;
  /** Le reste de la phrase, nom retiré (texte d'origine, ponctuation nettoyée au début). */
  rest: string;
}

/**
 * Le nom de l'assistant a-t-il été prononcé en début de phrase ? « Jarvis, ouvre Chrome » → woke, rest « ouvre Chrome ».
 * Le nom peut faire plusieurs mots (« Edith Prime ») ; il est comparé avec une petite tolérance aux fautes de whisper.
 */
export function detectWake(text: string, name: string): WakeResult {
  const target = normalize(name).split(" ").filter(Boolean);
  const words = text.trim().split(/\s+/);
  if (!target.length || !words.length) return { woke: false, rest: text.trim() };
  const joined = target.join("");
  const tol = tolerance(joined);
  for (let start = 0; start <= Math.min(2, words.length - 1); start++) {
    // Les mots avant le nom doivent tous être des mots d'appel.
    if (!words.slice(0, start).every((w) => CALLS.has(normalize(w)))) break;
    for (const len of new Set([target.length, 1, 2])) {
      const piece = words.slice(start, start + len);
      if (piece.length < len) continue;
      const heard = normalize(piece.join(" ")).replace(/ /g, "");
      if (heard && distance(heard, joined, tol) <= tol) {
        const rest = words
          .slice(start + len)
          .join(" ")
          .replace(/^[\s,.;:!?…\-–—]+/, "")
          .trim();
        return { woke: true, rest };
      }
    }
  }
  return { woke: false, rest: text.trim() };
}

/** Commandes comprises sans passer par le modèle. */
export type LocalIntent = "stop" | "sleep" | "yes" | "no" | "none";

const STOP = ["stop", "arrete", "arrete toi", "tais toi", "silence", "chut", "ca suffit", "c'est bon", "cest bon", "merci c'est tout", "merci cest tout"];
const SLEEP = ["mode veille", "en veille", "va dormir", "repos", "desactive l'ecoute", "desactive lecoute", "arrete d'ecouter", "arrete decouter", "fin de session", "au revoir", "bonne nuit"];
const YES = ["oui", "ouais", "vas y", "vas-y", "go", "ok", "d'accord", "daccord", "confirme", "je confirme", "fais le", "fais-le", "autorise", "valide", "affirmatif", "c'est parti", "cest parti", "oui vas y", "oui fais le", "oui confirme"];
const NO = ["non", "annule", "refuse", "laisse tomber", "ne fais pas", "ne le fais pas", "surtout pas", "negatif", "pas maintenant", "non merci", "non annule", "stop annule"];

/** Phrase courte qui correspond entièrement à une des formules (on ignore « merci », « s'il te plaît » autour). */
function matches(text: string, list: string[]): boolean {
  const t = normalize(text)
    .replace(/\b(merci|s'il te plait|sil te plait|stp|s'il vous plait|svp)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.split(" ").length > 6) return false;
  return list.some((f) => t === normalize(f));
}

/**
 * Ce que dit l'utilisateur, avant de l'envoyer au modèle : « stop » coupe la voix, « mode veille » arrête l'écoute,
 * « oui »/« non » répond à une confirmation en attente (seulement s'il y en a une : sinon c'est une phrase normale).
 */
export function localIntent(text: string, confirmPending: boolean): LocalIntent {
  if (confirmPending) {
    if (matches(text, YES)) return "yes";
    if (matches(text, NO)) return "no";
  }
  if (matches(text, SLEEP)) return "sleep";
  if (matches(text, STOP)) return "stop";
  return "none";
}

/** Phrases fantômes de whisper sur un bruit ou un silence (sous-titres appris) : jamais envoyées. */
const PHANTOMS = [
  "sous titres realises par la communaute d'amara org",
  "sous titrage st' 501",
  "merci d'avoir regarde cette video",
  "merci d'avoir regarde",
  "sous titres par",
  "abonnez vous",
  "musique",
  "rires",
  "applaudissements",
];

export function isPhantom(text: string): boolean {
  const t = normalize(text);
  if (t.length < 2) return true;
  return PHANTOMS.some((p) => t === p || t.startsWith(p));
}

/** Salutation selon l'heure, pour le briefing et la voix d'accueil. */
export function greeting(hour: number, user: string): string {
  const who = user ? ` ${user}` : "";
  if (hour < 5) return `Il est tard${who}`;
  if (hour < 12) return `Bonjour${who}`;
  if (hour < 18) return `Bon après-midi${who}`;
  return `Bonsoir${who}`;
}

/**
 * Détection de parole sur le niveau du micro (0..1, une mesure par image) : on attend que la voix monte au-dessus
 * du seuil (début de phrase), puis qu'elle reste en dessous pendant `silenceMs` (fin de phrase).
 * Pur : on lui donne l'heure et le niveau, il dit quoi faire.
 */
export interface VadConfig {
  threshold: number;
  silenceMs: number;
  /** Sans parole pendant ce temps : on relance l'écoute (évite les longs enregistrements vides). */
  idleMs: number;
  /** Phrase trop longue : on coupe quand même. */
  maxMs: number;
  /** Une voix doit durer au moins ça pour compter (un clic de souris ne déclenche rien). */
  minSpeechMs: number;
}

export const DEFAULT_VAD: VadConfig = { threshold: 0.12, silenceMs: 1100, idleMs: 25_000, maxMs: 45_000, minSpeechMs: 250 };

export interface VadState {
  startedAt: number;
  speechAt?: number;
  lastVoiceAt?: number;
  voicedMs: number;
  lastTick?: number;
}

export type VadAction = "wait" | "end" | "restart";

export function vadStep(s: VadState, now: number, level: number, cfg: VadConfig = DEFAULT_VAD): VadAction {
  const dt = s.lastTick === undefined ? 0 : Math.min(200, now - s.lastTick);
  s.lastTick = now;
  if (level >= cfg.threshold) {
    s.voicedMs += dt;
    s.lastVoiceAt = now;
    if (s.speechAt === undefined && s.voicedMs >= cfg.minSpeechMs) s.speechAt = now;
  }
  if (now - s.startedAt >= cfg.maxMs) return s.speechAt === undefined ? "restart" : "end";
  if (s.speechAt === undefined) return now - s.startedAt >= cfg.idleMs ? "restart" : "wait";
  return now - (s.lastVoiceAt ?? now) >= cfg.silenceMs ? "end" : "wait";
}

// ─── sentinelle : alertes dites à voix haute ─────────────────────────────────

export interface SentinelInput {
  cpu: number;
  ramPct: number;
  gpuTemp?: number;
  vramPct?: number;
}

export interface SentinelMemory {
  /** Depuis quand chaque seuil est dépassé (ms). */
  highSince: Record<string, number>;
  /** Dernière alerte dite pour chaque seuil (ms). */
  lastAlert: Record<string, number>;
}

export interface SentinelAlert {
  key: string;
  text: string;
}

const RULES: { key: string; value: (i: SentinelInput) => number | undefined; limit: number; sustainMs: number; text: (v: number) => string }[] = [
  { key: "gpuTemp", value: (i) => i.gpuTemp, limit: 85, sustainMs: 10_000, text: (v) => `Attention : la carte graphique chauffe, ${Math.round(v)} degrés.` },
  { key: "cpu", value: (i) => i.cpu, limit: 95, sustainMs: 30_000, text: (v) => `Le processeur est à ${Math.round(v)} % depuis plus de trente secondes.` },
  { key: "ram", value: (i) => i.ramPct, limit: 92, sustainMs: 20_000, text: (v) => `La mémoire est presque pleine : ${Math.round(v)} % utilisés.` },
  { key: "vram", value: (i) => i.vramPct, limit: 97, sustainMs: 20_000, text: () => "La mémoire de la carte graphique est saturée : un modèle risque de ralentir." },
];

/**
 * Seuils dépassés assez longtemps pour mériter une alerte, au plus une fois toutes les `cooldownMs` par seuil.
 * Pur : `mem` est mis à jour sur place, l'appelant le garde d'un appel à l'autre.
 */
export function sentinelCheck(input: SentinelInput, mem: SentinelMemory, now: number, cooldownMs = 10 * 60_000): SentinelAlert[] {
  const out: SentinelAlert[] = [];
  for (const r of RULES) {
    const v = r.value(input);
    if (v === undefined || !Number.isFinite(v) || v < r.limit) {
      delete mem.highSince[r.key];
      continue;
    }
    mem.highSince[r.key] ??= now;
    if (now - mem.highSince[r.key]! < r.sustainMs) continue;
    if (now - (mem.lastAlert[r.key] ?? -Infinity) < cooldownMs) continue;
    mem.lastAlert[r.key] = now;
    out.push({ key: r.key, text: r.text(v) });
  }
  return out;
}

/** Agents (hors MASTER) qui viennent de finir : occupés au relevé précédent, plus maintenant. */
export function finishedAgents(prev: Record<string, number>, cur: { id: string; name: string; busy: number; master?: boolean }[]): string[] {
  return cur.filter((a) => !a.master && (prev[a.id] ?? 0) > 0 && a.busy === 0).map((a) => a.name);
}

/** Date du jour (AAAA-MM-JJ, heure locale) : un seul briefing automatique par jour. */
export function dayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
