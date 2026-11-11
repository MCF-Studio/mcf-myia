<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{ value: number; size?: number; stroke?: number }>(), { size: 76, stroke: 7 });
const r = computed(() => (props.size - props.stroke) / 2);
const c = computed(() => 2 * Math.PI * r.value);
// Arc de 270° (ouvert en bas), façon cadran.
const arc = computed(() => c.value * 0.75);
const dash = computed(() => `${(Math.max(0, Math.min(100, props.value)) / 100) * arc.value} ${c.value}`);
const hot = computed(() => props.value >= 85);
</script>

<template>
  <div class="gauge" :class="{ hot }" :style="{ width: `${size}px`, height: `${size}px` }">
    <svg :viewBox="`0 0 ${size} ${size}`">
      <circle
        :cx="size / 2"
        :cy="size / 2"
        :r="r"
        fill="none"
        class="track"
        :stroke-width="stroke"
        :stroke-dasharray="`${arc} ${c}`"
        stroke-linecap="round"
        :transform="`rotate(135 ${size / 2} ${size / 2})`"
      />
      <circle
        :cx="size / 2"
        :cy="size / 2"
        :r="r"
        fill="none"
        class="value"
        :stroke-width="stroke"
        :stroke-dasharray="dash"
        stroke-linecap="round"
        :transform="`rotate(135 ${size / 2} ${size / 2})`"
      />
    </svg>
    <div class="label"><span><slot /></span></div>
  </div>
</template>

<style scoped>
.gauge {
  position: relative;
  flex: none;
}
svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}
.track {
  stroke: var(--surface-2);
}
.value {
  stroke: var(--accent);
  filter: drop-shadow(0 0 6px var(--glow));
  transition: stroke-dasharray 0.7s var(--ease);
}
.hot .value {
  stroke: var(--danger);
}
.label {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
</style>
