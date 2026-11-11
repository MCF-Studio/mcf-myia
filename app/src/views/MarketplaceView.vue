<script setup lang="ts">
import { BadgeCheck, Bot, Boxes, FileUp, Palette, Puzzle, ShieldCheck, Store, Users } from "lucide-vue-next";
import { computed, ref } from "vue";
import AgentAvatar from "../components/AgentAvatar.vue";
import { pickTextFile } from "../lib/files";
import { call } from "../lib/rpc";
import { settings } from "../lib/settings";
import { navigate, refreshAgents, refreshThemes, state, toast } from "../lib/store";
import { BUILTIN_THEMES } from "../lib/themes";
import type { AgentProfile, Theme } from "../lib/types";

type Tab = "agents" | "models" | "themes" | "extensions";
const tab = ref<Tab>("agents");
const tabs: { id: Tab; label: string; icon: unknown }[] = [
  { id: "agents", label: "Agents", icon: Bot },
  { id: "models", label: "Modèles", icon: Boxes },
  { id: "themes", label: "Thèmes", icon: Palette },
  { id: "extensions", label: "Extensions", icon: Puzzle },
];

const themes = computed(() => [...BUILTIN_THEMES, ...state.installedThemes]);

async function installAgent() {
  try {
    const json = await pickTextFile();
    if (!json) return;
    const p = await call<AgentProfile>("agents.import", { json });
    await refreshAgents();
    toast(`${p.name} installé — vérifie ses consignes dans Agents`, "success");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function installTheme() {
  try {
    const json = await pickTextFile(".json", 32_000);
    if (!json) return;
    const t = await call<Theme>("themes.install", { json });
    await refreshThemes();
    settings.appearance.theme = t.id;
    toast(`Thème « ${t.name} » installé et appliqué`, "success");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
</script>

<template>
  <div class="page market">
    <section class="hero card">
      <div class="hero-glow" aria-hidden="true" />
      <div class="hero-text">
        <span class="badge warn">En préparation</span>
        <h1>Marketplace communautaire</h1>
        <p>
          Bientôt : télécharger et partager des modèles, des agents, des thèmes et des extensions entre membres de la communauté, avec les
          membres certifiés de <strong>mcfstudio.fr</strong>.
        </p>
        <p class="small muted">Le registre en ligne n'est pas encore ouvert. En attendant, tu peux déjà installer un fichier qu'on t'a partagé.</p>
      </div>
      <Store :size="96" class="hero-icon" />
    </section>

    <section class="how">
      <div class="card step">
        <Users :size="20" />
        <strong>Partagé entre membres</strong>
        <span class="small muted">Tu exportes un agent ou un thème depuis l'app ; tu choisis de le partager ou de le garder pour toi.</span>
      </div>
      <div class="card step">
        <BadgeCheck :size="20" />
        <strong>Membres certifiés</strong>
        <span class="small muted">Les publications passeront par les comptes certifiés de mcfstudio.fr.</span>
      </div>
      <div class="card step">
        <ShieldCheck :size="20" />
        <strong>Des données, pas du code</strong>
        <span class="small muted">
          Un agent = nom, consignes, modèle, services autorisés. Un thème = des couleurs. Chaque fichier est vérifié avant installation.
        </span>
      </div>
    </section>

    <div class="row tabs-row">
      <div class="segmented">
        <button v-for="t in tabs" :key="t.id" :class="{ on: tab === t.id }" @click="tab = t.id">
          <component :is="t.icon" :size="15" /> {{ t.label }}
        </button>
      </div>
    </div>

    <section v-if="tab === 'agents'" class="card">
      <div class="card-head">
        <h3><Bot :size="17" /> Agents installés</h3>
        <button class="btn primary sm" @click="installAgent"><FileUp :size="15" /> Installer un fichier .agent.json</button>
      </div>
      <div class="tiles">
        <button v-for="a in state.agents" :key="a.id" class="tile" @click="navigate('agents')">
          <AgentAvatar :agent="a" :size="36" />
          <div>
            <strong>{{ a.name }}</strong>
            <span class="tiny muted">{{ a.description ?? "Pas de description" }}</span>
          </div>
        </button>
      </div>
    </section>

    <section v-else-if="tab === 'themes'" class="card">
      <div class="card-head">
        <h3><Palette :size="17" /> Thèmes</h3>
        <button class="btn primary sm" @click="installTheme"><FileUp :size="15" /> Installer un fichier de thème</button>
      </div>
      <div class="tiles">
        <button
          v-for="t in themes"
          :key="t.id"
          class="tile theme-tile"
          :class="{ on: settings.appearance.theme === t.id }"
          @click="settings.appearance.theme = t.id"
        >
          <div class="theme-preview" :style="{ background: t.colors.bg, borderColor: t.colors.border }">
            <i :style="{ background: t.colors.surface }" />
            <i :style="{ background: `linear-gradient(135deg, ${t.colors.accent}, ${t.colors['accent-2']})` }" />
          </div>
          <div>
            <strong>{{ t.name }}</strong>
            <span class="tiny muted">{{ t.builtin ? "intégré" : `par ${t.author ?? "inconnu"}` }} · {{ t.mode === "dark" ? "sombre" : "clair" }}</span>
          </div>
        </button>
      </div>
    </section>

    <section v-else class="card">
      <div class="empty">
        <component :is="tab === 'models' ? Boxes : Puzzle" :size="34" />
        <h3>{{ tab === "models" ? "Modèles communautaires" : "Extensions" }}</h3>
        <p class="small" style="max-width: 460px">
          <template v-if="tab === 'models'">
            Arrivent avec le registre. D'ici là, tout modèle du catalogue Ollama s'installe depuis l'onglet Modèles.
          </template>
          <template v-else>
            Arrivent avec le registre. Aujourd'hui, un serveur MCP déclaré dans <span class="mono">config/agent.json</span> devient déjà un service
            utilisable par les agents.
          </template>
        </p>
        <button v-if="tab === 'models'" class="btn" @click="navigate('models')">Ouvrir Modèles</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.market {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
}
.hero {
  display: flex;
  align-items: center;
  gap: 30px;
  padding: 32px 36px;
  overflow: hidden;
  border-color: color-mix(in srgb, var(--accent) 30%, var(--hairline));
}
.hero-glow {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(500px 260px at 90% 50%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%),
    radial-gradient(400px 200px at 70% 120%, color-mix(in srgb, var(--accent-2) 18%, transparent), transparent 70%);
  pointer-events: none;
}
.hero-text {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.hero-text h1 {
  font-size: 2rem;
}
.hero-text p {
  margin: 0;
  max-width: 620px;
  line-height: 1.55;
}
.hero-icon {
  position: relative;
  color: var(--accent);
  filter: drop-shadow(0 0 30px var(--glow));
  opacity: 0.9;
  flex: none;
}
.how {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--gap);
}
.step {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.step svg {
  color: var(--accent);
  margin-bottom: 4px;
}
.tabs-row {
  margin-top: 6px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.tile {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: var(--radius);
  border: 1px solid var(--hairline);
  background: var(--bg-elevated);
  cursor: pointer;
  text-align: left;
}
.tile:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--hairline));
}
.tile.on {
  border-color: var(--accent);
  box-shadow: 0 0 24px -12px var(--glow);
}
.tile div:last-child {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tile span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.theme-preview {
  width: 54px;
  height: 40px;
  border-radius: 8px;
  border: 1px solid;
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: none;
}
.theme-preview i {
  display: block;
  border-radius: 3px;
  flex: 1;
}
.theme-preview i:last-child {
  flex: 0 0 7px;
  width: 60%;
}
.empty h3 {
  color: var(--text);
}
</style>
