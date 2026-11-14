<script setup lang="ts">
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Download, FileUp, FolderOpen, MessageSquarePlus, Network, Plus, RotateCcw, Save, Trash2, UploadCloud, X } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import PublishDialog from "../components/PublishDialog.vue";
import TeamNodeView from "../components/TeamNodeView.vue";
import TeamScripts from "../components/TeamScripts.vue";
import WorkflowPreviewDialog from "../components/WorkflowPreviewDialog.vue";
import { downloadText, pickTextFile } from "../lib/files";
import { call } from "../lib/rpc";
import { createConversation, refreshOverview, refreshTeams, state, toast } from "../lib/store";
import type { Team, TeamNode, WorkflowInstalled, WorkflowPreview } from "../lib/types";

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

async function chooseWorkspace() {
  const dir = await openDialog({ directory: true, multiple: false, title: "Dossier dans lequel cette équipe travaille" });
  if (typeof dir === "string" && draft.value) draft.value.workspace = dir;
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

// ─── workflow : l'équipe exportée, importée, publiée ─────────────────────────

const preview = ref<WorkflowPreview>();
const publishing = ref(false);
const scriptsPanel = ref<InstanceType<typeof TeamScripts>>();

/** Export et publication portent sur l'équipe ENREGISTRÉE : on enregistre d'abord ce qui est en cours. */
async function savedFirst(): Promise<boolean> {
  if (!draft.value) return false;
  if (dirty.value) await save();
  return !dirty.value;
}

async function exportTeam() {
  if (!(await savedFirst()) || !draft.value) return;
  try {
    const r = await call<{ filename: string; json: string; avatarsDropped: boolean; scripts: number }>("teams.export", { id: draft.value.id });
    downloadText(r.filename, r.json);
    toast(
      `Workflow exporté : ${r.filename}${r.scripts ? ` (avec ${r.scripts} script${r.scripts > 1 ? "s" : ""})` : ""}${r.avatarsDropped ? ", sans les photos des agents (trop lourdes)" : ""}`,
      "success",
    );
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function importWorkflow() {
  try {
    const json = await pickTextFile(".json", 512_000);
    if (!json) return;
    preview.value = await call<WorkflowPreview>("workflows.inspect", { json });
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

function installed(r: WorkflowInstalled) {
  preview.value = undefined;
  select(state.teams.find((t) => t.id === r.team.id));
  dirty.value = false;
  void scriptsPanel.value?.refresh();
}

async function publish() {
  if (await savedFirst()) publishing.value = true;
}

async function talk() {
  if (!draft.value) return;
  if (dirty.value) await save();
  if (dirty.value) return;
  await createConversation(draft.value.root.agentId, draft.value.id).catch((e) => toast(e.message, "error"));
}

/* Déplacement de la carte en la faisant glisser à la souris (le tactile défile déjà nativement).
   Ce que la carte ne peut pas absorber verticalement fait défiler la page, pour atteindre le bas d'un grand arbre. */
const canvas = ref<HTMLElement>();
let pan: { id: number; x: number; y: number; moved: boolean } | undefined;

function panStart(e: PointerEvent) {
  if (e.pointerType !== "mouse" || e.button !== 0) return;
  if ((e.target as HTMLElement).closest("button, select, input, a, label")) return;
  pan = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
}
function panMove(e: PointerEvent) {
  const el = canvas.value;
  if (!pan || !el || e.pointerId !== pan.id) return;
  const dx = e.clientX - pan.x;
  const dy = e.clientY - pan.y;
  if (!pan.moved) {
    if (Math.hypot(dx, dy) < 4) return;
    pan.moved = true;
    el.setPointerCapture(e.pointerId);
    el.classList.add("panning");
  }
  pan.x = e.clientX;
  pan.y = e.clientY;
  el.scrollLeft -= dx;
  const top = el.scrollTop;
  el.scrollTop -= dy;
  const rest = dy - (top - el.scrollTop);
  const page = el.closest<HTMLElement>(".page");
  if (rest && page) page.scrollTop -= rest;
}
function panEnd(e: PointerEvent) {
  if (!pan || e.pointerId !== pan.id) return;
  canvas.value?.classList.remove("panning");
  pan = undefined;
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
        <button class="btn sm" title="Installer une équipe reçue en fichier .workflow.json" @click="importWorkflow"><FileUp :size="15" /> Importer un workflow</button>
      </aside>

      <section v-if="draft" class="editor">
        <div class="card editor-head">
          <div class="head-fields">
            <input v-model="draft.name" class="input title" maxlength="60" placeholder="Nom de l'équipe" />
            <input v-model="draft.description" class="input" maxlength="300" placeholder="À quoi sert cette équipe ? (optionnel)" />
          </div>
          <div class="workspace">
            <div class="row">
              <span class="small ws-label"><FolderOpen :size="15" /> Espace de travail</span>
              <input class="input grow mono" :value="draft.workspace ?? ''" readonly placeholder="Aucun : chaque agent garde le sien" :title="draft.workspace" />
              <button type="button" class="btn" @click="chooseWorkspace"><FolderOpen :size="15" /> Choisir…</button>
              <button v-if="draft.workspace" type="button" class="btn ghost" title="Retirer l'espace de travail" @click="draft.workspace = undefined"><X :size="15" /></button>
            </div>
            <span class="tiny muted">
              Le dossier du projet de cette équipe, sur n'importe quel disque : tous ses membres y lisent, cherchent et écrivent, et
              Claude Code y est lancé quand ils délèguent. Les confirmations restent les mêmes.
            </span>
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
            <button class="btn" :disabled="!draft.name.trim()" title="Enregistrer l'équipe dans un fichier .workflow.json à partager" @click="exportTeam">
              <Download :size="15" /> Exporter en workflow
            </button>
            <button class="btn" :disabled="!draft.name.trim()" title="Publier sur le marketplace de mcfstudio.fr (privé ou public)" @click="publish">
              <UploadCloud :size="15" /> Publier
            </button>
            <span class="spacer" />
            <button class="btn" :disabled="!draft.name.trim()" @click="talk"><MessageSquarePlus :size="15" /> Discuter avec l'équipe</button>
            <button class="btn primary" :disabled="!dirty || !draft.name.trim()" @click="save"><Save :size="15" /> Enregistrer</button>
          </div>
        </div>

        <div
          ref="canvas"
          class="canvas card"
          @pointerdown="panStart"
          @pointermove="panMove"
          @pointerup="panEnd"
          @pointercancel="panEnd"
        >
          <div class="legend tiny muted">
            <span><i class="l-sub" /> sous-agent : reçoit une tâche déléguée</span>
            <span><i class="l-peer" /> coéquipier : même niveau, vient en renfort avec ses propres agents</span>
          </div>
          <div class="tree">
            <TeamNodeView :node="draft.root" root :depth="0" />
          </div>
        </div>

        <TeamScripts ref="scriptsPanel" v-model="draft.scripts" />

        <p class="tiny muted note">
          <Network :size="14" /> Un agent n'appelle que ses sous-agents et coéquipiers directs, jamais un agent déjà
          sollicité pour la même demande (pas de boucle). Les actions sensibles demandent toujours ta confirmation, quel que soit l'agent.
        </p>
      </section>
    </div>

    <WorkflowPreviewDialog v-if="preview" :preview="preview" @close="preview = undefined" @installed="installed" />
    <PublishDialog v-if="publishing && draft" :team="draft" @close="publishing = false" @published="publishing = false" />
  </div>
</template>

<style scoped>
.teams {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
}
/* .page a une hauteur fixe : sans ça, les blocs se tassent au lieu de faire défiler la page
   et le bas de l'organigramme déborde hors de la zone défilable. */
.teams > * {
  flex-shrink: 0;
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
.workspace {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.workspace .grow {
  flex: 1;
  min-width: 0;
}
.ws-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 550;
  white-space: nowrap;
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
.head-actions {
  flex-wrap: wrap;
}
.canvas {
  overflow: auto;
  overscroll-behavior-x: contain;
  min-height: min(420px, 60vh);
  /* reste dans la fenêtre : les deux barres de défilement de la carte restent atteignables */
  max-height: max(320px, calc(100vh - var(--titlebar-h, 0px) - 2 * var(--pad)));
  cursor: grab;
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
.canvas.panning {
  cursor: grabbing;
  user-select: none;
}
.canvas :is(button, select, input) {
  cursor: pointer;
}
.note {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Fenêtres étroites : les champs et budgets passent en colonne, les boutons reviennent à la ligne. */
@media (max-width: 900px) {
  .budgets {
    grid-template-columns: 1fr 1fr;
    gap: 16px 24px;
  }
  .head-stats {
    grid-column: 1 / -1;
    max-width: none;
    justify-content: flex-start;
  }
}
@media (max-width: 640px) {
  .warn-banner {
    padding: 12px 14px;
    gap: 10px;
  }
  .head-fields,
  .budgets {
    grid-template-columns: 1fr;
  }
  .workspace .row {
    flex-wrap: wrap;
  }
  .ws-label {
    flex-basis: 100%;
  }
  .head-actions .spacer {
    display: none;
  }
  .legend {
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
  }
  .canvas {
    padding: 12px;
  }
}
</style>
