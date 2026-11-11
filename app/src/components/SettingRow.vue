<script setup lang="ts">
defineProps<{ label: string; hint?: string }>();
</script>

<template>
  <div class="setting">
    <div class="setting-text">
      <span class="setting-label">{{ label }}</span>
      <span v-if="hint" class="setting-hint">{{ hint }}</span>
    </div>
    <div class="setting-control"><slot /></div>
  </div>
</template>

<style scoped>
.setting {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 14px 0;
  border-top: 1px solid var(--hairline);
}
.setting:first-child {
  border-top: 0;
}
.setting-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.setting-label {
  font-weight: 550;
}
.setting-hint {
  font-size: 0.8rem;
  color: var(--text-muted);
  line-height: 1.45;
}
.setting-control {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
</style>
