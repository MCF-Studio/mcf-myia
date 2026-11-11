<script setup lang="ts">
import { computed, useId } from "vue";

const props = withDefaults(defineProps<{ values: number[]; max?: number; height?: number; points?: number }>(), {
  max: 100,
  height: 56,
  points: 60,
});
const id = useId();

const W = 300;
const path = computed(() => {
  const vals = props.values.slice(-props.points);
  if (vals.length < 2) return { line: "", area: "" };
  const step = W / (props.points - 1);
  const x0 = W - (vals.length - 1) * step;
  const y = (v: number) => props.height - 2 - (Math.min(v, props.max) / props.max) * (props.height - 6);
  const pts = vals.map((v, i) => [x0 + i * step, y(v)] as const);
  const line = pts.map(([x, yy], i) => `${i ? "L" : "M"}${x.toFixed(1)},${yy.toFixed(1)}`).join(" ");
  const area = `${line} L${W},${props.height} L${x0.toFixed(1)},${props.height} Z`;
  return { line, area };
});
</script>

<template>
  <svg class="spark" :viewBox="`0 0 ${W} ${height}`" preserveAspectRatio="none" :style="{ height: `${height}px` }" aria-hidden="true">
    <defs>
      <linearGradient :id="`f${id}`" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--accent)" stop-opacity="0.35" />
        <stop offset="1" stop-color="var(--accent)" stop-opacity="0" />
      </linearGradient>
      <linearGradient :id="`l${id}`" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="var(--accent-2)" />
        <stop offset="1" stop-color="var(--accent)" />
      </linearGradient>
    </defs>
    <path :d="path.area" :fill="`url(#f${id})`" />
    <path :d="path.line" fill="none" :stroke="`url(#l${id})`" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
  </svg>
</template>

<style scoped>
.spark {
  width: 100%;
  display: block;
}
</style>
