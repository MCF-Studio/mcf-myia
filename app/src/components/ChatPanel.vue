<script setup lang="ts">
import {
  ArrowUp,
  Check,
  Copy,
  Eraser,
  Loader2,
  Mic,
  Network,
  ShieldAlert,
  Square,
  Volume2,
  X,
} from "lucide-vue-next";
import { computed, nextTick, ref, watch } from "vue";
import { clock } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";
import { call } from "../lib/rpc";
import { settings } from "../lib/settings";
import { speak } from "../lib/sound";
import { dictation, startDictation, stopDictation } from "../lib/dictation";
import { agentById, answerConfirm, cancelConversation, navigate, sendMessage, state, toast } from "../lib/store";
import AgentAvatar from "./AgentAvatar.vue";

const props = defineProps<{ id: string; compact?: boolean; closable?: boolean }>();
const emit = defineEmits<{ close: [] }>();

const conv = computed(() => state.open[props.id]);
const agent = computed(() => (conv.value ? agentById(conv.value.agentId) : undefined));
const team = computed(() => {
  const tid = state.conversations.find((c) => c.id === props.id)?.teamId;
  return tid ? state.teams.find((t) => t.id === tid) : undefined;
});
const model = computed(() => agent.value?.model ?? state.overview?.defaultModel ?? "");
const messages = computed(() =>
  (conv.value?.messages ?? []).filter((m) => settings.conversations.showSteps || m.role !== "progress"),
);

const draft = ref("");
const scroller = ref<HTMLElement>();
const input = ref<HTMLTextAreaElement>();
const editingTitle = ref(false);
const titleDraft = ref("");

async function scrollDown(smooth = true) {
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth && !settings.appearance.reduceMotion ? "smooth" : "auto" });
}
watch(() => conv.value?.messages.length, () => scrollDown());
watch(() => props.id, () => scrollDown(false), { immediate: true });

function autoGrow() {
  const el = input.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, props.compact ? 140 : 220)}px`;
}

async function send() {
  const text = draft.value.trim();
  if (!text || conv.value?.busy) return;
  draft.value = "";
  await nextTick();
  autoGrow();
  await sendMessage(props.id, text);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Enter" || e.isComposing) return;
  const wantsSend = settings.conversations.sendOnEnter ? !e.shiftKey && !e.ctrlKey : e.ctrlKey;
  if (wantsSend) {
    e.preventDefault();
    void send();
  }
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  toast("Copié", "success");
}

function startRename() {
  titleDraft.value = conv.value?.title ?? "";
  editingTitle.value = true;
}
async function saveTitle() {
  editingTitle.value = false;
  const t = titleDraft.value.trim();
  if (!t || !conv.value || t === conv.value.title) return;
  conv.value.title = t;
  await call("conversations.update", { id: props.id, title: t }).catch((e) => toast(e.message, "error"));
}

async function clear() {
  if (!conv.value) return;
  await call("conversations.clear", { id: props.id });
  conv.value.messages = [];
  toast("Conversation effacée (l'agent repart de zéro)");
}

const mine = computed(() => dictation.owner === props.id);

async function toggleDictation() {
  if (mine.value && dictation.state === "recording") return stopDictation();
  if (dictation.state !== "idle") return;
  if (!dictation.ready) {
    toast("Installe d'abord la dictée : Paramètres → Son et voix", "info");
    navigate("settings");
    return;
  }
  try {
    const text = await startDictation(props.id);
    if (!text) return toast("Rien entendu", "info");
    draft.value = draft.value.trim() ? `${draft.value.trim()} ${text}` : text;
    await nextTick();
    autoGrow();
    input.value?.focus();
  } catch (e) {
    const msg = (e as Error).message;
    toast(/Permission|NotAllowed/i.test(msg) ? "Micro refusé : autorise-le dans les paramètres de confidentialité de Windows" : msg, "error");
  }
}

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <section v-if="conv" class="chat" :class="{ compact, busy: conv.busy }">
    <header class="chat-head">
      <AgentAvatar :agent="agent" :size="compact ? 28 : 34" :busy="conv.busy" />
      <div class="chat-title">
        <input
          v-if="editingTitle"
          v-model="titleDraft"
          class="input title-input"
          maxlength="80"
          @keydown.enter="saveTitle"
          @keydown.esc="editingTitle = false"
          @blur="saveTitle"
          autofocus
        />
        <strong v-else @dblclick="startRename" title="Double-clic pour renommer">{{ conv.title }}</strong>
        <span class="tiny muted">
          <span v-if="team" class="team-tag"><Network :size="11" /> {{ team.name }} ·</span>
          {{ agent?.name ?? "Agent supprimé" }}<template v-if="team"> (chef)</template> · <span class="mono">{{ model }}</span>
        </span>
      </div>
      <button v-if="conv.busy" class="btn sm" @click="cancelConversation(id)" title="Interrompre"><Square :size="13" /> Stop</button>
      <button class="btn sm ghost icon" title="Effacer la conversation" :disabled="conv.busy" @click="clear"><Eraser :size="15" /></button>
      <button v-if="closable" class="btn sm ghost icon" title="Fermer" @click="emit('close')"><X :size="16" /></button>
    </header>

    <div ref="scroller" class="chat-body selectable">
      <div v-if="!messages.length" class="empty hello">
        <AgentAvatar :agent="agent" :size="54" />
        <div>
          <strong>{{ agent?.name ?? "MyIA" }}</strong>
          <p class="small muted">{{ agent?.description ?? "Demande ce que tu veux : il choisit l'outil et te montre tout avant d'agir." }}</p>
        </div>
      </div>

      <template v-for="m in messages" :key="m.id">
        <div v-if="m.role === 'user'" class="msg user" :class="{ agent: m.from }">
          <span v-if="m.from" class="from tiny muted">de {{ m.from }}</span>
          <div class="bubble">{{ m.text }}</div>
          <span v-if="settings.conversations.showTimestamps" class="ts">{{ clock(m.ts) }}</span>
        </div>

        <div v-else-if="m.role === 'assistant'" class="msg assistant">
          <div class="bubble md" v-html="renderMarkdown(m.text)" />
          <div class="msg-actions">
            <span v-if="settings.conversations.showTimestamps" class="ts">{{ clock(m.ts) }}</span>
            <button class="btn sm ghost icon" title="Lire à voix haute" @click="speak(m.text, true)"><Volume2 :size="14" /></button>
            <button class="btn sm ghost icon" title="Copier" @click="copy(m.text)"><Copy :size="14" /></button>
          </div>
        </div>

        <div v-else-if="m.role === 'progress'" class="step"><span class="step-dot" />{{ m.text }}</div>

        <div v-else-if="m.role === 'error'" class="msg error"><div class="bubble">{{ m.text }}</div></div>

        <div v-else-if="m.role === 'confirm'" class="confirm" :class="m.decision">
          <div class="confirm-head">
            <ShieldAlert :size="17" />
            <strong>{{ m.title }}</strong>
            <span v-if="m.decision === 'approved'" class="badge ok">exécuté</span>
            <span v-else-if="m.decision === 'refused'" class="badge">refusé</span>
          </div>
          <pre class="confirm-body">{{ m.text }}</pre>
          <div v-if="m.decision === 'pending' && state.confirms[m.id] !== undefined" class="row confirm-actions">
            <button class="btn primary sm" @click="answerConfirm(m.id, true)"><Check :size="14" /> Exécuter</button>
            <button class="btn sm" @click="answerConfirm(m.id, false)">Refuser</button>
          </div>
          <div v-else-if="m.decision === 'pending'" class="tiny muted">En attente (demande expirée si l'app a redémarré).</div>
        </div>
      </template>

      <div v-if="conv.busy" class="typing">
        <Loader2 :size="15" class="spin" />
        <span>{{ agent?.name ?? "L'agent" }} réfléchit…</span>
      </div>
    </div>

    <footer class="composer">
      <textarea
        ref="input"
        v-model="draft"
        class="composer-input"
        rows="1"
        :placeholder="`Écris à ${agent?.name ?? 'l\'agent'}…`"
        @input="autoGrow"
        @keydown="onKeydown"
      />
      <button
        class="mic"
        :class="{ rec: mine && dictation.state === 'recording', wait: mine && dictation.state === 'transcribing' }"
        :style="mine && dictation.state === 'recording' ? { '--lvl': dictation.level } : undefined"
        :disabled="dictation.state !== 'idle' && !mine"
        :title="mine && dictation.state === 'recording' ? `Arrêter (${dictation.seconds} s)` : dictation.ready ? 'Dicter (whisper, local)' : 'Dictée non installée'"
        @click="toggleDictation"
      >
        <Loader2 v-if="mine && dictation.state === 'transcribing'" :size="17" class="spin" />
        <Square v-else-if="mine && dictation.state === 'recording'" :size="14" />
        <Mic v-else :size="17" />
      </button>
      <button class="send" :disabled="!draft.trim() || conv.busy" title="Envoyer" @click="send">
        <ArrowUp :size="18" />
      </button>
    </footer>
  </section>
  <section v-else class="chat loading">
    <Loader2 :size="20" class="spin" />
  </section>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  overflow: hidden;
  transition: border-color 0.3s, box-shadow 0.3s;
}
.chat.busy {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent), 0 10px 40px -20px var(--glow);
}
.chat.loading {
  display: grid;
  place-items: center;
  color: var(--accent);
}
.chat-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--hairline);
  background: color-mix(in srgb, var(--bg-elevated) 60%, transparent);
}
.chat-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.chat-title strong {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: text;
}
.team-tag {
  color: var(--accent-2);
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.title-input {
  height: 28px;
}
.chat-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 18px 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.compact .chat-body {
  padding: 12px 12px 6px;
}
.hello {
  margin: auto;
  max-width: 340px;
}
.msg {
  display: flex;
  flex-direction: column;
  max-width: min(78ch, 88%);
  animation: rise 0.25s var(--ease) both;
}
.msg.user {
  align-self: flex-end;
  align-items: flex-end;
}
/* Message écrit par un autre agent (MASTER) : distingué de l'utilisateur. */
.msg.user.agent .bubble {
  background: var(--surface-2);
  color: var(--text);
  border: 1px solid var(--accent);
  box-shadow: none;
}
.from {
  margin-bottom: 2px;
}
.msg.assistant,
.msg.error {
  align-self: flex-start;
}
.bubble {
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.user .bubble {
  white-space: pre-wrap;
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 88%, black), color-mix(in srgb, var(--accent-2) 75%, var(--accent)));
  color: var(--accent-contrast);
  border-bottom-right-radius: 6px;
  box-shadow: 0 8px 24px -14px var(--glow);
}
.assistant .bubble {
  background: var(--surface-2);
  border: 1px solid var(--hairline);
  border-bottom-left-radius: 6px;
}
.error .bubble {
  background: color-mix(in srgb, var(--danger) 10%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  color: var(--danger);
}
.msg-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.msg:hover .msg-actions {
  opacity: 1;
}
.ts {
  font-size: 0.7rem;
  color: var(--text-muted);
  padding: 3px 6px;
}
.md :deep(p) {
  margin: 0 0 0.6em;
}
.md :deep(p:last-child) {
  margin-bottom: 0;
}
.md :deep(pre) {
  background: var(--bg);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  overflow-x: auto;
  font-size: 0.85em;
}
.md :deep(code) {
  font-size: 0.88em;
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 5px;
}
.md :deep(pre code) {
  background: none;
  padding: 0;
}
.md :deep(ul),
.md :deep(ol) {
  margin: 0.3em 0 0.6em;
  padding-left: 1.3em;
}
.md :deep(a) {
  color: var(--accent);
  cursor: pointer;
}
.md :deep(blockquote) {
  margin: 0.4em 0;
  padding-left: 10px;
  border-left: 3px solid var(--accent);
  color: var(--text-muted);
}
.step {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8rem;
  color: var(--text-muted);
  padding-left: 6px;
}
.step-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.7;
}
.confirm {
  align-self: stretch;
  max-width: 640px;
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  background: color-mix(in srgb, var(--warning) 7%, var(--surface));
  border-radius: var(--radius);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  animation: rise 0.25s var(--ease) both;
}
.confirm.pending {
  box-shadow: 0 0 24px -10px var(--warning);
}
.confirm.approved {
  border-color: color-mix(in srgb, var(--success) 35%, transparent);
  background: color-mix(in srgb, var(--success) 5%, var(--surface));
}
.confirm.refused {
  opacity: 0.6;
  border-color: var(--hairline);
  background: var(--surface);
}
.confirm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--warning);
}
.confirm-head strong {
  color: var(--text);
  flex: 1;
}
.confirm-body {
  margin: 0;
  white-space: pre-wrap;
  font-size: 0.82rem;
  max-height: 260px;
  overflow: auto;
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 10px;
}
.typing {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--accent);
  font-size: 0.85rem;
  padding: 4px 6px;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin: 8px 12px 12px;
  padding: 6px 6px 6px 14px;
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.composer:focus-within {
  border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent), 0 0 30px -12px var(--glow);
}
.composer-input {
  flex: 1;
  border: 0;
  background: transparent;
  outline: none;
  resize: none;
  padding: 8px 0;
  max-height: 220px;
  line-height: 1.5;
  user-select: text;
}
.mic {
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  display: grid;
  place-items: center;
  background: var(--surface-2);
  color: var(--text-muted);
  cursor: pointer;
  position: relative;
  transition: color 0.15s, border-color 0.15s;
}
.mic:hover:not(:disabled) {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
}
.mic:disabled {
  opacity: 0.35;
  cursor: default;
}
.mic.rec {
  color: var(--accent-contrast);
  background: var(--danger);
  border-color: transparent;
  /* halo qui suit le niveau du micro */
  box-shadow: 0 0 0 calc(2px + var(--lvl, 0) * 10px) color-mix(in srgb, var(--danger) 35%, transparent);
  transition: box-shadow 0.08s linear;
}
.mic.wait {
  color: var(--accent);
}
.send {
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: var(--radius);
  border: 0;
  display: grid;
  place-items: center;
  background: var(--lava);
  color: var(--accent-contrast);
  cursor: pointer;
  box-shadow: 0 4px 16px -6px var(--glow);
  transition: opacity 0.15s, transform 0.1s;
}
.send:disabled {
  opacity: 0.3;
  cursor: default;
  box-shadow: none;
}
.send:not(:disabled):active {
  transform: scale(0.94);
}
</style>
