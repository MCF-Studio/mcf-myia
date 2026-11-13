import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { reactive, watch } from "vue";
import { cancelDictation, dictation, refreshDictation, startDictation, stopDictation } from "./dictation";
import { call, inTauri } from "./rpc";
import { settings } from "./settings";
import { playSound, speak } from "./sound";
import { refreshConversations, state, toast } from "./store";
import type { DisplayMessage } from "./types";

/**
 * « Appuyer pour parler » à MASTER : touche globale (enregistrée côté Rust, voir src-tauri/src/ptt.rs), active même
 * fenêtre cachée. Enfoncée : le micro enregistre ; relâchée : whisper transcrit EN LOCAL, puis la demande part dans la
 * conversation de MASTER (créée s'il n'y en a pas). La réponse arrive comme un message normal (notification, son) et
 * peut être lue à voix haute.
 */

const OWNER = "ptt";

/**
 * Étape en cours, affichée par PttIndicator (et signalée par un bip au début et à la fin de l'écoute) :
 * listening → transcribing → thinking → done, ou empty (rien entendu) / failed.
 */
export type PttPhase = "idle" | "listening" | "transcribing" | "thinking" | "done" | "empty" | "failed";

export const ptt = reactive({
  error: "" as string,
  active: false,
  phase: "idle" as PttPhase,
  /** Nom de l'agent MASTER qui reçoit la demande. */
  agent: "",
  /** Ce que whisper a compris (montré pendant que MASTER répond). */
  heard: "",
  /** Détail de l'échec (phase failed). */
  detail: "",
});

let hideTimer: ReturnType<typeof setTimeout> | undefined;
function setPhase(phase: PttPhase, detail = "") {
  clearTimeout(hideTimer);
  ptt.phase = phase;
  ptt.detail = detail;
  // États finaux : visibles quelques secondes, puis la pastille disparaît.
  if (phase === "done" || phase === "empty" || phase === "failed") hideTimer = setTimeout(() => (ptt.phase = "idle"), phase === "failed" ? 6000 : 3000);
}

const beep = (kind: "listen" | "stop" | "error") => {
  if (settings.sound.pttBeep) playSound(kind, true);
};

/** Conversation directe avec MASTER (hors équipe et hors échanges avec d'autres agents) ; créée au besoin. */
async function masterConversation(masterId: string, masterName: string): Promise<string> {
  await refreshConversations();
  const existing = state.conversations
    .filter((c) => c.agentId === masterId && !c.teamId && !c.title.includes("↔"))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (existing) return existing.id;
  const c = await call<{ id: string }>("conversations.create", { agentId: masterId, title: `Avec ${masterName}` });
  await refreshConversations();
  return c.id;
}

/** Touche « parler » actuellement enfoncée. */
let held = false;

async function onPress() {
  // Une seule écoute à la fois : on le dit au lieu d'ignorer la touche sans rien montrer.
  if (dictation.state !== "idle") {
    if (dictation.owner !== OWNER) {
      beep("error");
      setPhase("failed", "une dictée est déjà en cours ailleurs dans l'app");
    }
    return;
  }
  if (ptt.phase === "thinking") {
    beep("error");
    setPhase("thinking");
    return toast(`${ptt.agent} répond encore à ta demande précédente`, "error");
  }
  const master = state.agents.find((a) => a.master);
  if (!master) {
    beep("error");
    setPhase("failed", "aucun agent MASTER");
    toast("Aucun agent MASTER : coche « Agent MASTER » sur un agent (écran Agents)", "error");
    return;
  }
  if (!dictation.ready) await refreshDictation();
  if (!dictation.ready) {
    beep("error");
    setPhase("failed", "dictée non installée");
    toast("La dictée n'est pas installée : Paramètres → Son et voix → Dictée", "error");
    return;
  }
  ptt.agent = master.name;
  ptt.heard = "";
  ptt.active = true;
  let text = "";
  try {
    text = (
      await startDictation(OWNER, () => {
        // Touche déjà relâchée pendant l'ouverture du micro : on arrête tout de suite au lieu d'enregistrer 90 s.
        if (!held) return onRelease();
        setPhase("listening");
        beep("listen");
      })
    ).trim();
  } catch (e) {
    beep("error");
    setPhase("failed", `micro : ${(e as Error).message}`);
    toast(`Micro : ${(e as Error).message}`, "error");
    return;
  } finally {
    ptt.active = false;
  }
  if (!text) return setPhase("empty");
  ptt.heard = text;
  setPhase("thinking");
  try {
    const id = await masterConversation(master.id, master.name);
    const answer = await call<DisplayMessage>("conversations.send", { id, text }, 15 * 60_000);
    setPhase("done");
    if (answer.role === "assistant" && settings.sound.pttSpeak) speak(answer.text, true);
  } catch (e) {
    setPhase("failed", (e as Error).message);
    toast((e as Error).message, "error");
  } finally {
    void refreshConversations();
  }
}

function onRelease() {
  held = false;
  if (dictation.owner === OWNER && dictation.state === "recording") {
    beep("stop");
    setPhase("transcribing");
    stopDictation();
  }
}

/** Applique la touche choisie (vide = désactivée). */
export async function applyPttKey(key = settings.general.pttKey): Promise<void> {
  if (!inTauri) return;
  try {
    await invoke("ptt_set", { accelerator: key });
    ptt.error = "";
  } catch (e) {
    ptt.error = String(e);
    throw new Error(ptt.error);
  }
}

let started = false;
export async function startPtt() {
  if (!inTauri || started) return;
  started = true;
  await listen<boolean>("ptt://state", (e) => {
    if (!e.payload) return onRelease();
    // Répétition automatique du clavier tant que la touche reste enfoncée : une seule pression compte.
    if (held) return;
    held = true;
    void onPress();
  });
  await applyPttKey().catch((e) => toast(`Touche « parler à MASTER » : ${(e as Error).message}`, "error"));
  // Touche changée dans les Paramètres : réenregistrée.
  watch(
    () => settings.general.pttKey,
    (k) => void applyPttKey(k).catch(() => undefined),
  );
}

/** Annule un enregistrement en cours (ex. touche relâchée hors de l'app sans événement). */
export function cancelPtt() {
  if (dictation.owner === OWNER) {
    cancelDictation();
    setPhase("idle");
  }
}
