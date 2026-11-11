<script setup lang="ts">
import { Bot, Copy, Download, MessageSquarePlus, Plus, Save, ShieldCheck, Trash2, Upload } from "lucide-vue-next";
import { computed, onMounted, reactive, ref, watch } from "vue";
import AgentAvatar from "../components/AgentAvatar.vue";
import Toggle from "../components/Toggle.vue";
import { downloadText, pickTextFile } from "../lib/files";
import { agentColor } from "../lib/format";
import { call } from "../lib/rpc";
import { createConversation, refreshAgents, refreshOverview, state, toast } from "../lib/store";
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
  instructions: "",
  restrict: false,
  services: [] as string[],
});

const usage = computed(() => new Map((state.overview?.agents ?? []).map((a) => [a.id, a])));

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
  form.instructions = a?.instructions ?? "";
  form.restrict = !!a?.services;
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
  if (form.instructions.trim()) p.instructions = form.instructions.trim();
  if (form.restrict) p.services = [...form.services];
  return p;
}

async function save() {
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
  return JSON.stringify({ $schema: "myia/agent@1", ...toProfile() }, null, 2);
}

async function copyJson() {
  await navigator.clipboard.writeText(exportJson());
  toast("JSON copié", "success");
}

onMounted(async () => {
  const [svc, mod] = await Promise.all([
    call<{ id: string; label: string }[]>("services.list").catch(() => []),
    call<{ installed: ModelInfo[] }>("models.list").catch(() => ({ installed: [] })),
  ]);
  services.value = svc;
  models.value = mod.installed;
  load(state.agents.find((a) => a.id === selected.value) ?? state.agents[0]);
});
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
        <button class="btn" @click="importFile"><Upload :size="16" /> Importer</button>
        <button class="btn primary" @click="load()"><Plus :size="16" /> Nouvel agent</button>
      </div>
    </header>

    <div class="layout">
      <div class="agent-cards">
        <button
          v-for="a in state.agents"
          :key="a.id"
          class="agent-card card"
          :class="{ active: selected === a.id && !isNew }"
          :style="{ '--c': agentColor(a) }"
          @click="load(a)"
        >
          <AgentAvatar :agent="a" :size="42" :busy="(usage.get(a.id)?.busy ?? 0) > 0" />
          <div class="agent-card-meta">
            <strong>{{ a.name }}</strong>
            <span class="mono tiny muted">{{ a.model ?? `${state.overview?.defaultModel ?? ""} (défaut)` }}</span>
            <span class="tiny muted">{{ usage.get(a.id)?.conversations ?? 0 }} conversation(s)</span>
          </div>
        </button>
        <button v-if="isNew" class="agent-card card active new">
          <div class="new-glyph"><Plus :size="20" /></div>
          <div class="agent-card-meta"><strong>{{ form.name || "Nouvel agent" }}</strong></div>
        </button>
      </div>

      <form class="card editor" @submit.prevent="save">
        <div class="editor-head">
          <AgentAvatar :agent="{ id: form.id || 'x', name: form.name || '?', color: form.color || undefined }" :size="52" />
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
              <option v-for="m in models" :key="m.name" :value="m.name">{{ m.name }}{{ m.parameterSize ? ` · ${m.parameterSize}` : "" }}</option>
            </select>
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
          <button type="button" class="btn" :disabled="!form.id" @click="downloadText(`${form.id}.agent.json`, exportJson())"><Download :size="15" /> Exporter</button>
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
.agent-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
</style>
