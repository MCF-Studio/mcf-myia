<script setup lang="ts">
import { Boxes, Download, Flame, HardDrive, PowerOff, RefreshCw, Star, Store, Trash2, X } from "lucide-vue-next";
import { computed, onMounted, ref } from "vue";
import { bytes, relTime } from "../lib/format";
import { call } from "../lib/rpc";
import { navigate, refreshOverview, state, toast } from "../lib/store";
import type { ModelInfo, RunningModel } from "../lib/types";

const installed = ref<ModelInfo[]>([]);
const engine = ref<"ollama" | "llamacpp">("ollama");
/** Catalogue llama.cpp (GGUF officiels, empreintes vérifiées par le cœur). */
const catalog = ref<{ id: string; label: string; note: string; size: number; installed: boolean }[]>([]);
const isLlama = computed(() => engine.value === "llamacpp");
const running = ref<RunningModel[]>([]);
const defaultModel = ref("");
const loading = ref(false);
const pullName = ref("");
const armed = ref<string>();

/** Points de départ courants du registre Ollama (le nom exact se vérifie sur ollama.com/library). */
const SUGGESTIONS = [
  { name: "qwen3:4b", note: "rapide, ~2,5 Go" },
  { name: "qwen3:8b", note: "équilibré, ~5 Go" },
  { name: "qwen3:14b", note: "plus fin, ~9 Go" },
  { name: "gemma3:4b", note: "Google, ~3 Go" },
  { name: "llama3.2:3b", note: "Meta, ~2 Go" },
];

const totalSize = computed(() => installed.value.reduce((n, m) => n + m.size, 0));
const vram = computed(() => running.value.reduce((n, m) => n + m.sizeVram, 0));
const isRunning = (name: string) => running.value.some((r) => r.name === name);
const pulls = computed(() => Object.entries(state.pullProgress));

async function refresh() {
  loading.value = true;
  try {
    const r = await call<{ installed: ModelInfo[]; running: RunningModel[]; defaultModel: string; engine?: "ollama" | "llamacpp" }>("models.list");
    engine.value = r.engine ?? "ollama";
    if (engine.value === "llamacpp") {
      catalog.value = (await call<{ catalog: typeof catalog.value }>("llamacpp.status").catch(() => ({ catalog: [] }))).catalog;
    }
    installed.value = r.installed.sort((a, b) => a.name.localeCompare(b.name));
    running.value = r.running;
    defaultModel.value = r.defaultModel;
  } catch (e) {
    toast(`${engine.value === "llamacpp" ? "llama.cpp" : "Ollama"} : ${(e as Error).message}`, "error");
  } finally {
    loading.value = false;
  }
}

async function pull(name = pullName.value.trim()) {
  if (!name) return;
  pullName.value = "";
  state.pullProgress[name] = { status: "démarrage" };
  try {
    await call("models.pull", { name });
    await refresh();
  } catch (e) {
    delete state.pullProgress[name];
    const msg = (e as Error).message;
    if (!/abort|annul/i.test(msg)) toast(`${name} : ${msg}`, "error");
  }
}

async function act(method: string, name: string, okText: string) {
  try {
    await call(method, { name });
    toast(okText, "success");
    await Promise.all([refresh(), refreshOverview()]);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function remove(name: string) {
  if (armed.value !== name) {
    armed.value = name;
    setTimeout(() => armed.value === name && (armed.value = undefined), 3000);
    return;
  }
  armed.value = undefined;
  await act("models.delete", name, `${name} supprimé`);
}

function pct(p: { total?: number; completed?: number }) {
  return p.total ? Math.round(((p.completed ?? 0) / p.total) * 100) : 0;
}

onMounted(refresh);
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <div class="eyebrow">Modèles</div>
        <h1>Gestion des modèles</h1>
        <p>Modèles locaux servis par {{ isLlama ? "llama.cpp" : "Ollama" }} : rien ne quitte ta machine. Moteur : Paramètres → Système.</p>
      </div>
      <button class="btn" :disabled="loading" @click="refresh"><RefreshCw :size="15" :class="{ spin: loading }" /> Actualiser</button>
    </header>

    <section class="stats">
      <div class="card stat"><Boxes :size="20" /><div><strong>{{ installed.length }}</strong><span>installés</span></div></div>
      <div class="card stat"><HardDrive :size="20" /><div><strong>{{ bytes(totalSize) }}</strong><span>sur le disque</span></div></div>
      <div class="card stat"><Flame :size="20" /><div><strong>{{ bytes(vram) }}</strong><span>en VRAM ({{ running.length }} chargé{{ running.length > 1 ? "s" : "" }})</span></div></div>
      <div class="card stat"><Star :size="20" /><div><strong class="mono">{{ defaultModel || "—" }}</strong><span>par défaut</span></div></div>
    </section>

    <section class="card pull">
      <div class="card-head">
        <h3><Download :size="17" /> Télécharger un modèle</h3>
        <a v-if="isLlama" href="https://huggingface.co/models?library=gguf" class="small">Modèles GGUF sur Hugging Face ↗</a>
        <a v-else href="https://ollama.com/library" class="small">Catalogue Ollama ↗</a>
      </div>
      <form class="row" @submit.prevent="pull()">
        <input
          v-model="pullName"
          class="input mono"
          :placeholder="isLlama ? 'hf.co/organisation/dépôt/fichier.gguf' : 'nom:taille, ex. qwen3:14b'"
          spellcheck="false"
        />
        <button class="btn primary" :disabled="!pullName.trim()">Télécharger</button>
      </form>
      <p v-if="isLlama" class="tiny muted">
        Fichier vérifié avec l'empreinte publiée par Hugging Face. Choisis une quantification qui tient dans ta VRAM (Q4_K_M pour un
        8B avec 8 Go).
      </p>
      <div v-if="isLlama" class="chips">
        <button
          v-for="c in catalog"
          :key="c.id"
          class="chip"
          :title="c.note"
          :disabled="c.installed || installed.some((m) => m.name === c.id) || !!state.pullProgress[c.id]"
          @click="pull(c.id)"
        >
          <span class="mono">{{ c.label }}</span><span class="muted">{{ bytes(c.size) }} · {{ c.note }}</span>
        </button>
      </div>
      <div v-else class="chips">
        <button
          v-for="s in SUGGESTIONS"
          :key="s.name"
          class="chip"
          :disabled="installed.some((m) => m.name === s.name) || !!state.pullProgress[s.name]"
          @click="pull(s.name)"
        >
          <span class="mono">{{ s.name }}</span><span class="muted">{{ s.note }}</span>
        </button>
      </div>
      <div v-if="pulls.length" class="pulls">
        <div v-for="[name, p] in pulls" :key="name" class="pull-row">
          <div class="row small">
            <strong class="mono">{{ name }}</strong>
            <span class="muted">{{ p.status }}</span>
            <span class="spacer" />
            <span v-if="p.total" class="mono muted">{{ bytes(p.completed) }} / {{ bytes(p.total) }} · {{ pct(p) }} %</span>
            <button class="btn sm ghost icon" title="Annuler" @click="call('models.cancelPull', { name })"><X :size="14" /></button>
          </div>
          <div class="bar"><i :style="{ width: `${pct(p)}%` }" /></div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3><Boxes :size="17" /> Installés</h3></div>
      <table v-if="installed.length" class="table">
        <thead>
          <tr><th>Modèle</th><th>Famille</th><th>Taille</th><th>Quantif.</th><th>Mis à jour</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="m in installed" :key="m.name">
            <td>
              <div class="row">
                <strong class="mono">{{ m.name }}</strong>
                <span v-if="m.name === defaultModel" class="badge accent"><Star :size="11" /> défaut</span>
                <span v-if="isRunning(m.name)" class="badge ok"><span class="dot busy" /> chargé</span>
              </div>
            </td>
            <td class="muted">{{ m.family ?? "—" }} {{ m.parameterSize ? `· ${m.parameterSize}` : "" }}</td>
            <td class="mono">{{ bytes(m.size) }}</td>
            <td class="mono muted">{{ m.quantization ?? "—" }}</td>
            <td class="muted small">{{ relTime(m.modifiedAt) }}</td>
            <td>
              <div class="row actions">
                <button
                  v-if="m.name !== defaultModel"
                  class="btn sm"
                  title="Utilisé par les agents qui n'ont pas de modèle propre"
                  @click="act('models.setDefault', m.name, `${m.name} est le modèle par défaut`)"
                >
                  <Star :size="13" /> Par défaut
                </button>
                <button v-if="isRunning(m.name)" class="btn sm" title="Libérer la VRAM" @click="act('models.unload', m.name, `${m.name} déchargé`)">
                  <PowerOff :size="13" /> Décharger
                </button>
                <button
                  class="btn sm icon danger"
                  :class="{ armed: armed === m.name }"
                  :title="armed === m.name ? 'Cliquer encore pour supprimer' : 'Supprimer'"
                  @click="remove(m.name)"
                >
                  <Trash2 :size="14" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty small">Aucun modèle installé (ou {{ isLlama ? "llama.cpp" : "Ollama" }} ne répond pas).</div>
    </section>

    <button class="card market-teaser" @click="navigate('marketplace')">
      <Store :size="22" />
      <div>
        <strong>Modèles de la communauté</strong>
        <span class="small muted">Modèles ajustés, agents et thèmes partagés par les membres certifiés de mcfstudio.fr.</span>
      </div>
      <span class="badge warn">bientôt</span>
    </button>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
}
.page-head {
  margin-bottom: 4px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--gap);
}
.stat {
  display: flex;
  align-items: center;
  gap: 14px;
}
.stat > svg {
  color: var(--accent);
  filter: drop-shadow(0 0 8px var(--glow));
}
.stat div {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.stat strong {
  font-size: 1.2rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stat span {
  font-size: 0.8rem;
  color: var(--text-muted);
}
.pull form {
  margin-bottom: 12px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  padding: 6px 12px;
  border-radius: 99px;
  border: 1px solid var(--hairline);
  background: var(--bg-elevated);
  cursor: pointer;
  font-size: 0.82rem;
}
.chip:hover:not(:disabled) {
  border-color: var(--accent);
}
.chip:disabled {
  opacity: 0.4;
  cursor: default;
}
.pulls {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 16px;
}
.pull-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.actions {
  justify-content: flex-end;
  gap: 6px;
}
.armed {
  border-color: var(--danger);
  color: var(--danger);
}
.market-teaser {
  display: flex;
  align-items: center;
  gap: 16px;
  text-align: left;
  cursor: pointer;
  border-style: dashed;
}
.market-teaser > svg {
  color: var(--accent);
}
.market-teaser div {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
