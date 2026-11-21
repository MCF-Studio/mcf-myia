<script setup lang="ts">
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Bot, Camera, ChevronDown, ChevronUp, Crown, Copy, Download, FolderOpen, LayoutGrid, List, MessageSquarePlus, Network, Plus, RefreshCw, Save, ShieldCheck, Trash2, Upload, X } from "lucide-vue-next";
import { computed, onMounted, reactive, ref, watch } from "vue";
import AgentAvatar from "../components/AgentAvatar.vue";
import AgentTopology from "../components/AgentTopology.vue";
import { useAgentStatus } from "../lib/agentStatus";
import { settings } from "../lib/settings";
import { agentsGraph } from "../lib/topology";
import Toggle from "../components/Toggle.vue";
import { downloadText, pickAvatar, pickTextFile } from "../lib/files";
import { agentColor } from "../lib/format";
import { call } from "../lib/rpc";
import { moveId, useSortable } from "../lib/reorder";
import { createConversation, refreshAgents, refreshOverview, state, toast } from "../lib/store";
import { apiProviders, claudeApi, claudeModels, loadApiProviders, loadClaudeApi, loadClaudeModels } from "../lib/terminals";
import type { AgentProfile, ModelInfo } from "../lib/types";

const SWATCHES = ["#ff7a1a", "#e0a412", "#ff5247", "#f2c14e", "#45c98a", "#4cc9f0", "#8b7bff", "#ff6fae"];

const services = ref<{ id: string; label: string }[]>([]);
const models = ref<ModelInfo[]>([]);
const selected = ref<string>();
const isNew = ref(false);
const confirmDelete = ref(false);

const form = reactive({
  id: "",
  name: "",
  description: "",
  model: "",
  color: "",
  avatar: "",
  instructions: "",
  restrict: false,
  services: [] as string[],
  master: false,
  workspace: "",
});

async function chooseWorkspace() {
  const dir = await openDialog({ directory: true, multiple: false, title: "Dossier dans lequel cet agent travaille" });
  if (typeof dir === "string") form.workspace = dir;
}

/** Autre agent déjà MASTER (il perdra ce rôle si celui-ci le prend). */
const masterOther = computed(() => state.agents.find((a) => a.master && a.id !== form.id)?.name);

const usage = computed(() => new Map((state.overview?.agents ?? []).map((a) => [a.id, a])));

// ─── Affichage : liste, grille ou carte ──────────────────────────────────────
const MODES = [
  { id: "list", label: "Liste", icon: List },
  { id: "grid", label: "Grille", icon: LayoutGrid },
  { id: "map", label: "Carte", icon: Network },
] as const;
const mode = computed(() => (["list", "grid", "map"].includes(settings.appearance.agentsLayout) ? settings.appearance.agentsLayout : "list"));
const statusOf = useAgentStatus();
const graph = computed(() => agentsGraph(state.agents, state.teams, statusOf.value));
const editorEl = ref<HTMLFormElement>();
/** En grille et en carte, l'éditeur est sous la vue d'ensemble : on y descend quand on choisit un agent. */
function pick(a?: AgentProfile) {
  load(a);
  if (mode.value !== "list") requestAnimationFrame(() => editorEl.value?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function slug(s: string) {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agent"
  );
}

function load(a?: AgentProfile) {
  confirmDelete.value = false;
  isNew.value = !a;
  selected.value = a?.id;
  form.id = a?.id ?? "";
  form.name = a?.name ?? "";
  form.description = a?.description ?? "";
  form.model = a?.model ?? "";
  form.color = a?.color ?? "";
  form.avatar = a?.avatar ?? "";
  form.instructions = a?.instructions ?? "";
  form.restrict = !!a?.services;
  form.master = !!a?.master;
  form.workspace = a?.workspace ?? "";
  form.services = a?.services ? [...a.services] : services.value.map((s) => s.id);
}

watch(
  () => form.name,
  (n) => {
    if (isNew.value) form.id = slug(n);
  },
);

function toProfile(): AgentProfile {
  const p: AgentProfile = { id: form.id, name: form.name.trim() };
  if (form.description.trim()) p.description = form.description.trim();
  if (form.model) p.model = form.model;
  if (form.color) p.color = form.color;
  if (form.avatar) p.avatar = form.avatar;
  if (form.instructions.trim()) p.instructions = form.instructions.trim();
  if (form.restrict) p.services = [...form.services];
  if (form.master) p.master = true;
  if (form.workspace) p.workspace = form.workspace;
  return p;
}

// ─── Autres IA (OpenAI, Gemini, Mistral…) : « <fournisseur>-api:<modèle> » ───────────────────────────
/** Fournisseur du modèle choisi (« mistral-api:… » → mistral), sinon undefined. */
const providerOf = (model: string) => apiProviders.value.find((p) => model.startsWith(`${p.id}-api:`));
const currentProvider = computed(() => providerOf(form.model));
/** Partie « modèle » de « <fournisseur>-api:<modèle> », éditable à part. */
const providerModelId = computed({
  get: () => (currentProvider.value ? form.model.slice(currentProvider.value.id.length + 5) : ""),
  set: (v: string) => {
    if (currentProvider.value) form.model = `${currentProvider.value.id}-api:${v.trim()}`;
  },
});
const providerModels = ref<string[]>([]);
const providerModelsBusy = ref(false);
/** Erreur du dernier chargement, affichée sous la liste (une notification passe trop vite). */
const providerModelsError = ref("");
/** Saisie libre d'un identifiant (modèle absent de la liste, ou liste indisponible). */
const providerManual = ref(false);
let loadedFor = "";
async function loadProviderModels(id: string, force = false) {
  if (!force && loadedFor === id && providerModels.value.length) return;
  loadedFor = id;
  providerModels.value = [];
  providerModelsError.value = "";
  providerModelsBusy.value = true;
  try {
    // État des clés relu : une clé a pu être ajoutée dans Paramètres depuis l'ouverture de l'app.
    await loadApiProviders();
    if (!apiProviders.value.find((p) => p.id === id)?.configured) {
      providerModelsError.value = "Aucune clé enregistrée pour ce fournisseur : Paramètres → Général → Autres IA.";
      return;
    }
    providerModels.value = await call<string[]>("apiProviders.models", { provider: id }, 30_000);
    if (!providerModels.value.length) providerModelsError.value = "Le fournisseur n'a renvoyé aucun modèle de conversation pour cette clé.";
  } catch (e) {
    providerModelsError.value = (e as Error).message;
  } finally {
    providerModelsBusy.value = false;
    // Modèle déjà choisi mais absent de la liste : on le garde, en saisie libre.
    providerManual.value = !!providerModelId.value && !providerModels.value.includes(providerModelId.value);
  }
}
watch(
  () => currentProvider.value?.id,
  (id) => void (id ? loadProviderModels(id) : (providerModels.value = [])),
  { immediate: true },
);

async function save() {
  if (currentProvider.value && !providerModelId.value) {
    toast(`Choisis un modèle ${currentProvider.value.label} (liste sous le champ Modèle)`, "error");
    return;
  }
  if (isNew.value && state.agents.some((a) => a.id === form.id)) {
    toast(`L'id « ${form.id} » existe déjà`, "error");
    return;
  }
  try {
    await call("agents.save", toProfile());
    await Promise.all([refreshAgents(), refreshOverview()]);
    isNew.value = false;
    selected.value = form.id;
    toast(`${form.name} enregistré`, "success");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function remove() {
  if (!confirmDelete.value) {
    confirmDelete.value = true;
    return;
  }
  try {
    await call("agents.delete", { id: form.id });
    await refreshAgents();
    load(state.agents[0]);
    toast("Agent supprimé");
  } catch (e) {
    toast((e as Error).message, "error");
    confirmDelete.value = false;
  }
}

async function importFile() {
  try {
    const json = await pickTextFile();
    if (!json) return;
    const p = await call<AgentProfile>("agents.import", { json });
    await refreshAgents();
    load(state.agents.find((a) => a.id === p.id));
    toast(`${p.name} importé — vérifie ses consignes et ses services`, "success");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

function exportJson() {
  // L'espace de travail est un chemin de CETTE machine : il ne part pas dans un profil partagé.
  const { workspace: _w, ...shared } = toProfile();
  return JSON.stringify({ $schema: "myia/agent@1", ...shared }, null, 2);
}

async function exportAgentFile() {
  try {
    const saved = await downloadText(`${form.id}.agent.json`, exportJson());
    if (saved) toast(`Agent exporté : ${saved}`, "success");
  } catch (e) {
    toast((e as Error).message ?? String(e), "error");
  }
}

async function choosePhoto() {
  try {
    const data = await pickAvatar();
    if (data) form.avatar = data;
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function copyJson() {
  await navigator.clipboard.writeText(exportJson());
  toast("JSON copié", "success");
}

onMounted(async () => {
  void loadClaudeModels();
  void loadClaudeApi();
  void loadApiProviders();
  const [svc, mod] = await Promise.all([
    call<{ id: string; label: string }[]>("services.list").catch(() => []),
    call<{ installed: ModelInfo[] }>("models.list").catch(() => ({ installed: [] })),
  ]);
  services.value = svc;
  models.value = mod.installed;
  load(state.agents.find((a) => a.id === selected.value) ?? state.agents[0]);
});

/** Monte (-1) ou descend (+1) un agent dans la liste ; l'ordre est enregistré par le cœur et vaut pour toute l'app. */
let moving = false;
async function move(id: string, dir: -1 | 1) {
  const list = [...state.agents];
  const i = list.findIndex((a) => a.id === id);
  const j = i + dir;
  if (moving || i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
  await saveOrder(list);
}

/** Glisser-déposer d'un agent (liste et grille) : même enregistrement que les flèches. */
const sortable = useSortable({
  group: "agents",
  axis: () => (mode.value === "grid" ? "x" : "y"),
  onReorder: (dragged, target, after) => {
    const ids = moveId(
      state.agents.map((a) => a.id),
      dragged,
      target,
      after,
    );
    const byId = new Map(state.agents.map((a) => [a.id, a]));
    void saveOrder(ids.map((id) => byId.get(id)!));
  },
});

async function saveOrder(list: AgentProfile[]) {
  if (moving || list.every((a, k) => a.id === state.agents[k]?.id)) return;
  const before = state.agents;
  state.agents = list;
  moving = true;
  try {
    await call("agents.reorder", { ids: list.map((a) => a.id) });
  } catch (e) {
    state.agents = before;
    toast((e as Error).message, "error");
    await refreshAgents();
  } finally {
    moving = false;
  }
}
</script>

<template>
  <div class="page agents-page">
    <header class="page-head">
      <div>
        <div class="eyebrow">Agents</div>
        <h1>Personnalités</h1>
        <p>Chaque agent a son nom, son modèle, son ton et les services qu'il a le droit d'utiliser.</p>
      </div>
      <div class="row">
        <div class="segmented" role="group" aria-label="Affichage des agents">
          <button v-for="m in MODES" :key="m.id" :class="{ on: mode === m.id }" :aria-pressed="mode === m.id" :title="m.label" @click="settings.appearance.agentsLayout = m.id">
            <component :is="m.icon" :size="15" /> {{ m.label }}
          </button>
        </div>
        <button class="btn" @click="importFile"><Upload :size="16" /> Importer</button>
        <button class="btn primary" @click="pick()"><Plus :size="16" /> Nouvel agent</button>
      </div>
    </header>

    <div class="layout" :class="`mode-${mode}`">
      <AgentTopology v-if="mode === 'map'" :graph="graph" :selected="isNew ? undefined : selected" :height="460" @select="(id) => pick(state.agents.find((a) => a.id === id))" />
      <div v-else class="agent-cards">
        <TransitionGroup name="reorder" tag="div" class="agent-list" :data-axis="mode === 'grid' ? 'x' : 'y'">
          <div
            v-for="(a, i) in state.agents"
            :key="a.id"
            class="agent-row"
            :class="sortable.classes(a.id)"
            :title="state.agents.length > 1 ? 'Glisse pour changer l\'ordre' : undefined"
            v-bind="state.agents.length > 1 ? sortable.item(a.id) : {}"
          >
            <button
              class="agent-card card"
              :class="{ active: selected === a.id && !isNew }"
              :style="{ '--c': agentColor(a) }"
              @click="pick(a)"
            >
              <AgentAvatar :agent="a" :size="mode === 'grid' ? 64 : 42" :busy="(usage.get(a.id)?.busy ?? 0) > 0" />
              <div class="agent-card-meta">
                <strong>{{ a.name }}</strong>
                <span class="mono tiny muted">{{ a.model ?? `${state.overview?.defaultModel ?? ""} (défaut)` }}</span>
                <span class="tiny muted">{{ usage.get(a.id)?.conversations ?? 0 }} conversation(s)</span>
              </div>
            </button>
            <div v-if="state.agents.length > 1 && mode === 'list'" class="order">
              <button type="button" :disabled="i === 0" :title="`Monter ${a.name}`" :aria-label="`Monter ${a.name}`" @click="move(a.id, -1)">
                <ChevronUp :size="15" />
              </button>
              <button
                type="button"
                :disabled="i === state.agents.length - 1"
                :title="`Descendre ${a.name}`"
                :aria-label="`Descendre ${a.name}`"
                @click="move(a.id, 1)"
              >
                <ChevronDown :size="15" />
              </button>
            </div>
          </div>
        </TransitionGroup>
        <button v-if="isNew" class="agent-card card active new">
          <div class="new-glyph"><Plus :size="20" /></div>
          <div class="agent-card-meta"><strong>{{ form.name || "Nouvel agent" }}</strong></div>
        </button>
      </div>

      <form ref="editorEl" class="card editor" @submit.prevent="save">
        <div class="editor-head">
          <div class="avatar-edit">
            <AgentAvatar
              :agent="{ id: form.id || 'x', name: form.name || '?', color: form.color || undefined, avatar: form.avatar || undefined }"
              :size="64"
            />
            <button type="button" class="avatar-btn" :title="form.avatar ? 'Changer la photo' : 'Ajouter une photo'" @click="choosePhoto">
              <Camera :size="14" />
            </button>
            <button v-if="form.avatar" type="button" class="avatar-del" title="Retirer la photo" @click="form.avatar = ''">
              <X :size="12" />
            </button>
          </div>
          <div>
            <h2>{{ form.name || "Nouvel agent" }}</h2>
            <span class="mono tiny muted">id : {{ form.id || "—" }}</span>
          </div>
          <span class="spacer" />
          <button v-if="!isNew" type="button" class="btn" @click="createConversation(form.id)"><MessageSquarePlus :size="16" /> Discuter</button>
        </div>

        <div class="fields">
          <label class="field">
            <span>Nom</span>
            <input v-model="form.name" class="input" maxlength="40" required placeholder="Ex. Forgeron, Rédac', Veilleur…" />
          </label>
          <label class="field">
            <span>Modèle</span>
            <select v-model="form.model" class="input select">
              <option value="">Modèle par défaut ({{ state.overview?.defaultModel }})</option>
              <optgroup label="Local (rien ne quitte ta machine)">
                <option v-for="m in models" :key="m.name" :value="m.name">{{ m.name }}{{ m.parameterSize ? ` · ${m.parameterSize}` : "" }}</option>
              </optgroup>
              <optgroup label="Claude (ton abonnement, en ligne)">
                <option v-for="m in claudeModels" :key="m.id" :value="`claude:${m.id}`">Claude {{ m.label }} · {{ m.hint }}</option>
              </optgroup>
              <optgroup label="Claude par clé d'API (facturé à l'usage, en ligne)">
                <option v-for="m in claudeApi.models" :key="m.id" :value="`claude-api:${m.id}`">
                  API Claude {{ m.label }} · {{ m.hint }}{{ claudeApi.configured ? "" : " — clé manquante" }}
                </option>
              </optgroup>
              <optgroup label="Autres IA par clé d'API (facturé à l'usage, en ligne)">
                <option
                  v-for="p in apiProviders"
                  :key="p.id"
                  :value="currentProvider?.id === p.id ? form.model : `${p.id}-api:`"
                >
                  {{ p.label }}{{ currentProvider?.id === p.id && providerModelId ? ` · ${providerModelId}` : " · choisir le modèle…" }}{{ p.configured ? "" : " — clé manquante" }}
                </option>
              </optgroup>
            </select>
            <template v-if="currentProvider">
              <div class="provider-pick">
                <select
                  v-if="!providerManual"
                  class="input select"
                  :value="providerModelId"
                  :disabled="providerModelsBusy"
                  @change="
                    (e) => {
                      const v = (e.target as HTMLSelectElement).value;
                      if (v === '__autre') providerManual = true;
                      else providerModelId = v;
                    }
                  "
                >
                  <option value="" disabled>{{ providerModelsBusy ? "Chargement des modèles…" : providerModels.length ? `Choisis un modèle ${currentProvider.label}` : "Aucun modèle chargé" }}</option>
                  <option v-for="m in providerModels" :key="m" :value="m">{{ m }}</option>
                  <option value="__autre">Autre modèle (taper son identifiant)…</option>
                </select>
                <input
                  v-else
                  v-model.lazy="providerModelId"
                  class="input"
                  maxlength="120"
                  spellcheck="false"
                  :placeholder="`Identifiant du modèle ${currentProvider.label}`"
                />
                <button
                  type="button"
                  class="btn sm ghost icon"
                  :title="providerManual ? 'Revenir à la liste' : 'Recharger la liste des modèles'"
                  :disabled="providerModelsBusy"
                  @click="providerManual ? (providerManual = false) : loadProviderModels(currentProvider.id, true)"
                >
                  <RefreshCw :size="14" :class="{ spin: providerModelsBusy }" />
                </button>
              </div>
              <em v-if="providerModelsError" class="tiny warn-text">{{ providerModelsError }}</em>
              <em class="tiny muted">
                Cet agent réfléchit avec {{ currentProvider.label }}, payé avec ta clé d'API (facturé à l'usage chez le fournisseur) : ses
                conversations et les résultats de ses outils partent chez lui. Les outils restent ceux de MyIA, avec les mêmes confirmations. Il
                n'a pas accès à ta mémoire et ne peut pas être proposé à la Guilde.
                <strong v-if="!currentProvider.configured">Aucune clé enregistrée : ajoute-la dans Paramètres → Autres IA.</strong>
              </em>
            </template>
            <em v-if="form.model.startsWith('claude-api:')" class="tiny muted">
              Cet agent réfléchit avec l'API Claude, payée avec ta clé d'API (chaque réponse est facturée sur ton compte Anthropic) : ses
              conversations et les résultats de ses outils partent chez Anthropic. Les outils restent ceux de MyIA, avec les mêmes confirmations. Il
              n'a pas accès à ta mémoire et ne peut pas être proposé à la Guilde. Il fonctionne aussi comme membre d'une équipe.
              <strong v-if="!claudeApi.configured">Aucune clé enregistrée : ajoute-la dans Paramètres → Clé d'API Claude.</strong>
            </em>
            <em v-if="form.model.startsWith('claude:')" class="tiny muted">
              Cet agent réfléchit avec Claude : ses conversations et les résultats de ses outils partent chez Anthropic et comptent dans ton
              abonnement. Les outils restent ceux de MyIA, avec les mêmes confirmations. Il n'a pas accès à ta mémoire, qui ne quitte jamais le PC.
            </em>
          </label>
          <label class="field wide">
            <span>Description <em class="muted">(affichée dans l'app)</em></span>
            <input v-model="form.description" class="input" maxlength="300" placeholder="À quoi sert cet agent ?" />
          </label>
          <div class="field wide">
            <span>Couleur</span>
            <div class="swatches">
              <button type="button" class="swatch auto" :class="{ on: !form.color }" title="Automatique" @click="form.color = ''">A</button>
              <button
                v-for="c in SWATCHES"
                :key="c"
                type="button"
                class="swatch"
                :class="{ on: form.color === c }"
                :style="{ background: c }"
                @click="form.color = c"
              />
            </div>
          </div>
          <label class="field wide">
            <span>Consignes <em class="muted">(ton, rôle, spécialité — ajoutées au prompt, sans pouvoir lever les règles de sécurité)</em></span>
            <textarea
              v-model="form.instructions"
              class="input"
              rows="6"
              maxlength="4000"
              placeholder="Ex. Tu es spécialisé dans les annonces Discord du studio. Ton enthousiaste, phrases courtes, emojis avec parcimonie."
            />
            <small class="tiny muted counter">{{ form.instructions.length }} / 4000</small>
          </label>

          <div class="field wide">
            <span><FolderOpen :size="15" /> Espace de travail <em class="muted">(optionnel)</em></span>
            <div class="row">
              <input class="input grow mono" :value="form.workspace" readonly placeholder="Aucun : dossier workspace de MyIA" :title="form.workspace" />
              <button type="button" class="btn" @click="chooseWorkspace"><FolderOpen :size="15" /> Choisir…</button>
              <button v-if="form.workspace" type="button" class="btn ghost" title="Retirer l'espace de travail" @click="form.workspace = ''"><X :size="15" /></button>
            </div>
            <p class="tiny muted">
              Le dossier dans lequel cet agent travaille, sur n'importe quel disque : il peut y lire, chercher et écrire des fichiers (un
              simple nom de fichier s'y enregistre), et c'est là que Claude Code est lancé quand il lui délègue une tâche. Les
              confirmations avant d'écrire ou de déléguer restent les mêmes. Dans une équipe qui a son propre espace de travail, c'est
              celui de l'équipe qui compte.
            </p>
          </div>

          <div class="field wide">
            <div class="row">
              <span class="grow"><Crown :size="15" /> Agent MASTER</span>
              <Toggle v-model="form.master" label="Agent MASTER" />
            </div>
            <p class="tiny muted">
              Ton assistant principal : il pilote l'app (liste et crée des agents, ouvre des conversations, consulte la Guilde) et écrit aux
              autres agents quand une tâche relève de leur rôle ; tu vois leurs échanges dans les conversations. Créer ou supprimer un agent
              et publier sur la Guilde te sont toujours demandés. Il n'a accès à aucun réglage. Un seul MASTER à la fois.
              <strong v-if="form.master && masterOther">Il remplacera {{ masterOther }} comme MASTER.</strong>
            </p>
          </div>

          <div class="field wide">
            <div class="row">
              <span class="grow"><ShieldCheck :size="15" /> Restreindre les services</span>
              <Toggle v-model="form.restrict" label="Restreindre les services" />
            </div>
            <p class="tiny muted">
              Désactivé : l'agent voit tous les services disponibles. Activé : seulement ceux cochés. Les confirmations avant action
              s'appliquent dans tous les cas.
            </p>
            <div v-if="form.restrict" class="svc-grid">
              <label v-for="s in services" :key="s.id" class="svc" :class="{ on: form.services.includes(s.id) }">
                <input v-model="form.services" type="checkbox" :value="s.id" />
                <span>{{ s.label }}</span>
              </label>
            </div>
          </div>
        </div>

        <div class="editor-foot">
          <button v-if="!isNew" type="button" class="btn danger" :class="{ armed: confirmDelete }" @click="remove">
            <Trash2 :size="15" /> {{ confirmDelete ? "Confirmer la suppression" : "Supprimer" }}
          </button>
          <span class="spacer" />
          <button type="button" class="btn ghost" title="Copier le JSON pour le partager" @click="copyJson">
            <Copy :size="15" />
          </button>
          <button type="button" class="btn" :disabled="!form.id" @click="exportAgentFile"><Download :size="15" /> Exporter</button>
          <button type="submit" class="btn primary" :disabled="!form.name.trim() || (form.restrict && !form.services.length)">
            <Save :size="15" /> Enregistrer
          </button>
        </div>
      </form>
    </div>

    <p class="tiny muted note">
      <Bot :size="13" /> Les personnalités sont stockées sur ta machine (<span class="mono">config/agents.json</span>) et ne sont jamais publiées
      avec le code. Pour en partager une : Exporter, puis la proposer sur la Marketplace.
    </p>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: var(--gap);
  align-items: start;
}
.layout.mode-grid,
.layout.mode-map {
  grid-template-columns: 1fr;
}
.editor {
  scroll-margin-top: 16px;
}
.mode-grid .agent-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 10px;
}
.mode-grid .agent-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
}
.mode-grid .agent-cards > .agent-list {
  grid-column: 1 / -1;
}
.mode-grid .agent-card {
  flex-direction: column;
  text-align: center;
  padding: 18px 12px 14px;
  height: 100%;
}
.mode-grid .agent-row .agent-card {
  padding-right: 12px;
}
.mode-grid .agent-card-meta {
  align-items: center;
}
.segmented button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.agent-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agent-row {
  position: relative;
}
.agent-row .agent-card {
  width: 100%;
  padding-right: 40px;
}
.order {
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.agent-row:hover .order,
.agent-row:focus-within .order {
  opacity: 1;
}
.order button {
  display: grid;
  place-items: center;
  width: 24px;
  height: 20px;
  border-radius: 6px;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
}
.order button:hover:not(:disabled) {
  color: var(--text);
  background: var(--surface-2);
  border-color: var(--hairline);
}
.order button:disabled {
  opacity: 0.3;
  cursor: default;
}
.reorder-move {
  transition: transform 0.2s var(--ease);
}
.agent-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s;
}
.agent-card:hover {
  border-color: color-mix(in srgb, var(--c, var(--accent)) 45%, var(--hairline));
}
.agent-card.active {
  border-color: color-mix(in srgb, var(--c, var(--accent)) 70%, transparent);
  box-shadow: 0 0 30px -14px var(--c, var(--glow));
}
.agent-card-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.new-glyph {
  width: 42px;
  height: 42px;
  border-radius: 30%;
  border: 1px dashed var(--accent);
  color: var(--accent);
  display: grid;
  place-items: center;
}
.editor {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.editor-head {
  display: flex;
  align-items: center;
  gap: 14px;
}
.avatar-edit {
  position: relative;
  flex: none;
}
.avatar-btn,
.avatar-del {
  position: absolute;
  display: grid;
  place-items: center;
  border-radius: 50%;
  cursor: pointer;
  border: 2px solid var(--surface);
}
.avatar-btn {
  right: -6px;
  bottom: -6px;
  width: 28px;
  height: 28px;
  background: var(--lava);
  color: var(--accent-contrast);
  box-shadow: 0 4px 12px -4px var(--glow);
}
.avatar-del {
  right: -6px;
  top: -6px;
  width: 22px;
  height: 22px;
  background: var(--surface-2);
  color: var(--text-muted);
}
.avatar-del:hover {
  color: var(--danger);
}
.editor-head h2 {
  font-size: 1.3rem;
}
.fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  position: relative;
}
.field > span,
.field .grow {
  font-size: 0.85rem;
  font-weight: 550;
  display: flex;
  align-items: center;
  gap: 6px;
}
.field em {
  font-style: normal;
  font-weight: 400;
}
.field p {
  margin: 0;
}
.grow {
  flex: 1;
}
.wide {
  grid-column: span 2;
}
.counter {
  position: absolute;
  right: 10px;
  bottom: 8px;
}
.swatches {
  display: flex;
  gap: 8px;
}
.swatch {
  width: 28px;
  height: 28px;
  border-radius: 9px;
  border: 2px solid transparent;
  cursor: pointer;
  transition: transform 0.12s;
}
.swatch:hover {
  transform: scale(1.1);
}
.swatch.on {
  border-color: var(--text);
  box-shadow: 0 0 12px var(--glow);
}
.swatch.auto {
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 0.75rem;
  font-weight: 700;
}
.svc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
}
.svc {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline);
  background: var(--bg-elevated);
  cursor: pointer;
  font-size: 0.85rem;
}
.svc.on {
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
}
.svc input {
  accent-color: var(--accent);
}
.editor-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 16px;
  border-top: 1px solid var(--hairline);
}
.armed {
  border-color: var(--danger);
  color: var(--danger);
}
.note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 18px;
}
.provider-pick {
  display: flex;
  gap: 6px;
  align-items: center;
}
.provider-pick .input {
  flex: 1;
}
.warn-text {
  color: var(--warning);
}
</style>
