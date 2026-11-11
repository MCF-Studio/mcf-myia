<script setup lang="ts">
import { ChevronDown, Columns2, LayoutGrid, MessageSquarePlus, Pin, PinOff, Search, Trash2, X } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import AgentAvatar from "../components/AgentAvatar.vue";
import ChatPanel from "../components/ChatPanel.vue";
import { relTime } from "../lib/format";
import { call } from "../lib/rpc";
import { settings } from "../lib/settings";
import {
  agentById,
  closeTab,
  createConversation,
  deleteConversation,
  openConversation,
  refreshConversations,
  state,
  toast,
} from "../lib/store";

const cs = settings.conversations;
const query = ref("");
const pickerOpen = ref(false);
const confirmDelete = ref<string>();

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  const list = q
    ? state.conversations.filter(
        (c) => c.title.toLowerCase().includes(q) || (agentById(c.agentId)?.name.toLowerCase().includes(q) ?? false),
      )
    : state.conversations;
  return { pinned: list.filter((c) => c.pinned), others: list.filter((c) => !c.pinned) };
});

const tabs = computed(() => cs.openTabs.filter((id) => state.conversations.some((c) => c.id === id)));
const titleOf = (id: string) => state.open[id]?.title ?? state.conversations.find((c) => c.id === id)?.title ?? "…";
const gridCols = computed(() => Math.min(cs.gridColumns, Math.max(1, tabs.value.length)));

async function newWith(agentId: string) {
  pickerOpen.value = false;
  try {
    await createConversation(agentId);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function togglePin(id: string, pinned: boolean) {
  await call("conversations.update", { id, pinned: !pinned });
  await refreshConversations();
}

async function remove(id: string) {
  if (confirmDelete.value !== id) {
    confirmDelete.value = id;
    setTimeout(() => confirmDelete.value === id && (confirmDelete.value = undefined), 3000);
    return;
  }
  confirmDelete.value = undefined;
  await deleteConversation(id).catch((e) => toast(e.message, "error"));
}

function onKey(e: KeyboardEvent) {
  if (e.ctrlKey && e.key === "n") {
    e.preventDefault();
    const first = state.agents[0];
    if (state.agents.length === 1 && first) void newWith(first.id);
    else pickerOpen.value = true;
  } else if (e.ctrlKey && e.key === "w" && cs.activeTab) {
    e.preventDefault();
    closeTab(cs.activeTab);
  } else if (e.ctrlKey && e.key === "Tab" && tabs.value.length > 1) {
    e.preventDefault();
    const i = tabs.value.indexOf(cs.activeTab);
    const n = tabs.value.length;
    cs.activeTab = tabs.value[(i + (e.shiftKey ? n - 1 : 1)) % n]!;
  } else if (e.key === "Escape") {
    pickerOpen.value = false;
  }
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="convs">
    <!-- Liste -->
    <aside class="list">
      <div class="list-head">
        <h2>Conversations</h2>
        <div class="picker-wrap">
          <button class="btn primary sm" title="Nouvelle conversation (Ctrl+N)" @click="pickerOpen = !pickerOpen">
            <MessageSquarePlus :size="15" /> <ChevronDown :size="13" />
          </button>
          <Transition name="pop">
            <div v-if="pickerOpen" class="picker">
              <div class="tiny muted picker-title">Parler à…</div>
              <button v-for="a in state.agents" :key="a.id" class="picker-item" @click="newWith(a.id)">
                <AgentAvatar :agent="a" :size="26" />
                <span>{{ a.name }}</span>
                <span class="mono tiny muted">{{ a.model ?? state.overview?.defaultModel }}</span>
              </button>
            </div>
          </Transition>
        </div>
      </div>
      <label class="search">
        <Search :size="15" />
        <input v-model="query" placeholder="Rechercher" />
      </label>

      <div class="items">
        <template v-for="group in [{ k: 'pinned', label: 'Épinglées' }, { k: 'others', label: 'Récentes' }] as const" :key="group.k">
          <div v-if="filtered[group.k].length" class="group-label">{{ group.label }}</div>
          <div
            v-for="c in filtered[group.k]"
            :key="c.id"
            class="item"
            :class="{ active: cs.activeTab === c.id, open: cs.openTabs.includes(c.id) }"
            @click="openConversation(c.id)"
          >
            <AgentAvatar :agent="agentById(c.agentId)" :size="30" :busy="state.open[c.id]?.busy" />
            <div class="item-meta">
              <div class="row">
                <strong>{{ c.title }}</strong>
                <span class="tiny muted when">{{ relTime(c.updatedAt) }}</span>
              </div>
              <span class="tiny muted preview">{{ c.lastMessage ?? "Vide" }}</span>
            </div>
            <div class="item-actions" @click.stop>
              <button class="btn sm ghost icon" :title="c.pinned ? 'Désépingler' : 'Épingler'" @click="togglePin(c.id, !!c.pinned)">
                <component :is="c.pinned ? PinOff : Pin" :size="14" />
              </button>
              <button
                class="btn sm ghost icon danger"
                :class="{ armed: confirmDelete === c.id }"
                :title="confirmDelete === c.id ? 'Cliquer encore pour supprimer' : 'Supprimer'"
                @click="remove(c.id)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
        </template>
        <div v-if="!state.conversations.length" class="empty small">
          Aucune conversation.<br />
          <span class="tiny">Ctrl+N pour en démarrer une.</span>
        </div>
      </div>
    </aside>

    <!-- Zone de discussion -->
    <section class="stage">
      <div class="toolbar">
        <div v-if="cs.layout === 'tabs'" class="tabs">
          <button
            v-for="id in tabs"
            :key="id"
            class="tab"
            :class="{ active: cs.activeTab === id, busy: state.open[id]?.busy, wait: Object.keys(state.confirms).some((m) => state.open[id]?.messages.some((x) => x.id === m)) }"
            @click="cs.activeTab = id"
            @auxclick.middle="closeTab(id)"
          >
            <span class="dot" :class="state.open[id]?.busy ? 'busy' : 'off'" />
            <span class="tab-title">{{ titleOf(id) }}</span>
            <X :size="13" class="tab-x" @click.stop="closeTab(id)" />
          </button>
        </div>
        <div v-else class="tabs muted small grid-info">{{ tabs.length }} conversation{{ tabs.length > 1 ? "s" : "" }} ouverte{{ tabs.length > 1 ? "s" : "" }}</div>

        <div v-if="cs.layout === 'grid'" class="segmented" title="Colonnes">
          <button v-for="n in [1, 2, 3, 4]" :key="n" :class="{ on: cs.gridColumns === n }" @click="cs.gridColumns = n">{{ n }}</button>
        </div>
        <div class="segmented">
          <button :class="{ on: cs.layout === 'tabs' }" @click="cs.layout = 'tabs'"><Columns2 :size="15" /> Onglets</button>
          <button :class="{ on: cs.layout === 'grid' }" @click="cs.layout = 'grid'"><LayoutGrid :size="15" /> Grille</button>
        </div>
      </div>

      <div v-if="!tabs.length" class="empty stage-empty">
        <MessageSquarePlus :size="40" />
        <h3>Aucune conversation ouverte</h3>
        <p class="small">Choisis-en une à gauche ou démarre-en une nouvelle avec un agent.</p>
        <button class="btn primary" @click="pickerOpen = true">Nouvelle conversation</button>
      </div>

      <div v-else-if="cs.layout === 'tabs'" class="single">
        <KeepAlive :max="8">
          <ChatPanel v-if="cs.activeTab && state.open[cs.activeTab]" :id="cs.activeTab" :key="cs.activeTab" />
        </KeepAlive>
      </div>

      <div v-else class="grid-view" :style="{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }">
        <ChatPanel
          v-for="id in tabs"
          :id="id"
          :key="id"
          compact
          closable
          :class="{ focused: cs.activeTab === id }"
          @close="closeTab(id)"
          @focusin="cs.activeTab = id"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.convs {
  display: flex;
  height: 100%;
}
.list {
  width: 300px;
  flex: none;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--hairline);
  background: color-mix(in srgb, var(--bg-elevated) 55%, transparent);
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 16px 12px;
}
.list-head h2 {
  font-size: 1.15rem;
}
.picker-wrap {
  position: relative;
}
.picker {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  width: 270px;
  z-index: 20;
  padding: 6px;
  border-radius: var(--radius);
  background: var(--surface-2);
  border: 1px solid var(--border);
  box-shadow: 0 20px 50px -14px rgba(0, 0, 0, 0.7);
}
.picker-title {
  padding: 6px 8px;
}
.picker-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.picker-item span:nth-child(2) {
  flex: 1;
}
.picker-item:hover {
  background: var(--surface);
}
.pop-enter-active,
.pop-leave-active {
  transition: opacity 0.12s, transform 0.15s var(--ease);
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 12px 10px;
  padding: 0 10px;
  height: 34px;
  border-radius: var(--radius);
  background: var(--bg-elevated);
  border: 1px solid var(--hairline);
  color: var(--text-muted);
}
.search:focus-within {
  border-color: var(--accent);
}
.search input {
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
}
.items {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 12px;
}
.group-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  padding: 12px 8px 6px;
}
.item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 8px;
  border-radius: var(--radius);
  cursor: pointer;
}
.item:hover {
  background: var(--surface);
}
.item.active {
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 13%, transparent), var(--surface) 80%);
}
.item.open:not(.active)::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  width: 3px;
  height: 14px;
  margin-top: -7px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 50%, transparent);
}
.item-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.item-meta strong {
  flex: 1;
  font-weight: 560;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.preview {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.when {
  flex: none;
}
.item-actions {
  display: none;
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  background: var(--surface-2);
  border-radius: var(--radius-sm);
  box-shadow: -10px 0 12px var(--surface);
}
.item:hover .item-actions {
  display: flex;
}
.armed {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, transparent);
}
.stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 14px 16px 16px;
  gap: 12px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
}
.grid-info {
  align-items: center;
}
.tab {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 220px;
  height: 34px;
  padding: 0 10px 0 12px;
  border-radius: var(--radius);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  flex: none;
}
.tab:hover {
  background: var(--surface);
  color: var(--text);
}
.tab.active {
  background: var(--surface);
  color: var(--text);
  border-color: var(--hairline);
  box-shadow: inset 0 -2px 0 var(--accent);
}
.tab.wait .dot {
  background: var(--warning);
  animation: pulse 1s infinite;
}
.tab-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab-x {
  opacity: 0.4;
  flex: none;
  border-radius: 4px;
}
.tab-x:hover {
  opacity: 1;
  color: var(--danger);
}
.single {
  flex: 1;
  min-height: 0;
}
.grid-view {
  flex: 1;
  min-height: 0;
  display: grid;
  gap: 12px;
  grid-auto-rows: minmax(320px, 1fr);
  overflow-y: auto;
}
.grid-view .focused {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--hairline));
}
.stage-empty {
  flex: 1;
}
.stage-empty h3 {
  color: var(--text);
}
</style>
