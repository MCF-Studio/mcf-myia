<script setup lang="ts">
import { AlertTriangle, MessageSquarePlus, Network, Plus, RotateCcw, Save, Trash2 } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import TeamNodeView from "../components/TeamNodeView.vue";
import { call } from "../lib/rpc";
import { createConversation, refreshOverview, refreshTeams, state, toast } from "../lib/store";
import type { Team, TeamNode } from "../lib/types";

const selectedId = ref<string>();
const draft = ref<Team>();
const dirty = ref(false);
const isNew = ref(false);
const armed = ref(false);

function count(n: TeamNode): number {
  return 1 + n.subagents.reduce((s, c) => s + count(c), 0) + n.teammates.reduce((s, c) => s + count(c), 0);
}
function maxDepthOf(n: TeamNode, d = 0): number {
  return Math.max(d, ...n.subagents.map((c) => maxDepthOf(c, d + 1)), ...n.teammates.map((c) => maxDepthOf(c, d + 1)));
}
const models = (n: TeamNode, acc = new Set<string>()): Set<string> => {
  const a = state.agents.find((x) => x.id === n.agentId);
  acc.add(a?.model ?? state.overview?.defaultModel ?? "?");
  n.subagents.forEach((c) => models(c, acc));
  n.teammates.forEach((c) => models(c, acc));
  return acc;
};

const stats = computed(() => {
  if (!draft.value) return undefined;
  const nodes = count(draft.value.root);
  return {
    nodes,
    depth: maxDepthOf(draft.value.root),
    models: models(draft.value.root).size,
    worst: Math.min(draft.value.maxCalls, Math.max(0, nodes - 1)),
  };
});

/** Niveau de risque de coût, pour colorer l'avertissement. */
const risk = computed(() => {
  const s = stats.value;
  if (!s || !draft.value) return "low";
  if (s.nodes > 10 || draft.value.maxCalls > 15 || s.models > 2) return "high";
  if (s.nodes > 5 || draft.value.maxCalls > 8 || s.models > 1) return "mid";
  return "low";
});

function select(t?: Team) {
  armed.value = false;
  isNew.value = !t;
  selectedId.value = t?.id;
  draft.value = t
    ? structuredClone(JSON.parse(JSON.stringify(t)))
    : {
        id: "",
        name: "Nouvelle équipe",
        root: { id: crypto.randomUUID().slice(0, 8), agentId: state.agents[0]?.id ?? "myia", subagents: [], teammates: [] },
        maxCalls: 8,
        maxDepth: 3,
      };
  dirty.value = isNew.value;
}

watch(draft, () => (dirty.value = true), { deep: true, flush: "sync" });

function slug(s: string) {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "equipe"
  );
}

async function save() {
  const t = draft.value;
  if (!t) return;
  if (isNew.value) {
    let id = slug(t.name);
    for (let i = 2; state.teams.some((x) => x.id === id); i++) id = `${slug(t.name).slice(0, 36)}-${i}`;
    t.id = id;
  }
  try {
    await call("teams.save", JSON.parse(JSON.stringify(t)));
    await Promise.all([refreshTeams(), refreshOverview()]);
    isNew.value = false;
    selectedId.value = t.id;
    dirty.value = false;
    toast(`Équipe « ${t.name} » enregistrée`, "success");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function remove() {
  if (!draft.value) return;
  if (!armed.value) {
    armed.value = true;
    return;
  }
  try {
    await call("teams.delete", { id: draft.value.id });
    await refreshTeams();
    select(state.teams[0]);
    dirty.value = false;
    toast("Équipe supprimée");
  } catch (e) {
    toast((e as Error).message, "error");
    armed.value = false;
  }
}

async function talk() {
  if (!draft.value) return;
  if (dirty.value) await save();
  if (dirty.value) return;
  await createConversation(draft.value.root.agentId, draft.value.id).catch((e) => toast(e.message, "error"));
}

watch(
  () => state.teams,
  (teams) => {
    if (!draft.value) select(teams[0]);
  },
  { immediate: true },
);
</script>

<template>
  <div class="page teams">
    <div class="warn-banner" :class="risk">
      <AlertTriangle :size="20" />
      <div>
        <strong>Fonctionnalité très cool… mais potentiellement très coûteuse.</strong>
        <p>
          Chaque délégation fait réfléchir un agent de plus. Trop d'agents, des boucles de délégation mal pensées ou des modèles différents
          (qui se relaient en VRAM) peuvent rendre une réponse très lente et faire chauffer la machine. Si des agents délèguent à Claude Code
          ou tournent sur Claude, ça consomme ton quota Claude ; un agent sur l'API Claude est facturé à chaque réponse sur ta clé d'API. Garde des équipes petites, un rôle clair par agent, et un budget d'appels serré.
        </p>
      </div>
    </div>

    <div class="layout">
      <aside class="team-list">
        <h2>Équipes</h2>
        <button v-for="t in state.teams" :key="t.id" class="team-item" :class="{ active: selectedId === t.id && !isNew }" @click="select(t)">
          <Network :size="18" />
          <div>
            <strong>{{ t.name }}</strong>
            <span class="tiny muted">{{ count(t.root) }} agent{{ count(t.root) > 1 ? "s" : "" }} · {{ t.maxCalls }} appels max</span>
          </div>
        </button>
        <span v-if="!state.teams.length && !isNew" class="small muted">Aucune équipe : un chef, des sous-agents en dessous, des coéquipiers à côté.</span>
        <button class="btn primary sm" @click="select()"><Plus :size="15" /> Nouvelle équipe</button>
      </aside>

      <section v-if="draft" class="editor">
        <div class="card editor-head">
          <div class="head-fields">
            <input v-model="draft.name" class="input title" maxlength="60" placeholder="Nom de l'équipe" />
            <input v-model="draft.description" class="input" maxlength="300" placeholder="À quoi sert cette équipe ? (optionnel)" />
          </div>
          <div class="budgets">
            <label>
              <span class="small">Appels max par message <strong>{{ draft.maxCalls }}</strong></span>
              <input v-model.number="draft.maxCalls" type="range" min="1" max="30" :style="{ '--fill': `${((draft.maxCalls - 1) / 29) * 100}%` }" />
            </label>
            <label>
              <span class="small">Profondeur max <strong>{{ draft.maxDepth }}</strong></span>
              <input v-model.number="draft.maxDepth" type="range" min="1" max="6" :style="{ '--fill': `${((draft.maxDepth - 1) / 5) * 100}%` }" />
            </label>
            <div class="head-stats">
            <span class="badge">{{ stats?.nodes }} agent{{ (stats?.nodes ?? 0) > 1 ? "s" : "" }}</span>
            <span class="badge">profondeur {{ stats?.depth }}</span>
            <span class="badge" :class="{ warn: (stats?.models ?? 0) > 1 }">{{ stats?.models }} modèle{{ (stats?.models ?? 0) > 1 ? "s" : "" }}</span>
            <span class="badge" :class="risk === 'high' ? 'warn' : risk === 'mid' ? 'accent' : 'ok'">
              jusqu'à {{ stats?.worst }} appel{{ (stats?.worst ?? 0) > 1 ? "s" : "" }} d'agents par message
            </span>
            </div>
          </div>
          <div class="row head-actions">
            <button v-if="!isNew" class="btn danger" :class="{ armed }" @click="remove">
              <Trash2 :size="15" /> {{ armed ? "Confirmer" : "Supprimer" }}
            </button>
            <button v-if="!isNew && dirty" class="btn ghost" @click="select(state.teams.find((t) => t.id === selectedId))"><RotateCcw :size="15" /> Annuler</button>
            <span class="spacer" />
            <button class="btn" :disabled="!draft.name.trim()" @click="talk"><MessageSquarePlus :size="15" /> Discuter avec l'équipe</button>
            <button class="btn primary" :disabled="!dirty || !draft.name.trim()" @click="save"><Save :size="15" /> Enregistrer</button>
          </div>
        </div>

        <div class="canvas card">
          <div class="legend tiny muted">
            <span><i class="l-sub" /> sous-agent : reçoit une tâche déléguée</span>
            <span><i class="l-peer" /> coéquipier : même niveau, vient en renfort avec ses propres agents</span>
          </div>
          <div class="tree">
            <TeamNodeView :node="draft.root" root :depth="0" />
          </div>
        </div>

        <p class="tiny muted note">
          <Network :size="14" /> Un agent n'appelle que ses sous-agents et coéquipiers directs, jamais un agent déjà
          sollicité pour la même demande (pas de boucle). Les actions sensibles demandent toujours ta confirmation, quel que soit l'agent.
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.teams {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
}
.warn-banner {
  display: flex;
  gap: 14px;
  padding: 14px 18px;
  border-radius: var(--radius-lg);
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  background: linear-gradient(90deg, color-mix(in srgb, var(--warning) 12%, var(--surface)), var(--surface));
  color: var(--warning);
}
.warn-banner.high {
  border-color: color-mix(in srgb, var(--danger) 55%, transparent);
  background: linear-gradient(90deg, color-mix(in srgb, var(--danger) 13%, var(--surface)), var(--surface));
  color: var(--danger);
}
.warn-banner svg {
  flex: none;
  margin-top: 2px;
}
.warn-banner strong {
  color: var(--text);
}
.warn-banner p {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 0.85rem;
  line-height: 1.5;
}
.layout {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
  min-height: 0;
}
.team-list {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.team-list h2 {
  font-size: 1.15rem;
  margin-right: 8px;
}
.team-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px 6px 10px;
  border-radius: 99px;
  border: 1px solid var(--hairline);
  background: var(--surface);
  cursor: pointer;
  text-align: left;
}
.team-item svg {
  color: var(--accent);
}
.team-item div {
  display: flex;
  flex-direction: column;
}
.team-item:hover {
  background: var(--surface);
}
.team-item.active {
  background: var(--surface);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}
.editor {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
  min-width: 0;
}
.editor-head {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.head-fields {
  display: grid;
  grid-template-columns: minmax(200px, 1fr) 2fr;
  gap: 10px;
}
.editor-head {
  padding: 16px var(--pad);
}
.title {
  font-weight: 650;
}
.budgets {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  align-items: end;
  gap: 24px;
}
.budgets label {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.budgets strong {
  color: var(--accent);
  margin-left: 4px;
}
.head-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 340px;
  justify-content: flex-end;
}
.armed {
  border-color: var(--danger);
  color: var(--danger);
}
.canvas {
  overflow: auto;
  min-height: 420px;
  background:
    radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--text-muted) 18%, transparent) 1px, transparent 0) 0 0 / 22px 22px,
    var(--bg-elevated);
}
.legend {
  display: flex;
  gap: 20px;
  margin-bottom: 18px;
}
.legend span {
  display: flex;
  align-items: center;
  gap: 8px;
}
.legend i {
  display: inline-block;
  width: 22px;
}
.l-sub {
  border-top: 2px solid var(--accent);
}
.l-peer {
  border-top: 2px dashed var(--accent-2);
}
.tree {
  display: inline-flex;
  padding: 6px 6px 20px;
  min-width: 100%;
}
.note {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
