<script setup lang="ts">
import { Square, Volume2 } from "lucide-vue-next";
import { speech, stopSpeaking } from "../lib/sound";

/**
 * Pastille « lecture à voix haute » : visible tant que la voix parle, quelle que soit la vue, avec le bouton
 * qui l'arrête pour de bon (son coupé, plus rien en attente). Échap fait la même chose (App.vue).
 */
</script>

<template>
  <Transition name="speech">
    <div v-if="speech.speaking" class="speech-pill" role="status">
      <Volume2 :size="16" class="wave" />
      <span class="small">Lecture à voix haute…</span>
      <button class="btn sm" title="Arrêter la lecture (Échap)" @click="stopSpeaking"><Square :size="13" /> Arrêter la lecture</button>
    </div>
  </Transition>
</template>

<style scoped>
.speech-pill {
  position: fixed;
  left: 50%;
  /* En haut, sous la barre de titre : en bas elle couvrirait la zone de saisie pendant toute la lecture. */
  top: calc(var(--titlebar-h) + 12px);
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 6px 6px 14px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--hairline);
  box-shadow: 0 10px 40px -12px rgba(0, 0, 0, 0.6);
  color: var(--text);
  white-space: nowrap;
}
.speech-pill .btn {
  border-radius: 999px;
}
.wave {
  color: var(--accent);
  flex: none;
  animation: speech-pulse 1.2s ease-in-out infinite;
}
@keyframes speech-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
:global([data-motion="reduce"]) .wave {
  animation: none;
}
.speech-enter-active,
.speech-leave-active {
  transition: opacity 0.18s var(--ease), transform 0.18s var(--ease);
}
.speech-enter-from,
.speech-leave-to {
  opacity: 0;
  transform: translate(-50%, -8px);
}
</style>
