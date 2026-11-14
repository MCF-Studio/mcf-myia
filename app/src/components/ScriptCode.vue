<script setup lang="ts">
import { FileCode2 } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import type { ScriptFile } from "../lib/types";

/** Code d'un script, fichier par fichier, en texte brut (jamais interprété) : c'est ce que l'utilisateur accepte. */
const props = defineProps<{ files: ScriptFile[]; entry: string }>();

const current = ref(props.entry);
watch(
  () => props.files,
  () => (current.value = props.files.some((f) => f.path === props.entry) ? props.entry : (props.files[0]?.path ?? "")),
);
const file = computed(() => props.files.find((f) => f.path === current.value) ?? props.files[0]);
const lines = computed(() => (file.value ? file.value.content.split("\n").length : 0));
</script>

<template>
  <div class="code">
    <div class="code-files">
      <button v-for="f in files" :key="f.path" type="button" class="code-file" :class="{ on: f.path === file?.path }" @click="current = f.path">
        <FileCode2 :size="13" />
        <span class="mono">{{ f.path }}</span>
        <span v-if="f.path === entry" class="badge accent">lancé</span>
      </button>
    </div>
    <div class="code-meta tiny muted">{{ file?.path }} · {{ lines }} ligne{{ lines > 1 ? "s" : "" }} · {{ file?.content.length ?? 0 }} caractères</div>
    <pre class="code-text selectable mono">{{ file?.content }}</pre>
  </div>
</template>

<style scoped>
.code {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.code-files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.code-file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 99px;
  border: 1px solid var(--hairline);
  background: var(--bg-elevated);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.8rem;
}
.code-file.on {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 55%, var(--hairline));
}
.code-text {
  margin: 0;
  max-height: 340px;
  overflow: auto;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline);
  background: var(--bg);
  font-size: 0.8rem;
  line-height: 1.5;
  white-space: pre;
  tab-size: 4;
}
</style>
