<script setup lang="ts">
const model = defineModel<boolean>({ required: true });
defineProps<{ label?: string }>();
</script>

<template>
  <button type="button" class="toggle" :class="{ on: model }" role="switch" :aria-checked="model" :aria-label="label" @click="model = !model">
    <span />
  </button>
</template>

<style scoped>
.toggle {
  width: 40px;
  height: 22px;
  border-radius: 99px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  position: relative;
  cursor: pointer;
  flex: none;
  transition: background 0.2s, border-color 0.2s;
}
.toggle span {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: transform 0.2s var(--ease), background 0.2s;
}
.toggle.on {
  background: var(--lava);
  border-color: transparent;
  box-shadow: 0 0 14px -2px var(--glow);
}
.toggle.on span {
  transform: translateX(18px);
  background: var(--accent-contrast);
}
</style>
