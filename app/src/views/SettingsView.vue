<script setup lang="ts">
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Bell,
  AppWindow,
  Download,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Info,
  Keyboard,
  MessagesSquare,
  Palette,
  Play,
  RotateCcw,
  RotateCw,
  Search,
  Server,
  SlidersHorizontal,
  Trash2,
  Upload,
  Volume2,
} from "lucide-vue-next";
import { computed, onMounted, ref } from "vue";
import SettingRow from "../components/SettingRow.vue";
import Toggle from "../components/Toggle.vue";
import { downloadText, pickTextFile } from "../lib/files";
import { call, inTauri } from "../lib/rpc";
import { resetSettings, settings } from "../lib/settings";
import { playSound, SOUND_PACKS, speak, stopSpeaking, voices } from "../lib/sound";
import { refreshSidecar, refreshThemes, restartSidecar, state, toast } from "../lib/store";
import { BUILTIN_THEMES, exportTheme } from "../lib/themes";
import type { Theme } from "../lib/types";

type Section = "general" | "appearance" | "sound" | "notifications" | "conversations" | "shortcuts" | "system" | "about";
const section = ref<Section>("appearance");
const sections: { id: Section; label: string; icon: unknown }[] = [
  { id: "general", label: "Général", icon: SlidersHorizontal },
  { id: "appearance", label: "Apparence", icon: Palette },
  { id: "sound", label: "Son et voix", icon: Volume2 },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "conversations", label: "Conversations", icon: MessagesSquare },
  { id: "shortcuts", label: "Raccourcis", icon: Keyboard },
  { id: "system", label: "Système", icon: Server },
  { id: "about", label: "À propos", icon: Info },
];

const a = settings.appearance;
const s = settings.sound;
const n = settings.notifications;
const c = settings.conversations;
const g = settings.general;

const themes = computed<Theme[]>(() => [...BUILTIN_THEMES, ...state.installedThemes]);
const voiceList = ref<SpeechSynthesisVoice[]>([]);
const appVersion = ref("");

const fill = (v: number, min: number, max: number) => ({ "--fill": `${((v - min) / (max - min)) * 100}%` });

async function installTheme() {
  try {
    const json = await pickTextFile(".json", 32_000);
    if (!json) return;
    const t = await call<Theme>("themes.install", { json });
    await refreshThemes();
    a.theme = t.id;
    toast(`Thème « ${t.name} » installé`, "success");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function deleteTheme(id: string) {
  await call("themes.delete", { id });
  if (a.theme === id) a.theme = "volcano";
  await refreshThemes();
}

// ─── Identité et dossiers (config/agent.json, via le cœur) ───────────────────
const userName = ref("");
const roots = ref<{ path: string; depth: number }[]>([]);

async function loadConfigBits() {
  try {
    const c = await call<{ userName: string; projectRoots: { path: string; depth: number }[] }>("config.get");
    userName.value = c.userName === "l'utilisateur" ? "" : c.userName;
    roots.value = c.projectRoots;
  } catch {
    /* cœur arrêté */
  }
}

async function saveName() {
  const name = userName.value.trim();
  if (!name || name === state.info?.userName) return;
  try {
    await call("config.setUserName", { name });
    if (state.info) state.info.userName = name;
    toast(`Enchanté, ${name} !`, "success");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function saveRoots() {
  try {
    await call("config.setProjectRoots", { roots: roots.value });
  } catch (e) {
    toast((e as Error).message, "error");
    await loadConfigBits();
  }
}

async function addRoot() {
  const dir = await openDialog({ directory: true, multiple: false, title: "Dossier qui contient tes projets" });
  if (typeof dir !== "string" || roots.value.some((r) => r.path === dir)) return;
  roots.value.push({ path: dir, depth: 3 });
  await saveRoots();
  toast("Dossier ajouté : tes projets seront détectés", "success");
}

// ─── Programmes lançables par les agents ─────────────────────────────────────
interface Prog {
  name: string;
  path: string;
}
const programs = ref<Prog[]>([]);
const pending = ref<Prog>();
const progQuery = ref("");
const found = ref<(Prog & { source: string })[]>([]);
const searching = ref(false);

async function loadPrograms() {
  programs.value = await call<Prog[]>("programs.list").catch(() => []);
}

async function browseExe() {
  const file = await openDialog({ multiple: false, title: "Programme à ajouter", filters: [{ name: "Programme", extensions: ["exe"] }] });
  if (typeof file !== "string") return;
  const base = file.split(/[\\/]/).pop()!.replace(/\.exe$/i, "");
  pending.value = { name: base.charAt(0).toUpperCase() + base.slice(1), path: file };
}

async function confirmAdd() {
  if (!pending.value) return;
  try {
    await call("programs.add", { name: pending.value.name.trim(), path: pending.value.path });
    toast(`${pending.value.name} ajouté : les agents peuvent le lancer`, "success");
    pending.value = undefined;
    await loadPrograms();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function removeProg(name: string) {
  await call("programs.remove", { name }).catch((e) => toast(e.message, "error"));
  await loadPrograms();
}

async function searchProg() {
  searching.value = true;
  try {
    found.value = await call("programs.search", { query: progQuery.value.trim() });
    if (!found.value.length) toast("Rien trouvé : choisis le .exe à la main");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    searching.value = false;
  }
}

function loadVoices() {
  voiceList.value = voices();
}

onMounted(async () => {
  loadVoices();
  void loadConfigBits();
  void loadPrograms();
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = loadVoices;
  if (inTauri) appVersion.value = await getVersion();
  void refreshSidecar();
});

const shortcuts: [string, string][] = [
  ["Ctrl + 1 … 7", "Aller à une catégorie de la barre latérale"],
  ["Ctrl + B", "Replier / déplier la barre latérale"],
  ["Ctrl + N", "Nouvelle conversation (vue Conversations)"],
  ["Ctrl + Tab", "Onglet de conversation suivant (Maj : précédent)"],
  ["Ctrl + W", "Fermer l'onglet de conversation"],
  ["Entrée", "Envoyer (Maj + Entrée : nouvelle ligne) — modifiable"],
  ["Double-clic sur un titre", "Renommer la conversation"],
  ["Clic molette sur un onglet", "Fermer l'onglet"],
];
</script>

<template>
  <div class="settings">
    <nav class="sub-nav">
      <h2>Paramètres</h2>
      <button v-for="it in sections" :key="it.id" class="sub-item" :class="{ active: section === it.id }" @click="section = it.id">
        <component :is="it.icon" :size="17" />
        {{ it.label }}
      </button>
    </nav>

    <div class="content">
      <!-- Général -->
      <template v-if="section === 'general'">
      <section class="card">
        <h3 class="sec-title">Général</h3>
        <SettingRow label="Vue au démarrage">
          <select v-model="g.startView" class="input select w-220">
            <option value="overview">Vue d'ensemble</option>
            <option value="conversations">Conversations</option>
            <option value="last">Dernière vue ouverte</option>
          </select>
        </SettingRow>
        <SettingRow label="Rafraîchissement des ressources" :hint="`Toutes les ${g.metricsInterval} s. Plus court = plus réactif, un peu plus de CPU.`">
          <input v-model.number="g.metricsInterval" type="range" min="1" max="10" class="w-220" :style="fill(g.metricsInterval, 1, 10)" />
        </SettingRow>
        <SettingRow label="Ton prénom" hint="Comment les agents t'appellent.">
          <input v-model="userName" class="input w-220" maxlength="60" placeholder="Ton prénom" @keydown.enter="saveName" @blur="saveName" />
        </SettingRow>
      </section>

      <section class="card">
        <div class="card-head">
          <h3 class="sec-title">Dossiers de projets</h3>
          <button class="btn sm" @click="addRoot"><FolderPlus :size="14" /> Ajouter un dossier</button>
        </div>
        <p class="tiny muted">
          MyIA y repère tes projets (Godot, Tauri, Rust, Node, dépôts git) pour les builds, la délégation à Claude Code et les consoles.
        </p>
        <div v-for="(r, i) in roots" :key="r.path" class="root-row">
          <FolderOpen :size="16" />
          <code class="path grow">{{ r.path }}</code>
          <label class="tiny muted">profondeur
            <select v-model.number="r.depth" class="input select depth" @change="saveRoots">
              <option v-for="d in [1, 2, 3, 4, 5]" :key="d" :value="d">{{ d }}</option>
            </select>
          </label>
          <button class="btn sm ghost icon danger" title="Retirer" @click="roots.splice(i, 1); saveRoots()"><Trash2 :size="14" /></button>
        </div>
        <div v-if="!roots.length" class="empty small">Aucun dossier : ajoute celui qui contient tes projets.</div>
      </section>

      <section class="card">
        <div class="card-head">
          <h3 class="sec-title">Programmes</h3>
          <button class="btn sm" @click="browseExe"><FilePlus2 :size="14" /> Choisir un .exe</button>
        </div>
        <p class="tiny muted">
          Les agents peuvent lancer ces programmes (« ouvre Blender »). S'il en manque un, ils le cherchent sur le PC et te proposent de
          l'ajouter. Les shells et interpréteurs (cmd, PowerShell, Python…) ne peuvent pas être ajoutés.
        </p>

        <form v-if="pending" class="prog-pending" @submit.prevent="confirmAdd">
          <input v-model="pending.name" class="input" maxlength="40" placeholder="Nom (ex. Blender)" required />
          <code class="path grow" :title="pending.path">{{ pending.path }}</code>
          <button class="btn primary sm" :disabled="!pending.name.trim()">Ajouter</button>
          <button type="button" class="btn ghost sm" @click="pending = undefined">Annuler</button>
        </form>

        <div v-for="p in programs" :key="p.name" class="root-row">
          <AppWindow :size="16" />
          <strong class="prog-name">{{ p.name }}</strong>
          <code class="path grow" :title="p.path">{{ p.path }}</code>
          <button class="btn sm ghost icon danger" title="Retirer" @click="removeProg(p.name)"><Trash2 :size="14" /></button>
        </div>
        <div v-if="!programs.length && !pending" class="empty small">Aucun programme enregistré.</div>

        <form class="prog-search" @submit.prevent="searchProg">
          <Search :size="15" />
          <input v-model="progQuery" placeholder="Chercher un programme installé (ex. obs, blender, steam)" />
          <button class="btn sm" :disabled="progQuery.trim().length < 2 || searching">{{ searching ? "Recherche…" : "Chercher" }}</button>
        </form>
        <div v-for="f in found" :key="f.path" class="root-row found">
          <span class="badge">{{ f.source }}</span>
          <strong class="prog-name">{{ f.name }}</strong>
          <code class="path grow" :title="f.path">{{ f.path }}</code>
          <button class="btn sm" :disabled="programs.some((p) => p.path.toLowerCase() === f.path.toLowerCase())" @click="pending = { name: f.name, path: f.path }">
            Ajouter
          </button>
        </div>
      </section>
      </template>

      <!-- Apparence -->
      <template v-else-if="section === 'appearance'">
        <section class="card">
          <div class="card-head">
            <h3 class="sec-title">Thème</h3>
            <div class="row">
              <button class="btn sm" @click="installTheme"><Upload :size="14" /> Installer</button>
            </div>
          </div>
          <div class="themes">
            <div v-for="t in themes" :key="t.id" class="theme" :class="{ on: a.theme === t.id }" @click="a.theme = t.id">
              <div class="theme-art" :style="{ background: t.colors.bg, borderColor: t.colors.border }">
                <div class="art-side" :style="{ background: t.colors['bg-elevated'] }">
                  <i v-for="k in 4" :key="k" :style="{ background: k === 1 ? t.colors.accent : t.colors.surface }" />
                </div>
                <div class="art-main">
                  <i :style="{ background: t.colors.surface }" />
                  <i :style="{ background: t.colors.surface }" />
                  <b :style="{ background: `linear-gradient(90deg, ${t.colors.accent}, ${t.colors['accent-2']})`, boxShadow: `0 0 12px ${t.colors.glow}` }" />
                </div>
              </div>
              <div class="theme-info">
                <strong>{{ t.name }}</strong>
                <span class="tiny muted">{{ t.builtin ? "intégré" : t.author ?? "communauté" }}</span>
                <span class="spacer" />
                <button class="btn sm ghost icon" title="Exporter" @click.stop="downloadText(`${t.id}.theme.json`, exportTheme(t))">
                  <Download :size="13" />
                </button>
                <button v-if="!t.builtin" class="btn sm ghost icon danger" title="Désinstaller" @click.stop="deleteTheme(t.id)">
                  <Trash2 :size="13" />
                </button>
              </div>
            </div>
          </div>
          <p class="tiny muted">
            Un thème est un fichier JSON de couleurs (aucun code). Exporte un thème intégré pour t'en servir de modèle, puis partage le tien sur la
            Marketplace.
          </p>
        </section>

        <section class="card">
          <h3 class="sec-title">Affichage</h3>
          <SettingRow label="Lumières en fusion" hint="Halo orange autour des éléments actifs et fond ambiant.">
            <Toggle v-model="a.glow" />
          </SettingRow>
          <SettingRow label="Densité">
            <div class="segmented">
              <button :class="{ on: a.density === 'comfortable' }" @click="a.density = 'comfortable'">Confortable</button>
              <button :class="{ on: a.density === 'compact' }" @click="a.density = 'compact'">Compacte</button>
            </div>
          </SettingRow>
          <SettingRow label="Taille du texte" :hint="`${a.fontScale} %`">
            <input v-model.number="a.fontScale" type="range" min="85" max="130" step="5" class="w-220" :style="fill(a.fontScale, 85, 130)" />
          </SettingRow>
          <SettingRow label="Réduire les animations">
            <Toggle v-model="a.reduceMotion" />
          </SettingRow>
          <SettingRow label="Barre latérale repliée" hint="Ctrl + B">
            <Toggle v-model="a.sidebarCollapsed" />
          </SettingRow>
        </section>
      </template>

      <!-- Son -->
      <template v-else-if="section === 'sound'">
        <section class="card">
          <h3 class="sec-title">Volume général</h3>
          <SettingRow label="Volume principal" :hint="`${s.master} %`">
            <input v-model.number="s.master" type="range" min="0" max="100" class="w-220" :style="fill(s.master, 0, 100)" />
          </SettingRow>
        </section>

        <section class="card">
          <h3 class="sec-title">Voix de l'IA</h3>
          <SettingRow label="Activer la voix" hint="Synthèse vocale de Windows, 100 % locale. Une voix neuronale locale (Piper) est prévue.">
            <Toggle v-model="s.voice" />
          </SettingRow>
          <SettingRow label="Lire les réponses">
            <select v-model="s.readReplies" class="input select w-220" :disabled="!s.voice">
              <option value="off">Jamais automatiquement</option>
              <option value="focused">Conversation visible seulement</option>
              <option value="all">Toutes les réponses</option>
            </select>
          </SettingRow>
          <SettingRow label="Voix" :hint="voiceList.length ? `${voiceList.length} voix installées` : 'Aucune voix système détectée'">
            <select v-model="s.voiceName" class="input select w-280">
              <option value="">Automatique (français)</option>
              <option v-for="v in voiceList" :key="v.voiceURI" :value="v.voiceURI">{{ v.name }} — {{ v.lang }}</option>
            </select>
          </SettingRow>
          <SettingRow label="Vitesse" :hint="`× ${s.voiceRate.toFixed(1)}`">
            <input v-model.number="s.voiceRate" type="range" min="0.6" max="1.8" step="0.1" class="w-220" :style="fill(s.voiceRate, 0.6, 1.8)" />
          </SettingRow>
          <SettingRow label="Hauteur" :hint="`× ${s.voicePitch.toFixed(1)}`">
            <input v-model.number="s.voicePitch" type="range" min="0.5" max="1.5" step="0.1" class="w-220" :style="fill(s.voicePitch, 0.5, 1.5)" />
          </SettingRow>
          <SettingRow label="Volume de la voix" :hint="`${s.voiceVolume} %`">
            <input v-model.number="s.voiceVolume" type="range" min="0" max="100" class="w-220" :style="fill(s.voiceVolume, 0, 100)" />
          </SettingRow>
          <div class="row test-row">
            <button class="btn sm" @click="speak('Salut ! Je suis prête. Dis-moi ce que tu veux faire.', true)"><Play :size="14" /> Tester la voix</button>
            <button class="btn sm ghost" @click="stopSpeaking">Arrêter</button>
          </div>
        </section>

        <section class="card">
          <h3 class="sec-title">Sons de notification</h3>
          <SettingRow label="Activer les sons">
            <Toggle v-model="s.notifications" />
          </SettingRow>
          <SettingRow label="Jeu de sons">
            <div class="segmented">
              <button v-for="(label, id) in SOUND_PACKS" :key="id" :class="{ on: s.notifSound === id }" :title="label" @click="s.notifSound = id; playSound('reply', true)">
                {{ label.split(" ")[0] }}
              </button>
            </div>
          </SettingRow>
          <SettingRow label="Volume des notifications" :hint="`${s.notifVolume} %`">
            <input v-model.number="s.notifVolume" type="range" min="0" max="100" class="w-220" :style="fill(s.notifVolume, 0, 100)" />
          </SettingRow>
          <div class="row test-row">
            <button class="btn sm" @click="playSound('reply', true)"><Play :size="14" /> Réponse</button>
            <button class="btn sm" @click="playSound('confirm', true)"><Play :size="14" /> Confirmation</button>
            <button class="btn sm" @click="playSound('done', true)"><Play :size="14" /> Terminé</button>
            <button class="btn sm" @click="playSound('error', true)"><Play :size="14" /> Erreur</button>
          </div>
        </section>
      </template>

      <!-- Notifications -->
      <section v-else-if="section === 'notifications'" class="card">
        <h3 class="sec-title">Notifications du bureau</h3>
        <SettingRow label="Activer" hint="Notifications Windows quand un agent a besoin de toi.">
          <Toggle v-model="n.desktop" />
        </SettingRow>
        <SettingRow label="Quand un agent répond">
          <Toggle v-model="n.onReply" />
        </SettingRow>
        <SettingRow label="Quand une action attend ta confirmation" hint="Recommandé : l'agent est bloqué tant que tu n'as pas répondu.">
          <Toggle v-model="n.onConfirm" />
        </SettingRow>
        <SettingRow label="Seulement si la fenêtre n'est pas au premier plan">
          <Toggle v-model="n.onlyWhenUnfocused" />
        </SettingRow>
      </section>

      <!-- Conversations -->
      <section v-else-if="section === 'conversations'" class="card">
        <h3 class="sec-title">Conversations</h3>
        <SettingRow label="Affichage" hint="Onglets : une conversation à la fois. Grille : plusieurs côte à côte, chacune avec sa saisie.">
          <div class="segmented">
            <button :class="{ on: c.layout === 'tabs' }" @click="c.layout = 'tabs'">Onglets</button>
            <button :class="{ on: c.layout === 'grid' }" @click="c.layout = 'grid'">Grille</button>
          </div>
        </SettingRow>
        <SettingRow label="Colonnes en grille">
          <div class="segmented">
            <button v-for="k in [1, 2, 3, 4]" :key="k" :class="{ on: c.gridColumns === k }" @click="c.gridColumns = k">{{ k }}</button>
          </div>
        </SettingRow>
        <SettingRow label="Envoyer avec Entrée" hint="Désactivé : Ctrl + Entrée pour envoyer, Entrée pour aller à la ligne.">
          <Toggle v-model="c.sendOnEnter" />
        </SettingRow>
        <SettingRow label="Afficher les étapes" hint="Ce que l'agent fait pendant qu'il travaille (recherche, build…).">
          <Toggle v-model="c.showSteps" />
        </SettingRow>
        <SettingRow label="Afficher l'heure des messages">
          <Toggle v-model="c.showTimestamps" />
        </SettingRow>
      </section>

      <!-- Raccourcis -->
      <section v-else-if="section === 'shortcuts'" class="card">
        <h3 class="sec-title">Raccourcis clavier</h3>
        <table class="table">
          <tbody>
            <tr v-for="[k, d] in shortcuts" :key="k">
              <td class="w-keys"><kbd v-for="part in k.split(' + ')" :key="part">{{ part }}</kbd></td>
              <td class="muted">{{ d }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Système -->
      <section v-else-if="section === 'system'" class="card">
        <h3 class="sec-title">Système</h3>
        <SettingRow label="Cœur MyIA" :hint="state.sidecar.running ? `Processus ${state.sidecar.pid} · Node ${state.info?.node ?? '?'}` : state.sidecar.error ?? 'Arrêté'">
          <span class="badge" :class="state.sidecar.running ? 'ok' : 'warn'">
            <span class="dot" :class="state.sidecar.running ? 'ok' : 'err'" /> {{ state.sidecar.running ? "en marche" : "arrêté" }}
          </span>
          <button class="btn sm" @click="restartSidecar"><RotateCw :size="14" /> Redémarrer</button>
        </SettingRow>
        <SettingRow label="Recharger la configuration" hint="Après une modification à la main de config/agent.json.">
          <button class="btn sm" @click="call('config.reload').then(() => toast('Configuration rechargée', 'success')).catch((e) => toast(e.message, 'error'))">
            <RotateCw :size="14" /> Recharger
          </button>
        </SettingRow>
        <SettingRow label="Ollama" :hint="state.overview?.ollama.baseUrl">
          <span class="badge" :class="state.overview?.ollama.ok ? 'ok' : 'warn'">{{ state.overview?.ollama.ok ? `v${state.overview.ollama.version}` : "hors ligne" }}</span>
        </SettingRow>
        <SettingRow label="Dossier MyIA" hint="Configuration, conversations, journal d'audit, thèmes.">
          <code class="path">{{ state.sidecar.home || state.info?.home }}</code>
        </SettingRow>
        <div class="paths small muted">
          <div><code>config/agent.json</code> configuration (non secrète)</div>
          <div><code>config/agents.json</code> tes agents</div>
          <div><code>data/conversations/</code> historique des conversations</div>
          <div><code>data/audit/</code> journal de chaque action</div>
          <div><code>runtime/app-sidecar.log</code> journal technique du cœur</div>
        </div>
        <SettingRow label="Réinitialiser les réglages" hint="Remet l'apparence, le son et les notifications par défaut. Ne touche ni aux agents ni aux conversations.">
          <button class="btn sm danger" @click="resetSettings(); toast('Réglages réinitialisés')"><RotateCcw :size="14" /> Réinitialiser</button>
        </SettingRow>
      </section>

      <!-- À propos -->
      <section v-else class="card about">
        <img src="../assets/logo.svg" alt="" />
        <h2>MyIA</h2>
        <p class="muted">Version {{ appVersion || "—" }} · cœur {{ state.info?.version ?? "—" }}</p>
        <p>Agent IA local du quotidien, par MCF Studio.<br />Open source sous licence AGPL-3.0 : améliorations bienvenues.</p>
        <div class="row">
          <a class="btn" href="https://github.com/MCF-Studio/mcf-myia">Code source ↗</a>
          <a class="btn ghost" href="https://mcfstudio.fr">mcfstudio.fr ↗</a>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  height: 100%;
}
.sub-nav {
  width: 230px;
  flex: none;
  padding: 22px 12px;
  border-right: 1px solid var(--hairline);
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: color-mix(in srgb, var(--bg-elevated) 55%, transparent);
}
.sub-nav h2 {
  font-size: 1.15rem;
  padding: 0 10px 14px;
}
.sub-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 38px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
}
.sub-item:hover {
  background: var(--surface);
  color: var(--text);
}
.sub-item.active {
  background: var(--surface);
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--accent);
}
.sub-item.active svg {
  color: var(--accent);
}
.content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 26px 30px;
  display: flex;
  flex-direction: column;
  gap: var(--gap);
  max-width: 980px;
}
.sec-title {
  font-size: 1rem;
  margin-bottom: 6px;
}
.w-220 {
  width: 220px;
}
.w-280 {
  width: 280px;
}
.themes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}
.theme {
  border-radius: var(--radius);
  border: 1px solid var(--hairline);
  padding: 8px;
  cursor: pointer;
  background: var(--bg-elevated);
  transition: border-color 0.15s, box-shadow 0.2s;
}
.theme:hover {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--hairline));
}
.theme.on {
  border-color: var(--accent);
  box-shadow: 0 0 28px -12px var(--glow);
}
.theme-art {
  height: 96px;
  border-radius: var(--radius-sm);
  border: 1px solid;
  display: flex;
  overflow: hidden;
}
.art-side {
  width: 26%;
  padding: 8px 6px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.art-side i {
  height: 6px;
  border-radius: 3px;
}
.art-main {
  flex: 1;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.art-main i {
  flex: 1;
  border-radius: 5px;
}
.art-main b {
  height: 9px;
  width: 45%;
  border-radius: 5px;
  align-self: flex-end;
}
.theme-info {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 2px 0;
}
.test-row {
  padding-top: 12px;
  border-top: 1px solid var(--hairline);
  flex-wrap: wrap;
}
kbd {
  display: inline-block;
  padding: 2px 8px;
  margin-right: 4px;
  border-radius: 6px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  background: var(--bg-elevated);
  font-family: var(--mono);
  font-size: 0.78rem;
}
.w-keys {
  width: 260px;
}
.path {
  font-size: 0.8rem;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--bg-elevated);
  user-select: text;
}
.root-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid var(--hairline);
}
.root-row > svg {
  color: var(--accent);
  flex: none;
}
.root-row .grow {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.root-row label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.prog-name {
  white-space: nowrap;
  min-width: 90px;
}
.prog-pending {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  margin-bottom: 6px;
  border-radius: var(--radius);
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 6%, var(--bg-elevated));
}
.prog-pending .input {
  width: 180px;
  height: 32px;
}
.prog-pending .grow {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prog-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  padding: 4px 4px 4px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--hairline);
  background: var(--bg-elevated);
  color: var(--text-muted);
}
.prog-search:focus-within {
  border-color: var(--accent);
}
.prog-search input {
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  height: 30px;
}
.found .badge {
  flex: none;
}
.depth {
  width: 64px;
  height: 30px;
}
.paths {
  display: grid;
  gap: 4px;
  padding: 0 0 14px;
}
.paths code {
  color: var(--text);
  margin-right: 6px;
}
.about {
  align-items: center;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 40px;
}
.about img {
  width: 84px;
  filter: drop-shadow(0 0 24px var(--glow));
}
.about p {
  margin: 0;
  line-height: 1.6;
}
</style>
