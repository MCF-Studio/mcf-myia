<script setup lang="ts">
import { Activity, Bot, Boxes, Cpu, Flame, MemoryStick, MessageSquarePlus, Plug, Server, Zap } from "lucide-vue-next";
import { computed } from "vue";
import AgentAvatar from "../components/AgentAvatar.vue";
import Gauge from "../components/Gauge.vue";
import Sparkline from "../components/Sparkline.vue";
import { bytes, duration, relTime } from "../lib/format";
import { agentById, createConversation, navigate, openConversation, state, toast } from "../lib/store";

const m = computed(() => state.metrics);
const gpu = computed(() => m.value?.gpus[0]);
const ramPct = computed(() => (m.value ? (m.value.memoryUsed / m.value.memoryTotal) * 100 : 0));
const vramPct = computed(() => (gpu.value ? (gpu.value.memoryUsedMb / gpu.value.memoryTotalMb) * 100 : 0));
const ollama = computed(() => state.overview?.ollama);
const running = computed(() => ollama.value?.running ?? []);
const services = computed(() => state.overview?.services ?? []);
const servicesOk = computed(() => services.value.filter((s) => s.ok).length);
const toolsCount = computed(() => services.value.reduce((n, s) => n + s.tools.length, 0));
const agents = computed(() => state.overview?.agents ?? []);
const recent = computed(() => state.conversations.slice(0, 6));

const hello = computed(() => {
  const h = new Date().getHours();
  const name = state.info?.userName && state.info.userName !== "l'utilisateur" ? ` ${state.info.userName}` : "";
  return `${h < 6 ? "Bonne nuit" : h < 18 ? "Bonjour" : "Bonsoir"}${name}`;
});

function expires(iso?: string) {
  if (!iso) return "";
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  return s > 0 ? `déchargé dans ${duration(s)}` : "";
}

async function talkTo(agentId: string) {
  try {
    await createConversation(agentId);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
</script>

<template>
  <div class="page overview">
    <header class="page-head">
      <div>
        <div class="eyebrow">Vue d'ensemble</div>
        <h1>{{ hello }}</h1>
        <p>
          {{ agents.length }} agent{{ agents.length > 1 ? "s" : "" }} ·
          {{ state.overview?.conversations.busy ?? 0 }} en train de répondre ·
          {{ servicesOk }}/{{ services.length }} services actifs
        </p>
      </div>
      <button class="btn primary" :disabled="!agents.length" @click="talkTo(agents[0]!.id)">
        <MessageSquarePlus :size="17" /> Nouvelle conversation
      </button>
    </header>

    <!-- Ressources -->
    <section class="metrics">
      <div class="card metric">
        <div class="metric-top">
          <Gauge :value="m?.cpuUsage ?? 0">{{ Math.round(m?.cpuUsage ?? 0) }}<small>%</small></Gauge>
          <div class="metric-info">
            <span class="metric-label"><Cpu :size="15" /> Processeur</span>
            <strong class="metric-sub" :title="m?.cpuBrand">{{ m?.cpuBrand || "—" }}</strong>
            <span class="muted tiny">{{ m?.cpuCores ?? "—" }} cœurs logiques</span>
          </div>
        </div>
        <Sparkline :values="state.history.cpu" />
      </div>

      <div class="card metric">
        <div class="metric-top">
          <Gauge :value="ramPct">{{ Math.round(ramPct) }}<small>%</small></Gauge>
          <div class="metric-info">
            <span class="metric-label"><MemoryStick :size="15" /> Mémoire</span>
            <strong class="metric-sub">{{ bytes(m?.memoryUsed) }} / {{ bytes(m?.memoryTotal) }}</strong>
            <span class="muted tiny">{{ m?.os }}</span>
          </div>
        </div>
        <Sparkline :values="state.history.ram" />
      </div>

      <div class="card metric">
        <div class="metric-top">
          <Gauge :value="gpu?.utilization ?? 0">{{ gpu ? Math.round(gpu.utilization) : "—" }}<small v-if="gpu">%</small></Gauge>
          <div class="metric-info">
            <span class="metric-label"><Zap :size="15" /> GPU</span>
            <strong class="metric-sub" :title="gpu?.name">{{ gpu?.name ?? "Aucun GPU NVIDIA détecté" }}</strong>
            <span v-if="gpu?.temperatureC !== undefined" class="muted tiny">{{ gpu.temperatureC }} °C</span>
          </div>
        </div>
        <Sparkline :values="state.history.gpu" />
      </div>

      <div class="card metric">
        <div class="metric-top">
          <Gauge :value="vramPct">{{ gpu ? Math.round(vramPct) : "—" }}<small v-if="gpu">%</small></Gauge>
          <div class="metric-info">
            <span class="metric-label"><Flame :size="15" /> VRAM</span>
            <strong class="metric-sub">
              {{ gpu ? `${(gpu.memoryUsedMb / 1024).toFixed(1).replace(".", ",")} / ${(gpu.memoryTotalMb / 1024).toFixed(0)} Go` : "—" }}
            </strong>
            <span class="muted tiny">les modèles chargés vivent ici</span>
          </div>
        </div>
        <Sparkline :values="state.history.vram" />
      </div>
    </section>

    <section class="cols">
      <!-- Modèles en mémoire -->
      <div class="card models">
        <div class="card-head">
          <h3><Boxes :size="17" /> Modèles en mémoire</h3>
          <span class="badge" :class="ollama?.ok ? 'ok' : 'warn'">
            <span class="dot" :class="ollama?.ok ? 'ok' : 'err'" />
            Ollama {{ ollama?.ok ? ollama.version : "hors ligne" }}
          </span>
        </div>
        <div v-if="running.length" class="model-list">
          <div v-for="r in running" :key="r.name" class="model-row">
            <div class="model-glyph"><Flame :size="18" /></div>
            <div class="model-meta">
              <div class="row">
                <strong class="mono">{{ r.name }}</strong>
                <span v-if="r.name === state.overview?.defaultModel" class="badge accent">par défaut</span>
              </div>
              <div class="bar"><i :style="{ width: `${r.size ? (r.sizeVram / r.size) * 100 : 0}%` }" /></div>
              <div class="row tiny muted">
                <span>{{ bytes(r.sizeVram) }} en VRAM sur {{ bytes(r.size) }}</span>
                <span class="spacer" />
                <span>{{ expires(r.expiresAt) }}</span>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="empty small">
          <Boxes :size="28" />
          <div>
            Aucun modèle chargé.<br />
            <span class="tiny">Le premier message en charge un ({{ state.overview?.defaultModel ?? "—" }}).</span>
          </div>
        </div>
        <button class="btn sm ghost foot" @click="navigate('models')">Gérer les modèles →</button>
      </div>

      <!-- Agents -->
      <div class="card agents">
        <div class="card-head">
          <h3><Bot :size="17" /> Agents</h3>
          <span class="badge">{{ agents.length }}</span>
        </div>
        <div class="agent-list">
          <button v-for="a in agents" :key="a.id" class="agent-row" @click="talkTo(a.id)" :title="`Parler à ${a.name}`">
            <AgentAvatar :agent="a" :busy="a.busy > 0" />
            <div class="agent-meta">
              <strong>{{ a.name }}</strong>
              <span class="mono tiny muted">{{ a.model }}</span>
            </div>
            <span class="badge" :class="{ accent: a.busy }">
              {{ a.busy ? `répond (${a.busy})` : `${a.conversations} conv.` }}
            </span>
          </button>
        </div>
        <button class="btn sm ghost foot" @click="navigate('agents')">Gérer les agents →</button>
      </div>

      <!-- Services -->
      <div class="card services">
        <div class="card-head">
          <h3><Plug :size="17" /> Services</h3>
          <span class="badge">{{ toolsCount }} outils</span>
        </div>
        <ul class="service-list">
          <li v-for="s in services" :key="s.id" :title="s.ok ? s.tools.join(', ') : s.reason">
            <span class="dot" :class="s.ok ? 'ok' : 'off'" />
            <span class="svc-name">{{ s.label }}</span>
            <span class="tiny muted svc-detail">{{ s.ok ? `${s.tools.length} outil${s.tools.length > 1 ? "s" : ""}` : s.reason }}</span>
          </li>
        </ul>
      </div>
    </section>

    <section class="cols two">
      <!-- Activité -->
      <div class="card">
        <div class="card-head">
          <h3><Activity :size="17" /> Conversations récentes</h3>
          <button class="btn sm ghost" @click="navigate('conversations')">Tout voir →</button>
        </div>
        <div v-if="recent.length" class="recent">
          <button v-for="c in recent" :key="c.id" class="recent-row" @click="openConversation(c.id)">
            <AgentAvatar :agent="agentById(c.agentId)" :size="28" :busy="state.open[c.id]?.busy" />
            <div class="recent-meta">
              <strong>{{ c.title }}</strong>
              <span class="tiny muted">{{ c.lastMessage ?? "—" }}</span>
            </div>
            <span class="tiny muted">{{ relTime(c.updatedAt) }}</span>
          </button>
        </div>
        <div v-else class="empty small">Pas encore de conversation.</div>
      </div>

      <!-- Processus -->
      <div class="card">
        <div class="card-head">
          <h3><Server :size="17" /> Processus</h3>
          <span class="tiny muted">machine allumée depuis {{ m ? duration(m.uptimeSecs) : "—" }}</span>
        </div>
        <table v-if="m?.processes.length" class="table small">
          <thead>
            <tr><th>Processus</th><th>PID</th><th>CPU</th><th>Mémoire</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in m.processes" :key="p.pid">
              <td>{{ p.name }}</td>
              <td class="mono muted">{{ p.pid }}</td>
              <td class="mono">{{ p.cpu.toFixed(1).replace(".", ",") }} %</td>
              <td class="mono">{{ bytes(p.memory) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty small">Ni Ollama ni le cœur MyIA ne tournent.</div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.overview {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
}
.page-head {
  margin-bottom: calc(var(--gap) * 0.5);
}
.metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--gap);
}
@media (max-width: 1280px) {
  .metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.metric {
  padding-bottom: 0;
  overflow: hidden;
  animation: rise 0.4s var(--ease) both;
}
.metric:nth-child(2) {
  animation-delay: 0.04s;
}
.metric:nth-child(3) {
  animation-delay: 0.08s;
}
.metric:nth-child(4) {
  animation-delay: 0.12s;
}
.metric-top {
  display: flex;
  gap: 14px;
  align-items: center;
}
.metric-top small {
  font-size: 0.65em;
  color: var(--text-muted);
  margin-left: 1px;
}
.metric-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.metric-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}
.metric-label svg {
  color: var(--accent);
}
.metric-sub {
  font-size: 0.92rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.metric :deep(.spark) {
  margin: 10px calc(var(--pad) * -1) 0;
  width: calc(100% + var(--pad) * 2);
}
.cols {
  display: grid;
  grid-template-columns: 1.25fr 1fr 1fr;
  gap: var(--gap);
}
.cols.two {
  grid-template-columns: 1.3fr 1fr;
}
@media (max-width: 1280px) {
  .cols {
    grid-template-columns: 1fr 1fr;
  }
  .cols .services {
    grid-column: span 2;
  }
}
.card {
  display: flex;
  flex-direction: column;
}
.foot {
  margin-top: auto;
  align-self: flex-start;
  padding-left: 0;
}
.foot:hover {
  background: none;
  color: var(--accent);
}
.model-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-bottom: 10px;
}
.model-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.model-glyph {
  width: 38px;
  height: 38px;
  border-radius: var(--radius);
  display: grid;
  place-items: center;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  box-shadow: 0 0 20px -6px var(--glow);
}
.model-meta {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}
.agent-list,
.recent {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0 -8px 10px;
}
.agent-row,
.recent-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border-radius: var(--radius);
  border: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.agent-row:hover,
.recent-row:hover {
  background: var(--surface-2);
}
.agent-meta,
.recent-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.recent-meta strong,
.recent-meta span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.service-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.service-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.svc-name {
  white-space: nowrap;
}
.svc-detail {
  margin-left: auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 55%;
  text-align: right;
}
</style>
