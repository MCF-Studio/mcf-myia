<script setup lang="ts">
import {
  BadgeCheck,
  CircleOff,
  FlaskConical,
  Handshake,
  LogIn,
  LogOut,
  Moon,
  Plus,
  Power,
  Save,
  ScrollText,
  Send,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import Toggle from "../components/Toggle.vue";
import { relTime } from "../lib/format";
import { call, on } from "../lib/rpc";
import { state, toast } from "../lib/store";

interface Offer {
  id: string;
  name: string;
  description: string;
  tags: string[];
  model: string;
  instructions: string;
  enabled: boolean;
}
interface Guild {
  enabled: boolean;
  serve: "everyone" | "certified" | "whitelist";
  whitelist: string[];
  offers: Offer[];
  limits: { maxChars: number; maxSeconds: number; perMemberPerHour: number; perDay: number };
  auto: { enabled: boolean; whitelistOnly: boolean; from: string; to: string; gpuMax: number };
  relay?: LinkState;
}
type Member = { id: number; name: string; certified: boolean };
type LinkState =
  | { state: "off"; reason: string }
  | { state: "connecting" }
  | { state: "online"; member: Member; device: number; fingerprint: string }
  | { state: "error"; reason: string; retryAt?: string };
interface PendingRequest {
  id: string;
  from: Member;
  offerId: string;
  offerName: string;
  text: string;
  reason: string;
  receivedAt: string;
  fingerprint: string;
}
interface JournalEntry {
  ts: string;
  kind: string;
  offerId: string;
  from: string;
  decision: string;
  reason?: string;
  chars: number;
  ms?: number;
}

const g = ref<Guild>();

// ─── compte mcfstudio.fr (connexion OAuth dans le navigateur) ───
interface McfAccountInfo {
  id: number;
  name: string;
  avatar: string | null;
  certified: boolean;
}
const account = ref<McfAccountInfo | null>(null);
const accountSite = ref("");
const accountError = ref("");
const loggingIn = ref(false);

async function loadAccount() {
  const r = await call<{ site: string; account: McfAccountInfo | null; error?: string }>("guild.account").catch(() => undefined);
  if (!r) return;
  account.value = r.account;
  accountSite.value = r.site.replace(/^https?:\/\//, "");
  accountError.value = r.error ?? "";
}

async function login() {
  loggingIn.value = true;
  accountError.value = "";
  try {
    const r = await call<{ account: McfAccountInfo }>("guild.login");
    account.value = r.account;
    toast(`Connecté en tant que ${r.account.name}`, "success");
    void refreshRelay();
  } catch (e) {
    accountError.value = (e as Error).message;
  } finally {
    loggingIn.value = false;
  }
}

async function logout() {
  await call("guild.logout").catch(() => undefined);
  account.value = null;
  toast("Déconnecté de mcfstudio.fr");
}
const dirty = ref(false);
const models = ref<string[]>([]);
const journal = ref<JournalEntry[]>([]);
const newMember = ref("");

async function load() {
  g.value = await call<Guild>("guild.get");
  journal.value = await call<JournalEntry[]>("guild.journal").catch(() => []);
  dirty.value = false;
}

watch(g, () => (dirty.value = true), { deep: true, flush: "sync" });

async function save() {
  if (!g.value) return;
  try {
    const { relay: _r, ...raw } = JSON.parse(JSON.stringify(g.value)) as Guild;
    await call("guild.save", raw);
    dirty.value = false;
    toast("Réglages de la Guilde enregistrés", "success");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

function addMember() {
  const m = newMember.value.trim();
  if (!g.value || !m || g.value.whitelist.some((w) => w.toLowerCase() === m.toLowerCase())) return;
  g.value.whitelist.push(m);
  newMember.value = "";
}

// ─── offres ───
const editing = ref<Offer>();
const editingIsNew = ref(false);

function slug(s: string) {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "offre"
  );
}

/** Nouvelle offre à partir d'un de tes agents : on reprend son modèle et ses consignes (modifiables). */
function newOffer(agentId?: string) {
  const a = state.agents.find((x) => x.id === agentId) ?? state.agents[0];
  editingIsNew.value = true;
  editing.value = {
    id: "",
    name: a?.name ?? "Offre",
    description: a?.description ?? "",
    tags: [],
    model: a?.model ?? state.overview?.defaultModel ?? "qwen3:8b",
    instructions: a?.instructions ?? "",
    enabled: true,
  };
}

function editOffer(o: Offer) {
  editingIsNew.value = false;
  editing.value = JSON.parse(JSON.stringify(o));
}

const tagInput = ref("");
function addTag() {
  const t = tagInput.value.trim().toLowerCase();
  if (editing.value && t && !editing.value.tags.includes(t) && editing.value.tags.length < 8) editing.value.tags.push(t);
  tagInput.value = "";
}

function commitOffer() {
  if (!g.value || !editing.value) return;
  const o = editing.value;
  if (editingIsNew.value) {
    let id = slug(o.name);
    for (let i = 2; g.value.offers.some((x) => x.id === id); i++) id = `${slug(o.name).slice(0, 36)}-${i}`;
    o.id = id;
    g.value.offers.push(o);
  } else {
    const i = g.value.offers.findIndex((x) => x.id === o.id);
    if (i >= 0) g.value.offers[i] = o;
  }
  editing.value = undefined;
  void save();
}

function removeOffer(id: string) {
  if (!g.value) return;
  g.value.offers = g.value.offers.filter((o) => o.id !== id);
  void save();
}

// ─── test d'une offre (bac à sable réel, local) ───
const testOffer = ref<string>();
const testText = ref("");
const testing = ref(false);
const testResult = ref<{ answer: string; ms: number }>();

async function runTest() {
  if (!testOffer.value || !testText.value.trim()) return;
  if (dirty.value) await save();
  testing.value = true;
  testResult.value = undefined;
  try {
    testResult.value = await call("guild.test", { offerId: testOffer.value, text: testText.value });
    journal.value = await call<JournalEntry[]>("guild.journal").catch(() => journal.value);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    testing.value = false;
  }
}

// ─── simulateur des règles ───
const sim = reactive({ memberId: "Lea", certified: true, at: "02:00", gpuPct: 10, offerId: "", chars: 800 });
const simResult = ref<{ kind: "refuse" | "ask" | "auto"; reason: string }>();

async function simulate() {
  if (!g.value) return;
  if (dirty.value) await save();
  try {
    simResult.value = await call("guild.simulate", { ...sim, offerId: sim.offerId || g.value.offers[0]?.id || "" });
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

// ─── relais : état, demandes à valider, demander à la Guilde ───
const relay = ref<LinkState>({ state: "off", reason: "non connecté à mcfstudio.fr" });
const pending = ref<PendingRequest[]>([]);
const deciding = ref<string>();

async function refreshRelay() {
  relay.value = await call<LinkState>("guild.status").catch(() => relay.value);
  pending.value = await call<PendingRequest[]>("guild.pending").catch(() => []);
}

async function reconnect() {
  try {
    relay.value = await call<LinkState>("guild.connect");
  } catch (e) {
    relay.value = { state: "error", reason: (e as Error).message };
  }
}

async function acceptPending(id: string) {
  deciding.value = id;
  try {
    await call("guild.accept", { id });
    toast("Demande acceptée : ton agent y répond", "success");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    deciding.value = undefined;
  }
}

async function rejectPending(id: string) {
  await call("guild.reject", { id }).catch((e) => toast((e as Error).message, "error"));
}

const askForm = reactive({ tag: "", text: "" });
const askingNow = ref(false);
const askResult = ref<{ answer: string; provider: Member; offer: { name: string; model: string }; fingerprint: string }>();
const askError = ref("");

async function askGuild() {
  if (!askForm.tag.trim() || askForm.text.trim().length < 3) return;
  askingNow.value = true;
  askResult.value = undefined;
  askError.value = "";
  try {
    askResult.value = await call("guild.ask", { tag: askForm.tag.trim().toLowerCase(), text: askForm.text });
  } catch (e) {
    askError.value = (e as Error).message;
  } finally {
    askingNow.value = false;
  }
}

const offStatus = on("guild.status", (s) => (relay.value = s as LinkState));
const offPending = on("guild.pending", (list) => (pending.value = list as PendingRequest[]));
const offServed = on("guild.served", (d) => {
  toast(`Demande de ${(d as { from: string }).from} traitée par ton agent`, "success");
  void call<JournalEntry[]>("guild.journal")
    .then((j) => (journal.value = j))
    .catch(() => undefined);
});
onBeforeUnmount(() => {
  offStatus();
  offPending();
  offServed();
});

const gpuNow = computed(() => state.metrics?.gpus[0]?.utilization);
const offersOn = computed(() => g.value?.offers.filter((o) => o.enabled).length ?? 0);
const DECISION = { auto: "acceptée automatiquement", ask: "te sera demandée", refuse: "refusée", erreur: "erreur" } as const;

onMounted(async () => {
  void loadAccount();
  void refreshRelay();
  await load();
  const r = await call<{ installed: { name: string }[] }>("models.list").catch(() => ({ installed: [] }));
  models.value = r.installed.map((m) => m.name);
  sim.offerId = g.value?.offers[0]?.id ?? "";
});
</script>

<template>
  <div v-if="g" class="page guild">
    <header class="page-head">
      <div>
        <div class="eyebrow">Guilde</div>
        <h1>Mutualiser nos agents</h1>
        <p>Mets à disposition ce que tu veux ; les autres membres en profitent, toujours avec ton accord ou tes règles.</p>
      </div>
      <button class="btn primary" :disabled="!dirty" @click="save"><Save :size="16" /> Enregistrer</button>
    </header>

    <!-- Compte mcfstudio.fr -->
    <section class="card account">
      <template v-if="account">
        <img v-if="account.avatar?.startsWith('https://cdn.discordapp.com/')" :src="account.avatar" alt="" class="acc-avatar" referrerpolicy="no-referrer" />
        <div v-else class="acc-avatar acc-initial">{{ account.name.charAt(0).toUpperCase() }}</div>
        <div class="acc-text">
          <strong>{{ account.name }} <span v-if="account.certified" class="badge accent"><BadgeCheck :size="12" /> certifié</span></strong>
          <span class="small muted">Connecté à {{ accountSite }} · la Guilde te reconnaîtra sous ce nom.</span>
        </div>
        <button class="btn sm ghost" @click="logout"><LogOut :size="14" /> Se déconnecter</button>
      </template>
      <template v-else>
        <UserRound :size="22" class="acc-icon" />
        <div class="acc-text">
          <strong>Compte mcfstudio.fr</strong>
          <span class="small muted">
            {{ loggingIn ? "Termine la connexion dans ton navigateur (Discord ou e-mail), puis clique sur « Autoriser »." : "Pour participer à la Guilde : connexion dans ton navigateur, MyIA ne voit jamais ton mot de passe." }}
          </span>
          <span v-if="accountError" class="small acc-error">{{ accountError }}</span>
        </div>
        <button v-if="loggingIn" class="btn sm" @click="call('guild.cancelLogin')">Annuler</button>
        <button v-else class="btn primary sm" @click="login"><LogIn :size="14" /> Se connecter avec mcfstudio.fr</button>
      </template>
    </section>

    <!-- État : relais + interrupteur -->
    <section class="status card">
      <div class="relay" :class="relay.state">
        <Wifi v-if="relay.state === 'online'" :size="22" />
        <WifiOff v-else :size="22" />
        <div>
          <template v-if="relay.state === 'online'">
            <strong>Connecté au relais</strong>
            <span class="small muted">Contenu chiffré de bout en bout : MCF Studio ne lit rien. Empreinte de ta clé : <code>{{ relay.fingerprint }}</code></span>
          </template>
          <template v-else-if="relay.state === 'connecting'">
            <strong>Connexion au relais…</strong>
            <span class="small muted">guilde.mcfstudio.fr</span>
          </template>
          <template v-else>
            <strong>Relais hors ligne</strong>
            <span class="small muted">{{ relay.reason }}{{ relay.state === "error" && relay.retryAt ? " · nouvel essai automatique" : "" }}</span>
          </template>
        </div>
        <button v-if="account && relay.state !== 'online' && relay.state !== 'connecting'" class="btn sm" @click="reconnect">Reconnecter</button>
      </div>
      <div class="switch" :class="{ on: g.enabled }">
        <Power :size="20" />
        <div>
          <strong>{{ g.enabled ? "Prêt à servir" : "Guilde coupée" }}</strong>
          <span class="small muted">Interrupteur général : coupé, ta machine ne sert personne, quoi qu'il arrive.</span>
        </div>
        <Toggle v-model="g.enabled" label="Interrupteur général" />
      </div>
    </section>

    <!-- Demandes reçues qui attendent ta décision -->
    <section v-if="pending.length" class="card pending">
      <div class="card-head">
        <h3><ShieldCheck :size="17" /> À valider <span class="badge accent">{{ pending.length }}</span></h3>
      </div>
      <div v-for="p in pending" :key="p.id" class="pending-row">
        <div class="pending-head">
          <strong>{{ p.from.name }}</strong>
          <span v-if="p.from.certified" class="badge accent"><BadgeCheck :size="12" /> certifié</span>
          <span class="small muted">→ {{ p.offerName }} · {{ relTime(p.receivedAt) }} · {{ p.reason }}</span>
        </div>
        <pre class="pending-text">{{ p.text }}</pre>
        <div class="pending-actions">
          <span class="tiny muted">Empreinte de son appareil : <code>{{ p.fingerprint }}</code></span>
          <button class="btn sm ghost" @click="rejectPending(p.id)"><X :size="14" /> Refuser</button>
          <button class="btn primary sm" :disabled="deciding === p.id" @click="acceptPending(p.id)"><Handshake :size="14" /> Accepter</button>
        </div>
      </div>
    </section>

    <!-- Demander à la Guilde -->
    <section v-if="relay.state === 'online'" class="card ask">
      <div class="card-head"><h3><Send :size="17" /> Demander à la Guilde</h3></div>
      <p class="tiny muted">
        Le premier membre en ligne qui a une offre avec cette compétence, et qui accepte, te répond. Ton texte est chiffré pour son seul
        appareil ; il ne voit ni tes fichiers ni tes conversations.
      </p>
      <form class="ask-form" @submit.prevent="askGuild">
        <input v-model="askForm.tag" class="input" maxlength="24" placeholder="Compétence (ex. relecture, code, traduction)" required />
        <textarea v-model="askForm.text" class="input" rows="4" maxlength="20000" placeholder="Ta demande, complète : l'autre membre ne voit rien d'autre." required />
        <div class="ask-actions">
          <button v-if="askingNow" type="button" class="btn sm" @click="call('guild.cancelAsk')">Annuler</button>
          <button class="btn primary sm" :disabled="askingNow"><Send :size="14" /> {{ askingNow ? "En attente d'un membre…" : "Envoyer" }}</button>
        </div>
      </form>
      <p v-if="askError" class="small acc-error">{{ askError }}</p>
      <div v-if="askResult" class="ask-result">
        <div class="small muted">
          Réponse de <strong>{{ askResult.provider.name }}</strong> ({{ askResult.offer.name }}, {{ askResult.offer.model }}) · empreinte
          <code>{{ askResult.fingerprint }}</code>
        </div>
        <pre class="pending-text">{{ askResult.answer }}</pre>
      </div>
    </section>

    <div class="cols">
      <!-- Offres -->
      <section class="card offers">
        <div class="card-head">
          <h3><Handshake :size="17" /> Mes offres <span class="badge">{{ offersOn }} active{{ offersOn > 1 ? "s" : "" }}</span></h3>
          <button class="btn sm" @click="newOffer()"><Plus :size="14" /> Nouvelle offre</button>
        </div>
        <p class="tiny muted">
          Une offre = un modèle + des consignes. Elle tourne en <strong>bac à sable</strong> : texte en entrée, texte en sortie, aucun accès à
          tes fichiers, tes services ou ton réseau. Tes agents personnels ne sont pas partagés.
        </p>
        <div v-for="o in g.offers" :key="o.id" class="offer" :class="{ off: !o.enabled }">
          <div class="offer-main" @click="editOffer(o)">
            <strong>{{ o.name }}</strong>
            <span class="mono tiny muted">{{ o.model }}</span>
            <span v-if="o.description" class="small muted">{{ o.description }}</span>
            <div class="tags">
              <span v-for="t in o.tags" :key="t" class="badge">{{ t }}</span>
            </div>
          </div>
          <Toggle v-model="o.enabled" :label="`Activer ${o.name}`" />
          <button class="btn sm ghost icon" title="Tester en local" @click="testOffer = o.id"><FlaskConical :size="14" /></button>
          <button class="btn sm ghost icon danger" title="Supprimer" @click="removeOffer(o.id)"><Trash2 :size="14" /></button>
        </div>
        <div v-if="!g.offers.length" class="empty small">
          Aucune offre. Pars d'un de tes agents :
          <div class="row agent-picks">
            <button v-for="a in state.agents" :key="a.id" class="btn sm" @click="newOffer(a.id)">{{ a.name }}</button>
          </div>
        </div>

        <!-- Test -->
        <div v-if="testOffer" class="test">
          <div class="row">
            <FlaskConical :size="15" />
            <strong class="small">Tester « {{ g.offers.find((o) => o.id === testOffer)?.name }} » comme une vraie demande</strong>
            <span class="spacer" />
            <button class="btn sm ghost icon" @click="testOffer = undefined; testResult = undefined"><X :size="14" /></button>
          </div>
          <textarea v-model="testText" class="input" rows="3" placeholder="Ex. Écris une annonce de 2 phrases pour la sortie de notre jeu" />
          <div class="row">
            <span class="tiny muted">Même traitement qu'une demande reçue : bac à sable, durée max {{ g.limits.maxSeconds }} s.</span>
            <span class="spacer" />
            <button class="btn primary sm" :disabled="testing || !testText.trim()" @click="runTest">{{ testing ? "En cours…" : "Lancer le test" }}</button>
          </div>
          <div v-if="testResult" class="test-result selectable">
            <span class="tiny muted">Réponse en {{ (testResult.ms / 1000).toFixed(1).replace(".", ",") }} s</span>
            <p>{{ testResult.answer }}</p>
          </div>
        </div>
      </section>

      <!-- Qui je sers -->
      <section class="card">
        <div class="card-head"><h3><Users :size="17" /> Qui peut te solliciter</h3></div>
        <div class="segmented serve">
          <button :class="{ on: g.serve === 'everyone' }" @click="g.serve = 'everyone'">Membres connectés</button>
          <button :class="{ on: g.serve === 'certified' }" @click="g.serve = 'certified'"><BadgeCheck :size="14" /> Certifiés</button>
          <button :class="{ on: g.serve === 'whitelist' }" @click="g.serve = 'whitelist'">Ma liste blanche</button>
        </div>
        <p class="tiny muted">
          {{
            g.serve === "everyone"
              ? "Tout compte mcfstudio.fr connecté peut t'envoyer une demande ; tu valides chacune (sauf liste blanche en mode auto)."
              : g.serve === "certified"
                ? "Seuls les membres certifiés de mcfstudio.fr (et ta liste blanche) peuvent te solliciter."
                : "Seuls les membres de ta liste blanche peuvent te solliciter."
          }}
        </p>
        <h4 class="sub">Liste blanche <span class="tiny muted">(pseudos mcfstudio.fr)</span></h4>
        <div class="chips">
          <span v-for="(w, i) in g.whitelist" :key="w" class="chip">
            {{ w }} <button title="Retirer" @click="g.whitelist.splice(i, 1)"><X :size="11" /></button>
          </span>
          <form class="chip-add" @submit.prevent="addMember">
            <input v-model="newMember" maxlength="40" placeholder="Ajouter un pseudo" />
          </form>
        </div>

        <h4 class="sub">Limites</h4>
        <div class="limits">
          <label>Taille max d'une demande <input v-model.number="g.limits.maxChars" type="number" min="200" max="20000" class="input" /> caractères</label>
          <label>Durée max <input v-model.number="g.limits.maxSeconds" type="number" min="10" max="600" class="input" /> s</label>
          <label>Par membre <input v-model.number="g.limits.perMemberPerHour" type="number" min="1" max="100" class="input" /> / heure</label>
          <label>Au total <input v-model.number="g.limits.perDay" type="number" min="1" max="1000" class="input" /> / jour</label>
        </div>
      </section>
    </div>

    <div class="cols">
      <!-- Mode auto -->
      <section class="card">
        <div class="card-head">
          <h3><Moon :size="17" /> Mode auto <span class="tiny muted">(ton PC à dispo pendant que tu dors)</span></h3>
          <Toggle v-model="g.auto.enabled" label="Mode auto" />
        </div>
        <p class="tiny muted">Une demande n'est acceptée sans toi que si <strong>toutes</strong> ces règles passent :</p>
        <div class="rules" :class="{ dim: !g.auto.enabled }">
          <label class="rule"><ShieldCheck :size="15" /> Seulement ma liste blanche <Toggle v-model="g.auto.whitelistOnly" /></label>
          <label class="rule">
            <Moon :size="15" /> Entre
            <input v-model="g.auto.from" type="time" class="input time" /> et <input v-model="g.auto.to" type="time" class="input time" />
          </label>
          <label class="rule gpu">
            <CircleOff :size="15" /> Pause si le GPU dépasse <strong>{{ g.auto.gpuMax }} %</strong>
            <input v-model.number="g.auto.gpuMax" type="range" min="5" max="100" :style="{ '--fill': `${g.auto.gpuMax}%` }" />
          </label>
          <span class="tiny muted">GPU en ce moment : {{ gpuNow !== undefined ? `${Math.round(gpuNow)} %` : "inconnu" }}. Quotas ci-dessus toujours appliqués.</span>
        </div>

        <!-- Simulateur -->
        <h4 class="sub">Simulateur : que deviendrait cette demande ?</h4>
        <div class="sim">
          <input v-model="sim.memberId" class="input" placeholder="Pseudo" />
          <label class="row tiny"><input v-model="sim.certified" type="checkbox" /> certifié</label>
          <input v-model="sim.at" type="time" class="input time" />
          <label class="tiny">GPU <input v-model.number="sim.gpuPct" type="number" min="0" max="100" class="input num" /> %</label>
          <button class="btn sm" :disabled="!g.offers.length" @click="simulate">Simuler</button>
        </div>
        <div v-if="simResult" class="sim-result" :class="simResult.kind">
          Demande <strong>{{ DECISION[simResult.kind] }}</strong> — {{ simResult.reason }}
        </div>
      </section>

      <!-- Journal -->
      <section class="card">
        <div class="card-head"><h3><ScrollText :size="17" /> Journal</h3></div>
        <div v-if="journal.length" class="journal">
          <div v-for="(j, i) in journal.slice(0, 30)" :key="i" class="j-row">
            <span class="badge" :class="j.decision === 'erreur' ? 'warn' : j.decision === 'auto' ? 'ok' : ''">{{ j.kind }}</span>
            <span class="small">{{ g.offers.find((o) => o.id === j.offerId)?.name ?? j.offerId }} · {{ j.from }}</span>
            <span class="spacer" />
            <span class="tiny muted">{{ j.ms ? `${(j.ms / 1000).toFixed(1)} s · ` : "" }}{{ relTime(j.ts) }}</span>
          </div>
        </div>
        <div v-else class="empty small">Rien pour l'instant. Chaque demande (et chaque test) y sera inscrite.</div>
      </section>
    </div>

    <!-- Éditeur d'offre -->
    <Transition name="pop">
      <div v-if="editing" class="modal-backdrop" @click.self="editing = undefined">
        <form class="modal card" @submit.prevent="commitOffer">
          <h3>{{ editingIsNew ? "Nouvelle offre" : `Offre « ${editing.name} »` }}</h3>
          <label class="field"><span class="small">Nom affiché aux membres</span><input v-model="editing.name" class="input" maxlength="40" required /></label>
          <label class="field"><span class="small">Description</span><input v-model="editing.description" class="input" maxlength="300" placeholder="Ce que cette offre fait bien" /></label>
          <label class="field">
            <span class="small">Modèle</span>
            <select v-model="editing.model" class="input select">
              <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
            </select>
          </label>
          <div class="field">
            <span class="small">Compétences</span>
            <div class="chips">
              <span v-for="(t, i) in editing.tags" :key="t" class="chip">{{ t }} <button type="button" @click="editing.tags.splice(i, 1)"><X :size="11" /></button></span>
              <input v-model="tagInput" class="chip-input" maxlength="24" placeholder="rédaction, traduction…" @keydown.enter.prevent="addTag" @blur="addTag" />
            </div>
          </div>
          <label class="field">
            <span class="small">Consignes <em class="muted">(visibles par toi seul ; elles orientent les réponses)</em></span>
            <textarea v-model="editing.instructions" class="input" rows="5" maxlength="4000" />
          </label>
          <div class="row modal-actions">
            <span class="spacer" />
            <button type="button" class="btn ghost" @click="editing = undefined">Annuler</button>
            <button class="btn primary" :disabled="!editing.name.trim() || !editing.model">Enregistrer l'offre</button>
          </div>
        </form>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.guild {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
}
.account {
  display: flex;
  align-items: center;
  gap: 14px;
}
.acc-avatar {
  width: 42px;
  height: 42px;
  border-radius: 30%;
  object-fit: cover;
  flex: none;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
}
.acc-initial {
  display: grid;
  place-items: center;
  font-weight: 700;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--surface-2));
}
.acc-icon {
  color: var(--accent);
  flex: none;
}
.acc-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.acc-text strong {
  display: flex;
  align-items: center;
  gap: 8px;
}
.acc-error {
  color: var(--danger);
}
.status {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--gap);
}
.relay,
.switch {
  display: flex;
  align-items: center;
  gap: 14px;
}
.relay > svg {
  color: var(--warning);
  flex: none;
}
.relay.online > svg {
  color: var(--success);
}
.pending-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 0;
  border-top: 1px solid var(--hairline);
}
.pending-head,
.pending-actions,
.ask-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pending-actions span {
  flex: 1;
}
.ask-actions {
  justify-content: flex-end;
}
.pending-text {
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 260px;
  overflow: auto;
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--text-muted) 8%, transparent);
  font: inherit;
}
.ask-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ask-result {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.relay div,
.switch div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}
.switch {
  padding-left: var(--gap);
  border-left: 1px solid var(--hairline);
}
.switch > svg {
  color: var(--text-muted);
  flex: none;
}
.switch.on > svg {
  color: var(--success);
  filter: drop-shadow(0 0 8px color-mix(in srgb, var(--success) 60%, transparent));
}
.cols {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: var(--gap);
  align-items: start;
}
.card h3 {
  gap: 8px;
}
@media (max-width: 1250px) {
  .cols,
  .status {
    grid-template-columns: 1fr;
  }
  .switch {
    padding-left: 0;
    border-left: 0;
    padding-top: var(--gap);
    border-top: 1px solid var(--hairline);
  }
}
.offer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  margin-top: 10px;
  border-radius: var(--radius);
  border: 1px solid var(--hairline);
  background: var(--bg-elevated);
}
.offer.off {
  opacity: 0.55;
}
.offer-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  cursor: pointer;
}
.tags,
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.agent-picks {
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 8px;
}
.test {
  margin-top: 14px;
  padding: 12px;
  border-radius: var(--radius);
  border: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.test > .row svg {
  color: var(--accent);
}
.test-result {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
.test-result p {
  margin: 4px 0 0;
  white-space: pre-wrap;
  line-height: 1.5;
}
.serve {
  margin-bottom: 8px;
}
.sub {
  font-size: 0.85rem;
  margin: 16px 0 8px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px 3px 10px;
  border-radius: 99px;
  background: var(--surface-2);
  border: 1px solid var(--hairline);
  font-size: 0.82rem;
}
.chip button {
  border: 0;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  display: grid;
  place-items: center;
}
.chip-add input,
.chip-input {
  height: 28px;
  border-radius: 99px;
  border: 1px dashed var(--border);
  background: transparent;
  padding: 0 12px;
  outline: none;
  width: 170px;
}
.limits {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 8px 16px;
  font-size: 0.82rem;
  color: var(--text-muted);
}
.limits label {
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 6px;
}
.limits .input {
  width: 80px;
  height: 30px;
  padding: 0 8px;
}
.rules {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rules.dim {
  opacity: 0.5;
}
.rule {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.88rem;
}
.rule > svg {
  color: var(--accent);
}
.rule.gpu input {
  flex: 1;
}
.time {
  width: 100px;
  height: 30px;
  padding: 0 8px;
}
.num {
  width: 64px;
  height: 30px;
  padding: 0 8px;
}
.sim {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sim > .input:first-child {
  width: 130px;
  height: 30px;
}
.sim-result {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  font-size: 0.88rem;
  border: 1px solid var(--hairline);
}
.sim-result.auto {
  border-color: color-mix(in srgb, var(--success) 45%, transparent);
  background: color-mix(in srgb, var(--success) 8%, transparent);
}
.sim-result.ask {
  border-color: color-mix(in srgb, var(--warning) 45%, transparent);
  background: color-mix(in srgb, var(--warning) 8%, transparent);
}
.sim-result.refuse {
  border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}
.journal {
  display: flex;
  flex-direction: column;
}
.j-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--hairline);
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(3px);
}
.modal {
  width: min(560px, 92vw);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field em {
  font-style: normal;
}
.modal-actions {
  gap: 8px;
}
.pop-enter-active,
.pop-leave-active {
  transition: opacity 0.12s;
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
}
</style>
