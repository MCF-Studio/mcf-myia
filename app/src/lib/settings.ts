import { reactive, watch } from "vue";
import { call, inTauri } from "./rpc";

/** Réglages de l'app, enregistrés par le sidecar dans data/app-settings.json (survivent à une réinstallation). */
export const DEFAULT_SETTINGS = {
  general: {
    startView: "overview" as "overview" | "conversations" | "last",
    metricsInterval: 2,
    /** Touche globale « appuyer pour parler » à MASTER (vide = désactivée). */
    pttKey: "F9",
  },
  appearance: {
    theme: "volcano",
    glow: true,
    density: "comfortable" as "comfortable" | "compact",
    fontScale: 100,
    reduceMotion: false,
    sidebarCollapsed: false,
    /** Vue Agents : liste, grille ou carte (réseau des agents et de leurs équipes). */
    agentsLayout: "list" as "list" | "grid" | "map",
    /** Vue Équipes : carte de l'équipe affichée au-dessus de l'éditeur. */
    teamMap: true,
    /** Image de fond (copie gérée par le sidecar dans data/backgrounds/ ; vide = aucune). */
    background: {
      file: "",
      fit: "cover" as "cover" | "contain" | "tile",
      /** Voile de la couleur de fond du thème par-dessus l'image, en % (lisibilité). */
      dim: 55,
      blur: 0,
      /** Opacité des panneaux quand une image est affichée, en %. */
      panelOpacity: 82,
      /** Taille de l'image en % de la zone (100 = toute la zone) ; en dessous, elle est réduite et ancrée selon `anchor`. */
      size: 100,
      anchor: "center" as "center" | "bottom-right" | "bottom-left" | "top-right",
    },
  },
  conversations: {
    layout: "tabs" as "tabs" | "grid",
    gridColumns: 2,
    sendOnEnter: true,
    showSteps: true,
    showTimestamps: true,
    openTabs: [] as string[],
    activeTab: "" as string,
  },
  sound: {
    master: 80,
    notifications: true,
    notifVolume: 70,
    notifSound: "ember" as string,
    voice: false,
    voiceName: "",
    voiceRate: 1,
    voicePitch: 1,
    voiceVolume: 90,
    readReplies: "focused" as "off" | "focused" | "all",
    /** Langue de la dictée (whisper) : code ISO ou "auto". */
    dictationLang: "fr",
    /** Lire à voix haute la réponse de MASTER à une demande faite avec la touche « parler ». */
    pttSpeak: true,
    /** Bip au début et à la fin de l'écoute (touche « parler »), audible même quand MyIA est en arrière-plan. */
    pttBeep: true,
  },
  notifications: {
    desktop: true,
    onReply: true,
    onConfirm: true,
    onlyWhenUnfocused: true,
  },
  lastView: "overview",
};

export type Settings = typeof DEFAULT_SETTINGS;

export const settings = reactive(structuredClone(DEFAULT_SETTINGS)) as Settings;

/** Fusion profonde : un réglage absent (nouvelle version de l'app) garde sa valeur par défaut. */
function merge(target: any, src: any) {
  if (!src || typeof src !== "object") return;
  for (const k of Object.keys(target)) {
    if (!(k in src)) continue;
    const t = target[k];
    const v = src[k];
    if (t && typeof t === "object" && !Array.isArray(t)) merge(t, v);
    else if (typeof v === typeof t) target[k] = v;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
let loaded = false;

export async function loadSettings() {
  if (inTauri) {
    try {
      merge(settings, await call("settings.get", {}, 5000));
    } catch (e) {
      console.warn("réglages :", e);
    }
  }
  loaded = true;
  watch(
    settings,
    () => {
      if (!loaded || !inTauri) return;
      clearTimeout(timer);
      timer = setTimeout(() => call("settings.set", JSON.parse(JSON.stringify(settings))).catch(console.warn), 400);
    },
    { deep: true },
  );
}

export function resetSettings(section?: keyof Settings) {
  const fresh = structuredClone(DEFAULT_SETTINGS);
  if (section) (settings as any)[section] = (fresh as any)[section];
  else merge(settings, fresh);
}
