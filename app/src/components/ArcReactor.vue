<script setup lang="ts">
import { computed } from "vue";
import type { JarvisPhase } from "../lib/jarvis";

/**
 * Cœur animé de l'onglet Jarvis : anneaux qui tournent, segments, noyau qui pulse avec la voix (level 0..1).
 * Purement décoratif (SVG + CSS), aux couleurs du thème ; les animations s'arrêtent si « réduire les animations ».
 */
const props = withDefaults(defineProps<{ phase: JarvisPhase; level?: number; size?: number }>(), { level: 0, size: 320 });

const C = 160; // centre du viewBox 320×320
const ticks = Array.from({ length: 72 }, (_, i) => i * 5);
const segments = Array.from({ length: 12 }, (_, i) => i * 30);

/** Arc SVG de `a0` à `a1` degrés sur le rayon r. */
function arc(r: number, a0: number, a1: number) {
  const p = (a: number) => [C + r * Math.cos(((a - 90) * Math.PI) / 180), C + r * Math.sin(((a - 90) * Math.PI) / 180)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M${x0!.toFixed(2)},${y0!.toFixed(2)} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1!.toFixed(2)},${y1!.toFixed(2)}`;
}

const pulse = computed(() => 1 + Math.min(1, props.level) * 0.22);
const active = computed(() => props.phase !== "off");
</script>

<template>
  <div class="reactor" :class="[`p-${phase}`, { active }]" :style="{ width: `${size}px`, height: `${size}px` }">
    <svg viewBox="0 0 320 320" aria-hidden="true">
      <defs>
        <radialGradient id="rc-core" cx="50%" cy="50%" r="50%">
          <stop offset="0" stop-color="#fff" stop-opacity="0.95" />
          <stop offset="0.35" style="stop-color: var(--accent-2); stop-opacity: 0.9" />
          <stop offset="0.7" style="stop-color: var(--accent); stop-opacity: 0.55" />
          <stop offset="1" style="stop-color: var(--accent); stop-opacity: 0" />
        </radialGradient>
        <filter id="rc-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      <!-- graduations extérieures -->
      <g class="ring r-ticks">
        <line
          v-for="a in ticks"
          :key="a"
          :x1="C"
          :y1="C - 152"
          :x2="C"
          :y2="C - (a % 30 === 0 ? 140 : 146)"
          :transform="`rotate(${a} ${C} ${C})`"
          class="tick"
          :class="{ major: a % 30 === 0 }"
        />
      </g>

      <!-- anneau d'arcs, sens horaire -->
      <g class="ring r-outer" filter="url(#rc-glow)">
        <path :d="arc(128, 10, 80)" class="arc a-strong" />
        <path :d="arc(128, 100, 140)" class="arc" />
        <path :d="arc(128, 160, 250)" class="arc a-strong" />
        <path :d="arc(128, 270, 340)" class="arc" />
      </g>

      <!-- anneau segmenté, sens inverse -->
      <g class="ring r-mid">
        <path v-for="a in segments" :key="a" :d="arc(108, a + 3, a + 24)" class="seg" />
      </g>

      <!-- anneau pointillé -->
      <g class="ring r-dots">
        <circle :cx="C" :cy="C" r="92" class="dots" />
      </g>

      <!-- bobines du réacteur -->
      <g class="ring r-coils" filter="url(#rc-glow)">
        <rect v-for="a in [0, 36, 72, 108, 144, 180, 216, 252, 288, 324]" :key="a" :x="C - 6" :y="C - 80" width="12" height="22" rx="3" :transform="`rotate(${a} ${C} ${C})`" class="coil" />
      </g>

      <circle :cx="C" :cy="C" r="56" class="inner-ring" />
      <!-- noyau : pulse avec le niveau du micro -->
      <g :style="{ transform: `scale(${pulse})` }" class="core-g">
        <circle :cx="C" :cy="C" r="46" fill="url(#rc-core)" class="core" />
        <circle :cx="C" :cy="C" r="22" class="core-hot" />
      </g>
    </svg>
    <div class="slot"><slot /></div>
  </div>
</template>

<style scoped>
.reactor {
  position: relative;
  display: grid;
  place-items: center;
  max-width: 100%;
  aspect-ratio: 1;
}
svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}
.ring {
  transform-origin: 160px 160px;
  transform-box: view-box;
}
.tick {
  stroke: color-mix(in srgb, var(--accent) 35%, transparent);
  stroke-width: 1;
}
.tick.major {
  stroke: var(--accent);
  stroke-width: 2;
}
.arc {
  fill: none;
  stroke: color-mix(in srgb, var(--accent) 55%, transparent);
  stroke-width: 3;
  stroke-linecap: round;
}
.arc.a-strong {
  stroke: var(--accent);
  stroke-width: 5;
}
.seg {
  fill: none;
  stroke: color-mix(in srgb, var(--accent-2) 70%, transparent);
  stroke-width: 9;
}
.dots {
  fill: none;
  stroke: color-mix(in srgb, var(--accent) 60%, transparent);
  stroke-width: 2;
  stroke-dasharray: 1 7;
  stroke-linecap: round;
}
.coil {
  fill: color-mix(in srgb, var(--accent) 22%, transparent);
  stroke: var(--accent);
  stroke-width: 1.5;
}
.inner-ring {
  fill: none;
  stroke: color-mix(in srgb, var(--accent-2) 80%, transparent);
  stroke-width: 2;
}
.core-g {
  transform-origin: 160px 160px;
  transform-box: view-box;
  transition: transform 0.08s linear;
}
.core {
  opacity: 0.55;
  transition: opacity 0.4s;
}
.core-hot {
  fill: #fff;
  opacity: 0.35;
  filter: blur(4px);
}
.reactor:not(.active) {
  filter: saturate(0.35) brightness(0.75);
}
.active .core {
  opacity: 1;
}
.slot {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
}

/* animations (désactivées par « réduire les animations ») */
:root[data-motion="full"] .r-ticks {
  animation: spin 120s linear infinite;
}
:root[data-motion="full"] .r-outer {
  animation: spin 22s linear infinite;
}
:root[data-motion="full"] .r-mid {
  animation: spin 34s linear infinite reverse;
}
:root[data-motion="full"] .r-dots {
  animation: spin 60s linear infinite;
}
:root[data-motion="full"] .r-coils {
  animation: spin 90s linear infinite reverse;
}
:root[data-motion="full"] .active .core {
  animation: breathe 3.2s ease-in-out infinite;
}
:root[data-motion="full"] .p-thinking .r-outer {
  animation-duration: 3s;
}
:root[data-motion="full"] .p-thinking .r-mid {
  animation-duration: 5s;
}
:root[data-motion="full"] .p-hearing .r-outer,
:root[data-motion="full"] .p-speaking .r-outer {
  animation-duration: 8s;
}
.p-standby .seg {
  stroke: color-mix(in srgb, var(--accent-2) 40%, transparent);
}
.p-attentive .seg,
.p-hearing .seg {
  stroke: var(--accent-2);
}
.p-speaking .core-hot {
  opacity: 0.75;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes breathe {
  0%,
  100% {
    opacity: 0.8;
  }
  50% {
    opacity: 1;
  }
}
</style>
