<script setup lang="ts">
import { ArrowDown, ArrowRight, Crown, X } from "lucide-vue-next";
import { computed } from "vue";
import { agentColor } from "../lib/format";
import { state } from "../lib/store";
import type { TeamNode } from "../lib/types";
import AgentAvatar from "./AgentAvatar.vue";

const props = defineProps<{ node: TeamNode; root?: boolean; relation?: "sub" | "peer"; depth: number }>();
const emit = defineEmits<{ remove: [] }>();

const agent = computed(() => state.agents.find((a) => a.id === props.node.agentId));
const newId = () => crypto.randomUUID().slice(0, 8);
const firstAgent = () => state.agents[0]?.id ?? "myia";

function addSub() {
  props.node.subagents.push({ id: newId(), agentId: firstAgent(), subagents: [], teammates: [] });
}
function addPeer() {
  props.node.teammates.push({ id: newId(), agentId: firstAgent(), subagents: [], teammates: [] });
}
</script>

<template>
  <div class="tn">
    <div class="tn-col">
      <div class="tn-card-row">
      <div class="tn-card" :class="{ root, peer: relation === 'peer' }" :style="{ '--c': agent ? agentColor(agent) : 'var(--danger)' }">
        <div class="tn-top">
          <AgentAvatar :agent="agent ?? { id: node.agentId, name: '?' }" :size="34" />
          <div class="tn-meta">
            <span class="tn-role">
              <template v-if="root"><Crown :size="11" /> Chef d'équipe</template>
              <template v-else-if="relation === 'peer'">Coéquipier</template>
              <template v-else>Sous-agent</template>
            </span>
            <select v-model="node.agentId" class="tn-select" :title="agent?.description">
              <option v-for="a in state.agents" :key="a.id" :value="a.id">{{ a.name }}</option>
              <option v-if="!agent" :value="node.agentId">⚠ {{ node.agentId }} (supprimé)</option>
            </select>
          </div>
          <button v-if="!root" class="tn-x" title="Retirer (avec ses branches)" @click="emit('remove')"><X :size="14" /></button>
        </div>
        <div class="tn-model mono">{{ agent?.model ?? `${state.overview?.defaultModel ?? ""} (défaut)` }}</div>
        <div class="tn-actions">
          <button class="tn-add" title="Ajouter un sous-agent : il reçoit des tâches déléguées" @click="addSub"><ArrowDown :size="13" /> Sous-agent</button>
          <button class="tn-add" title="Ajouter un coéquipier : même niveau, vient en renfort avec ses propres agents" @click="addPeer">
            <ArrowRight :size="13" /> Coéquipier
          </button>
        </div>
      </div>
      <!-- prolonge la liaison horizontale jusqu'au coéquipier quand la branche du dessous est large -->
      <div v-if="node.teammates.length" class="tn-peer-line" />
      </div>

      <div v-if="node.subagents.length" class="tn-children">
        <div v-for="(c, i) in node.subagents" :key="c.id" class="tn-child">
          <TeamNodeView :node="c" relation="sub" :depth="depth + 1" @remove="node.subagents.splice(i, 1)" />
        </div>
      </div>
    </div>

    <div v-for="(t, i) in node.teammates" :key="t.id" class="tn-peer">
      <TeamNodeView :node="t" relation="peer" :depth="depth" @remove="node.teammates.splice(i, 1)" />
    </div>
  </div>
</template>

<style scoped>
.tn {
  display: flex;
  align-items: flex-start;
  /* largeur des cartes et écarts : les liaisons sont calculées à partir de ces valeurs */
  --tn-w: 210px;
  --tn-gap: 22px;
  --tn-peer: 46px;
}
@media (max-width: 640px) {
  .tn {
    --tn-w: 178px;
    --tn-gap: 14px;
    --tn-peer: 30px;
  }
}
.tn-col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  --branch: color-mix(in srgb, var(--accent) 55%, transparent);
}
.tn-card-row {
  display: flex;
  align-items: flex-start;
  align-self: stretch;
}
.tn-peer-line {
  flex: 1;
  margin-top: 56px;
  border-top: 2px dashed color-mix(in srgb, var(--accent-2) 70%, transparent);
}
.tn-card {
  width: var(--tn-w);
  flex: none;
  padding: 12px;
  border-radius: var(--radius-lg);
  background: linear-gradient(180deg, color-mix(in srgb, var(--c) 7%, var(--surface)), var(--surface));
  border: 1px solid color-mix(in srgb, var(--c) 35%, var(--hairline));
  box-shadow: 0 10px 30px -18px var(--c);
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
  z-index: 1;
  animation: rise 0.25s var(--ease) both;
}
.tn-card.root {
  border-color: color-mix(in srgb, var(--c) 70%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--c) 25%, transparent), 0 12px 40px -14px var(--c);
}
.tn-card.peer {
  border-style: dashed;
}
.tn-top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tn-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.tn-role {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--c);
  font-weight: 650;
}
.tn-select {
  width: 100%;
  border: 0;
  background: transparent;
  font-weight: 650;
  padding: 2px 0;
  cursor: pointer;
  outline: none;
}
.tn-select option {
  background: var(--surface-2);
}
.tn-x {
  align-self: flex-start;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 6px;
  padding: 2px;
}
.tn-x:hover {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}
.tn-model {
  font-size: 0.72rem;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tn-actions {
  display: flex;
  gap: 6px;
}
.tn-add {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 26px;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text-muted);
  font-size: 0.72rem;
  cursor: pointer;
}
.tn-add:hover {
  border-color: var(--accent);
  color: var(--accent);
  border-style: solid;
}

/* Branches vers le bas (sous-agents). Les cartes font --tn-w et sont alignées à gauche de leur colonne :
   le centre d'une carte est donc toujours à --tn-w / 2 du bord gauche de sa branche. */
.tn-children {
  display: flex;
  gap: var(--tn-gap);
  padding-top: 34px;
  position: relative;
  align-self: stretch;
}
.tn-children::before {
  content: "";
  position: absolute;
  top: 0;
  left: calc(var(--tn-w) / 2);
  height: 17px;
  border-left: 2px solid var(--branch);
}
.tn-child {
  position: relative;
}
.tn-child::before {
  content: "";
  position: absolute;
  top: -17px;
  left: calc(var(--tn-gap) / -2);
  right: calc(var(--tn-gap) / -2);
  border-top: 2px solid var(--branch);
}
.tn-child:first-child::before {
  left: calc(var(--tn-w) / 2);
}
.tn-child:last-child::before {
  right: auto;
  width: calc(var(--tn-w) / 2 + var(--tn-gap) / 2);
}
.tn-child:first-child:last-child::before {
  display: none;
}
.tn-child::after {
  content: "";
  position: absolute;
  top: -17px;
  left: calc(var(--tn-w) / 2);
  height: 17px;
  border-left: 2px solid var(--branch);
}

/* Branches horizontales (coéquipiers) */
.tn-peer {
  position: relative;
  padding-left: var(--tn-peer);
}
.tn-peer::before {
  content: "";
  position: absolute;
  left: 0;
  top: 56px;
  width: var(--tn-peer);
  border-top: 2px dashed color-mix(in srgb, var(--accent-2) 70%, transparent);
}
.tn-peer::after {
  content: "";
  position: absolute;
  left: calc(var(--tn-peer) / 2 - 5px);
  top: 51px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent-2);
  box-shadow: 0 0 10px var(--accent-2);
}
</style>
