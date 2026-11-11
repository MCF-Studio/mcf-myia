<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-vue-next";
import { computed, onMounted, onUnmounted, ref } from "vue";
import logo from "../assets/logo.svg";
import { inTauri } from "../lib/rpc";
import { state, type View } from "../lib/store";

/**
 * Barre de titre de l'app (la fenêtre n'a plus celle de Windows) : on la saisit pour déplacer la fenêtre,
 * double-clic pour agrandir, et les trois boutons habituels à droite.
 */
const LABELS: Record<View, string> = {
  overview: "Vue d'ensemble",
  conversations: "Conversations",
  agents: "Agents",
  teams: "Équipes",
  guild: "Guilde",
  models: "Modèles",
  marketplace: "Marketplace",
  settings: "Paramètres",
};

const title = computed(() => LABELS[state.view]);
const maximized = ref(false);
const win = inTauri ? getCurrentWindow() : undefined;
let unlisten: (() => void) | undefined;

async function refresh() {
  if (win) maximized.value = await win.isMaximized().catch(() => false);
}

onMounted(async () => {
  if (!win) return;
  await refresh();
  unlisten = await win.onResized(() => void refresh());
});
onUnmounted(() => unlisten?.());
</script>

<template>
  <header class="titlebar" data-tauri-drag-region>
    <img :src="logo" alt="" data-tauri-drag-region />
    <span class="app" data-tauri-drag-region>MyIA</span>
    <span class="sep" data-tauri-drag-region>/</span>
    <span class="view" data-tauri-drag-region>{{ title }}</span>
    <div class="grow" data-tauri-drag-region />
    <div v-if="win" class="controls">
      <button type="button" title="Réduire" aria-label="Réduire" @click="win.minimize()"><Minus :size="15" /></button>
      <button type="button" :title="maximized ? 'Restaurer' : 'Agrandir'" :aria-label="maximized ? 'Restaurer' : 'Agrandir'" @click="win.toggleMaximize()">
        <component :is="maximized ? Copy : Square" :size="maximized ? 13 : 12" />
      </button>
      <button type="button" class="close" title="Fermer" aria-label="Fermer" @click="win.close()"><X :size="16" /></button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  flex: none;
  height: var(--titlebar-h);
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 14px;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--hairline);
  user-select: none;
  position: relative;
  z-index: 3;
  font-size: 0.86rem;
}
.titlebar img {
  width: 18px;
  height: 18px;
}
.app {
  font-weight: 650;
  letter-spacing: -0.01em;
}
.sep {
  color: var(--border);
}
.view {
  color: var(--text-muted);
}
.grow {
  flex: 1;
  align-self: stretch;
}
.controls {
  display: flex;
  align-self: stretch;
}
.controls button {
  width: 46px;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.controls button:hover {
  background: var(--surface-2);
  color: var(--text);
}
.controls button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.controls .close:hover {
  background: var(--danger);
  color: #fff;
}
</style>
