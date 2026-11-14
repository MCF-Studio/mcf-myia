<script setup lang="ts">
import { BadgeCheck, ChevronLeft, ChevronRight, Download, FileCode2, Globe, Loader2, Lock, LogIn, LogOut, Network, RefreshCw, Search, Trash2 } from "lucide-vue-next";
import { onMounted, ref } from "vue";
import { relTime } from "../lib/format";
import { call } from "../lib/rpc";
import { navigate, toast } from "../lib/store";
import type { MarketAccount, WorkflowPage, WorkflowPreview, WorkflowSummary } from "../lib/types";
import WorkflowPreviewDialog from "./WorkflowPreviewDialog.vue";

/** Workflows du marketplace de mcfstudio.fr : parcourir et installer (sans compte), gérer ses publications (compte). */
const mode = ref<"public" | "mine">("public");
const query = ref("");
const page = ref<WorkflowPage>();
const mine = ref<WorkflowSummary[]>();
const account = ref<MarketAccount>();
const loading = ref(false);
const error = ref<string>();
const opening = ref<number>();
const preview = ref<WorkflowPreview>();
const logging = ref(false);
const armed = ref<number>();

async function loadPublic(p = 1) {
  loading.value = true;
  error.value = undefined;
  try {
    page.value = await call<WorkflowPage>("market.list", { q: query.value.trim(), page: p });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function loadMine() {
  loading.value = true;
  error.value = undefined;
  try {
    account.value = await call<MarketAccount>("market.account");
    mine.value = account.value.account ? await call<WorkflowSummary[]>("market.mine") : undefined;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function show(m: "public" | "mine") {
  mode.value = m;
  void (m === "public" ? loadPublic(page.value?.page ?? 1) : loadMine());
}
onMounted(() => loadPublic());

async function open(w: WorkflowSummary, own = false) {
  opening.value = w.id;
  try {
    preview.value = await call<WorkflowPreview>("market.preview", { id: w.id, sha256: w.sha256, mine: own, author: w.author.name });
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    opening.value = undefined;
  }
}

async function login() {
  logging.value = true;
  try {
    await call("market.login");
    await loadMine();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    logging.value = false;
  }
}

async function logout() {
  await call("market.logout").catch((e) => toast((e as Error).message, "error"));
  await loadMine();
}

async function setVisibility(w: WorkflowSummary, visibility: "private" | "public") {
  try {
    await call("market.setVisibility", { id: w.id, visibility });
    toast(visibility === "public" ? `« ${w.name} » sera public après validation par l'équipe MCF Studio` : `« ${w.name} » est repassé en privé`, "success");
    await loadMine();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function remove(w: WorkflowSummary) {
  if (armed.value !== w.id) {
    armed.value = w.id;
    return;
  }
  armed.value = undefined;
  try {
    await call("market.remove", { id: w.id });
    toast(`« ${w.name} » retiré du marketplace`);
    await loadMine();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

function status(w: WorkflowSummary): { label: string; cls: string } {
  if (w.visibility === "private") return { label: "privé", cls: "" };
  if (w.review === "approved") return { label: "public", cls: "ok" };
  if (w.review === "rejected") return { label: "refusé", cls: "warn" };
  return { label: "en attente de validation", cls: "accent" };
}
</script>

<template>
  <section class="card wf">
    <div class="card-head">
      <h3><Network :size="17" /> Workflows</h3>
      <div class="segmented">
        <button :class="{ on: mode === 'public' }" @click="show('public')"><Globe :size="15" /> Publics</button>
        <button :class="{ on: mode === 'mine' }" @click="show('mine')"><Lock :size="15" /> Mes publications</button>
      </div>
    </div>
    <p class="tiny muted">
      Un workflow est une équipe prête à l'emploi : ses agents, leurs consignes et, parfois, des scripts. Avant toute installation, MyIA te montre
      ce qu'il contient ; un script ne tourne jamais sans ton accord. Pour publier le tien : écran
      <button type="button" class="link" @click="navigate('teams')">Équipes</button>, bouton « Publier ».
    </p>

    <template v-if="mode === 'public'">
      <form class="row" @submit.prevent="loadPublic(1)">
        <label class="search">
          <Search :size="15" />
          <input v-model="query" maxlength="60" placeholder="Rechercher un workflow (Godot, 3D, rédaction…)" />
        </label>
        <button class="btn" :disabled="loading"><Loader2 v-if="loading" :size="15" class="spin" /><Search v-else :size="15" /> Chercher</button>
      </form>

      <div v-if="error" class="empty small">
        <p>{{ error }}</p>
        <button type="button" class="btn sm" @click="loadPublic(page?.page ?? 1)"><RefreshCw :size="14" /> Réessayer</button>
      </div>
      <div v-else-if="page && !page.workflows.length" class="empty small">
        <p>{{ query.trim() ? "Aucun workflow ne correspond à cette recherche." : "Aucun workflow public pour l'instant." }}</p>
      </div>
      <div v-else-if="page" class="tiles">
        <article v-for="w in page.workflows" :key="w.id" class="tile">
          <div class="tile-head">
            <strong>{{ w.name }}</strong>
            <span class="tiny muted">{{ relTime(w.updatedAt) }}</span>
          </div>
          <p class="small muted desc">{{ w.description ?? "Pas de description" }}</p>
          <div class="row facts">
            <span class="badge">{{ w.agents }} agent{{ w.agents > 1 ? "s" : "" }}</span>
            <span v-if="w.scripts" class="badge warn"><FileCode2 :size="12" /> {{ w.scripts }} script{{ w.scripts > 1 ? "s" : "" }}</span>
            <span class="tiny muted">{{ w.downloads }} installation{{ w.downloads > 1 ? "s" : "" }}</span>
          </div>
          <div class="row tile-foot">
            <span class="small author">
              par {{ w.author.name }}
              <BadgeCheck v-if="w.author.certified" :size="14" class="cert" aria-label="membre certifié" />
            </span>
            <span class="spacer" />
            <button type="button" class="btn sm primary" :disabled="opening !== undefined" @click="open(w)">
              <Loader2 v-if="opening === w.id" :size="14" class="spin" /><Download v-else :size="14" /> Voir et installer
            </button>
          </div>
        </article>
      </div>

      <div v-if="page && page.pages > 1" class="row pager">
        <button type="button" class="btn sm" :disabled="page.page <= 1 || loading" @click="loadPublic(page.page - 1)"><ChevronLeft :size="14" /> Précédents</button>
        <span class="small muted">page {{ page.page }} / {{ page.pages }} · {{ page.total }} workflows</span>
        <button type="button" class="btn sm" :disabled="page.page >= page.pages || loading" @click="loadPublic(page.page + 1)">Suivants <ChevronRight :size="14" /></button>
      </div>
    </template>

    <template v-else>
      <div v-if="error" class="empty small">
        <p>{{ error }}</p>
        <button type="button" class="btn sm" @click="loadMine"><RefreshCw :size="14" /> Réessayer</button>
      </div>
      <div v-else-if="!account" class="row muted small"><Loader2 :size="15" class="spin" /> Chargement…</div>
      <div v-else-if="!account.account" class="empty small">
        <p>
          Connecte MyIA à <span class="mono">{{ account.site.replace(/^https?:\/\//, "") }}</span> pour retrouver et gérer tes publications. Ton
          navigateur s'ouvre ; MyIA ne voit ni ton mot de passe ni ton e-mail.
        </p>
        <button type="button" class="btn primary" :disabled="logging" @click="logging ? undefined : login()">
          <Loader2 v-if="logging" :size="15" class="spin" /><LogIn v-else :size="15" /> {{ logging ? "En attente du navigateur…" : "Se connecter" }}
        </button>
        <button v-if="logging" type="button" class="btn ghost sm" @click="call('market.cancelLogin')">Annuler</button>
      </div>
      <template v-else>
        <div class="row small">
          Connecté : <strong>{{ account.account.name }}</strong>
          <BadgeCheck v-if="account.account.certified" :size="15" class="cert" />
          <span class="spacer" />
          <button type="button" class="btn sm ghost" @click="logout"><LogOut :size="14" /> Se déconnecter</button>
        </div>
        <p v-if="mine && !mine.length" class="small muted">Tu n'as encore rien publié. Ouvre une équipe et clique sur « Publier ».</p>
        <div v-for="w in mine ?? []" :key="w.id" class="mine">
          <div class="mine-meta">
            <div class="row">
              <strong>{{ w.name }}</strong>
              <span class="badge" :class="status(w).cls">{{ status(w).label }}</span>
              <span v-if="w.scripts" class="badge warn"><FileCode2 :size="12" /> {{ w.scripts }} script{{ w.scripts > 1 ? "s" : "" }}</span>
            </div>
            <span class="tiny muted">
              {{ w.agents }} agent{{ w.agents > 1 ? "s" : "" }} · mis à jour {{ relTime(w.updatedAt) }} · {{ w.downloads }} installation{{ w.downloads > 1 ? "s" : "" }}
            </span>
            <span v-if="w.review === 'rejected' && w.rejectReason" class="tiny reject">Motif du refus : {{ w.rejectReason }}</span>
          </div>
          <button type="button" class="btn sm" :disabled="opening !== undefined" title="Installer ce workflow sur ce PC" @click="open(w, true)">
            <Loader2 v-if="opening === w.id" :size="14" class="spin" /><Download v-else :size="14" /> Installer ici
          </button>
          <button v-if="w.visibility === 'private'" type="button" class="btn sm" @click="setVisibility(w, 'public')"><Globe :size="14" /> Rendre public</button>
          <button v-else type="button" class="btn sm" @click="setVisibility(w, 'private')"><Lock :size="14" /> Repasser en privé</button>
          <button type="button" class="btn sm ghost icon danger" :class="{ armed: armed === w.id }" :title="armed === w.id ? 'Cliquer encore pour retirer du marketplace' : 'Retirer du marketplace'" @click="remove(w)">
            <Trash2 :size="14" />
          </button>
        </div>
      </template>
    </template>

    <WorkflowPreviewDialog v-if="preview" :preview="preview" @close="preview = undefined" @installed="((preview = undefined), navigate('teams'))" />
  </section>
</template>

<style scoped>
.wf {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
p {
  margin: 0;
  line-height: 1.5;
}
.link {
  border: 0;
  background: none;
  padding: 0;
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
  font: inherit;
}
.search {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  height: 36px;
  border-radius: var(--radius);
  background: var(--bg-elevated);
  border: 1px solid var(--hairline);
  color: var(--text-muted);
}
.search:focus-within {
  border-color: var(--accent);
}
.search input {
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
  gap: 10px;
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: var(--radius);
  border: 1px solid var(--hairline);
  background: var(--bg-elevated);
  min-width: 0;
}
.tile-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.tile-head strong {
  overflow-wrap: anywhere;
}
.desc {
  flex: 1;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.facts {
  flex-wrap: wrap;
  gap: 6px;
}
.author {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.cert {
  color: var(--accent);
  flex: none;
}
.pager {
  justify-content: center;
  gap: 14px;
}
.mine {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--hairline);
  background: var(--bg-elevated);
}
.mine-meta {
  flex: 1;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mine-meta .row {
  flex-wrap: wrap;
  gap: 8px;
}
.reject {
  color: var(--warning);
}
.armed {
  color: var(--danger);
  border-color: var(--danger);
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
