<script setup lang="ts">
import { computed } from "vue";
import { agentColor, initials } from "../lib/format";
import type { AgentProfile } from "../lib/types";

const props = withDefaults(
  defineProps<{ agent?: Pick<AgentProfile, "id" | "name" | "color" | "avatar">; size?: number; busy?: boolean }>(),
  { size: 34 },
);
const color = computed(() => (props.agent ? agentColor(props.agent) : "var(--accent)"));
/** Seules des images raster en data URL sont affichées (le cœur refuse tout le reste). */
const photo = computed(() => (props.agent?.avatar?.startsWith("data:image/") ? props.agent.avatar : undefined));
</script>

<template>
  <div class="av" :class="{ busy, photo }" :style="{ width: `${size}px`, height: `${size}px`, '--c': color, fontSize: `${size * 0.38}px` }">
    <img v-if="photo" :src="photo" alt="" draggable="false" />
    <template v-else>{{ agent ? initials(agent.name) : "?" }}</template>
  </div>
</template>

<style scoped>
.av {
  flex: none;
  border-radius: 30%;
  display: grid;
  place-items: center;
  font-weight: 700;
  color: var(--c);
  background: color-mix(in srgb, var(--c) 14%, var(--surface-2));
  border: 1px solid color-mix(in srgb, var(--c) 40%, transparent);
  position: relative;
}
.av.photo {
  border-color: color-mix(in srgb, var(--c) 70%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--c) 25%, transparent);
}
.av img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
}
.av.busy::after {
  content: "";
  position: absolute;
  inset: -4px;
  border-radius: 34%;
  border: 2px solid var(--c);
  opacity: 0.6;
  animation: pulse 1.2s ease-in-out infinite;
}
</style>
