<script setup lang="ts">
import "@xterm/xterm/css/xterm.css";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { Archive, FolderOpen, Gauge, Loader2, RefreshCcwDot, RotateCw, SquareTerminal, X } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { wallpaper } from "../lib/background";
import { settings } from "../lib/settings";
import {
  attach,
  claudeModels,
  compact as compactSession,
  detach,
  loadClaudeModels,
  openClaude,
  resizeTerminal,
  resumeFresh,
  sessionLooksLong,
  switchModel,
  terminals,
  writeTerminal,
} from "../lib/terminals";
import { toast } from "../lib/store";

const props = defineProps<{ tabKey: string; compact?: boolean; closable?: boolean }>();
const emit = defineEmits<{ close: []; replaced: [newKey: string] }>();

const info = computed(() => terminals[props.tabKey]);
const alive = computed(() => !!info.value && info.value.exited === undefined);
const busyHandoff = computed(() => ["écriture", "nettoyage", "reprise"].includes(info.value?.handoff?.step ?? ""));

// Coach : réévalué chaque minute (durée de session) et à chaque sortie (volume).
const tick = ref(0);
const timer = setInterval(() => tick.value++, 60_000);
const longSession = computed(() => (tick.value, info.value?.outBytes, info.value ? sessionLooksLong(info.value) : false));
const elapsed = computed(() => {
  void tick.value;
  const m = info.value ? Math.floor((Date.now() - info.value.startedAt) / 60_000) : 0;
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
});

void loadClaudeModels();

function onModel(e: Event) {
  const el = e.target as HTMLSelectElement;
  const v = el.value;
  if (v) switchModel(props.tabKey, v);
  // L'étiquette ne change qu'à la confirmation : on remet la liste sur l'état connu (en attente ou actuel).
  el.value = info.value?.pendingModel ?? info.value?.model ?? "";
  term?.focus();
}

function snooze() {
  if (info.value) info.value.coachSnoozedUntil = Date.now() + 30 * 60_000;
}

async function fresh() {
  await resumeFresh(props.tabKey);
  const h = info.value?.handoff;
  if (h?.step === "échec") toast(`Passation : ${h.detail}`, "error");
  else if (h) toast("Nouvelle session lancée depuis la passation", "success");
}
const host = ref<HTMLElement>();
let term: Terminal | undefined;
let fit: FitAddon | undefined;
let ro: ResizeObserver | undefined;

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Image de fond derrière le texte : réglage activé et image chargée. */
const bgCfg = settings.appearance.background;
const withImage = computed(() => bgCfg.terminals && !!wallpaper.url);
const imageDim = computed(() => Math.min(95, Math.max(0, bgCfg.terminalDim)) / 100);
const imageStyle = computed(() => {
  const blur = Math.min(24, Math.max(0, bgCfg.blur));
  const fit = bgCfg.fit === "contain" || bgCfg.fit === "tile" ? bgCfg.fit : "cover";
  return {
    backgroundSize: fit === "tile" ? "auto" : fit,
    backgroundRepeat: fit === "tile" ? "repeat" : "no-repeat",
    filter: blur ? `blur(${blur}px)` : undefined,
    inset: `-${blur * 2}px`,
  };
});
// Comme dans App.vue : la data: URL (plusieurs Mo) est posée hors du style réactif.
const imageEl = ref<HTMLDivElement>();
watch([imageEl, () => wallpaper.url], ([el, url]) => {
  if (el) el.style.backgroundImage = url ? `url("${url}")` : "";
});

function theme() {
  return {
    // Fond transparent quand l'image est affichée : xterm peint sinon un aplat opaque par-dessus.
    background: withImage.value ? "#00000000" : cssVar("--bg"),
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

/** Taille déjà envoyée à Claude Code : un redimensionnement lui fait redessiner tout son écran, on n'envoie que les vrais changements. */
let sent = { cols: 0, rows: 0 };
function refit() {
  if (!term || !fit || !info.value || info.value.exited !== undefined) return;
  // Panneau masqué (onglet inactif, v-show) : rien à mesurer, on refera le calcul à son affichage.
  if (!host.value?.offsetParent) return;
  try {
    fit.fit();
  } catch {
    return;
  }
  if (term.cols === sent.cols && term.rows === sent.rows) return;
  sent = { cols: term.cols, rows: term.rows };
  void resizeTerminal(info.value.id, term.cols, term.rows).catch(() => undefined);
}
/** Au plus un calcul par image, même si plusieurs consoles de la grille sont redimensionnées ensemble. */
let refitFrame = 0;
function scheduleRefit() {
  if (refitFrame) return;
  refitFrame = requestAnimationFrame(() => {
    refitFrame = 0;
    refit();
  });
}

/**
 * Rendu par la carte graphique (WebGL) : bien plus léger que le rendu DOM quand plusieurs consoles défilent en même
 * temps. Pas avec une image de fond (le fond transparent n'est sûr qu'avec le rendu DOM). Si le contexte WebGL est
 * perdu (trop de consoles, pilote), on revient au rendu DOM.
 */
let webgl: WebglAddon | undefined;
function useWebgl(on: boolean) {
  if (!term) return;
  if (!on) {
    webgl?.dispose();
    webgl = undefined;
    return;
  }
  if (webgl) return;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      if (webgl === addon) webgl = undefined;
    });
    term.loadAddon(addon);
    webgl = addon;
  } catch {
    webgl = undefined; // WebGL indisponible : rendu DOM
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
    allowTransparency: true,
    scrollback: 5000,
    theme: theme(),
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  // Liens : ouverts dans le navigateur système, jamais dans l'app.
  term.loadAddon(new WebLinksAddon((_e, uri) => /^https?:\/\//i.test(uri) && void openUrl(uri)));
  term.open(host.value);
  const id = info.value.id;
  term.onData((d) => writeTerminal(id, d));
  attach(id, (d) => term?.write(d));
  useWebgl(!withImage.value);
  ro = new ResizeObserver(scheduleRefit);
  ro.observe(host.value);
  scheduleRefit();
  term.focus();
});

watch(
  () => settings.appearance.theme,
  () => setTimeout(() => term && (term.options.theme = theme()), 50),
);
watch(withImage, (img) => {
  if (!term) return;
  useWebgl(!img);
  term.options.theme = theme();
});

onBeforeUnmount(() => {
  clearInterval(timer);
  ro?.disconnect();
  cancelAnimationFrame(refitFrame);
  if (info.value) detach(info.value.id);
  webgl?.dispose();
  term?.dispose();
});

async function restart() {
  const i = info.value;
  if (!i) return;
  try {
    const key = await openClaude(i.cwd, i.title, true, i.model);
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
      <template v-if="alive">
        <span v-if="info?.handoff && info.handoff.step !== 'terminée'" class="badge" :class="info.handoff.step === 'échec' ? 'warn' : 'accent'" :title="info.handoff.detail">
          <Loader2 v-if="busyHandoff" :size="11" class="spin" /> passation : {{ info.handoff.step }}
        </span>
        <span v-if="!compact" class="tiny muted session-time" title="Durée de la session"><Gauge :size="12" /> {{ elapsed }}</span>
        <span v-if="info?.model === 'local'" class="badge" title="Claude Code sur ton modèle llama.cpp">local</span>
        <select
          v-else
          class="model-pick"
          :class="{ pending: !!info?.pendingModel }"
          :value="info?.pendingModel ?? info?.model ?? ''"
          :disabled="!!info?.pendingModel"
          :title="info?.pendingModel ? 'Changement de modèle en attente de confirmation par Claude Code…' : 'Changer le modèle Claude (/model)'"
          @change="onModel"
        >
          <option value="" disabled>modèle</option>
          <option v-for="m in claudeModels" :key="m.id" :value="m.id" :title="m.hint">{{ m.label }}{{ info?.pendingModel === m.id ? " …" : "" }}</option>
        </select>
        <button class="btn sm ghost" :class="{ icon: compact }" title="Résumer le contexte sans perdre le fil (/compact)" :disabled="busyHandoff" @click="compactSession(tabKey)">
          <Archive :size="13" /><span v-if="!compact">Compacter</span>
        </button>
        <button
          class="btn sm"
          :class="{ icon: compact }"
          title="Claude écrit une passation, la session est vidée, puis il reprend à partir de la passation"
          :disabled="busyHandoff"
          @click="fresh"
        >
          <RefreshCcwDot :size="13" /><span v-if="!compact">Résumer et repartir</span>
        </button>
      </template>
      <span v-if="info?.exited !== undefined" class="badge">terminé{{ info?.exited != null ? ` (${info.exited})` : "" }}</span>
      <button v-if="info?.exited !== undefined" class="btn sm" @click="restart"><RotateCw :size="13" /> Reprendre</button>
      <button v-if="closable" class="btn sm ghost icon" title="Fermer la console" @click="emit('close')"><X :size="16" /></button>
    </header>
    <div v-if="longSession" class="coach">
      <Gauge :size="16" />
      <span>
        Session longue ({{ elapsed }}, estimation) : le contexte de Claude se remplit, ses réponses vont ralentir et coûter plus.
        <strong>Compacte</strong> ou <strong>repars d'une passation</strong>.
      </span>
      <button class="btn sm" @click="compactSession(tabKey)">Compacter</button>
      <button class="btn sm primary" @click="fresh">Résumer et repartir</button>
      <button class="btn sm ghost icon" title="Plus tard (30 min)" @click="snooze"><X :size="14" /></button>
    </div>
    <div class="term-body">
      <template v-if="withImage">
        <div ref="imageEl" class="term-image" :style="imageStyle" aria-hidden="true" />
        <div class="term-image-dim" :style="{ opacity: imageDim }" aria-hidden="true" />
      </template>
      <div ref="host" class="term-host" @click="term?.focus()" />
    </div>
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
.model-pick {
  height: 30px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface-2);
  padding: 0 6px;
  font-size: 0.8rem;
  cursor: pointer;
}
.model-pick.pending {
  opacity: 0.6;
  font-style: italic;
  cursor: progress;
}
.session-time {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.coach {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  font-size: 0.82rem;
  color: var(--text);
  background: linear-gradient(90deg, color-mix(in srgb, var(--warning) 14%, var(--surface)), var(--surface));
  border-bottom: 1px solid color-mix(in srgb, var(--warning) 35%, transparent);
}
.coach > svg {
  color: var(--warning);
  flex: none;
}
.coach span {
  flex: 1;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.term-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.term-image,
.term-image-dim {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.term-image {
  background-position: center;
}
.term-image-dim {
  background: var(--bg);
}
.term-host {
  position: relative;
  flex: 1;
  min-width: 0;
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
