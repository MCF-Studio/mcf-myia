<script setup lang="ts">
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, CheckCircle2, Info, RotateCw } from "lucide-vue-next";
import { computed, onMounted, onUnmounted, watchEffect } from "vue";
import Sidebar from "./components/Sidebar.vue";
import { inTauri } from "./lib/rpc";
import { settings } from "./lib/settings";
import { navigate, restartSidecar, startPolling, state, type View } from "./lib/store";
import { applyTheme, BUILTIN_THEMES } from "./lib/themes";
import AgentsView from "./views/AgentsView.vue";
import ConversationsView from "./views/ConversationsView.vue";
import MarketplaceView from "./views/MarketplaceView.vue";
import ModelsView from "./views/ModelsView.vue";
import OverviewView from "./views/OverviewView.vue";
import SettingsView from "./views/SettingsView.vue";

const views = {
  overview: OverviewView,
  conversations: ConversationsView,
  agents: AgentsView,
  models: ModelsView,
  marketplace: MarketplaceView,
  settings: SettingsView,
};

// Apparence : thème, densité, taille de police, animations.
watchEffect(() => {
  const a = settings.appearance;
  const theme = [...BUILTIN_THEMES, ...state.installedThemes].find((t) => t.id === a.theme) ?? BUILTIN_THEMES[0]!;
  applyTheme(theme, { glow: a.glow });
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

const order: View[] = ["overview", "conversations", "agents", "models", "marketplace", "settings"];
function onKey(e: KeyboardEvent) {
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

onMounted(() => {
  window.addEventListener("keydown", onKey);
  document.addEventListener("click", onClick);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKey);
  document.removeEventListener("click", onClick);
});

const current = computed(() => views[state.view]);
const icons = { info: Info, success: CheckCircle2, error: AlertTriangle };
</script>

<template>
  <div class="shell">
    <Sidebar />
    <main class="main">
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

    <div class="toasts">
      <TransitionGroup name="toast">
        <div v-for="t in state.toasts" :key="t.id" class="toast" :class="t.kind">
          <component :is="icons[t.kind]" :size="17" />
          <span>{{ t.text }}</span>
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>

<style>
.shell {
  display: flex;
  height: 100%;
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
.main > :not(.ambient):not(.offline) {
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
