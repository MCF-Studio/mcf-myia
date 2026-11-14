<script setup lang="ts">
import { AlertTriangle, Bot, Download, FileCode2, Network, ShieldAlert } from "lucide-vue-next";
import { computed, ref } from "vue";
import { call } from "../lib/rpc";
import { refreshAgents, refreshOverview, refreshTeams, toast } from "../lib/store";
import type { WorkflowInstalled, WorkflowPreview } from "../lib/types";
import AgentAvatar from "./AgentAvatar.vue";
import ModalBox from "./ModalBox.vue";
import ScriptCode from "./ScriptCode.vue";

/**
 * Ce qu'un workflow installerait, montré AVANT toute écriture : l'équipe, ses agents (consignes comprises) et le code
 * de ses scripts. Les scripts ne sont activés que si la case d'accord est cochée ; sinon ils restent en attente.
 */
const props = defineProps<{ preview: WorkflowPreview }>();
const emit = defineEmits<{ close: []; installed: [WorkflowInstalled] }>();

const accept = ref(false);
const busy = ref(false);
const openAgent = ref<string>();
const openScript = ref(props.preview.scripts.find((s) => !s.reused)?.id ?? props.preview.scripts[0]?.id);

/** Scripts dont le code est nouveau pour ce PC : ce sont eux que l'accord concerne. */
const newScripts = computed(() => props.preview.scripts.filter((s) => !s.reused));

async function install(withScripts: boolean) {
  busy.value = true;
  try {
    const r = await call<WorkflowInstalled>("workflows.install", { sha256: props.preview.sha256, acceptScripts: withScripts });
    await Promise.all([refreshAgents(), refreshTeams(), refreshOverview()]);
    toast(
      r.scriptsPending
        ? `Équipe « ${r.team.name} » installée. Ses scripts attendent ton accord (Équipes → Scripts).`
        : `Équipe « ${r.team.name} » installée`,
      "success",
    );
    emit("installed", r);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ModalBox :title="`Installer « ${preview.name} » ?`" wide @close="emit('close')">
    <template #icon><span class="glyph"><Network :size="20" /></span></template>

    <p v-if="preview.description" class="small">{{ preview.description }}</p>
    <div class="row facts">
      <span class="badge">source : {{ preview.origin }}</span>
      <span class="badge">{{ preview.team.nodes }} agent{{ preview.team.nodes > 1 ? "s" : "" }} dans l'équipe</span>
      <span class="badge">{{ preview.team.maxCalls }} appels max par message</span>
      <span class="badge" :class="{ warn: preview.scripts.length }">{{ preview.scripts.length }} script{{ preview.scripts.length > 1 ? "s" : "" }}</span>
      <span class="tiny muted mono" :title="preview.sha256">empreinte {{ preview.sha256.slice(0, 12) }}…</span>
    </div>

    <div v-if="preview.warnings.length" class="warn-box">
      <AlertTriangle :size="17" />
      <ul>
        <li v-for="w in preview.warnings" :key="w">{{ w }}</li>
      </ul>
    </div>

    <section class="part">
      <h4><Bot :size="15" /> Agents</h4>
      <p class="tiny muted">
        Rien n'est remplacé : un agent déjà présent à l'identique est réutilisé, un agent de même id mais différent est installé à côté.
        Les consignes ne changent pas les règles de confirmation.
      </p>
      <div v-for="a in preview.agents" :key="a.id" class="agent">
        <button type="button" class="agent-head" @click="openAgent = openAgent === a.id ? undefined : a.id">
          <AgentAvatar :agent="a" :size="28" />
          <strong>{{ a.name }}</strong>
          <span class="tiny muted mono">{{ a.model ?? "modèle par défaut" }}</span>
          <span class="spacer" />
          <span v-if="a.reused" class="badge ok">déjà installé</span>
          <span v-else-if="preview.renamed.some((r) => r.kind === 'agent' && r.from === a.id)" class="badge">
            installé sous « {{ preview.renamed.find((r) => r.kind === "agent" && r.from === a.id)?.to }} »
          </span>
          <span class="tiny muted">{{ openAgent === a.id ? "masquer" : "voir les consignes" }}</span>
        </button>
        <div v-if="openAgent === a.id" class="agent-body">
          <p v-if="a.description" class="small muted">{{ a.description }}</p>
          <pre v-if="a.instructions" class="instructions selectable">{{ a.instructions }}</pre>
          <p v-else class="tiny muted">Pas de consignes particulières.</p>
          <p class="tiny muted">Services autorisés : {{ a.services?.length ? a.services.join(", ") : "tous ceux de ce PC" }}</p>
        </div>
      </div>
    </section>

    <section v-if="preview.scripts.length" class="part">
      <h4><FileCode2 :size="15" /> Scripts</h4>
      <div class="danger-box">
        <ShieldAlert :size="18" />
        <div>
          <strong>Un script est un programme : il s'exécute sur ton PC avec tes droits.</strong>
          <p>
            Il peut lire, modifier ou supprimer tes fichiers et accéder à Internet. MyIA ne l'isole pas. Lis le code ci-dessous, et
            n'accepte que si tu fais confiance à son auteur. Chaque appel d'un outil du script te sera ensuite confirmé avec ses
            arguments, et un script modifié après ton accord ne se lance plus.
          </p>
        </div>
      </div>
      <div class="script-tabs">
        <button v-for="s in preview.scripts" :key="s.id" type="button" class="script-tab" :class="{ on: openScript === s.id }" @click="openScript = s.id">
          {{ s.name }}
          <span v-if="s.reused" class="badge ok">déjà installé</span>
        </button>
      </div>
      <template v-for="s in preview.scripts" :key="s.id">
        <div v-if="openScript === s.id" class="script">
          <p v-if="s.description" class="small muted">{{ s.description }}</p>
          <ScriptCode :files="s.files" :entry="s.entry" />
        </div>
      </template>
      <label v-if="newScripts.length" class="row accept">
        <input v-model="accept" type="checkbox" />
        <span>
          J'ai lu le code {{ newScripts.length > 1 ? `des ${newScripts.length} scripts` : "du script" }} et j'accepte
          {{ newScripts.length > 1 ? "qu'ils s'exécutent" : "qu'il s'exécute" }} sur mon PC.
        </span>
      </label>
    </section>

    <template #actions>
      <button type="button" class="btn ghost" :disabled="busy" @click="emit('close')">Annuler</button>
      <button v-if="newScripts.length" type="button" class="btn" :disabled="busy" title="L'équipe est installée ; ses scripts restent en attente et ne tournent pas" @click="install(false)">
        Installer sans activer les scripts
      </button>
      <button type="button" class="btn primary" :disabled="busy || (newScripts.length > 0 && !accept)" @click="install(true)">
        <Download :size="15" /> Installer{{ newScripts.length ? " et activer les scripts" : "" }}
      </button>
    </template>
  </ModalBox>
</template>

<style scoped>
.glyph {
  width: 40px;
  height: 40px;
  border-radius: 30%;
  display: grid;
  place-items: center;
  flex: none;
  color: var(--accent-2);
  background: color-mix(in srgb, var(--accent-2) 14%, var(--surface-2));
  border: 1px solid color-mix(in srgb, var(--accent-2) 40%, transparent);
}
p {
  margin: 0;
  line-height: 1.5;
}
.facts {
  flex-wrap: wrap;
  gap: 6px;
}
.part {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.part h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.95rem;
}
.warn-box,
.danger-box {
  display: flex;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--radius);
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  background: color-mix(in srgb, var(--warning) 8%, var(--surface));
  color: var(--warning);
  font-size: 0.85rem;
}
.danger-box {
  border-color: color-mix(in srgb, var(--danger) 55%, transparent);
  background: color-mix(in srgb, var(--danger) 9%, var(--surface));
  color: var(--danger);
}
.warn-box svg,
.danger-box svg {
  flex: none;
  margin-top: 2px;
}
.warn-box ul {
  margin: 0;
  padding-left: 18px;
  color: var(--text);
}
.danger-box strong {
  color: var(--text);
}
.danger-box p {
  margin-top: 4px;
  color: var(--text-muted);
}
.agent {
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--bg-elevated);
}
.agent-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.agent-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 12px 12px;
}
.instructions {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg);
  border: 1px solid var(--hairline);
  white-space: pre-wrap;
  font-size: 0.82rem;
  line-height: 1.5;
}
.script-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.script-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.script-tab.on {
  color: var(--text);
  background: var(--surface);
  box-shadow: inset 0 -2px 0 var(--accent);
}
.script {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
</style>
