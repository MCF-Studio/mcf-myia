<script setup lang="ts">
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, RefreshCw, Sparkles } from "lucide-vue-next";
import { onMounted, ref } from "vue";
import { call } from "../lib/rpc";

/** Notes de mise à jour : les versions publiées de MyIA (releases GitHub), la plus récente d'abord. Texte brut. */
const props = defineProps<{ current?: string }>();

interface ReleaseNote {
  version: string;
  name: string;
  date: string;
  notes: string;
  url: string;
}
const notes = ref<ReleaseNote[]>([]);
const loading = ref(false);
const failed = ref("");

async function load() {
  loading.value = true;
  try {
    notes.value = await call<ReleaseNote[]>("app.releases", {}, 20_000);
    failed.value = "";
  } catch (e) {
    failed.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

/** Les notes sont souvent une liste séparée par « ; » : une ligne par point, plus lisible. */
const points = (text: string) =>
  text
    .split(/\n+|;\s+/)
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
const fmtDate = (d: string) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) : "");
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h3 class="sec-title"><Sparkles :size="16" /> Notes de mise à jour</h3>
      <button class="btn sm ghost icon" title="Relire" :disabled="loading" @click="load"><RefreshCw :size="14" :class="{ spin: loading }" /></button>
    </div>
    <p v-if="failed" class="small muted">{{ failed }}</p>
    <p v-else-if="loading && !notes.length" class="small muted">Chargement…</p>
    <article v-for="n in notes" :key="n.version" class="release" :class="{ current: n.version === props.current }">
      <header>
        <strong>Version {{ n.version }}</strong>
        <span v-if="n.version === props.current" class="badge accent">installée</span>
        <span class="tiny muted">{{ fmtDate(n.date) }}</span>
        <span class="spacer" />
        <button class="btn sm ghost icon" title="Voir sur GitHub" @click="openUrl(n.url)"><ExternalLink :size="13" /></button>
      </header>
      <ul v-if="n.notes">
        <li v-for="(p, i) in points(n.notes)" :key="i" class="small">{{ p }}</li>
      </ul>
      <p v-else class="tiny muted">Pas de note pour cette version.</p>
    </article>
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
.release {
  border-top: 1px solid var(--border);
  padding: 12px 0 4px;
}
.release header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.release.current strong {
  color: var(--accent);
}
.release ul {
  margin: 8px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.spacer {
  flex: 1;
}
</style>
