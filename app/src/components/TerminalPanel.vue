<script setup lang="ts">
import "@xterm/xterm/css/xterm.css";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { FolderOpen, RotateCw, SquareTerminal, X } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { settings } from "../lib/settings";
import { attach, detach, openClaude, resizeTerminal, terminals, writeTerminal } from "../lib/terminals";
import { toast } from "../lib/store";

const props = defineProps<{ tabKey: string; compact?: boolean; closable?: boolean }>();
const emit = defineEmits<{ close: []; replaced: [newKey: string] }>();

const info = computed(() => terminals[props.tabKey]);
const host = ref<HTMLElement>();
let term: Terminal | undefined;
let fit: FitAddon | undefined;
let ro: ResizeObserver | undefined;

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function theme() {
  return {
    background: cssVar("--bg"),
    foreground: cssVar("--text"),
    cursor: cssVar("--accent"),
    cursorAccent: cssVar("--bg"),
    selectionBackground: "rgba(255, 122, 26, 0.3)",
    brightBlack: cssVar("--text-muted"),
    yellow: cssVar("--accent-2"),
    brightYellow: cssVar("--accent-2"),
    red: cssVar("--danger"),
    green: cssVar("--success"),
  };
}

function refit() {
  if (!term || !fit || !info.value || info.value.exited !== undefined) return;
  try {
    fit.fit();
    void resizeTerminal(info.value.id, term.cols, term.rows).catch(() => undefined);
  } catch {
    /* panneau masqué */
  }
}

onMounted(() => {
  if (!host.value || !info.value) return;
  term = new Terminal({
    fontFamily: cssVar("--mono") || "Consolas, monospace",
    fontSize: Math.round(13 * (settings.appearance.fontScale / 100)),
    lineHeight: 1.2,
    cursorBlink: true,
    allowProposedApi: false,
    scrollback: 5000,
    theme: theme(),
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  // Liens : ouverts dans le navigateur système, jamais dans l'app.
  term.loadAddon(new WebLinksAddon((_e, uri) => /^https?:\/\//i.test(uri) && void openUrl(uri)));
  term.open(host.value);
  const id = info.value.id;
  term.onData((d) => void writeTerminal(id, d).catch(() => undefined));
  attach(id, (d) => term?.write(d));
  ro = new ResizeObserver(() => refit());
  ro.observe(host.value);
  requestAnimationFrame(refit);
  term.focus();
});

watch(
  () => settings.appearance.theme,
  () => setTimeout(() => term && (term.options.theme = theme()), 50),
);

onBeforeUnmount(() => {
  ro?.disconnect();
  if (info.value) detach(info.value.id);
  term?.dispose();
});

async function restart() {
  const i = info.value;
  if (!i) return;
  try {
    const key = await openClaude(i.cwd, i.title, true);
    emit("replaced", key);
  } catch (e) {
    toast(String(e), "error");
  }
}
</script>

<template>
  <section class="term-panel" :class="{ compact, dead: info?.exited !== undefined }">
    <header class="term-head">
      <div class="term-icon"><SquareTerminal :size="17" /></div>
      <div class="term-title">
        <strong>Claude Code</strong>
        <span class="tiny muted mono" :title="info?.cwd"><FolderOpen :size="11" /> {{ info?.title ?? "—" }}</span>
      </div>
      <span v-if="info?.exited !== undefined" class="badge">terminé{{ info?.exited != null ? ` (${info.exited})` : "" }}</span>
      <button v-if="info?.exited !== undefined" class="btn sm" @click="restart"><RotateCw :size="13" /> Reprendre</button>
      <button v-if="closable" class="btn sm ghost icon" title="Fermer la console" @click="emit('close')"><X :size="16" /></button>
    </header>
    <div ref="host" class="term-host" @click="term?.focus()" />
  </section>
</template>

<style scoped>
.term-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border-radius: var(--radius-lg);
  border: 1px solid color-mix(in srgb, var(--accent-2) 30%, var(--hairline));
  background: var(--bg);
  overflow: hidden;
  box-shadow: 0 10px 40px -24px var(--accent-2);
}
.term-panel.dead {
  border-color: var(--hairline);
  box-shadow: none;
}
.term-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--hairline);
  background: color-mix(in srgb, var(--bg-elevated) 70%, transparent);
}
.term-icon {
  width: 30px;
  height: 30px;
  border-radius: 30%;
  display: grid;
  place-items: center;
  color: var(--accent-2);
  background: color-mix(in srgb, var(--accent-2) 13%, var(--surface-2));
  border: 1px solid color-mix(in srgb, var(--accent-2) 40%, transparent);
}
.term-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.term-title span {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.term-host {
  flex: 1;
  min-height: 0;
  padding: 8px 6px 6px 10px;
  user-select: text;
}
.term-host :deep(.xterm) {
  height: 100%;
}
.term-host :deep(.xterm-viewport) {
  background: transparent !important;
}
</style>
