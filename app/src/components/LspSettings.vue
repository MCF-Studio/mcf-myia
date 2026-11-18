<script setup lang="ts">
import { Braces, Check, Download, RefreshCw } from "lucide-vue-next";
import { onMounted, ref } from "vue";
import { call } from "../lib/rpc";
import { toast } from "../lib/store";

/**
 * Serveurs de langage (LSP) pour les consoles Claude Code (core/lsp.ts) : Claude saute à la définition d'un symbole
 * et trouve ses usages au lieu de relire des fichiers entiers, ce qui économise des jetons sur les gros projets.
 */
interface LspStatus {
  id: string;
  label: string;
  needs: string;
  server: boolean;
  plugin: boolean;
}
const list = ref<LspStatus[]>([]);
const loading = ref(false);
const installing = ref("");

async function load() {
  loading.value = true;
  try {
    list.value = await call<LspStatus[]>("lsp.status", {}, 60_000);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    loading.value = false;
  }
}
async function install(id: string) {
  installing.value = id;
  try {
    const r = await call<{ ok: boolean; detail?: string }>("lsp.install", { id }, 15 * 60_000);
    if (r.ok) toast("LSP installé : il sert dès la prochaine console ouverte", "success");
    else toast(r.detail ?? "installation impossible", "error");
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    installing.value = "";
  }
}
onMounted(load);
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h3 class="sec-title"><Braces :size="16" /> LSP : Claude lit moins, dépense moins</h3>
      <button class="btn sm ghost icon" title="Relire" :disabled="loading" @click="load"><RefreshCw :size="14" :class="{ spin: loading }" /></button>
    </div>
    <p class="tiny muted">
      Avec un serveur de langage, Claude Code va droit à la définition d'une fonction, trouve ses usages et voit les erreurs de type, sans relire des fichiers entiers :
      moins de jetons sur les projets un peu gros. Il faut le serveur (programme) et le plugin officiel de Claude Code.
    </p>
    <div v-for="l in list" :key="l.id" class="lsp-row">
      <div class="grow">
        <strong class="small">{{ l.label }}</strong>
        <div class="tiny muted">serveur {{ l.server ? "installé" : "absent" }} · plugin {{ l.plugin ? "installé" : "absent" }}</div>
      </div>
      <span v-if="l.server && l.plugin" class="badge ok"><Check :size="12" /> prêt</span>
      <button v-else class="btn sm" :disabled="!!installing" :title="`Nécessite ${l.needs}`" @click="install(l.id)">
        <Download :size="13" /> {{ installing === l.id ? "Installation…" : "Installer" }}
      </button>
    </div>
    <p v-if="!list.length && !loading" class="small muted">État indisponible (Claude Code est-il installé ?).</p>
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
.lsp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
.grow {
  flex: 1;
}
</style>
