<script setup lang="ts">
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, CheckCircle2, Download, Info, RotateCw } from "lucide-vue-next";
import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from "vue";
import Sidebar from "./components/Sidebar.vue";
import TitleBar from "./components/TitleBar.vue";
import { inTauri } from "./lib/rpc";
import { settings } from "./lib/settings";
import { navigate, restartSidecar, startPolling, state, type View } from "./lib/store";
import { applyTheme, BUILTIN_THEMES } from "./lib/themes";
import { startUpdates, update } from "./lib/update";
import { startPtt } from "./lib/ptt";
import { startWallpaper, wallpaper } from "./lib/background";
import PttIndicator from "./components/PttIndicator.vue";
import SpeechIndicator from "./components/SpeechIndicator.vue";
import { speech, stopSpeaking } from "./lib/sound";
import AgentsView from "./views/AgentsView.vue";
import ConversationsView from "./views/ConversationsView.vue";
import MarketplaceView from "./views/MarketplaceView.vue";
import ModelsView from "./views/ModelsView.vue";
import OverviewView from "./views/OverviewView.vue";
import SettingsView from "./views/SettingsView.vue";
import GuildView from "./views/GuildView.vue";
import TeamsView from "./views/TeamsView.vue";
import JarvisView from "./views/JarvisView.vue";
import { startJarvis } from "./lib/jarvis";

const views = {
  overview: OverviewView,
  jarvis: JarvisView,
  conversations: ConversationsView,
  agents: AgentsView,
  teams: TeamsView,
  guild: GuildView,
  models: ModelsView,
  marketplace: MarketplaceView,
  settings: SettingsView,
};

// Apparence : thème, densité, taille de police, animations.
watchEffect(() => {
  const a = settings.appearance;
  const theme = [...BUILTIN_THEMES, ...state.installedThemes].find((t) => t.id === a.theme) ?? BUILTIN_THEMES[0]!;
  const bg = a.background;
  applyTheme(theme, { glow: a.glow, panelOpacity: wallpaper.url ? bg.panelOpacity : 100 });
  document.documentElement.dataset.wallpaper = wallpaper.url ? "on" : "off";
  const root = document.documentElement;
  root.dataset.density = a.density;
  root.dataset.motion = a.reduceMotion ? "reduce" : "full";
  root.style.setProperty("--font-scale", String(a.fontScale / 100));
});

let lastInterval = settings.general.metricsInterval;
watchEffect(() => {
  if (settings.general.metricsInterval !== lastInterval && state.ready) {
    lastInterval = settings.general.metricsInterval;
    startPolling();
  }
});

// Ctrl+1 à Ctrl+8 : ordre historique (raccourcis déjà appris) ; Jarvis, arrivé ensuite, prend Ctrl+9.
const order: View[] = ["overview", "conversations", "agents", "teams", "guild", "models", "marketplace", "settings", "jarvis"];
function onKey(e: KeyboardEvent) {
  // Échap coupe la lecture à voix haute en cours (une fenêtre modale ouverte garde Échap pour elle).
  if (e.key === "Escape" && speech.speaking) return stopSpeaking();
  if (!e.ctrlKey || e.altKey) return;
  const n = Number(e.key);
  if (n >= 1 && n <= order.length) {
    e.preventDefault();
    navigate(order[n - 1]!);
  } else if (e.key === "b") {
    e.preventDefault();
    settings.appearance.sidebarCollapsed = !settings.appearance.sidebarCollapsed;
  }
}

/** Tous les liens des réponses s'ouvrent dans le navigateur système, jamais dans la fenêtre de l'app. */
function onClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(href) && inTauri) void openUrl(href);
}

/** Menu de l'icône de la zone de notification : ouvrir directement une vue. */
function openView(v: unknown) {
  if (typeof v === "string" && order.includes(v as View)) navigate(v as View);
}
let unlistenNavigate: (() => void) | undefined;
async function startTrayNavigation() {
  if (!inTauri) return;
  unlistenNavigate = await listen<string>("app://navigate", (e) => openView(e.payload));
}

onMounted(() => {
  void startUpdates();
  void startPtt();
  startJarvis();
  startWallpaper();
  void startTrayNavigation();
  window.addEventListener("keydown", onKey);
  document.addEventListener("click", onClick);
});
onUnmounted(() => {
  unlistenNavigate?.();
  window.removeEventListener("keydown", onKey);
  document.removeEventListener("click", onClick);
});

const current = computed(() => views[state.view]);

/** Calque de l'image de fond : ajustement, flou, voile de la couleur du thème pour garder le texte lisible. */
const wallpaperStyle = computed(() => {
  const b = settings.appearance.background;
  const fit = b.fit === "contain" || b.fit === "tile" ? b.fit : "cover";
  const blur = Math.min(24, Math.max(0, b.blur));
  const scale = Math.min(100, Math.max(20, b.size)) / 100;
  const anchor = ["bottom-right", "bottom-left", "top-right"].includes(b.anchor) ? b.anchor.replace("-", " ") : "center";
  // Le flou fait baver les bords : on agrandit un peu le calque pour les cacher.
  const bleed = blur * 2;
  // Mosaïque réduite : calque agrandi de 1/scale puis rétréci, pour des carreaux plus petits sur toute la zone.
  // Sinon : l'image entière est réduite et posée dans le coin choisi (mode « petite »).
  const grow = fit === "tile" && scale < 1 ? ((1 / scale - 1) * 50).toFixed(3) : "0";
  return {
    backgroundSize: fit === "tile" ? "auto" : fit,
    backgroundRepeat: fit === "tile" ? "repeat" : "no-repeat",
    filter: blur ? `blur(${blur}px)` : undefined,
    inset: `calc(-${grow}% - ${bleed}px)`,
    transform: scale < 1 ? `scale(${scale})` : undefined,
    transformOrigin: fit === "tile" ? "center" : anchor,
    borderRadius: scale < 1 && fit !== "tile" ? "var(--radius-lg)" : undefined,
  };
});
// L'image (data: URL de plusieurs Mo) est posée une seule fois, hors du style réactif : bouger un curseur
// (flou, voile) ne doit pas faire réanalyser toute l'image au navigateur.
const wallpaperEl = ref<HTMLDivElement>();
watch([wallpaperEl, () => wallpaper.url], ([el, url]) => {
  if (el) el.style.backgroundImage = url ? `url("${url}")` : "";
});
const wallpaperDim = computed(() => Math.min(95, Math.max(0, settings.appearance.background.dim)) / 100);
const icons = { info: Info, success: CheckCircle2, error: AlertTriangle };
</script>

<template>
  <div class="frame">
  <TitleBar />
  <div class="shell">
    <Sidebar />
    <main class="main">
      <template v-if="wallpaper.url">
        <div ref="wallpaperEl" class="wallpaper" :style="wallpaperStyle" aria-hidden="true" />
        <div class="wallpaper-dim" :style="{ opacity: wallpaperDim }" aria-hidden="true" />
      </template>
      <div class="ambient" aria-hidden="true" />
      <div v-if="!inTauri" class="offline">
        <AlertTriangle :size="18" />
        Aperçu navigateur : lance l'app avec <code>npm run tauri dev</code> pour la connecter au cœur MyIA.
      </div>
      <div v-else-if="!state.sidecar.running && !state.ready" class="offline">
        <AlertTriangle :size="18" />
        <span>Le cœur MyIA ne tourne pas{{ state.sidecar.error ? ` : ${state.sidecar.error}` : "" }}.</span>
        <button class="btn sm" @click="restartSidecar"><RotateCw :size="14" /> Relancer</button>
      </div>
      <Transition name="view" mode="out-in">
        <KeepAlive include="ConversationsView">
          <component :is="current" :key="state.view" />
        </KeepAlive>
      </Transition>
    </main>

    <!-- Mise à jour en cours : l'app va se fermer puis redémarrer, on bloque l'interface pendant ce temps. -->
    <div v-if="update.state === 'downloading' || update.state === 'installing'" class="updating" role="alertdialog" aria-live="polite">
      <div class="updating-card">
        <Download :size="26" />
        <h3>Mise à jour {{ update.version ? `v${update.version}` : "" }}</h3>
        <p v-if="update.state === 'downloading'">Téléchargement… {{ update.percent ?? 0 }} %</p>
        <p v-else>Installation… MyIA va redémarrer.</p>
        <div class="updating-bar"><span :style="{ width: `${update.percent ?? 0}%` }" /></div>
      </div>
    </div>

    <PttIndicator />
    <SpeechIndicator />
    <div class="toasts">
      <TransitionGroup name="toast">
        <div v-for="t in state.toasts" :key="t.id" class="toast" :class="t.kind">
          <component :is="icons[t.kind]" :size="17" />
          <span>{{ t.text }}</span>
        </div>
      </TransitionGroup>
    </div>
  </div>
  </div>
</template>

<style>
.frame {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.shell {
  display: flex;
  flex: 1;
  min-height: 0;
}
.main {
  flex: 1;
  min-width: 0;
  height: 100%;
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.main > :not(.ambient):not(.offline):not(.wallpaper):not(.wallpaper-dim) {
  position: relative;
  flex: 1;
  min-height: 0;
}
.ambient {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(900px 420px at 85% -10%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 70%),
    radial-gradient(700px 380px at 10% 110%, color-mix(in srgb, var(--accent-2) 6%, transparent), transparent 70%);
}
.wallpaper,
.wallpaper-dim {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.wallpaper {
  background-position: center;
}
.wallpaper-dim {
  background: var(--bg);
}
:root[data-glow="off"] .ambient {
  display: none;
}
.offline {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 16px 0;
  padding: 10px 14px;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--warning) 10%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
  color: var(--warning);
  font-size: 0.9rem;
}
.offline span {
  flex: 1;
  color: var(--text);
}
.view-enter-active,
.view-leave-active {
  transition: opacity 0.16s, transform 0.2s var(--ease);
}
.view-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.view-leave-to {
  opacity: 0;
}
.updating {
  position: fixed;
  /* sous la barre de titre : la fenêtre reste déplaçable pendant la mise à jour */
  inset: var(--titlebar-h) 0 0 0;
  z-index: 100;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(6px);
}
.updating-card {
  width: min(380px, 90vw);
  padding: 26px 28px;
  border-radius: var(--radius);
  background: var(--surface-2);
  border: 1px solid var(--border);
  box-shadow: 0 24px 60px -16px rgba(0, 0, 0, 0.7);
  text-align: center;
}
.updating-card svg {
  color: var(--accent);
}
.updating-card h3 {
  margin: 10px 0 4px;
}
.updating-card p {
  margin: 0 0 14px;
  color: var(--text-muted);
  font-size: 0.9rem;
}
.updating-bar {
  height: 6px;
  border-radius: 99px;
  background: var(--bg-elevated);
  overflow: hidden;
}
.updating-bar span {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  transition: width 0.25s;
}
.toasts {
  position: fixed;
  right: 20px;
  bottom: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 50;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 420px;
  padding: 12px 16px;
  border-radius: var(--radius);
  background: var(--surface-2);
  border: 1px solid var(--border);
  box-shadow: 0 16px 40px -12px rgba(0, 0, 0, 0.6);
}
.toast.success svg {
  color: var(--success);
}
.toast.error {
  border-color: color-mix(in srgb, var(--danger) 50%, transparent);
}
.toast.error svg {
  color: var(--danger);
}
.toast.info svg {
  color: var(--accent);
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s var(--ease);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(20px);
}
</style>
