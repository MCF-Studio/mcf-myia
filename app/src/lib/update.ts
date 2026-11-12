import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { reactive } from "vue";
import { inTauri } from "./rpc";

/**
 * Mises à jour automatiques : tout est fait côté Rust (recherche, téléchargement, vérification de la signature,
 * installation). La page ne fait qu'afficher l'état.
 */
export interface UpdateStatus {
  state: "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error";
  version?: string | null;
  percent?: number | null;
  error?: string | null;
}

export const update = reactive<UpdateStatus>({ state: "idle" });

let started = false;
export async function startUpdates() {
  if (!inTauri || started) return;
  started = true;
  await listen<UpdateStatus>("update://status", (e) => Object.assign(update, e.payload));
  // La recherche a pu commencer avant que la page écoute.
  try {
    Object.assign(update, await invoke<UpdateStatus>("update_status"));
  } catch {
    /* ancienne version du cœur natif */
  }
}

/** Recherche manuelle : installe et redémarre si une version plus récente existe. */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const status = await invoke<UpdateStatus>("update_check");
  Object.assign(update, status);
  return status;
}
