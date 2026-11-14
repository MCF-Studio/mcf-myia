<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

/** Fenêtre modale simple : fond cliquable, Échap pour fermer, focus rendu à l'élément d'origine. */
defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();

const box = ref<HTMLElement>();
let back: HTMLElement | null = null;

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("close");
  }
}
onMounted(() => {
  back = document.activeElement as HTMLElement | null;
  box.value?.focus();
  window.addEventListener("keydown", onKey, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey, true);
  if (back?.isConnected) back.focus();
});
</script>

<template>
  <div class="mb-backdrop" @click.self="emit('close')">
    <div ref="box" class="mb card" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
      <header class="mb-head">
        <slot name="icon" />
        <h3>{{ title }}</h3>
      </header>
      <div class="mb-body">
        <slot />
      </div>
      <footer v-if="$slots.actions" class="mb-actions">
        <slot name="actions" />
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mb-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(3px);
}
.mb {
  width: min(540px, 100%);
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
  gap: 14px;
  outline: none;
  box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.8), 0 0 60px -30px var(--glow);
}
.mb.wide {
  width: min(980px, 100%);
}
.mb-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.mb-head h3 {
  font-size: 1.1rem;
}
.mb-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}
.mb-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
