<script setup lang="ts">
import {
  Bot,
  Boxes,
  ChevronsLeft,
  ChevronsRight,
  Gauge,
  Handshake,
  MessagesSquare,
  Network,
  Settings,
  Store,
} from "lucide-vue-next";
import { computed } from "vue";
import logo from "../assets/logo.svg";
import { settings } from "../lib/settings";
import { navigate, state, type View } from "../lib/store";

const items: { id: View; label: string; icon: unknown; key: string }[] = [
  { id: "overview", label: "Vue d'ensemble", icon: Gauge, key: "1" },
  { id: "conversations", label: "Conversations", icon: MessagesSquare, key: "2" },
  { id: "agents", label: "Agents", icon: Bot, key: "3" },
  { id: "teams", label: "Équipes", icon: Network, key: "4" },
  { id: "guild", label: "Guilde", icon: Handshake, key: "5" },
  { id: "models", label: "Modèles", icon: Boxes, key: "6" },
  { id: "marketplace", label: "Marketplace", icon: Store, key: "7" },
  { id: "settings", label: "Paramètres", icon: Settings, key: "8" },
];

const collapsed = computed(() => settings.appearance.sidebarCollapsed);
const busyCount = computed(() => state.overview?.conversations.busy ?? 0);
const pendingConfirms = computed(() => Object.keys(state.confirms).length);
const loadedModel = computed(() => state.overview?.ollama.running?.[0]?.name);
const ollamaOk = computed(() => state.overview?.ollama.ok);
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="brand">
      <img :src="logo" alt="" />
      <div v-if="!collapsed" class="brand-text">
        <strong>MyIA</strong>
        <span>MCF Studio</span>
      </div>
    </div>

    <nav>
      <button
        v-for="it in items"
        :key="it.id"
        class="nav-item"
        :class="{ active: state.view === it.id }"
        :title="collapsed ? `${it.label} (Ctrl+${it.key})` : `Ctrl+${it.key}`"
        @click="navigate(it.id)"
      >
        <component :is="it.icon" :size="19" :stroke-width="1.8" />
        <span v-if="!collapsed" class="label">{{ it.label }}</span>
        <span v-if="it.id === 'conversations' && pendingConfirms" class="pill warn">{{ pendingConfirms }}</span>
        <span v-else-if="it.id === 'conversations' && busyCount" class="pill">{{ busyCount }}</span>
      </button>
    </nav>

    <div class="spacer" />

    <div class="status" :title="state.overview?.ollama.error ?? ''">
      <span class="dot" :class="!state.ready ? 'err' : loadedModel ? 'busy' : ollamaOk ? 'ok' : 'off'" />
      <div v-if="!collapsed" class="status-text">
        <span>{{ !state.ready ? "Cœur arrêté" : ollamaOk ? "Ollama prêt" : "Ollama arrêté" }}</span>
        <small class="mono">{{ loadedModel ?? state.overview?.defaultModel ?? "—" }}</small>
      </div>
    </div>

    <button class="nav-item collapse" :title="collapsed ? 'Déplier' : 'Replier'" @click="settings.appearance.sidebarCollapsed = !collapsed">
      <component :is="collapsed ? ChevronsRight : ChevronsLeft" :size="18" />
      <span v-if="!collapsed" class="label">Replier</span>
    </button>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-w);
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 18px 12px 12px;
  background: linear-gradient(180deg, var(--bg-elevated), var(--bg));
  border-right: 1px solid var(--hairline);
  transition: width 0.25s var(--ease);
  position: relative;
  z-index: 2;
}
.sidebar::after {
  /* filet de lumière en fusion sur le bord */
  content: "";
  position: absolute;
  top: 12%;
  bottom: 12%;
  right: -1px;
  width: 1px;
  background: linear-gradient(180deg, transparent, var(--accent), transparent);
  opacity: 0.35;
}
.sidebar.collapsed {
  width: 68px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 6px 22px;
}
.brand img {
  width: 36px;
  height: 36px;
  filter: drop-shadow(0 0 12px var(--glow));
}
.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}
.brand-text strong {
  font-size: 1.15rem;
  letter-spacing: -0.02em;
}
.brand-text span {
  font-size: 0.72rem;
  color: var(--text-muted);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 42px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}
.collapsed .nav-item {
  justify-content: center;
  padding: 0;
}
.nav-item:hover {
  background: var(--surface);
  color: var(--text);
}
.nav-item.active {
  color: var(--text);
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 16%, transparent), transparent 85%);
}
.nav-item.active::before {
  content: "";
  position: absolute;
  left: -12px;
  top: 9px;
  bottom: 9px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--lava);
  box-shadow: 0 0 12px var(--glow);
}
.nav-item.active svg {
  color: var(--accent);
  filter: drop-shadow(0 0 6px var(--glow));
}
.label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
}
.pill {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 0.72rem;
  font-weight: 700;
  display: grid;
  place-items: center;
}
.pill.warn {
  background: var(--warning);
  animation: pulse 1.4s infinite;
}
.collapsed .pill {
  position: absolute;
  top: 4px;
  right: 6px;
  min-width: 16px;
  height: 16px;
  font-size: 0.65rem;
}
.status {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 6px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--hairline);
}
.collapsed .status {
  justify-content: center;
  padding: 12px 0;
}
.status-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: 0.82rem;
}
.status-text small {
  color: var(--text-muted);
  font-size: 0.72rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.collapse {
  height: 36px;
}
</style>
