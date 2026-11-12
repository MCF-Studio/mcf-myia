import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { reactive, watch } from "vue";
import { cancelDictation, dictation, refreshDictation, startDictation, stopDictation } from "./dictation";
import { call, inTauri } from "./rpc";
import { settings } from "./settings";
import { speak } from "./sound";
import { refreshConversations, state, toast } from "./store";
import type { DisplayMessage } from "./types";

/**
 * « Appuyer pour parler » à MASTER : touche globale (enregistrée côté Rust, voir src-tauri/src/ptt.rs), active même
 * fenêtre cachée. Enfoncée : le micro enregistre ; relâchée : whisper transcrit EN LOCAL, puis la demande part dans la
 * conversation de MASTER (créée s'il n'y en a pas). La réponse arrive comme un message normal (notification, son) et
 * peut être lue à voix haute.
 */

const OWNER = "ptt";

export const ptt = reactive({ error: "" as string, active: false });

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

async function onPress() {
  if (dictation.state !== "idle") return;
  const master = state.agents.find((a) => a.master);
  if (!master) {
    toast("Aucun agent MASTER : coche « Agent MASTER » sur un agent (écran Agents)", "error");
    return;
  }
  if (!dictation.ready) await refreshDictation();
  if (!dictation.ready) {
    toast("La dictée n'est pas installée : Paramètres → Son et voix → Dictée", "error");
    return;
  }
  ptt.active = true;
  let text = "";
  try {
    text = (await startDictation(OWNER)).trim();
  } catch (e) {
    toast(`Micro : ${(e as Error).message}`, "error");
    return;
  } finally {
    ptt.active = false;
  }
  if (!text) return;
  try {
    const id = await masterConversation(master.id, master.name);
    const answer = await call<DisplayMessage>("conversations.send", { id, text }, 15 * 60_000);
    if (answer.role === "assistant" && settings.sound.pttSpeak) speak(answer.text, true);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    void refreshConversations();
  }
}

function onRelease() {
  if (dictation.owner === OWNER && dictation.state === "recording") stopDictation();
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
  await listen<boolean>("ptt://state", (e) => (e.payload ? void onPress() : onRelease()));
  await applyPttKey().catch((e) => toast(`Touche « parler à MASTER » : ${(e as Error).message}`, "error"));
  // Touche changée dans les Paramètres : réenregistrée.
  watch(
    () => settings.general.pttKey,
    (k) => void applyPttKey(k).catch(() => undefined),
  );
}

/** Annule un enregistrement en cours (ex. touche relâchée hors de l'app sans événement). */
export function cancelPtt() {
  if (dictation.owner === OWNER) cancelDictation();
}
