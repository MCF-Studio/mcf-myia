<script setup lang="ts">
import { BadgeCheck, Globe, Loader2, Lock, LogIn, UploadCloud } from "lucide-vue-next";
import { onMounted, ref } from "vue";
import { call } from "../lib/rpc";
import { toast } from "../lib/store";
import type { MarketAccount, Team, WorkflowSummary } from "../lib/types";
import ModalBox from "./ModalBox.vue";

/** Publier une équipe sur le marketplace de mcfstudio.fr : privé (soi seul) ou public (après validation). */
const props = defineProps<{ team: Team }>();
const emit = defineEmits<{ close: []; published: [WorkflowSummary] }>();

const account = ref<MarketAccount>();
const mine = ref<WorkflowSummary[]>([]);
const visibility = ref<"private" | "public">("private");
const busy = ref(false);
const logging = ref(false);
const error = ref<string>();

/** Publication existante du même nom : elle sera mise à jour au lieu d'en créer une seconde. */
const existing = () => mine.value.find((w) => w.name === props.team.name);

async function load() {
  error.value = undefined;
  try {
    account.value = await call<MarketAccount>("market.account");
    if (account.value.account) {
      mine.value = await call<WorkflowSummary[]>("market.mine");
      const e = existing();
      if (e) visibility.value = e.visibility;
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);

async function login() {
  logging.value = true;
  try {
    await call("market.login");
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    logging.value = false;
  }
}

async function publish() {
  busy.value = true;
  try {
    const r = await call<{ workflow: WorkflowSummary; updated: boolean; avatarsDropped: boolean }>("market.publish", {
      teamId: props.team.id,
      visibility: visibility.value,
      ...(existing() ? { id: existing()!.id } : {}),
    });
    toast(
      r.workflow.visibility === "public"
        ? `« ${r.workflow.name} » envoyé : il sera visible de tous après validation par l'équipe MCF Studio`
        : `« ${r.workflow.name} » ${r.updated ? "mis à jour" : "publié"} en privé`,
      "success",
    );
    if (r.avatarsDropped) toast("Les photos des agents ont été retirées pour tenir dans la taille maximale", "info");
    emit("published", r.workflow);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ModalBox :title="`Publier « ${team.name} »`" @close="logging ? call('market.cancelLogin') : emit('close')">
    <template #icon><UploadCloud :size="20" /></template>

    <p class="small">
      L'équipe part comme un workflow : son organisation, les consignes et le modèle de chaque agent, et le code de ses scripts
      <template v-if="team.scripts?.length">({{ team.scripts.length }})</template>. Les espaces de travail, les conversations et la mémoire ne
      partent jamais.
    </p>

    <p v-if="error" class="small err">{{ error }}</p>

    <div v-else-if="!account" class="row muted small"><Loader2 :size="15" class="spin" /> Vérification du compte…</div>

    <template v-else-if="!account.account">
      <p class="small muted">
        Publier demande d'autoriser MyIA sur <span class="mono">{{ account.site.replace(/^https?:\/\//, "") }}</span> : ton navigateur s'ouvre,
        tu te connectes au site et tu acceptes. MyIA ne voit ni ton mot de passe ni ton e-mail.
      </p>
      <button type="button" class="btn primary" :disabled="logging" @click="login">
        <Loader2 v-if="logging" :size="15" class="spin" /><LogIn v-else :size="15" />
        {{ logging ? "En attente du navigateur…" : "Se connecter pour publier" }}
      </button>
    </template>

    <template v-else>
      <div class="row small">
        Publié sous le pseudo <strong>{{ account.account.name }}</strong>
        <BadgeCheck v-if="account.account.certified" :size="15" class="cert" />
      </div>
      <p v-if="existing()" class="tiny muted">Tu as déjà publié un workflow de ce nom : il sera mis à jour.</p>

      <div class="choices">
        <label class="choice" :class="{ on: visibility === 'private' }">
          <input v-model="visibility" type="radio" value="private" />
          <Lock :size="17" />
          <div>
            <strong>Privé</strong>
            <span class="tiny muted">Toi seul le vois et peux l'installer, sur tous tes PC connectés à ton compte.</span>
          </div>
        </label>
        <label class="choice" :class="{ on: visibility === 'public' }">
          <input v-model="visibility" type="radio" value="public" />
          <Globe :size="17" />
          <div>
            <strong>Public</strong>
            <span class="tiny muted">
              Visible de tous dans le Marketplace et sur le site, sous ton pseudo, une fois validé par l'équipe MCF Studio. Toute modification
              repasse par la validation.
            </span>
          </div>
        </label>
      </div>
    </template>

    <template #actions>
      <button type="button" class="btn ghost" @click="logging ? call('market.cancelLogin') : emit('close')">Annuler</button>
      <button v-if="account?.account" type="button" class="btn primary" :disabled="busy" @click="publish">
        <Loader2 v-if="busy" :size="15" class="spin" /><UploadCloud v-else :size="15" />
        {{ existing() ? "Mettre à jour" : "Publier" }}
      </button>
    </template>
  </ModalBox>
</template>

<style scoped>
p {
  margin: 0;
  line-height: 1.5;
}
.err {
  color: var(--danger);
}
.cert {
  color: var(--accent);
}
.choices {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.choice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--hairline);
  background: var(--bg-elevated);
  cursor: pointer;
}
.choice.on {
  border-color: var(--accent);
}
.choice input {
  margin-top: 3px;
  accent-color: var(--accent);
}
.choice svg {
  flex: none;
  margin-top: 2px;
  color: var(--accent);
}
.choice div {
  display: flex;
  flex-direction: column;
  gap: 2px;
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
