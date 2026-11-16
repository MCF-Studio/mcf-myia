<script setup lang="ts">
// Carte des agents : nœuds lumineux colorés selon l'état, liens de délégation animés quand un agent travaille.
// Placement calculé par lib/topology.ts ; ici on ne fait que dessiner (SVG, couleurs du thème).
import { computed, onBeforeUnmount, onMounted, ref, useId } from "vue";
import { agentColor, initials } from "../lib/format";
import { layout, type NodeStatus, type Placed, type TopoEdge, type TopoGraph } from "../lib/topology";

const props = withDefaults(defineProps<{ graph: TopoGraph; title?: string; height?: number; selected?: string }>(), {
  title: "Carte des agents",
  height: 440,
});
const emit = defineEmits<{ select: [id: string] }>();

const uid = useId();
const box = ref<HTMLDivElement>();
const width = ref(800);
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (!box.value) return;
  width.value = box.value.clientWidth || 800;
  observer = new ResizeObserver(([e]) => (width.value = Math.max(320, e!.contentRect.width)));
  observer.observe(box.value);
});
onBeforeUnmount(() => observer?.disconnect());

const PAD_X = 80;
const PAD_TOP = 84;
const PAD_BOTTOM = 96;
const R = 30;
const R_MAJOR = 40;

// Le placement ne dépend que du graphe et du format, pas de la largeur exacte : redimensionner ne refait pas le calcul.
const aspect = computed(() => Math.round((width.value / props.height) * 2) / 2);
const placed = computed(() => layout(props.graph, Math.max(1, aspect.value)));
const nodes = computed(() =>
  placed.value.map((n) => ({
    ...n,
    cx: PAD_X + n.x * (width.value - PAD_X * 2),
    cy: PAD_TOP + n.y * (props.height - PAD_TOP - PAD_BOTTOM),
    r: n.major ? R_MAJOR : R,
  })),
);
const byId = computed(() => new Map(nodes.value.map((n) => [n.id, n])));

/** Segment raccourci aux bords des cercles (les flèches touchent l'anneau, pas le centre). */
interface DrawnEdge {
  key: string;
  kind: TopoEdge["kind"];
  live: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
const edges = computed(() =>
  props.graph.edges.flatMap((e): DrawnEdge[] => {
    const a = byId.value.get(e.from);
    const b = byId.value.get(e.to);
    if (!a || !b) return [];
    const d = Math.hypot(b.cx - a.cx, b.cy - a.cy) || 1;
    const ux = (b.cx - a.cx) / d;
    const uy = (b.cy - a.cy) / d;
    const gapA = a.r + 8;
    const gapB = b.r + 12;
    // Lien animé : les deux agents travaillent (une délégation est en cours entre eux).
    const live = a.status === "busy" && b.status === "busy";
    // Coéquipiers : deux traits parallèles, un dans chaque sens.
    const off = e.kind === "mate" ? 4 : 0;
    const line = (s: number) => ({
      x1: a.cx + ux * gapA - uy * off * s,
      y1: a.cy + uy * gapA + ux * off * s,
      x2: b.cx - ux * gapB - uy * off * s,
      y2: b.cy - uy * gapB + ux * off * s,
    });
    return e.kind === "mate"
      ? [
          { key: `${e.from}>${e.to}`, kind: e.kind, live, ...line(1) },
          { key: `${e.to}>${e.from}`, kind: e.kind, live, ...swap(line(-1)) },
        ]
      : [{ key: `${e.from}>${e.to}`, kind: e.kind, live, ...line(0) }];
  }),
);
function swap(l: { x1: number; y1: number; x2: number; y2: number }) {
  return { x1: l.x2, y1: l.y2, x2: l.x1, y2: l.y1 };
}

const STATUS: Record<NodeStatus, { color: string; label: string }> = {
  ok: { color: "var(--success)", label: "Prêt" },
  busy: { color: "var(--accent)", label: "Répond" },
  warn: { color: "var(--warning)", label: "À vérifier" },
  error: { color: "var(--danger)", label: "Indisponible" },
};
const photo = (n: Placed) => (n.agent?.avatar?.startsWith("data:image/") ? n.agent.avatar : undefined);
const counts = computed(() => {
  const c: Record<NodeStatus, number> = { ok: 0, busy: 0, warn: 0, error: 0 };
  for (const n of props.graph.nodes) c[n.status]++;
  return c;
});
</script>

<template>
  <div ref="box" class="topo" :style="{ height: `${height}px` }">
    <svg :width="width" :height="height" role="img" :aria-label="`${title} : ${graph.nodes.length} agent(s)`">
      <defs>
        <pattern :id="`${uid}-grid`" width="28" height="28" patternUnits="userSpaceOnUse">
          <path d="M 28 0 L 0 0 0 28" fill="none" class="grid-line" />
        </pattern>
        <marker :id="`${uid}-arrow`" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" class="arrow" />
        </marker>
        <marker :id="`${uid}-arrow-live`" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" class="arrow live" />
        </marker>
        <filter :id="`${uid}-glow`" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <clipPath v-for="n in nodes" :id="`${uid}-clip-${n.id}`" :key="n.id">
          <circle :cx="n.cx" :cy="n.cy" :r="n.r - 7" />
        </clipPath>
      </defs>

      <rect :width="width" :height="height" :fill="`url(#${uid}-grid)`" />
      <text x="20" y="32" class="title">{{ title.toUpperCase() }}</text>

      <g class="edges">
        <line
          v-for="e in edges"
          :key="e.key"
          :x1="e.x1"
          :y1="e.y1"
          :x2="e.x2"
          :y2="e.y2"
          class="edge"
          :class="[e.kind, { live: e.live }]"
          :marker-end="`url(#${uid}-${e.live ? 'arrow-live' : 'arrow'})`"
          :filter="e.live ? `url(#${uid}-glow)` : undefined"
        />
      </g>

      <g
        v-for="n in nodes"
        :key="n.id"
        class="node"
        :class="[n.status, { major: n.major, selected: selected === n.id }]"
        :style="{ '--s': STATUS[n.status].color, '--c': n.agent ? agentColor(n.agent) : 'var(--text-muted)' }"
        tabindex="0"
        role="button"
        :aria-label="`${n.label} — ${STATUS[n.status].label}${n.hint ? ` (${n.hint})` : ''}`"
        @click="emit('select', n.id)"
        @keydown.enter.prevent="emit('select', n.id)"
        @keydown.space.prevent="emit('select', n.id)"
      >
        <title>{{ n.label }} — {{ STATUS[n.status].label }}{{ n.hint ? ` (${n.hint})` : "" }}</title>
        <circle :cx="n.cx" :cy="n.cy" :r="n.r + 6" class="halo" :filter="`url(#${uid}-glow)`" />
        <circle :cx="n.cx" :cy="n.cy" :r="n.r" class="ring" />
        <circle :cx="n.cx" :cy="n.cy" :r="n.r - 7" class="core" />
        <image
          v-if="photo(n)"
          :href="photo(n)"
          :x="n.cx - n.r + 7"
          :y="n.cy - n.r + 7"
          :width="(n.r - 7) * 2"
          :height="(n.r - 7) * 2"
          preserveAspectRatio="xMidYMid slice"
          :clip-path="`url(#${uid}-clip-${n.id})`"
        />
        <text v-else :x="n.cx" :y="n.cy" class="initials" :style="{ fontSize: `${n.r * 0.62}px` }">{{ initials(n.label) }}</text>
        <text :x="n.cx" :y="n.cy + n.r + 20" class="label">{{ n.label }}</text>
      </g>
    </svg>

    <div class="legend">
      <span v-for="(s, k) in STATUS" :key="k" :class="{ none: !counts[k] }"><i :style="{ background: s.color }" />{{ s.label }} {{ counts[k] }}</span>
      <span class="sep" />
      <span><b class="ln sub" />délègue</span>
      <span><b class="ln mate" />coéquipiers</span>
      <span><b class="ln pilot" />pilote</span>
    </div>
  </div>
</template>

<style scoped>
.topo {
  position: relative;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  overflow: hidden;
  background:
    radial-gradient(120% 90% at 50% 0%, color-mix(in srgb, var(--accent-2) 10%, transparent), transparent 70%),
    color-mix(in srgb, var(--bg) 70%, var(--surface));
}
svg {
  display: block;
}
.grid-line {
  stroke: color-mix(in srgb, var(--text-muted) 12%, transparent);
  stroke-width: 1;
}
.title {
  fill: var(--text);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.arrow {
  fill: color-mix(in srgb, var(--text-muted) 75%, transparent);
}
.arrow.live {
  fill: var(--accent-2);
}
.edge {
  stroke: color-mix(in srgb, var(--text-muted) 55%, transparent);
  stroke-width: 1.4;
}
.edge.mate {
  stroke: color-mix(in srgb, var(--accent-2) 55%, transparent);
  stroke-width: 2;
}
.edge.pilot {
  stroke-dasharray: 5 6;
  stroke: color-mix(in srgb, var(--text-muted) 40%, transparent);
}
.edge.live {
  stroke: var(--accent-2);
  stroke-width: 3;
  stroke-dasharray: 14 8;
  animation: flow 0.9s linear infinite;
}
@keyframes flow {
  to {
    stroke-dashoffset: -22;
  }
}
.node {
  cursor: pointer;
  outline: none;
}
.halo {
  fill: none;
  stroke: var(--s);
  stroke-width: 3;
  opacity: 0.45;
}
.ring {
  fill: color-mix(in srgb, var(--s) 12%, var(--bg));
  stroke: var(--s);
  stroke-width: 3;
}
.core {
  fill: color-mix(in srgb, var(--c) 18%, var(--surface));
  stroke: color-mix(in srgb, var(--s) 45%, transparent);
  stroke-width: 1.5;
}
.initials {
  fill: var(--c);
  font-weight: 800;
  text-anchor: middle;
  dominant-baseline: central;
  pointer-events: none;
}
.label {
  fill: var(--text);
  font-size: 13px;
  font-weight: 700;
  text-anchor: middle;
  paint-order: stroke;
  stroke: color-mix(in srgb, var(--bg) 85%, transparent);
  stroke-width: 4px;
}
.node.major .label {
  font-size: 14.5px;
}
.node.busy .halo {
  animation: beat 1.3s ease-in-out infinite;
  transform-box: fill-box;
  transform-origin: center;
}
@keyframes beat {
  50% {
    opacity: 0.9;
    transform: scale(1.12);
  }
}
.node:hover .ring,
.node:focus-visible .ring {
  stroke-width: 4.5;
}
.node.selected .halo {
  opacity: 1;
  stroke-width: 4;
}
.node:focus-visible .halo {
  stroke: var(--text);
}
:global(:root[data-motion="reduce"]) .edge.live,
:global(:root[data-motion="reduce"]) .node.busy .halo {
  animation: none;
}
.legend {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  font-size: 0.78rem;
  color: var(--text-muted);
  pointer-events: none;
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.legend span.none {
  opacity: 0.45;
}
.legend i {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.legend .sep {
  flex: 1;
}
.ln {
  display: inline-block;
  width: 20px;
  border-top: 2px solid color-mix(in srgb, var(--text-muted) 60%, transparent);
}
.ln.mate {
  border-top-color: color-mix(in srgb, var(--accent-2) 70%, transparent);
}
.ln.pilot {
  border-top-style: dashed;
}
</style>
