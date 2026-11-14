<script setup lang="ts">
import { Check, Download, Eye, FileCode2, Loader2, Plus, ShieldAlert, Trash2 } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { pickTextFiles } from "../lib/files";
import { call, on } from "../lib/rpc";
import { toast } from "../lib/store";
import type { ScriptFile, ScriptInfo, ScriptsStatus } from "../lib/types";
import ModalBox from "./ModalBox.vue";
import ScriptCode from "./ScriptCode.vue";

/**
 * Scripts de l'équipe : des outils en plus pour ses membres (serveurs MCP en Python). La liste cochée est celle de
 * l'équipe en cours d'édition (enregistrée avec elle) ; l'accord sur le code, lui, s'applique tout de suite.
 */
const selected = defineModel<string[] | undefined>({ required: true });

const status = ref<ScriptsStatus>();
const progress = ref<string>();
const installing = ref(false);

async function refresh() {
  try {
    status.value = await call<ScriptsStatus>("scripts.list");
    installing.value = status.value.installing;
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

let off: (() => void) | undefined;
onMounted(() => {
  void refresh();
  off = on("scripts.runtimeProgress", (p: { what: string; received: number; total?: number }) => {
    progress.value = p.total ? `${p.what} : ${Math.round((p.received / p.total) * 100)} %` : p.what;
  });
});
onBeforeUnmount(() => off?.());
defineExpose({ refresh });

const scripts = computed(() => status.value?.scripts ?? []);
const isOn = (id: string) => selected.value?.includes(id) ?? false;
function toggle(id: string) {
  const next = isOn(id) ? (selected.value ?? []).filter((x) => x !== id) : [...(selected.value ?? []), id];
  selected.value = next.length ? next : undefined;
}

const STATE: Record<ScriptInfo["state"], { label: string; cls: string }> = {
  approved: { label: "accepté", cls: "ok" },
  pending: { label: "en attente de ton accord", cls: "warn" },
  changed: { label: "modifié depuis ton accord", cls: "warn" },
  missing: { label: "fichiers absents", cls: "warn" },
};

async function installRuntime() {
  installing.value = true;
  progress.value = "téléchargement…";
  try {
    const rt = await call<{ label: string }>("scripts.installRuntime");
    toast(`Moteur Python installé (${rt.label})`, "success");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    installing.value = false;
    progress.value = undefined;
    await refresh();
  }
}

// ─── lire le code, accepter, retirer l'accord ────────────────────────────────

const viewing = ref<ScriptInfo & { files: ScriptFile[] }>();
const acceptRead = ref(false);

async function view(id: string) {
  try {
    viewing.value = await call("scripts.get", { id });
    acceptRead.value = false;
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function approve() {
  const s = viewing.value;
  if (!s?.diskSha256) return;
  try {
    await call("scripts.approve", { id: s.id, sha256: s.diskSha256 });
    toast(`Script « ${s.name} » accepté`, "success");
    viewing.value = undefined;
    await refresh();
  } catch (e) {
    toast((e as Error).message, "error");
    await view(s.id); // le code a changé entre-temps : on montre le nouveau
  }
}

async function revoke() {
  const s = viewing.value;
  if (!s) return;
  try {
    await call("scripts.revoke", { id: s.id });
    toast(`Accord retiré : « ${s.name} » ne se lance plus`);
    viewing.value = undefined;
    await refresh();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

const armed = ref<string>();
async function remove(s: ScriptInfo) {
  if (armed.value !== s.id) {
    armed.value = s.id;
    return;
  }
  armed.value = undefined;
  try {
    await call("scripts.delete", { id: s.id });
    if (isOn(s.id)) toggle(s.id);
    toast("Script supprimé");
    await refresh();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

// ─── ajouter un script depuis des fichiers de ce PC ──────────────────────────

const adding = ref<{ name: string; description: string; entry: string; files: ScriptFile[] }>();
const saving = ref(false);

async function pick() {
  try {
    const files = await pickTextFiles(".py,.pyi,.txt,.md,.json,.toml,.yaml,.yml,.cfg,.ini,.csv", 20, 200_000);
    if (!files) return;
    const py = files.filter((f) => f.name.toLowerCase().endsWith(".py"));
    if (!py.length) return toast("Choisis au moins un fichier .py (le script à lancer)", "error");
    const entry = (py.find((f) => /^(server|main)\.py$/i.test(f.name)) ?? py[0]!).name;
    adding.value = {
      name: entry.replace(/\.py$/i, "").replace(/[_-]+/g, " "),
      description: "",
      entry,
      files: files.map((f) => ({ path: f.name, content: f.content })),
    };
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function add() {
  const a = adding.value;
  if (!a) return;
  saving.value = true;
  try {
    const s = await call<ScriptInfo>("scripts.add", { name: a.name.trim(), description: a.description.trim() || undefined, entry: a.entry, files: a.files });
    if (!isOn(s.id)) toggle(s.id);
    adding.value = undefined;
    toast(`Script « ${s.name} » ajouté à l'équipe (pense à enregistrer)`, "success");
    await refresh();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="card scripts">
    <div class="card-head">
      <h3><FileCode2 :size="17" /> Scripts de l'équipe</h3>
      <button type="button" class="btn sm" @click="pick"><Plus :size="15" /> Ajouter un script…</button>
    </div>
    <p class="tiny muted">
      Un script est un petit serveur d'outils en Python (protocole MCP) : il donne de nouveaux outils à tous les membres de cette équipe, et
      part avec elle quand tu l'exportes en workflow. Chaque appel d'un de ses outils te demande confirmation.
    </p>

    <div class="runtime row">
      <template v-if="status?.runtime">
        <span class="badge ok"><Check :size="12" /> Moteur Python : {{ status.runtime.label }}</span>
        <span v-if="status.runtime.kind === 'python'" class="tiny muted">
          Sans uv, un script n'a que les paquets Python déjà installés sur ce PC.
        </span>
      </template>
      <template v-else-if="status">
        <span class="badge warn">Aucun moteur Python sur ce PC</span>
        <button v-if="status.canInstallRuntime" type="button" class="btn sm primary" :disabled="installing" @click="installRuntime">
          <Loader2 v-if="installing" :size="14" class="spin" /><Download v-else :size="14" />
          {{ installing ? (progress ?? "installation…") : `Installer uv ${status.uv.version} (${status.uv.sizeMb} Mo)` }}
        </button>
        <span class="tiny muted">uv (Astral) lance les scripts et télécharge Python et leurs dépendances au premier lancement.</span>
      </template>
    </div>

    <div v-if="scripts.length" class="list">
      <div v-for="s in scripts" :key="s.id" class="item" :class="{ on: isOn(s.id) }">
        <label class="pick" :title="isOn(s.id) ? 'Retirer de cette équipe' : 'Donner à cette équipe'">
          <input type="checkbox" :checked="isOn(s.id)" @change="toggle(s.id)" />
        </label>
        <div class="meta">
          <div class="row">
            <strong>{{ s.name }}</strong>
            <span class="badge" :class="STATE[s.state].cls">{{ STATE[s.state].label }}</span>
          </div>
          <span class="tiny muted">
            {{ s.description || "Pas de description" }}<template v-if="s.origin"> · {{ s.origin }}</template>
            <template v-if="s.teams.length"> · utilisé par {{ s.teams.join(", ") }}</template>
          </span>
        </div>
        <button type="button" class="btn sm" @click="view(s.id)"><Eye :size="14" /> {{ s.state === "approved" ? "Voir le code" : "Lire et accepter" }}</button>
        <button type="button" class="btn sm ghost icon danger" :class="{ armed: armed === s.id }" :title="armed === s.id ? 'Cliquer encore pour supprimer' : 'Supprimer de ce PC'" @click="remove(s)">
          <Trash2 :size="14" />
        </button>
      </div>
    </div>
    <p v-else-if="status" class="small muted">Aucun script sur ce PC. Tu peux en ajouter un, ou en recevoir avec un workflow.</p>

    <!-- Lire le code et donner (ou retirer) son accord -->
    <ModalBox v-if="viewing" :title="`Script « ${viewing.name} »`" wide @close="viewing = undefined">
      <template #icon><FileCode2 :size="20" /></template>
      <div class="row facts">
        <span class="badge" :class="STATE[viewing.state].cls">{{ STATE[viewing.state].label }}</span>
        <span v-if="viewing.origin" class="badge">{{ viewing.origin }}</span>
        <span v-if="viewing.diskSha256" class="tiny muted mono" :title="viewing.diskSha256">empreinte {{ viewing.diskSha256.slice(0, 12) }}…</span>
      </div>
      <p v-if="viewing.description" class="small muted">{{ viewing.description }}</p>
      <div v-if="viewing.state !== 'approved'" class="danger-box">
        <ShieldAlert :size="18" />
        <div>
          <strong>Un script est un programme : il s'exécute sur ton PC avec tes droits.</strong>
          <p>
            Il peut lire, modifier ou supprimer tes fichiers et accéder à Internet. MyIA ne l'isole pas. N'accepte que si tu as lu le code et
            que tu fais confiance à son auteur.
          </p>
        </div>
      </div>
      <ScriptCode v-if="viewing.files.length" :files="viewing.files" :entry="viewing.entry" />
      <p v-else class="small muted">Les fichiers de ce script ont disparu du disque.</p>
      <label v-if="viewing.state === 'pending' || viewing.state === 'changed'" class="row accept">
        <input v-model="acceptRead" type="checkbox" />
        <span>J'ai lu ce code et j'accepte qu'il s'exécute sur mon PC.</span>
      </label>
      <template #actions>
        <button v-if="viewing.state === 'approved'" type="button" class="btn danger" @click="revoke">Retirer mon accord</button>
        <span class="spacer" />
        <button type="button" class="btn ghost" @click="viewing = undefined">Fermer</button>
        <button v-if="viewing.state === 'pending' || viewing.state === 'changed'" type="button" class="btn primary" :disabled="!acceptRead" @click="approve">
          <Check :size="15" /> Accepter ce script
        </button>
      </template>
    </ModalBox>

    <!-- Nouveau script à partir de fichiers choisis sur ce PC -->
    <ModalBox v-if="adding" title="Ajouter un script" wide @close="adding = undefined">
      <template #icon><FileCode2 :size="20" /></template>
      <div class="fields">
        <label class="field">
          <span class="small">Nom</span>
          <input v-model="adding.name" class="input" maxlength="60" />
        </label>
        <label class="field">
          <span class="small">Fichier lancé</span>
          <select v-model="adding.entry" class="input select">
            <option v-for="f in adding.files.filter((x) => x.path.toLowerCase().endsWith('.py'))" :key="f.path" :value="f.path">{{ f.path }}</option>
          </select>
        </label>
      </div>
      <label class="field">
        <span class="small">À quoi sert-il ? <em class="muted">(affiché à ceux qui recevront le workflow)</em></span>
        <input v-model="adding.description" class="input" maxlength="300" />
      </label>
      <p class="tiny muted">
        Le fichier lancé doit être un serveur MCP qui parle sur l'entrée/sortie standard. Avec uv, il peut déclarer ses dépendances en tête de
        fichier (bloc <span class="mono"># /// script</span>). Ce sont tes fichiers : le script est accepté d'office sur ce PC.
      </p>
      <ScriptCode :files="adding.files" :entry="adding.entry" />
      <template #actions>
        <button type="button" class="btn ghost" @click="adding = undefined">Annuler</button>
        <button type="button" class="btn primary" :disabled="saving || !adding.name.trim()" @click="add"><Plus :size="15" /> Ajouter à l'équipe</button>
      </template>
    </ModalBox>
  </div>
</template>

<style scoped>
.scripts {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
p {
  margin: 0;
  line-height: 1.5;
}
.runtime,
.facts {
  flex-wrap: wrap;
  gap: 8px;
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
}
.item.on {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--hairline));
}
.pick input {
  accent-color: var(--accent);
  cursor: pointer;
}
.meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.meta .row {
  gap: 8px;
  flex-wrap: wrap;
}
.armed {
  color: var(--danger);
  border-color: var(--danger);
}
.danger-box {
  display: flex;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--radius);
  border: 1px solid color-mix(in srgb, var(--danger) 55%, transparent);
  background: color-mix(in srgb, var(--danger) 9%, var(--surface));
  color: var(--danger);
  font-size: 0.85rem;
}
.danger-box svg {
  flex: none;
  margin-top: 2px;
}
.danger-box strong {
  color: var(--text);
}
.danger-box p {
  margin-top: 4px;
  color: var(--text-muted);
}
.accept {
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--hairline);
  cursor: pointer;
  font-size: 0.9rem;
}
.accept input {
  margin-top: 3px;
  accent-color: var(--accent);
}
.fields {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 10px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field em {
  font-style: normal;
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
