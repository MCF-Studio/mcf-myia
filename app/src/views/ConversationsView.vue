<script setup lang="ts">
import { ChevronDown, Columns2, LayoutGrid, MessageSquarePlus, Network, Pin, PinOff, Search, SquareTerminal, Trash2, X } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import AgentAvatar from "../components/AgentAvatar.vue";
import ChatPanel from "../components/ChatPanel.vue";
import TerminalPanel from "../components/TerminalPanel.vue";
import { CLAUDE_MODELS, isTerminalKey, killTerminal, openClaude, terminals, triage, type Triage } from "../lib/terminals";
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

const tabs = computed(() =>
  cs.openTabs.filter((id) => (isTerminalKey(id) ? !!terminals[id] : state.conversations.some((c) => c.id === id))),
);
const terminalTabs = computed(() => tabs.value.filter(isTerminalKey));
const titleOf = (id: string) =>
  isTerminalKey(id)
    ? `Claude · ${terminals[id]?.title ?? "…"}`
    : (state.open[id]?.title ?? state.conversations.find((c) => c.id === id)?.title ?? "…");

/** Fermer un onglet : une console est arrêtée (Claude Code se ferme), une conversation reste dans la liste. */
async function closeAny(id: string) {
  if (isTerminalKey(id)) await killTerminal(id);
  closeTab(id);
}

// ─── Console Claude Code ────────────────────────────────────────────────────
const consoleDialog = ref(false);
const projects = ref<{ name: string; path: string; kinds: string[] }[]>([]);
const workspace = ref("");
const consoleDir = ref("");
const consoleResume = ref(false);
const launching = ref(false);
const consoleTask = ref("");
/** "auto" = le modèle local choisit selon la difficulté ; "" = modèle par défaut de Claude Code. */
const consoleModel = ref<"auto" | "" | "haiku" | "sonnet" | "opus">("auto");
const advice = ref<Triage>();
const advising = ref(false);

async function adviseModel() {
  const task = consoleTask.value.trim();
  if (task.length < 3) return undefined;
  advising.value = true;
  try {
    advice.value = await triage(task);
    return advice.value;
  } catch (e) {
    toast((e as Error).message, "error");
    return undefined;
  } finally {
    advising.value = false;
  }
}

async function askConsole() {
  pickerOpen.value = false;
  consoleDialog.value = true;
  if (!projects.value.length) {
    try {
      const r = await call<{ workspace: string; projects: { name: string; path: string; kinds: string[] }[] }>("projects.list");
      projects.value = r.projects;
      workspace.value = r.workspace;
      consoleDir.value ||= r.workspace;
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
}

async function launchConsole() {
  launching.value = true;
  try {
    const p = projects.value.find((x) => x.path === consoleDir.value);
    const task = consoleTask.value.trim();
    let model: string | undefined = consoleModel.value || undefined;
    if (model === "auto") model = task ? (advice.value ?? (await adviseModel()))?.model : undefined;
    const key = await openClaude(consoleDir.value, p?.name ?? "workspace", consoleResume.value, model, task || undefined);
    consoleTask.value = "";
    advice.value = undefined;
    cs.openTabs.push(key);
    cs.activeTab = key;
    consoleDialog.value = false;
  } catch (e) {
    toast(String(e), "error");
  } finally {
    launching.value = false;
  }
}

function replaced(oldKey: string, newKey: string) {
  const i = cs.openTabs.indexOf(oldKey);
  if (i >= 0) cs.openTabs.splice(i, 1, newKey);
  if (cs.activeTab === oldKey) cs.activeTab = newKey;
  delete terminals[oldKey];
}
const gridCols = computed(() => Math.min(cs.gridColumns, Math.max(1, tabs.value.length)));

async function newWith(agentId: string) {
  pickerOpen.value = false;
  try {
    await createConversation(agentId);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function newTeam(teamId: string, rootAgent: string) {
  pickerOpen.value = false;
  try {
    await createConversation(rootAgent, teamId);
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
    void closeAny(cs.activeTab);
  } else if (e.ctrlKey && e.key === "Tab" && tabs.value.length > 1) {
    e.preventDefault();
    const i = tabs.value.indexOf(cs.activeTab);
    const n = tabs.value.length;
    cs.activeTab = tabs.value[(i + (e.shiftKey ? n - 1 : 1)) % n]!;
  } else if (e.key === "Escape") {
    pickerOpen.value = false;
    consoleDialog.value = false;
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
              <template v-if="state.teams.length">
                <div class="tiny muted picker-title">Équipes</div>
                <button v-for="t in state.teams" :key="t.id" class="picker-item" @click="newTeam(t.id, t.root.agentId)">
                  <span class="team-glyph"><Network :size="15" /></span>
                  <span>{{ t.name }}</span>
                  <span class="tiny muted">équipe</span>
                </button>
              </template>
              <div class="tiny muted picker-title">Console</div>
              <button class="picker-item" @click="askConsole">
                <span class="term-glyph"><SquareTerminal :size="15" /></span>
                <span>Claude Code</span>
                <span class="tiny muted">terminal</span>
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
              <span class="tiny muted preview">
                <Network v-if="c.teamId" :size="11" class="team-mark" />{{ c.lastMessage ?? "Vide" }}
              </span>
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
            @auxclick.middle="closeAny(id)"
          >
            <SquareTerminal v-if="isTerminalKey(id)" :size="14" class="tab-term" />
            <span v-else class="dot" :class="state.open[id]?.busy ? 'busy' : 'off'" />
            <span class="tab-title">{{ titleOf(id) }}</span>
            <X :size="13" class="tab-x" @click.stop="closeAny(id)" />
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
          <ChatPanel v-if="cs.activeTab && !isTerminalKey(cs.activeTab) && state.open[cs.activeTab]" :id="cs.activeTab" :key="cs.activeTab" />
        </KeepAlive>
        <!-- Les consoles restent montées (v-show) pour garder leur écran quand on change d'onglet. -->
        <TerminalPanel
          v-for="k in terminalTabs"
          v-show="cs.activeTab === k"
          :key="k"
          :tab-key="k"
          @replaced="(n) => replaced(k, n)"
        />
      </div>

      <div v-else class="grid-view" :style="{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }">
        <template v-for="id in tabs" :key="id">
          <TerminalPanel
            v-if="isTerminalKey(id)"
            :tab-key="id"
            compact
            closable
            :class="{ focused: cs.activeTab === id }"
            @close="closeAny(id)"
            @replaced="(n) => replaced(id, n)"
            @focusin="cs.activeTab = id"
          />
          <ChatPanel
            v-else
            :id="id"
            compact
            closable
            :class="{ focused: cs.activeTab === id }"
            @close="closeTab(id)"
            @focusin="cs.activeTab = id"
          />
        </template>
      </div>
    </section>

    <!-- Choix du dossier pour une console Claude Code -->
    <Transition name="pop">
      <div v-if="consoleDialog" class="modal-backdrop" @click.self="consoleDialog = false">
        <form class="modal card" @submit.prevent="launchConsole">
          <div class="row">
            <span class="term-glyph big"><SquareTerminal :size="20" /></span>
            <div>
              <h3>Inviter Claude Code à la table</h3>
              <p class="small muted">Une vraie session Claude Code, dans un onglet, sur le dossier de ton choix.</p>
            </div>
          </div>
          <label class="field">
            <span class="small">Dossier de travail</span>
            <select v-model="consoleDir" class="input select">
              <option :value="workspace">workspace (dossier de travail MyIA)</option>
              <option v-for="p in projects" :key="p.path" :value="p.path">{{ p.name }}{{ p.kinds.length ? ` · ${p.kinds.join(", ")}` : "" }}</option>
            </select>
          </label>
          <label class="field">
            <span class="small">Tâche <em class="muted">(optionnelle : Claude démarre directement dessus)</em></span>
            <textarea
              v-model="consoleTask"
              class="input"
              rows="3"
              maxlength="8000"
              placeholder="Ex. ajoute un écran d'options au menu principal"
              @input="advice = undefined"
            />
          </label>
          <div class="field">
            <span class="small">Modèle Claude</span>
            <div class="segmented model-seg">
              <button type="button" :class="{ on: consoleModel === 'auto' }" title="Le modèle local choisit selon la difficulté de la tâche" @click="consoleModel = 'auto'">
                Auto
              </button>
              <button v-for="m in CLAUDE_MODELS" :key="m.id" type="button" :class="{ on: consoleModel === m.id }" :title="m.hint" @click="consoleModel = m.id">
                {{ m.label }}
              </button>
              <button type="button" :class="{ on: consoleModel === '' }" title="Le modèle configuré dans Claude Code" @click="consoleModel = ''">Défaut</button>
            </div>
            <div v-if="consoleModel === 'auto'" class="advice small">
              <template v-if="advice">
                <strong>{{ CLAUDE_MODELS.find((m) => m.id === advice!.model)?.label }}</strong>
                <span class="muted">· difficulté {{ advice.difficulty }}/5 · {{ advice.reason }}</span>
              </template>
              <span v-else-if="consoleTask.trim().length >= 3" class="muted">
                <button type="button" class="link" :disabled="advising" @click="adviseModel">{{ advising ? "analyse…" : "Voir le modèle conseillé" }}</button>
                (choisi automatiquement à l'ouverture)
              </span>
              <span v-else class="muted">Décris la tâche pour que le modèle soit choisi selon sa difficulté.</span>
            </div>
          </div>
          <label class="row small check">
            <input v-model="consoleResume" type="checkbox" />
            Reprendre la dernière session de ce dossier (<span class="mono">claude --continue</span>)
          </label>
          <p class="tiny muted">Claude Code garde ses propres règles de permission : il demande avant d'agir, dans le terminal.</p>
          <div class="row modal-actions">
            <span class="spacer" />
            <button type="button" class="btn ghost" @click="consoleDialog = false">Annuler</button>
            <button class="btn primary" :disabled="!consoleDir || launching">Ouvrir la console</button>
          </div>
        </form>
      </div>
    </Transition>
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
.term-glyph {
  width: 26px;
  height: 26px;
  border-radius: 30%;
  display: grid;
  place-items: center;
  flex: none;
  color: var(--accent-2);
  background: color-mix(in srgb, var(--accent-2) 14%, var(--surface-2));
  border: 1px solid color-mix(in srgb, var(--accent-2) 40%, transparent);
}
.term-glyph.big {
  width: 42px;
  height: 42px;
}
.tab-term {
  color: var(--accent-2);
  flex: none;
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(3px);
}
.modal {
  width: min(520px, 92vw);
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.8), 0 0 60px -30px var(--glow);
}
.modal h3 {
  font-size: 1.1rem;
}
.modal p {
  margin: 2px 0 0;
}
.modal .row {
  gap: 14px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.model-seg {
  align-self: flex-start;
}
.advice {
  display: flex;
  gap: 6px;
  align-items: baseline;
  flex-wrap: wrap;
}
.advice strong {
  color: var(--accent);
}
.link {
  border: 0;
  background: none;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}
.field em {
  font-style: normal;
}
.check {
  gap: 8px;
  cursor: pointer;
}
.check input {
  accent-color: var(--accent);
}
.modal-actions {
  gap: 8px;
}
.team-glyph {
  width: 26px;
  height: 26px;
  border-radius: 30%;
  display: grid;
  place-items: center;
  color: var(--accent-2);
  background: color-mix(in srgb, var(--accent-2) 14%, var(--surface-2));
  border: 1px solid color-mix(in srgb, var(--accent-2) 40%, transparent);
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
.team-mark {
  color: var(--accent-2);
  margin-right: 4px;
  vertical-align: -1px;
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
