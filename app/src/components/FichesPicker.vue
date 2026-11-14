<script setup lang="ts">
import { NotebookPen, ShieldAlert } from "lucide-vue-next";
import { onMounted, ref } from "vue";
import { call } from "../lib/rpc";
import { toast } from "../lib/store";

/**
 * Fiches de l'espace de coordination à joindre au workflow (export ou publication). L'auteur choisit fichier par
 * fichier ; le journal n'est jamais proposé. Une fiche dont le nom évoque des accès est décochée d'office.
 */
const props = defineProps<{ teamId: string }>();
const selected = defineModel<string[]>({ required: true });

interface FicheInfo {
  path: string;
  chars: number;
  sensitive: boolean;
}
const files = ref<FicheInfo[]>();

onMounted(async () => {
  try {
    const r = await call<{ dir: string | null; files: FicheInfo[] }>("teams.coordinationFiles", { id: props.teamId });
    files.value = r.files;
    selected.value = r.files.filter((f) => !f.sensitive).map((f) => f.path);
  } catch (e) {
    files.value = [];
    toast((e as Error).message, "error");
  }
});

function toggle(name: string) {
  selected.value = selected.value.includes(name) ? selected.value.filter((n) => n !== name) : [...selected.value, name];
}
</script>

<template>
  <div v-if="files?.length" class="fiches">
    <strong class="small head"><NotebookPen :size="15" /> Fiches de l'espace de coordination à joindre</strong>
    <p class="tiny muted">
      Ce sont les règles et la méthode de l'équipe : celui qui installera le workflow les recevra, et ses agents les liront. Ton journal
      (<span class="mono">journal/</span>) ne part jamais. Relis chaque fiche avant de la joindre : décoche ce qui ne concerne que ton projet.
    </p>
    <label v-for="f in files" :key="f.path" class="fiche" :class="{ on: selected.includes(f.path) }">
      <input type="checkbox" :checked="selected.includes(f.path)" @change="toggle(f.path)" />
      <span class="mono">{{ f.path }}</span>
      <span class="tiny muted">{{ f.chars.toLocaleString("fr-FR") }} caractères</span>
      <span v-if="f.sensitive" class="badge warn" title="Le nom de cette fiche évoque des accès ou des secrets : vérifie son contenu avant de la joindre">
        <ShieldAlert :size="12" /> à vérifier
      </span>
    </label>
  </div>
</template>

<style scoped>
.fiches {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
}
p {
  margin: 0;
  line-height: 1.5;
}
.fiche {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: var(--radius);
  border: 1px solid var(--hairline);
  background: var(--bg-elevated);
  cursor: pointer;
}
.fiche.on {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--hairline));
}
.fiche input {
  accent-color: var(--accent);
}
.fiche .mono {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
