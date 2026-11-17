import { reactive, watch } from "vue";
import { cancelDictation, dictation, refreshDictation, startDictation, stopDictation } from "./dictation";
import { dayKey, DEFAULT_VAD, detectWake, finishedAgents, greeting, isPhantom, localIntent, normalize, sentinelCheck, vadStep, type SentinelMemory, type VadState } from "./jarvisCore";
import { masterConversation } from "./ptt";
import { call, inTauri } from "./rpc";
import { settings } from "./settings";
import { playSound, speak, speech, stopSpeaking } from "./sound";
import { answerConfirm, refreshConversations, state, toast } from "./store";
import type { ConversationFull, DisplayMessage } from "./types";

/**
 * Onglet Jarvis : un assistant vocal branché sur l'agent MASTER (même conversation que la touche « parler »).
 *
 * Mains libres : le micro écoute en continu, une phrase est détectée par le niveau de la voix (jarvisCore.vadStep),
 * transcrite EN LOCAL par whisper, puis envoyée si elle commence par le nom de l'assistant (mot d'éveil). « Oui » /
 * « non » répondent à une confirmation en attente, « stop » coupe la voix, « mode veille » arrête l'écoute.
 * Rien ne change dans les règles : chaque action de MASTER suit ses niveaux de risque et ses confirmations (SPEC §3).
 * Le micro est coupé pendant que l'assistant parle (il s'entendrait lui-même).
 */

const OWNER = "jarvis";

export type JarvisPhase = "off" | "standby" | "attentive" | "hearing" | "transcribing" | "thinking" | "speaking";

export const jarvis = reactive({
  phase: "off" as JarvisPhase,
  /** Boucle d'écoute en cours (mains libres, ou écoute ponctuelle). */
  listening: false,
  /** Dernière phrase entendue (texte de whisper). */
  heard: "",
  /** Dernière réponse de l'assistant. */
  reply: "",
  /** Conversation avec MASTER. */
  conversationId: "",
  /** Jusqu'à quand on peut parler sans redire le nom (ms depuis l'époque). */
  attentiveUntil: 0,
  /** Demande en cours chez MASTER. */
  busy: false,
  error: "",
  /** Ligne d'état courte affichée sous le réacteur. */
  status: "",
  /** Séquence de démarrage déjà jouée pendant cette session de l'app. */
  booted: false,
  /** Dernières alertes de la sentinelle (affichées dans le HUD). */
  alerts: [] as { ts: number; text: string }[],
});

// ─── sentinelle et briefing du jour ──────────────────────────────────────────

const sentinelMem: SentinelMemory = { highSince: {}, lastAlert: {} };
let busyBefore: Record<string, number> = {};

/** La sentinelle parle-t-elle maintenant ? Onglet affiché, ou écoute en arrière-plan choisie. */
const sentinelOn = () => settings.jarvis.sentinel && state.ready && (state.view === "jarvis" || (settings.jarvis.background && settings.jarvis.handsFree));

function alert(text: string) {
  jarvis.alerts.unshift({ ts: Date.now(), text });
  jarvis.alerts.splice(6);
  playSound("confirm", true);
  // Pas de voix par-dessus une réponse ou pendant une écoute : l'alerte reste affichée.
  if (settings.jarvis.speak && !speech.speaking && dictation.state === "idle") say(text);
  else toast(text, "info");
}

/** Briefing automatique : une fois par jour, à la première ouverture de l'onglet (agent MASTER requis). */
export function maybeDailyBriefing() {
  const today = dayKey();
  if (!settings.jarvis.dailyBriefing || settings.jarvis.lastBriefing === today || !state.ready || !masterAgent() || jarvis.busy) return;
  settings.jarvis.lastBriefing = today;
  const proto = settings.jarvis.protocols.find((p) => normalize(p.label) === "briefing")?.prompt;
  jarvis.heard = "Briefing du jour";
  void ask(
    proto ??
      "Fais-moi un briefing rapide : état du PC (pc_status), mes projets avec des changements git non commités, et mes tâches prévues. Quelques phrases courtes.",
  );
}

export const masterAgent = () => state.agents.find((a) => a.master);

/** Confirmation en attente dans la conversation de MASTER (la plus récente). */
export function pendingConfirm(): DisplayMessage | undefined {
  const conv = state.open[jarvis.conversationId];
  if (!conv) return undefined;
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i]!;
    if (m.role === "confirm" && m.id in state.confirms) return m;
  }
  return undefined;
}

/** Ouvre (sans changer de vue) la conversation de MASTER, pour suivre ses messages en direct. */
export async function ensureConversation(): Promise<string> {
  const master = masterAgent();
  if (!master) throw new Error("aucun agent MASTER : coche « Agent MASTER » sur un agent (écran Agents)");
  const id = await masterConversation(master.id, master.name);
  if (!state.open[id]) state.open[id] = await call<ConversationFull>("conversations.get", { id });
  jarvis.conversationId = id;
  return id;
}

function say(text: string) {
  jarvis.reply = text;
  if (settings.jarvis.speak) speak(text, true);
}

// ─── demandes ────────────────────────────────────────────────────────────────

/** Demande « protocole <nom> » : le texte du protocole, sinon undefined. */
function protocolFor(text: string): string | undefined {
  const t = normalize(text);
  const m = /^(?:lance |active |execute )?(?:le )?protocole (.+)$/.exec(t);
  if (!m) return undefined;
  const want = m[1]!.trim();
  return settings.jarvis.protocols.find((p) => normalize(p.label) === want || normalize(p.label).startsWith(want))?.prompt;
}

/** Envoie une demande à MASTER. Ne bloque pas l'écoute : on peut répondre « oui » à une confirmation pendant ce temps. */
export async function ask(text: string): Promise<void> {
  const prompt = text.trim();
  if (!prompt) return;
  if (jarvis.busy) {
    toast(`${settings.jarvis.name} traite encore la demande précédente`, "error");
    return;
  }
  jarvis.busy = true;
  jarvis.error = "";
  jarvis.status = "Analyse de la demande…";
  stopSpeaking();
  try {
    const id = await ensureConversation();
    const answer = await call<DisplayMessage>("conversations.send", { id, text: protocolFor(prompt) ?? prompt }, 15 * 60_000);
    if (answer.role === "assistant") say(answer.text);
    else if (answer.role === "error") {
      jarvis.error = answer.text;
      playSound("error", true);
    }
    // Enchaîner sans redire le nom : la fenêtre démarre à la fin de la lecture (voir le watch de speech.speaking).
    jarvis.attentiveUntil = Date.now() + settings.jarvis.followUp * 1000;
  } catch (e) {
    jarvis.error = (e as Error).message;
    playSound("error", true);
  } finally {
    jarvis.busy = false;
    jarvis.status = "";
    void refreshConversations();
  }
}

/** Traite une phrase entendue (`voice`) ou tapée. */
export async function handle(text: string, voice: boolean): Promise<void> {
  let t = text.trim();
  if (!t || (voice && isPhantom(t))) return;
  const confirm = pendingConfirm();
  if (voice && settings.jarvis.wakeWord && Date.now() > jarvis.attentiveUntil && !confirm) {
    const w = detectWake(t, settings.jarvis.name);
    if (!w.woke) return;
    jarvis.heard = t;
    if (!w.rest) {
      playSound("listen", true);
      jarvis.attentiveUntil = Date.now() + 8000;
      say("Oui ?");
      return;
    }
    t = w.rest;
  } else if (voice && settings.jarvis.wakeWord) {
    // Fenêtre d'attention ou confirmation : le nom reste accepté, retiré s'il est dit.
    const w = detectWake(t, settings.jarvis.name);
    if (w.woke && w.rest) t = w.rest;
  }
  jarvis.heard = t;

  const intent = localIntent(t, !!confirm);
  if (intent === "yes" || intent === "no") {
    await answerConfirm(confirm!.id, intent === "yes");
    playSound(intent === "yes" ? "done" : "stop", true);
    say(intent === "yes" ? "C'est parti." : "Annulé.");
    return;
  }
  if (intent === "stop") {
    stopSpeaking();
    jarvis.attentiveUntil = 0;
    return;
  }
  if (intent === "sleep") {
    settings.jarvis.handsFree = false;
    say("Je me mets en veille.");
    return;
  }
  playSound("stop", true);
  void ask(t);
}

// ─── écoute ──────────────────────────────────────────────────────────────────

let loopRunning = false;
let stopRequested = false;
let current: { cancel(): void } | undefined;

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Peut-on ouvrir le micro ? Pas pendant que l'assistant parle, ni pendant qu'une autre dictée est en cours. */
function micBlocked(): boolean {
  if (speech.speaking) return true;
  // Micro pris ailleurs (dictée, touche « parler ») ou pas encore libéré par l'écoute précédente.
  if (dictation.state !== "idle") return true;
  // Pendant une demande, on n'écoute que pour répondre à une confirmation.
  return jarvis.busy && !pendingConfirm();
}

/**
 * Une phrase : ouvre le micro, attend qu'on parle puis qu'on se taise. Rend le texte, ou "" si personne n'a parlé
 * (l'écoute est alors relancée sans passer par whisper).
 */
function listenOnce(): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false;
    let raf = 0;
    const done = (text: string) => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(raf);
      current = undefined;
      resolve(text);
    };
    const vad: VadState = { startedAt: performance.now(), voicedMs: 0 };
    const cfg = { ...DEFAULT_VAD, threshold: Math.min(40, Math.max(4, settings.jarvis.sensitivity)) / 100 };
    current = {
      cancel() {
        cancelDictation();
        done("");
      },
    };
    startDictation(OWNER, () => {
      // Annulé pendant l'ouverture du micro : on le referme tout de suite.
      if (settled) return cancelDictation();
      const tick = () => {
        if (settled) return;
        // L'assistant s'est mis à parler (réponse arrivée) : on coupe pour ne pas s'enregistrer soi-même.
        if (speech.speaking) return current?.cancel();
        const action = vadStep(vad, performance.now(), dictation.level, cfg);
        if (vad.speechAt !== undefined && jarvis.phase !== "hearing") jarvis.phase = "hearing";
        if (action === "end") {
          jarvis.phase = "transcribing";
          stopDictation();
          return;
        }
        if (action === "restart") return current?.cancel();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })
      .then((text) => done(text))
      .catch((e: Error) => {
        jarvis.error = `micro : ${e.message}`;
        done("");
      });
  });
}

function idlePhase(): JarvisPhase {
  if (speech.speaking) return "speaking";
  if (jarvis.busy && !pendingConfirm()) return "thinking";
  if (!jarvis.listening) return "off";
  return !settings.jarvis.wakeWord || Date.now() < jarvis.attentiveUntil || pendingConfirm() ? "attentive" : "standby";
}

async function loop(once = false) {
  if (loopRunning) return;
  loopRunning = true;
  stopRequested = false;
  jarvis.listening = true;
  try {
    if (!dictation.ready) await refreshDictation();
    if (!dictation.ready) {
      jarvis.error = "La dictée n'est pas installée : Paramètres → Son et voix → Dictée";
      toast(jarvis.error, "error");
      settings.jarvis.handsFree = false;
      return;
    }
    while (!stopRequested) {
      if (micBlocked()) {
        jarvis.phase = idlePhase();
        await sleepMs(150);
        continue;
      }
      jarvis.phase = idlePhase();
      const text = await listenOnce();
      if (stopRequested) break;
      jarvis.phase = idlePhase();
      if (!text) continue;
      await handle(text, !once);
      if (once) break;
    }
  } finally {
    loopRunning = false;
    jarvis.listening = false;
    jarvis.phase = idlePhase();
  }
}

function stopLoop() {
  stopRequested = true;
  current?.cancel();
}

/** Écoute ponctuelle (clic sur le réacteur) : une phrase, sans mot d'éveil. */
export function listenNow() {
  if (settings.jarvis.handsFree) {
    jarvis.attentiveUntil = Date.now() + 15_000;
    playSound("listen", true);
    return;
  }
  if (loopRunning) return stopLoop();
  stopSpeaking();
  playSound("listen", true);
  void loop(true);
}

/** Démarre et arrête l'écoute mains libres selon les réglages et la vue affichée. */
let started = false;
export function startJarvis() {
  if (started || !inTauri) return;
  started = true;
  watch(
    () => [settings.jarvis.handsFree, settings.jarvis.background, state.view, state.ready] as const,
    ([on, bg, view, ready], old) => {
      const want = on && ready && (bg || view === "jarvis");
      if (want && !loopRunning) {
        if (on && !old?.[0]) {
          const user = state.info?.userName ?? "";
          say(`${greeting(new Date().getHours(), user)}. ${settings.jarvis.name} à l'écoute.`);
        }
        void loop();
      } else if (!want && loopRunning) stopLoop();
    },
    { immediate: true },
  );
  // Fin de la lecture : la fenêtre « sans redire le nom » repart de là.
  watch(
    () => speech.speaking,
    (talking) => {
      if (!talking && jarvis.attentiveUntil > Date.now()) jarvis.attentiveUntil = Date.now() + settings.jarvis.followUp * 1000;
      jarvis.phase = idlePhase();
    },
  );
  // Nouvelle confirmation : l'assistant la lit à voix haute et attend « oui » ou « non ».
  watch(
    () => pendingConfirm()?.id,
    (id) => {
      const m = pendingConfirm();
      if (!id || !m) return;
      playSound("confirm", true);
      say(`Je dois ton accord : ${m.title ?? "action sensible"}. Je le fais ?`);
    },
  );
  // Sentinelle : chaque relevé des métriques est comparé aux seuils.
  watch(
    () => state.metrics,
    (m) => {
      if (!m || !sentinelOn()) return;
      const g = m.gpus[0];
      for (const a of sentinelCheck(
        { cpu: m.cpuUsage, ramPct: (m.memoryUsed / m.memoryTotal) * 100, gpuTemp: g?.temperatureC, vramPct: g ? (g.memoryUsedMb / g.memoryTotalMb) * 100 : undefined },
        sentinelMem,
        Date.now(),
      ))
        alert(a.text);
    },
  );
  // Un agent a fini son travail : on le dit.
  watch(
    () => state.overview?.agents,
    (agents) => {
      if (!agents) return;
      const done = sentinelOn() ? finishedAgents(busyBefore, agents) : [];
      busyBefore = Object.fromEntries(agents.map((a) => [a.id, a.busy]));
      if (done.length) alert(done.length === 1 ? `${done[0]} a terminé son travail.` : `${done.join(" et ")} ont terminé leur travail.`);
    },
  );
  // Progression des outils (« ⚙ … ») : affichée sous le réacteur pendant la demande.
  watch(
    () => state.open[jarvis.conversationId]?.messages.length,
    () => {
      const last = state.open[jarvis.conversationId]?.messages.at(-1);
      if (jarvis.busy && last?.role === "progress") jarvis.status = last.text.slice(0, 140);
    },
  );
}

/** Micro occupé par l'écoute de Jarvis : la touche « parler » le reprend (ptt.ts). */
export const JARVIS_OWNER = OWNER;
