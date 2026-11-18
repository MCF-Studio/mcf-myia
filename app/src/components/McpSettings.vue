<script setup lang="ts">
import { Import, Plug, RefreshCw } from "lucide-vue-next";
import { onMounted, ref } from "vue";
import { call } from "../lib/rpc";
import { toast } from "../lib/store";

/**
 * Serveurs MCP de MyIA : ils servent à TOUS les agents, quel que soit leur modèle (local, Claude, OpenAI, Gemini,
 * Mistral…). Import en un clic de ceux déjà configurés dans Claude Code ; leurs jetons vont au coffre Windows.
 */
interface McpList {
  servers: string[];
  status: { id: string; label: string; available: { ok: boolean; reason?: string } }[];
  importable: { name: string; already: boolean; envKeys: string[] }[];
}
const data = ref<McpList>();
const picked = ref<string[]>([]);
const busy = ref(false);

async function load() {
  data.value = await call<McpList>("mcp.list", {}, 30_000).catch(() => undefined);
}
async function importPicked() {
  busy.value = true;
  try {
    const r = await call<{ imported: string[] }>("mcp.importFromClaude", { names: picked.value }, 60_000);
    toast(`Importé : ${r.imported.join(", ")}. Chaque outil demandera ta confirmation tant que tu ne l'as pas marqué en lecture seule.`, "success");
    picked.value = [];
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h3 class="sec-title"><Plug :size="16" /> Serveurs MCP pour tous les modèles</h3>
      <button class="btn sm ghost icon" title="Relire" @click="load"><RefreshCw :size="14" /></button>
    </div>
    <p class="tiny muted">
      Un serveur MCP déclaré ici sert à tous tes agents, qu'ils tournent en local, sur Claude, OpenAI, Gemini ou Mistral. Les outils demandent ta
      confirmation par défaut (config/agent.json → mcpServers → readOnlyTools pour ceux en lecture seule).
    </p>
    <ul v-if="data?.status.length" class="list">
      <li v-for="s in data.status" :key="s.id" class="small">
        {{ s.label }}
        <span class="badge" :class="s.available.ok ? 'ok' : 'warn'">{{ s.available.ok ? "prêt" : s.available.reason ?? "indisponible" }}</span>
      </li>
    </ul>
    <p v-else class="small muted">Aucun serveur MCP dans MyIA pour l'instant.</p>
    <template v-if="data?.importable.some((x) => !x.already)">
      <p class="small"><strong>Déjà dans Claude Code :</strong></p>
      <div class="pick">
        <label v-for="x in data.importable.filter((y) => !y.already)" :key="x.name" class="tiny">
          <input v-model="picked" type="checkbox" :value="x.name" />
          <span class="mono">{{ x.name }}</span>
          <span v-if="x.envKeys.length" class="muted">({{ x.envKeys.length }} variable{{ x.envKeys.length > 1 ? "s" : "" }} → coffre Windows)</span>
        </label>
      </div>
      <button class="btn sm" :disabled="!picked.length || busy" @click="importPicked"><Import :size="13" /> Importer dans MyIA</button>
    </template>
  </section>
</template>

<style scoped>
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sec-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.list {
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pick {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin-bottom: 8px;
}
.pick label {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
</style>
