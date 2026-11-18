<script setup lang="ts">
import { ArrowLeftRight, CheckCircle2, ListTodo, Plus, RefreshCw, RotateCcw, Undo2 } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { call } from "../lib/rpc";
import { toast } from "../lib/store";
import type { WorkItem, WorkList, WorkType } from "../lib/types";
import ModalBox from "./ModalBox.vue";

/**
 * Registre de travail d'une équipe (docs/TRAVAIL.md) : les tâches que ses membres créent, prennent, annotent et
 * ferment. Tu y vois où en est le travail et tu peux agir : créer, noter, fermer, rouvrir, rendre une tâche bloquée.
 * Le contenu est écrit par les agents : il est affiché comme du texte, jamais interprété.
 */
const props = defineProps<{ teamId: string }>();

const data = ref<WorkList>();
const loading = ref(false);
const failed = ref<string>();

async function refresh() {
  loading.value = true;
  try {
    data.value = await call<WorkList>("work.list", { teamId: props.teamId });
    failed.value = undefined;
  } catch (e) {
    failed.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

// Synchronisation avec un autre outil de suivi (work.provider = exec:<script>, docs/TRAVAIL.md §7).
const sync = ref<{ provider: string; active: boolean; pending: number }>();
const syncing = ref(false);
async function refreshSync() {
  sync.value = await call<typeof sync.value>("work.syncStatus", { teamId: props.teamId }).catch(() => undefined);
}
async function syncNow() {
  syncing.value = true;
  try {
    const r = await call<{ push: { ok: boolean; sent?: number; error?: string }; pull: { ok: boolean; applied?: number; skipped?: number; error?: string }; pending: number }>(
      "work.sync",
      { teamId: props.teamId },
      120_000,
    );
    const err = r.push.error ?? r.pull.error;
    if (err) toast(`Synchronisation : ${err}`, "error");
    else toast(`Synchronisé : ${r.push.sent ?? 0} envoyé(s), ${r.pull.applied ?? 0} reçu(s)${r.pull.skipped ? `, ${r.pull.skipped} ignoré(s)` : ""}`, "success");
    await refresh();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    syncing.value = false;
    void refreshSync();
  }
}
onMounted(() => void refreshSync());

// Les agents écrivent pendant que l'écran est ouvert : relecture régulière (un petit fichier local).
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), 8000);
});
onBeforeUnmount(() => clearInterval(timer));
watch(
  () => props.teamId,
  () => {
    data.value = undefined;
    void refresh();
    void refreshSync();
  },
);

type Tab = "en_cours" | "pretes" | "bloquees" | "decisions" | "fermees";
const tab = ref<Tab>("en_cours");
const items = computed(() => data.value?.items ?? []);
const groups = computed<Record<Tab, WorkItem[]>>(() => {
  const open = items.value.filter((i) => i.status !== "fermee");
  return {
    en_cours: open.filter((i) => i.status === "en_cours"),
    pretes: open.filter((i) => i.ready && i.type !== "decision"),
    bloquees: open.filter((i) => i.status === "ouverte" && i.blockers.length > 0),
    decisions: open.filter((i) => i.type === "decision"),
    fermees: items.value.filter((i) => i.status === "fermee"),
  };
});
const TABS: { id: Tab; label: string }[] = [
  { id: "en_cours", label: "En cours" },
  { id: "pretes", label: "Prêtes" },
  { id: "bloquees", label: "Bloquées" },
  { id: "decisions", label: "Décisions" },
  { id: "fermees", label: "Fermées" },
];
const TYPE_LABEL: Record<WorkType, string> = { tache: "tâche", bug: "bug", decision: "décision", lot: "lot" };
const shown = computed(() => groups.value[tab.value]);
const titleOf = (id: string) => items.value.find((i) => i.id === id)?.title;
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "");

// ─── fiche d'une tâche ───────────────────────────────────────────────────────
const openId = ref<string>();
const current = computed(() => items.value.find((i) => i.id === openId.value));
const noteText = ref("");
const reason = ref("");
const busy = ref(false);

function show(i: WorkItem) {
  openId.value = i.id;
  noteText.value = "";
  reason.value = "";
}

async function act(method: string, extra: Record<string, string> = {}, done = "Fait") {
  if (!current.value) return;
  busy.value = true;
  try {
    await call(method, { teamId: props.teamId, id: current.value.id, ...extra });
    toast(done, "success");
    noteText.value = "";
    reason.value = "";
    await refresh();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}

// ─── nouvelle tâche ──────────────────────────────────────────────────────────
const creating = ref<{ title: string; description: string; type: WorkType }>();
async function create() {
  if (!creating.value) return;
  busy.value = true;
  try {
    await call("work.create", { teamId: props.teamId, ...creating.value });
    creating.value = undefined;
    tab.value = "pretes";
    await refresh();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="card work">
    <div class="card-head">
      <h3><ListTodo :size="17" /> Travail de l'équipe</h3>
      <div class="row">
        <button
          v-if="sync?.active"
          type="button"
          class="btn sm ghost"
          :title="`Envoyer les changements au suivi externe et relever les siens (${sync.provider})`"
          :disabled="syncing"
          @click="syncNow"
        >
          <ArrowLeftRight :size="14" :class="{ spin: syncing }" /> Synchroniser<span v-if="sync.pending"> ({{ sync.pending }})</span>
        </button>
        <button type="button" class="btn sm ghost icon" title="Relire le registre" :disabled="loading" @click="refresh"><RefreshCw :size="14" :class="{ spin: loading }" /></button>
        <button type="button" class="btn sm" @click="creating = { title: '', description: '', type: 'tache' }"><Plus :size="15" /> Nouvelle tâche…</button>
      </div>
    </div>
    <p class="tiny muted">
      Le registre de l'équipe : les tâches que ses membres créent, prennent et ferment. Il survit aux conversations, et chaque membre en reçoit un
      résumé à chaque demande. Ce qui y est écrit vient des agents : vérifie avant de t'y fier.
    </p>

    <p v-if="failed" class="small warn-text">{{ failed }}</p>

    <div class="tabs row">
      <button v-for="t in TABS" :key="t.id" type="button" class="btn sm" :class="{ primary: tab === t.id, ghost: tab !== t.id }" @click="tab = t.id">
        {{ t.label }} <span class="count">{{ t.id === "fermees" ? (data?.closedTotal ?? 0) : groups[t.id].length }}</span>
      </button>
    </div>

    <div v-if="shown.length" class="list">
      <button v-for="i in shown" :key="i.id" type="button" class="item" @click="show(i)">
        <span class="mono tiny muted">{{ i.id }}</span>
        <span class="badge" :class="{ warn: i.type === 'decision' || i.type === 'bug', accent: i.type === 'lot' }">{{ TYPE_LABEL[i.type] }}</span>
        <span class="title">{{ i.title }}</span>
        <span v-if="i.assignee" class="tiny muted">{{ i.assignee }}</span>
        <span v-if="i.blockers.length" class="tiny muted">attend {{ i.blockers.join(", ") }}</span>
      </button>
      <p v-if="tab === 'fermees' && (data?.closedTotal ?? 0) > shown.length" class="tiny muted">Les {{ shown.length }} plus récentes.</p>
    </div>
    <p v-else-if="data" class="small muted">Rien ici pour l'instant.</p>

    <!-- Fiche d'une tâche -->
    <ModalBox v-if="current" :title="current.title" wide @close="openId = undefined">
      <template #icon><ListTodo :size="20" /></template>
      <div class="row facts">
        <span class="badge mono">{{ current.id }}</span>
        <span v-if="current.ext" class="badge mono" title="Référence dans le suivi externe">{{ current.ext }}</span>
        <span class="badge">{{ TYPE_LABEL[current.type] }}</span>
        <span class="badge" :class="{ ok: current.status === 'fermee' }">{{ current.status === "en_cours" ? "en cours" : current.status === "fermee" ? "fermée" : "ouverte" }}</span>
        <span v-if="current.assignee" class="badge">{{ current.assignee }}</span>
        <span v-for="l in current.labels" :key="l" class="badge">#{{ l }}</span>
      </div>
      <p class="tiny muted">Créée par {{ current.createdBy }} le {{ when(current.createdAt) }} · révision {{ current.rev }}</p>
      <p v-if="current.parent" class="small">Lot : <span class="mono">{{ current.parent }}</span> {{ titleOf(current.parent) }}</p>
      <div v-if="current.needs.length" class="small">
        Dépend de :
        <ul>
          <li v-for="d in current.needs" :key="d">
            <span class="mono">{{ d }}</span> {{ titleOf(d) ?? "" }} <em v-if="current.blockers.includes(d)" class="muted">(pas encore fermée)</em>
          </li>
        </ul>
      </div>
      <pre v-if="current.description" class="desc">{{ current.description }}</pre>
      <p v-if="current.closeReason" class="small"><CheckCircle2 :size="14" /> Fermée le {{ when(current.closedAt) }} : {{ current.closeReason }}</p>

      <div v-if="current.notes.length" class="notes">
        <strong class="small">Notes</strong>
        <div v-for="(n, k) in current.notes" :key="k" class="note">
          <span class="tiny muted">{{ when(n.at) }} · {{ n.by }}</span>
          <pre>{{ n.text }}</pre>
        </div>
      </div>

      <label class="field">
        <span class="small">Ajouter une note</span>
        <textarea v-model="noteText" class="input" rows="2" maxlength="2000" />
      </label>
      <label class="field">
        <span class="small">{{ current.status === "fermee" ? "Raison de la réouverture" : "Raison de la fermeture (ce qui est fait, ou pourquoi on abandonne)" }}</span>
        <input v-model="reason" class="input" maxlength="2000" />
      </label>

      <template #actions>
        <button v-if="current.status === 'en_cours'" type="button" class="btn ghost" :disabled="busy" title="La tâche redevient prête pour un autre membre" @click="act('work.release', {}, 'Tâche rendue')">
          <Undo2 :size="15" /> Rendre
        </button>
        <span class="spacer" />
        <button type="button" class="btn" :disabled="busy || !noteText.trim()" @click="act('work.note', { text: noteText }, 'Note ajoutée')">Noter</button>
        <button v-if="current.status !== 'fermee'" type="button" class="btn primary" :disabled="busy || !reason.trim()" @click="act('work.close', { reason }, 'Tâche fermée')">
          <CheckCircle2 :size="15" /> Fermer
        </button>
        <button v-else type="button" class="btn primary" :disabled="busy || !reason.trim()" @click="act('work.reopen', { reason }, 'Tâche rouverte')">
          <RotateCcw :size="15" /> Rouvrir
        </button>
      </template>
    </ModalBox>

    <!-- Nouvelle tâche -->
    <ModalBox v-if="creating" title="Nouvelle tâche" @close="creating = undefined">
      <template #icon><Plus :size="20" /></template>
      <label class="field">
        <span class="small">Titre</span>
        <input v-model="creating.title" class="input" maxlength="200" />
      </label>
      <label class="field">
        <span class="small">Type</span>
        <select v-model="creating.type" class="input select">
          <option value="tache">tâche</option>
          <option value="bug">bug</option>
          <option value="decision">décision (attend une réponse de ta part)</option>
          <option value="lot">lot (regroupe des tâches)</option>
        </select>
      </label>
      <label class="field">
        <span class="small">Description <em class="muted">(ce que le membre doit savoir : il ne voit pas tes conversations)</em></span>
        <textarea v-model="creating.description" class="input" rows="5" maxlength="4000" />
      </label>
      <template #actions>
        <button type="button" class="btn ghost" @click="creating = undefined">Annuler</button>
        <button type="button" class="btn primary" :disabled="busy || creating.title.trim().length < 3" @click="create"><Plus :size="15" /> Créer</button>
      </template>
    </ModalBox>
  </div>
</template>

<style scoped>
.work {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
p {
  margin: 0;
  line-height: 1.5;
}
.tabs {
  flex-wrap: wrap;
  gap: 6px;
}
.count {
  opacity: 0.7;
  margin-left: 4px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius);
  border: 1px solid var(--hairline);
  background: var(--bg-elevated);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.item:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--hairline));
}
.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.facts {
  flex-wrap: wrap;
  gap: 6px;
}
.desc,
.note pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font: inherit;
  line-height: 1.5;
}
.desc {
  padding: 10px;
  border-radius: var(--radius);
  background: var(--bg-elevated);
  border: 1px solid var(--hairline);
}
.notes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 260px;
  overflow: auto;
}
.note {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 8px;
  border-left: 2px solid var(--hairline);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.warn-text {
  color: var(--warning);
}
</style>
