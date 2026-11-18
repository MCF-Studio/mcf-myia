<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Check,
  CircleStop,
  Ear,
  EarOff,
  FolderGit2,
  Maximize2,
  Mic,
  Minimize2,
  Plus,
  Send,
  Settings2,
  ShieldAlert,
  Trash2,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-vue-next";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import ArcReactor from "../components/ArcReactor.vue";
import Sparkline from "../components/Sparkline.vue";
import { dictation } from "../lib/dictation";
import { bytes, duration } from "../lib/format";
import { ask, ensureConversation, handle, jarvis, listenNow, masterAgent, maybeDailyBriefing, pendingConfirm } from "../lib/jarvis";
import { greeting } from "../lib/jarvisCore";
import { call, inTauri } from "../lib/rpc";
import { settings } from "../lib/settings";
import { piper, playBoot, speech, stopSpeaking } from "../lib/sound";
import { answerConfirm, navigate, state } from "../lib/store";

defineOptions({ name: "JarvisView" });

const j = settings.jarvis;

// ─── horloge ─────────────────────────────────────────────────────────────────
const now = ref(new Date());
let clock: ReturnType<typeof setInterval> | undefined;
const time = computed(() => now.value.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
const date = computed(() => now.value.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }));
const hello = computed(() => greeting(now.value.getHours(), state.info?.userName ?? ""));

// ─── données ─────────────────────────────────────────────────────────────────
interface ProjectRow {
  name: string;
  path: string;
  kinds: string[];
}
interface PlanRow {
  id: string;
  task: string;
  when: string;
  nextRun?: string;
  conversationTitle: string;
}
const projects = ref<ProjectRow[]>([]);
const plans = ref<PlanRow[]>([]);
async function refreshSide() {
  if (!state.ready) return;
  try {
    projects.value = (await call<{ projects: ProjectRow[] }>("projects.list", {}, 8000)).projects;
  } catch {
    /* cœur pas prêt */
  }
  try {
    plans.value = (await call<PlanRow[]>("planner.list", {}, 8000)).sort((a, b) => (a.nextRun ?? "").localeCompare(b.nextRun ?? "")).slice(0, 6);
  } catch {
    /* idem */
  }
}
let side: ReturnType<typeof setInterval> | undefined;

const m = computed(() => state.metrics);
const ramPct = computed(() => (m.value ? (m.value.memoryUsed / m.value.memoryTotal) * 100 : 0));
const gpu = computed(() => m.value?.gpus[0]);
const vramPct = computed(() => (gpu.value ? (gpu.value.memoryUsedMb / gpu.value.memoryTotalMb) * 100 : 0));
const topProcs = computed(() => [...(m.value?.processes ?? [])].sort((a, b) => b.memory - a.memory).slice(0, 5));
const busyAgents = computed(() => (state.overview?.agents ?? []).filter((a) => a.busy > 0));
const models = computed(() => state.overview?.ollama.running ?? []);
const services = computed(() => state.overview?.services ?? []);
const servicesOk = computed(() => services.value.filter((s) => s.ok).length);
const pcService = computed(() => services.value.find((s) => s.id === "pc"));

const telemetry = computed(() => [
  { key: "CPU", value: m.value?.cpuUsage ?? 0, hist: state.history.cpu, sub: m.value ? `${m.value.cpuCores} cœurs` : "" },
  { key: "RAM", value: ramPct.value, hist: state.history.ram, sub: m.value ? `${bytes(m.value.memoryUsed)} / ${bytes(m.value.memoryTotal)}` : "" },
  { key: "GPU", value: gpu.value?.utilization ?? 0, hist: state.history.gpu, sub: gpu.value?.temperatureC ? `${gpu.value.temperatureC} °C` : gpu.value?.name ?? "—" },
  { key: "VRAM", value: vramPct.value, hist: state.history.vram, sub: gpu.value ? `${(gpu.value.memoryUsedMb / 1024).toFixed(1)} / ${(gpu.value.memoryTotalMb / 1024).toFixed(1)} Go` : "—" },
]);

// ─── conversation ────────────────────────────────────────────────────────────
const master = computed(() => masterAgent());

// ─── cerveau : agent et modèle de Jarvis ─────────────────────────────────────
const localModels = ref<string[]>([]);
async function refreshModels() {
  if (!state.ready) return;
  try {
    localModels.value = (await call<{ installed: { name: string }[] }>("models.list", {}, 8000)).installed.map((x) => x.name);
  } catch {
    /* moteur local absent */
  }
}
/** Le bandeau « accès total » est montré à chaque arrivée sur l'onglet, tant que le mode libre est actif. */
const freeWarningSeen = ref(false);
const conv = computed(() => state.open[jarvis.conversationId]);
const feed = computed(() => (conv.value?.messages ?? []).filter((x) => x.role !== "confirm" || x.decision !== "pending").slice(-14));
const confirm = computed(() => pendingConfirm());
const feedEl = ref<HTMLElement>();
watch(
  () => feed.value.length,
  async () => {
    await nextTick();
    feedEl.value?.scrollTo({ top: feedEl.value.scrollHeight, behavior: "smooth" });
  },
);

const input = ref("");
function submit() {
  const t = input.value.trim();
  if (!t) return;
  input.value = "";
  void handle(t, false);
}
function runProtocol(p: { label: string; prompt: string }) {
  jarvis.heard = `Protocole ${p.label}`;
  void ask(p.prompt);
}
function projectBrief(p: ProjectRow) {
  jarvis.heard = `État du projet ${p.name}`;
  void ask(`Donne-moi l'état du projet ${p.name} : branche, changements non commités, derniers commits. Réponds en trois phrases au plus.`);
}

// ─── états affichés ──────────────────────────────────────────────────────────
const PHASES = {
  off: "Hors ligne",
  standby: "En veille · dis mon nom",
  attentive: "À l'écoute",
  hearing: "J'écoute…",
  transcribing: "Transcription…",
  thinking: "Réflexion…",
  speaking: "Je parle",
} as const;
const phaseLabel = computed(() => {
  if (jarvis.busy && confirm.value) return "En attente de ton accord";
  if (jarvis.busy && jarvis.phase !== "speaking") return PHASES.thinking;
  return PHASES[jarvis.phase];
});
const reactorPhase = computed(() => (jarvis.busy && jarvis.phase !== "speaking" && !confirm.value ? "thinking" : jarvis.phase === "off" && jarvis.busy ? "thinking" : jarvis.phase));
// Micro pendant l'écoute ; voix Piper réelle pendant qu'il parle (la voix de Windows ne donne pas de niveau).
const level = computed(() => (dictation.owner === "jarvis" ? dictation.level : speech.speaking ? (speech.level || 0.4) : 0));

// ─── séquence de démarrage ───────────────────────────────────────────────────
const BOOT_LINES = [
  "Initialisation du noyau",
  "Capteurs système",
  "Liaison avec l'agent MASTER",
  "Contrôle du PC",
  "Reconnaissance vocale",
  "Tous les systèmes sont opérationnels",
];
const booting = ref(false);
const bootStep = ref(0);
function runBoot() {
  booting.value = true;
  bootStep.value = 0;
  playBoot();
  const tick = setInterval(() => {
    bootStep.value++;
    if (bootStep.value >= BOOT_LINES.length) {
      clearInterval(tick);
      setTimeout(() => {
        booting.value = false;
        maybeDailyBriefing();
      }, 650);
    }
  }, 330);
}

// ─── plein écran ─────────────────────────────────────────────────────────────
const immersive = ref(false);
async function toggleImmersive() {
  immersive.value = !immersive.value;
  if (inTauri) await getCurrentWindow().setFullscreen(immersive.value).catch(() => undefined);
}
function onKey(e: KeyboardEvent) {
  if (state.view !== "jarvis") return;
  if (e.key === "F11") {
    e.preventDefault();
    void toggleImmersive();
  } else if (e.key === "Escape" && immersive.value && !speech.speaking) void toggleImmersive();
}

// ─── réglages ────────────────────────────────────────────────────────────────
const showSettings = ref(false);
const editingName = ref(false);
const nameDraft = ref(j.name);
function saveName() {
  const n = nameDraft.value.trim().slice(0, 24);
  if (n) j.name = n;
  nameDraft.value = j.name;
  editingName.value = false;
}
function addProtocol() {
  j.protocols.push({ label: "Nouveau", prompt: "" });
}
function removeProtocol(i: number) {
  j.protocols.splice(i, 1);
}

onMounted(() => {
  clock = setInterval(() => (now.value = new Date()), 1000);
  side = setInterval(refreshSide, 30_000);
  void refreshSide();
  window.addEventListener("keydown", onKey);
  if (state.ready && master.value) void ensureConversation().catch(() => undefined);
  void refreshModels();
  if (!jarvis.booted) {
    jarvis.booted = true;
    if (j.bootSequence) runBoot();
    else maybeDailyBriefing();
  } else maybeDailyBriefing();
});
watch(
  () => [state.ready, master.value?.id, j.agentId, j.model, j.free, j.name],
  () => {
    if (state.ready && master.value) void ensureConversation().catch(() => undefined);
    void refreshSide();
    if (!booting.value) maybeDailyBriefing();
  },
);
onUnmounted(() => {
  clearInterval(clock);
  clearInterval(side);
  window.removeEventListener("keydown", onKey);
  if (immersive.value && inTauri) void getCurrentWindow().setFullscreen(false).catch(() => undefined);
});

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const fmtNext = (iso?: string) => (iso ? new Date(iso).toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "—");
</script>

<template>
  <div class="jarvis" :class="{ immersive }">
    <div class="grid-bg" aria-hidden="true" />
    <div class="scan" aria-hidden="true" />

    <!-- ─── barre du haut ─── -->
    <header class="hud-top">
      <div class="ident">
        <span class="hex" aria-hidden="true" />
        <div>
          <div v-if="!editingName" class="name" title="Cliquer pour renommer" @click="(editingName = true), (nameDraft = j.name)">{{ j.name }}</div>
          <input v-else v-model="nameDraft" class="input name-input" maxlength="24" autofocus @keydown.enter="saveName" @keydown.esc="editingName = false" @blur="saveName" />
          <small>{{ hello }} · assistant {{ master ? `relié à ${master.name}` : "sans agent MASTER" }}</small>
        </div>
      </div>
      <div class="phase-chip" :class="`ph-${reactorPhase}`"><span class="dot" />{{ phaseLabel }}</div>
      <div class="clock">
        <strong class="mono">{{ time }}</strong>
        <small>{{ date }}</small>
      </div>
      <div class="controls">
        <button class="hud-btn" :class="{ on: j.handsFree }" :title="j.handsFree ? 'Couper l\'écoute mains libres' : 'Écoute mains libres'" @click="j.handsFree = !j.handsFree">
          <component :is="j.handsFree ? Ear : EarOff" :size="17" />
          <span>Mains libres</span>
        </button>
        <button class="hud-btn icon" :class="{ on: j.speak }" :title="j.speak ? 'Voix activée' : 'Voix coupée'" @click="j.speak = !j.speak">
          <component :is="j.speak ? Volume2 : VolumeX" :size="17" />
        </button>
        <button class="hud-btn icon" :title="immersive ? 'Quitter le plein écran (Échap)' : 'Plein écran (F11)'" @click="toggleImmersive">
          <component :is="immersive ? Minimize2 : Maximize2" :size="17" />
        </button>
        <button class="hud-btn icon" :class="{ on: showSettings }" title="Réglages de l'assistant" @click="showSettings = !showSettings">
          <Settings2 :size="17" />
        </button>
      </div>
    </header>

    <div v-if="j.free && !freeWarningSeen" class="alert danger">
      <ShieldAlert :size="18" />
      <span>
        <strong>Attention : {{ j.name }} a un accès total à l'ordinateur.</strong> Mode libre : il exécute des commandes PowerShell,
        lit, modifie et supprime des fichiers partout, installe des programmes, sans te demander de confirmation.
      </span>
      <button class="hud-btn" @click="freeWarningSeen = true">Compris</button>
      <button class="hud-btn" @click="(j.free = false), (freeWarningSeen = true)">Désactiver</button>
    </div>

    <div class="brain">
      <label>
        <span>Agent</span>
        <select v-model="j.agentId" class="input">
          <option value="">MASTER{{ state.agents.find((a) => a.master) ? ` (${state.agents.find((a) => a.master)!.name})` : "" }}</option>
          <option v-for="a in state.agents" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
      </label>
      <label>
        <span>Modèle</span>
        <select v-model="j.model" class="input" @focus="refreshModels">
          <option value="auto">Local rapide (auto)</option>
          <option value="">Celui de l'agent{{ master?.model ? ` (${master.model})` : "" }}</option>
          <option v-for="x in localModels" :key="x" :value="x">{{ x }} · local</option>
        </select>
      </label>
      <small v-if="jarvis.model" class="mono muted">en service : {{ jarvis.model }}</small>
      <label class="free" :class="{ on: j.free }" title="Accès total au PC, sans confirmation">
        <input v-model="j.free" type="checkbox" @change="freeWarningSeen = false" />
        <span>Mode libre</span>
      </label>
    </div>

    <div v-if="state.ready && !master" class="alert">
      <ShieldAlert :size="18" />
      <span>Aucun agent : crées-en un dans l'écran Agents pour que {{ j.name }} puisse répondre.</span>
      <button class="hud-btn" @click="navigate('agents')">Ouvrir Agents</button>
    </div>

    <div class="hud-body">
      <!-- ─── colonne gauche : systèmes ─── -->
      <section class="col left">
        <div class="panel">
          <h4><span>Systèmes</span><small class="mono">{{ m ? `${m.os} · ${duration(m.uptimeSecs)}` : "—" }}</small></h4>
          <div class="tele">
            <div v-for="t in telemetry" :key="t.key" class="tele-row" :class="{ hot: t.value >= 85 }">
              <div class="tele-head">
                <span class="k">{{ t.key }}</span>
                <span class="v mono">{{ Math.round(t.value) }}<small>%</small></span>
              </div>
              <div class="bar"><span :style="{ width: `${Math.min(100, t.value)}%` }" /></div>
              <Sparkline :values="t.hist" :height="22" />
              <small class="sub">{{ t.sub }}</small>
            </div>
          </div>
        </div>
        <div class="panel">
          <h4><span>Processus</span><small>mémoire</small></h4>
          <ul class="list">
            <li v-for="p in topProcs" :key="p.pid">
              <span class="ellipsis">{{ p.name }}</span>
              <span class="mono muted">{{ bytes(p.memory) }}</span>
            </li>
            <li v-if="!topProcs.length" class="muted">—</li>
          </ul>
        </div>
        <div class="panel">
          <h4><span>Cœur IA</span><small>{{ servicesOk }}/{{ services.length }} services</small></h4>
          <ul class="list">
            <li v-for="x in models" :key="x.name">
              <span class="ellipsis mono">{{ x.name }}</span>
              <span class="mono muted">{{ bytes(x.sizeVram) }}</span>
            </li>
            <li v-if="!models.length" class="muted">Aucun modèle en mémoire</li>
            <li v-if="pcService" :class="pcService.ok ? '' : 'warn'">
              <span>Contrôle du PC</span>
              <span class="mono" :class="pcService.ok ? 'ok' : 'warn'">{{ pcService.ok ? "en ligne" : pcService.reason }}</span>
            </li>
          </ul>
        </div>
      </section>

      <!-- ─── centre : réacteur ─── -->
      <section class="center">
        <button class="reactor-btn" :title="j.handsFree ? 'Me parler sans dire mon nom' : 'Cliquer et parler'" @click="listenNow">
          <ArcReactor :phase="reactorPhase" :level="level" :size="300">
            <div class="core-label">
              <Mic v-if="dictation.owner === 'jarvis'" :size="22" />
              <Zap v-else :size="22" />
            </div>
          </ArcReactor>
        </button>
        <div class="phase-big">{{ phaseLabel }}</div>
        <div v-if="jarvis.status && jarvis.busy" class="status mono">{{ jarvis.status }}</div>
        <div v-if="jarvis.heard" class="heard">« {{ jarvis.heard }} »</div>
        <div v-if="jarvis.reply && !jarvis.busy" class="reply">{{ jarvis.reply.length > 320 ? `${jarvis.reply.slice(0, 320)}…` : jarvis.reply }}</div>
        <div v-if="jarvis.error" class="err">{{ jarvis.error }}</div>
        <button v-if="speech.speaking" class="hud-btn stop" @click="stopSpeaking"><CircleStop :size="16" /> Arrêter la voix</button>

        <!-- confirmation en attente : bouton ou « oui » / « non » à voix haute -->
        <Transition name="pop">
          <div v-if="confirm" class="confirm-card">
            <div class="confirm-head"><ShieldAlert :size="18" /> Autorisation requise</div>
            <strong>{{ confirm.title }}</strong>
            <pre>{{ confirm.text }}</pre>
            <div class="confirm-actions">
              <button class="hud-btn ok" @click="answerConfirm(confirm.id, true)"><Check :size="16" /> Autoriser</button>
              <button class="hud-btn no" @click="answerConfirm(confirm.id, false)"><X :size="16" /> Refuser</button>
              <small v-if="jarvis.listening">ou dis « oui » / « non »</small>
            </div>
          </div>
        </Transition>
      </section>

      <!-- ─── colonne droite : projets, agents, planning ─── -->
      <section class="col right">
        <div class="panel">
          <h4><span>Projets</span><small>{{ projects.length }}</small></h4>
          <ul class="list click">
            <li v-for="p in projects.slice(0, 9)" :key="p.path" :title="`${p.path}\nCliquer : état du projet`" @click="projectBrief(p)">
              <span class="ellipsis"><FolderGit2 :size="13" /> {{ p.name }}</span>
              <span class="tags">{{ p.kinds.join(" · ") }}</span>
            </li>
            <li v-if="!projects.length" class="muted">Aucun projet (Paramètres → Général → dossiers de projets)</li>
          </ul>
        </div>
        <div class="panel">
          <h4><span>Agents actifs</span><small>{{ state.overview?.agents.length ?? 0 }} agent{{ (state.overview?.agents.length ?? 0) > 1 ? "s" : "" }}</small></h4>
          <ul class="list">
            <li v-for="a in busyAgents" :key="a.id">
              <span class="ellipsis"><i class="pip" :style="{ background: a.color ?? 'var(--accent)' }" /> {{ a.name }}</span>
              <span class="mono ok">en cours</span>
            </li>
            <li v-if="!busyAgents.length" class="muted">Tous au repos</li>
          </ul>
        </div>
        <div v-if="jarvis.alerts.length" class="panel alerts">
          <h4><span>Sentinelle</span><small>{{ jarvis.alerts.length }}</small></h4>
          <ul class="list">
            <li v-for="a in jarvis.alerts" :key="a.ts">
              <span class="alert-txt">{{ a.text }}</span>
              <span class="mono muted">{{ fmtTime(new Date(a.ts).toISOString()) }}</span>
            </li>
          </ul>
        </div>
        <div class="panel">
          <h4><span>Planning</span><small>{{ plans.length }}</small></h4>
          <ul class="list">
            <li v-for="p in plans" :key="p.id" :title="p.conversationTitle">
              <span class="ellipsis">{{ p.task }}</span>
              <span class="mono muted">{{ fmtNext(p.nextRun) }}</span>
            </li>
            <li v-if="!plans.length" class="muted">Rien de prévu · « rappelle-moi dans 20 minutes… »</li>
          </ul>
        </div>
      </section>
    </div>

    <!-- ─── bas : protocoles, journal, commande ─── -->
    <footer class="hud-bottom">
      <div class="protocols">
        <button v-for="p in j.protocols" :key="p.label" class="proto" :disabled="!p.prompt || jarvis.busy" :title="p.prompt" @click="runProtocol(p)">
          <Zap :size="13" /> {{ p.label }}
        </button>
      </div>
      <div ref="feedEl" class="feed">
        <div v-for="x in feed" :key="x.id" class="line" :class="x.role">
          <span class="ts mono">{{ fmtTime(x.ts) }}</span>
          <span class="who">{{ x.role === "user" ? (x.from ?? "Toi") : x.role === "assistant" ? j.name : x.role === "progress" ? "SYS" : x.role === "error" ? "ERR" : "ACC" }}</span>
          <span class="txt">{{ x.role === "confirm" ? `${x.title} → ${x.decision === "approved" ? "autorisé" : "refusé"}` : x.text }}</span>
        </div>
        <div v-if="!feed.length" class="line muted"><span class="txt">Dis « {{ j.name }}, fais-moi un briefing » ou tape une commande ci-dessous.</span></div>
      </div>
      <form class="cmd" @submit.prevent="submit">
        <span class="prompt mono">&gt;</span>
        <input v-model="input" :placeholder="`Commande pour ${j.name}… (ex. « mets le volume à 30 », « ferme Chrome », « build mon projet »)`" :disabled="!state.ready" />
        <button class="hud-btn" type="submit" :disabled="!input.trim() || !state.ready"><Send :size="15" /></button>
      </form>
    </footer>

    <!-- ─── séquence de démarrage ─── -->
    <Transition name="boot">
      <div v-if="booting" class="boot" @click="booting = false">
        <ArcReactor phase="thinking" :level="0.2 + bootStep * 0.12" :size="200" />
        <div class="boot-name mono">{{ j.name }}</div>
        <ul class="boot-lines mono">
          <li v-for="(l, i) in BOOT_LINES" :key="l" :class="{ on: i < bootStep, last: i === BOOT_LINES.length - 1 }">
            <span>{{ i < bootStep ? (i === BOOT_LINES.length - 1 ? "▶" : "✓") : "·" }}</span> {{ l }}
          </li>
        </ul>
        <div class="boot-bar"><i :style="{ width: `${(bootStep / BOOT_LINES.length) * 100}%` }" /></div>
      </div>
    </Transition>

    <!-- ─── réglages ─── -->
    <Transition name="slide">
      <aside v-if="showSettings" class="drawer">
        <h3>Réglages de {{ j.name }} <button class="hud-btn icon" @click="showSettings = false"><X :size="16" /></button></h3>
        <label class="row">
          <span>Nom (et mot d'éveil)</span>
          <input v-model.lazy="j.name" class="input" maxlength="24" @change="j.name = j.name.trim() || 'JARVIS'" />
        </label>
        <label class="row check">
          <input v-model="j.wakeWord" type="checkbox" />
          <span>Mains libres : il faut dire « {{ j.name }} » avant la demande</span>
        </label>
        <label class="row check">
          <input v-model="j.background" type="checkbox" />
          <span>Continuer d'écouter hors de cet onglet</span>
        </label>
        <label class="row check">
          <input v-model="j.speak" type="checkbox" />
          <span>Lire les réponses à voix haute (voix choisie dans Paramètres → Son et voix)</span>
        </label>
        <label class="row check">
          <input v-model="j.sentinel" type="checkbox" />
          <span>Sentinelle : me prévenir si le PC chauffe ou sature, et quand un agent a fini</span>
        </label>
        <label class="row check">
          <input v-model="j.dailyBriefing" type="checkbox" />
          <span>Briefing automatique à la première ouverture de la journée</span>
        </label>
        <label class="row check">
          <input v-model="j.bootSequence" type="checkbox" />
          <span>Séquence de démarrage</span>
        </label>
        <p v-if="!piper.ready" class="hint">
          Astuce : installe la <strong>voix neuronale</strong> (Paramètres → Son et voix) pour une vraie voix d'assistant, et un modèle
          de vision (ex. <code>qwen2.5vl:7b</code>, écran Modèles) pour « {{ j.name }}, regarde mon écran ».
        </p>
        <label class="row">
          <span>Enchaîner sans redire le nom pendant <strong>{{ j.followUp }} s</strong></span>
          <input v-model.number="j.followUp" type="range" min="0" max="30" step="1" />
        </label>
        <label class="row">
          <span>Sensibilité du micro <small>(seuil {{ j.sensitivity }} ; plus bas = capte les voix plus faibles)</small></span>
          <input v-model.number="j.sensitivity" type="range" min="4" max="40" step="1" />
        </label>
        <h4>Protocoles <button class="hud-btn icon" title="Ajouter" @click="addProtocol"><Plus :size="15" /></button></h4>
        <p class="hint">Un clic (ou « protocole &lt;nom&gt; » à voix haute) envoie la demande à {{ j.name }}.</p>
        <div v-for="(p, i) in j.protocols" :key="i" class="proto-edit">
          <div class="proto-line">
            <input v-model="p.label" class="input" maxlength="30" placeholder="Nom" />
            <button class="hud-btn icon" title="Supprimer" @click="removeProtocol(i)"><Trash2 :size="14" /></button>
          </div>
          <textarea v-model="p.prompt" class="input" rows="3" placeholder="Ce que l'assistant doit faire" />
        </div>
        <p class="hint">
          {{ j.name }} agit à travers l'agent MASTER et ses outils : fenêtres, son, médias, captures, processus, alimentation, projets,
          git, fichiers… Les actions sensibles demandent toujours ton accord (sauf si tu as activé le mode bypass des agents).
        </p>
      </aside>
    </Transition>
  </div>
</template>

<style scoped>
.jarvis {
  --hud: var(--accent);
  --hud-2: var(--accent-2);
  --hud-line: color-mix(in srgb, var(--accent) 28%, transparent);
  --hud-fill: color-mix(in srgb, var(--surface) 72%, transparent);
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 18px 14px;
  overflow: hidden;
  min-height: 0;
}
.jarvis.immersive {
  position: fixed !important;
  inset: 0;
  z-index: 60;
  background: var(--bg);
}
.grid-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(var(--hud-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--hud-line) 1px, transparent 1px);
  background-size: 44px 44px;
  opacity: 0.18;
  mask-image: radial-gradient(ellipse at center, #000 30%, transparent 80%);
}
.scan {
  position: absolute;
  left: 0;
  right: 0;
  height: 120px;
  pointer-events: none;
  background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--hud) 7%, transparent), transparent);
  top: -120px;
}
:root[data-motion="full"] .scan {
  animation: scan 9s linear infinite;
}
@keyframes scan {
  to {
    top: 100%;
  }
}

/* ─── haut ─── */
.hud-top {
  position: relative;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 14px;
  border: 1px solid var(--hud-line);
  border-radius: var(--radius);
  background: var(--hud-fill);
  backdrop-filter: blur(6px);
  clip-path: polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px));
}
.ident {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex: 1;
}
.hex {
  width: 26px;
  height: 30px;
  background: var(--lava);
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
  box-shadow: 0 0 18px var(--glow);
  flex: none;
}
.name {
  font-family: var(--mono);
  font-size: 1.35rem;
  font-weight: 700;
  letter-spacing: 0.32em;
  color: var(--hud);
  text-shadow: 0 0 14px var(--glow);
  cursor: text;
  line-height: 1.1;
}
.name-input {
  font-family: var(--mono);
  font-size: 1.1rem;
  letter-spacing: 0.2em;
  width: 220px;
}
.ident small {
  color: var(--text-muted);
  font-size: 0.75rem;
}
.phase-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border-radius: 99px;
  border: 1px solid var(--hud-line);
  font-size: 0.78rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  white-space: nowrap;
}
.phase-chip .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
}
.phase-chip:not(.ph-off) .dot {
  background: var(--hud);
  box-shadow: 0 0 10px var(--hud);
  animation: pulse 1.6s infinite;
}
.phase-chip.ph-hearing,
.phase-chip.ph-attentive {
  color: var(--hud);
}
.clock {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  line-height: 1.15;
}
.clock strong {
  font-size: 1.15rem;
  color: var(--text);
  letter-spacing: 0.06em;
}
.clock small {
  color: var(--text-muted);
  font-size: 0.72rem;
  text-transform: capitalize;
}
.controls {
  display: flex;
  gap: 6px;
}
.hud-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--hud-line);
  background: color-mix(in srgb, var(--bg) 50%, transparent);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.82rem;
  transition: all 0.15s;
}
.hud-btn.icon {
  width: 32px;
  padding: 0;
  justify-content: center;
}
.hud-btn:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--hud);
}
.hud-btn.on {
  color: var(--accent-contrast);
  background: var(--lava);
  border-color: transparent;
  box-shadow: 0 0 14px var(--glow);
}
.hud-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.alert {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: var(--radius);
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  background: color-mix(in srgb, var(--warning) 10%, var(--surface));
  color: var(--warning);
  font-size: 0.86rem;
}
.alert span {
  flex: 1;
  color: var(--text);
}
.alert.danger {
  border-color: color-mix(in srgb, var(--danger, #ef4444) 55%, transparent);
  background: color-mix(in srgb, var(--danger, #ef4444) 12%, var(--surface));
  color: var(--danger, #ef4444);
}
.brain {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  font-size: 0.8rem;
}
.brain label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.brain label > span {
  color: var(--text-muted, var(--muted));
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.7rem;
}
.brain select {
  min-width: 150px;
  max-width: 240px;
  padding: 3px 6px;
}
.brain .free {
  margin-left: auto;
  cursor: pointer;
}
.brain .free.on > span {
  color: var(--danger, #ef4444);
  font-weight: 600;
}

/* ─── corps ─── */
.hud-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(320px, 1.5fr) minmax(220px, 1fr);
  gap: 14px;
}
.col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: auto;
  scrollbar-width: thin;
}
.panel {
  position: relative;
  padding: 10px 12px;
  border: 1px solid var(--hud-line);
  border-radius: 10px;
  background: var(--hud-fill);
  backdrop-filter: blur(6px);
}
.panel::before {
  content: "";
  position: absolute;
  top: -1px;
  left: 12px;
  width: 40px;
  height: 2px;
  background: var(--hud);
  box-shadow: 0 0 10px var(--hud);
}
.right .panel::before {
  left: auto;
  right: 12px;
}
.panel h4 {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin: 0 0 8px;
  font-size: 0.72rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--hud);
}
.panel h4 small {
  font-size: 0.68rem;
  letter-spacing: 0.04em;
  text-transform: none;
  color: var(--text-muted);
  font-weight: 400;
}
.tele {
  display: grid;
  gap: 8px;
}
.tele-row {
  display: grid;
  gap: 3px;
}
.tele-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.tele-head .k {
  font-size: 0.74rem;
  letter-spacing: 0.14em;
  color: var(--text-muted);
}
.tele-head .v {
  font-size: 1.05rem;
  color: var(--text);
}
.tele-head .v small {
  font-size: 0.7rem;
  color: var(--text-muted);
}
.bar {
  height: 4px;
  border-radius: 99px;
  background: color-mix(in srgb, var(--hud) 12%, transparent);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--lava);
  box-shadow: 0 0 8px var(--glow);
  transition: width 0.6s var(--ease);
}
.tele-row.hot .bar span {
  background: var(--danger);
}
.tele-row.hot .v {
  color: var(--danger);
}
.sub {
  font-size: 0.68rem;
  color: var(--text-muted);
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
  font-size: 0.82rem;
}
.list li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 6px;
  border-radius: 6px;
  align-items: center;
}
.list.click li:not(.muted) {
  cursor: pointer;
}
.list.click li:not(.muted):hover {
  background: color-mix(in srgb, var(--hud) 12%, transparent);
}
.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tags {
  font-size: 0.66rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  white-space: nowrap;
}
.muted {
  color: var(--text-muted);
}
.ok {
  color: var(--success);
  font-size: 0.74rem;
}
.warn {
  color: var(--warning);
  font-size: 0.74rem;
}
.pip {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

/* ─── centre ─── */
.center {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 0;
  overflow: hidden;
  text-align: center;
}
.reactor-btn {
  border: 0;
  background: none;
  padding: 0;
  cursor: pointer;
  border-radius: 50%;
  max-width: 100%;
}
.reactor-btn:focus-visible {
  outline: 2px solid var(--hud);
  outline-offset: 6px;
}
.core-label {
  color: #fff;
  filter: drop-shadow(0 0 8px var(--hud));
}
.phase-big {
  font-family: var(--mono);
  font-size: 0.86rem;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--hud);
}
.status {
  font-size: 0.75rem;
  color: var(--text-muted);
  max-width: 90%;
}
.heard {
  font-size: 0.95rem;
  color: var(--text);
  max-width: 92%;
  font-style: italic;
}
.reply {
  font-size: 0.92rem;
  color: var(--text-muted);
  max-width: 92%;
  line-height: 1.45;
  max-height: 7.5em;
  overflow: auto;
}
.err {
  color: var(--danger);
  font-size: 0.82rem;
  max-width: 90%;
}
.hud-btn.stop {
  margin-top: 4px;
}
.confirm-card {
  position: absolute;
  left: 50%;
  bottom: 6px;
  transform: translateX(-50%);
  width: min(560px, 96%);
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--warning) 60%, transparent);
  background: color-mix(in srgb, var(--warning) 8%, var(--surface-2));
  box-shadow: 0 0 30px -6px color-mix(in srgb, var(--warning) 60%, transparent);
  text-align: left;
  z-index: 3;
}
.confirm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.72rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--warning);
  margin-bottom: 6px;
}
.confirm-card pre {
  margin: 6px 0 10px;
  max-height: 140px;
  overflow: auto;
  font-size: 0.76rem;
  white-space: pre-wrap;
  color: var(--text-muted);
}
.confirm-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.confirm-actions small {
  color: var(--text-muted);
}
.hud-btn.ok {
  color: var(--accent-contrast);
  background: var(--success);
  border-color: transparent;
}
.hud-btn.no:hover {
  border-color: var(--danger);
  color: var(--danger);
}

/* ─── bas ─── */
.hud-bottom {
  position: relative;
  display: grid;
  gap: 8px;
}
.protocols {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.proto {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--hud-line);
  background: color-mix(in srgb, var(--hud) 6%, transparent);
  color: var(--text);
  font-size: 0.78rem;
  letter-spacing: 0.05em;
  cursor: pointer;
  clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%);
  padding-inline: 16px;
}
.proto:hover:not(:disabled) {
  background: color-mix(in srgb, var(--hud) 20%, transparent);
}
.proto:disabled {
  opacity: 0.45;
  cursor: default;
}
.feed {
  height: 118px;
  overflow: auto;
  padding: 6px 10px;
  border: 1px solid var(--hud-line);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  font-size: 0.8rem;
  scrollbar-width: thin;
}
.line {
  display: flex;
  gap: 8px;
  padding: 1px 0;
  line-height: 1.4;
}
.line .ts {
  color: var(--text-muted);
  font-size: 0.7rem;
  flex: none;
  padding-top: 1px;
}
.line .who {
  flex: none;
  width: 64px;
  font-family: var(--mono);
  font-size: 0.72rem;
  color: var(--hud);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.line .txt {
  white-space: pre-wrap;
  word-break: break-word;
  min-width: 0;
}
.line.user .who {
  color: var(--text);
}
.line.progress {
  color: var(--text-muted);
}
.line.error .who,
.line.error .txt {
  color: var(--danger);
}
.line.confirm .who {
  color: var(--warning);
}
.cmd {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 4px 12px;
  border: 1px solid var(--hud-line);
  border-radius: 8px;
  background: var(--hud-fill);
}
.cmd .prompt {
  color: var(--hud);
}
.cmd input {
  flex: 1;
  background: transparent;
  border: 0;
  outline: none;
  color: var(--text);
  padding: 6px 0;
  box-shadow: none;
}

.alerts {
  border-color: color-mix(in srgb, var(--warning) 45%, transparent);
}
.alerts h4 {
  color: var(--warning);
}
.alert-txt {
  white-space: normal;
  font-size: 0.78rem;
}

/* ─── démarrage ─── */
.boot {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: radial-gradient(circle at center, color-mix(in srgb, var(--bg) 93%, transparent), var(--bg) 70%);
  backdrop-filter: blur(6px);
  cursor: pointer;
}
.boot-name {
  font-size: 1.6rem;
  letter-spacing: 0.6em;
  color: var(--hud);
  text-shadow: 0 0 18px var(--glow);
  padding-left: 0.6em;
}
.boot-lines {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 3px;
  font-size: 0.8rem;
  min-width: 300px;
}
.boot-lines li {
  color: color-mix(in srgb, var(--text-muted) 50%, transparent);
  transition: color 0.2s;
}
.boot-lines li.on {
  color: var(--text);
}
.boot-lines li.on span {
  color: var(--success);
}
.boot-lines li.on.last {
  color: var(--hud);
}
.boot-lines li.on.last span {
  color: var(--hud);
}
.boot-bar {
  width: 300px;
  height: 3px;
  border-radius: 99px;
  background: color-mix(in srgb, var(--hud) 15%, transparent);
  overflow: hidden;
}
.boot-bar i {
  display: block;
  height: 100%;
  background: var(--lava);
  box-shadow: 0 0 10px var(--glow);
  transition: width 0.3s var(--ease);
}
.boot-leave-active {
  transition: opacity 0.5s, transform 0.5s var(--ease);
}
.boot-leave-to {
  opacity: 0;
  transform: scale(1.06);
}

/* ─── réglages ─── */
.drawer {
  position: absolute;
  top: 70px;
  right: 18px;
  bottom: 14px;
  width: min(380px, 92%);
  z-index: 10;
  padding: 14px 16px;
  overflow: auto;
  border: 1px solid var(--hud-line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 96%, transparent);
  box-shadow: 0 24px 60px -16px rgba(0, 0, 0, 0.7);
  display: grid;
  align-content: start;
  gap: 10px;
}
.drawer h3,
.drawer h4 {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 0;
}
.drawer h4 {
  margin-top: 6px;
  font-size: 0.8rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--hud);
}
.row {
  display: grid;
  gap: 4px;
  font-size: 0.85rem;
}
.row small {
  color: var(--text-muted);
}
.row.check {
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 8px;
}
.hint {
  margin: 0;
  font-size: 0.76rem;
  color: var(--text-muted);
  line-height: 1.4;
}
.proto-edit {
  display: grid;
  gap: 4px;
}
.proto-line {
  display: flex;
  gap: 6px;
}
.proto-line input {
  flex: 1;
}
.proto-edit textarea {
  resize: vertical;
  font-size: 0.8rem;
}

.pop-enter-active,
.pop-leave-active,
.slide-enter-active,
.slide-leave-active {
  transition: all 0.2s var(--ease);
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translate(-50%, 10px);
}
.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  transform: translateX(20px);
}

@media (max-width: 1100px) {
  .hud-body {
    grid-template-columns: 1fr 1.4fr;
  }
  .right {
    display: none;
  }
}
@media (max-width: 820px) {
  .hud-body {
    grid-template-columns: 1fr;
  }
  .left {
    display: none;
  }
  .controls .hud-btn span {
    display: none;
  }
}
</style>
