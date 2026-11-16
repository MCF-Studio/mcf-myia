import { reactive, watch } from "vue";
import { call, inTauri } from "./rpc";
import { settings } from "./settings";

/** Image de fond affichée : data: URL chargée depuis le sidecar quand `settings.appearance.background.file` change. */
export const wallpaper = reactive({ url: "", loading: false });

export const BACKGROUND_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];

let seq = 0;
async function load(file: string) {
  const mine = ++seq;
  if (!file || !inTauri) {
    wallpaper.url = "";
    return;
  }
  wallpaper.loading = true;
  try {
    const res = await call<{ dataUrl: string } | null>("background.get", { file }, 20_000);
    if (mine !== seq) return;
    wallpaper.url = res?.dataUrl ?? "";
    // Image disparue (données effacées, réglages copiés d'une autre machine) : on oublie le réglage.
    if (!res) settings.appearance.background.file = "";
  } catch (e) {
    if (mine === seq) wallpaper.url = "";
    console.warn("image de fond :", e);
  } finally {
    if (mine === seq) wallpaper.loading = false;
  }
}

export function startWallpaper() {
  watch(() => settings.appearance.background.file, load, { immediate: true });
}

/** Copie l'image choisie dans les données de MyIA et l'affiche. */
export async function setWallpaper(path: string) {
  const res = await call<{ file: string }>("background.set", { path }, 30_000);
  settings.appearance.background.file = res.file;
}

export async function clearWallpaper() {
  settings.appearance.background.file = "";
  await call("background.clear", {}, 10_000);
}
