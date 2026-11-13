<script setup lang="ts">
import { AlertTriangle, Check, Loader2, Mic, MicOff } from "lucide-vue-next";
import { computed } from "vue";
import { dictation } from "../lib/dictation";
import { ptt } from "../lib/ptt";
import { settings } from "../lib/settings";

/**
 * Pastille « parler à MASTER » : montre à quelle étape en est la demande vocale (écoute, transcription, réponse),
 * pour qu'on sache toujours si l'agent nous entend. Fenêtre cachée : seuls les bips (sound.pttBeep) restent.
 */

const BARS = 5;
const key = computed(() => settings.general.pttKey || "la touche");
/** Hauteur de chaque barre du vumètre, selon le niveau du micro. */
const bars = computed(() =>
  Array.from({ length: BARS }, (_, i) => {
    const center = 1 - Math.abs(i - (BARS - 1) / 2) / BARS;
    return Math.max(0.15, Math.min(1, dictation.level * 1.6 * center + 0.1));
  }),
);
const seconds = computed(() => `${Math.floor(dictation.seconds / 60)}:${String(dictation.seconds % 60).padStart(2, "0")}`);
const heard = computed(() => (ptt.heard.length > 90 ? `${ptt.heard.slice(0, 90)}…` : ptt.heard));
</script>

<template>
  <Transition name="ptt">
    <div v-if="ptt.phase !== 'idle'" class="ptt-pill" :class="ptt.phase" role="status" aria-live="polite">
      <template v-if="ptt.phase === 'listening'">
        <span class="rec"><Mic :size="16" /></span>
        <div class="txt">
          <strong>{{ ptt.agent }} t'écoute</strong>
          <span class="tiny muted">relâche {{ key }} pour envoyer · {{ seconds }}</span>
        </div>
        <span class="meter" aria-hidden="true">
          <i v-for="(h, i) in bars" :key="i" :style="{ transform: `scaleY(${h})` }" />
        </span>
      </template>

      <template v-else-if="ptt.phase === 'transcribing'">
        <Loader2 :size="16" class="spin" />
        <div class="txt"><strong>Transcription…</strong><span class="tiny muted">en local, rien ne sort de la machine</span></div>
      </template>

      <template v-else-if="ptt.phase === 'thinking'">
        <Loader2 :size="16" class="spin" />
        <div class="txt">
          <strong>{{ ptt.agent }} réfléchit…</strong>
          <span class="tiny muted heard">« {{ heard }} »</span>
        </div>
      </template>

      <template v-else-if="ptt.phase === 'done'">
        <Check :size="16" class="ok" />
        <div class="txt"><strong>{{ ptt.agent }} a répondu</strong><span class="tiny muted">dans sa conversation</span></div>
      </template>

      <template v-else-if="ptt.phase === 'empty'">
        <MicOff :size="16" />
        <div class="txt"><strong>Rien entendu</strong><span class="tiny muted">garde {{ key }} enfoncée pendant que tu parles</span></div>
      </template>

      <template v-else>
        <AlertTriangle :size="16" class="bad" />
        <div class="txt"><strong>Demande non envoyée</strong><span class="tiny muted">{{ ptt.detail }}</span></div>
      </template>
    </div>
  </Transition>
</template>

<style scoped>
.ptt-pill {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: min(520px, calc(100vw - 32px));
  padding: 10px 16px 10px 12px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--hairline);
  box-shadow: 0 10px 40px -12px rgba(0, 0, 0, 0.6);
  color: var(--text);
  pointer-events: none;
}
.ptt-pill.listening {
  border-color: color-mix(in srgb, var(--danger) 65%, transparent);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--danger) 18%, transparent), 0 10px 40px -12px rgba(0, 0, 0, 0.6);
}
.ptt-pill.failed {
  border-color: color-mix(in srgb, var(--danger) 50%, transparent);
}
.txt {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.txt strong {
  font-size: 13px;
}
.heard {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rec {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--danger);
  color: #fff;
  flex: none;
  animation: rec-pulse 1.2s ease-in-out infinite;
}
.meter {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  flex: none;
}
.meter i {
  display: block;
  width: 3px;
  height: 22px;
  border-radius: 2px;
  background: var(--danger);
  transform-origin: center;
  transition: transform 80ms linear;
}
.ok {
  color: var(--success);
}
.bad {
  color: var(--danger);
}
.spin {
  animation: spin 0.9s linear infinite;
  flex: none;
}
@keyframes rec-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--danger) 55%, transparent);
  }
  50% {
    box-shadow: 0 0 0 7px transparent;
  }
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
:global([data-motion="reduce"]) .rec,
:global([data-motion="reduce"]) .spin {
  animation: none;
}
.ptt-enter-active,
.ptt-leave-active {
  transition: opacity 0.18s var(--ease), transform 0.18s var(--ease);
}
.ptt-enter-from,
.ptt-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
