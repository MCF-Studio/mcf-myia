<script setup lang="ts">
import { openUrl } from "@tauri-apps/plugin-opener";
import { Bluetooth, Cable, Home, MousePointerClick, Network, RefreshCw, Router, Trash2 } from "lucide-vue-next";
import { onMounted, ref } from "vue";
import { call } from "../lib/rpc";
import { toast } from "../lib/store";

/**
 * Appareils et domotique : ce que le PC voit (Bluetooth, ports COM, réseau local) et le lien avec Home Assistant, le
 * hub qui pilote les appareils (Zigbee / Z-Wave par une clé USB, Wi-Fi, Matter, Hue…). Lecture seule, sauf le lien.
 * Les noms viennent des appareils eux-mêmes : affichés comme du texte.
 */
interface Hardware {
  bluetooth: { adapters: { name: string; ok: boolean }[]; paired: { name: string; ok: boolean; le: boolean }[]; service?: string };
  serial: { port: string; name: string; manufacturer?: string; vid?: string; pid?: string; kind?: string; ok: boolean }[];
}
interface Lan {
  gateway?: string;
  box?: { name: string; ip: string; api?: string };
  devices: { ip: string; name?: string; manufacturer?: string; model?: string; kind: string }[];
  homeAssistant?: { url: string };
}

const hw = ref<Hardware>();
const lan = ref<Lan>();
const hwBusy = ref(false);
const lanBusy = ref(false);

async function loadHw() {
  hwBusy.value = true;
  try {
    hw.value = await call<Hardware>("devices.hardware", {}, 60_000);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    hwBusy.value = false;
  }
}
async function scan() {
  lanBusy.value = true;
  try {
    lan.value = await call<Lan>("devices.lan", {}, 60_000);
    if (lan.value.homeAssistant && !ha.value.url) haUrl.value = lan.value.homeAssistant.url;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    lanBusy.value = false;
  }
}

// Home Assistant
const ha = ref<{ url: string; configured: boolean; keyEnd?: string }>({ url: "", configured: false });
const haUrl = ref("http://homeassistant.local:8123");
const haToken = ref("");
const haBusy = ref(false);
async function loadHa() {
  ha.value = await call<typeof ha.value>("homeAssistant.status").catch(() => ha.value);
  if (ha.value.url) haUrl.value = ha.value.url;
}
async function saveHa() {
  haBusy.value = true;
  try {
    ha.value = await call<typeof ha.value>("homeAssistant.set", { url: haUrl.value, ...(haToken.value.trim() ? { token: haToken.value.trim() } : {}) }, 30_000);
    haToken.value = "";
    toast("Home Assistant relié : tes agents peuvent lire l'état de la maison et agir (avec ta confirmation).", "success");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    haBusy.value = false;
  }
}
async function unlinkHa() {
  ha.value = await call<typeof ha.value>("homeAssistant.delete");
  toast("Home Assistant délié, jeton effacé", "success");
}

// Contrôle de l'écran par AutoHotkey (services/autohotkey.ts)
const ahk = ref<{ installed: boolean; path?: string }>();
const ahkBusy = ref(false);
async function loadAhk() {
  ahk.value = await call<{ installed: boolean; path?: string }>("autohotkey.status").catch(() => undefined);
}
async function installAhk() {
  ahkBusy.value = true;
  try {
    ahk.value = await call<{ installed: boolean; path?: string }>("autohotkey.install", {}, 11 * 60_000);
    toast("AutoHotkey installé : tes agents peuvent cliquer et taper à l'écran (avec ta confirmation).", "success");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    ahkBusy.value = false;
  }
}

onMounted(() => {
  void loadHw();
  void loadHa();
  void loadAhk();
});
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h3 class="sec-title"><Bluetooth :size="16" /> Bluetooth</h3>
      <button class="btn sm ghost icon" title="Relire" :disabled="hwBusy" @click="loadHw"><RefreshCw :size="14" :class="{ spin: hwBusy }" /></button>
    </div>
    <template v-if="hw">
      <p v-if="!hw.bluetooth.adapters.length" class="small">
        <strong>Aucune carte Bluetooth détectée.</strong>
        <span class="muted"> Une clé USB Bluetooth 5 (une dizaine d'euros) suffit pour les capteurs, casques et manettes ; pour la domotique, une clé Zigbee est souvent plus utile (voir ci-dessous).</span>
      </p>
      <ul v-else class="list">
        <li v-for="a in hw.bluetooth.adapters" :key="a.name" class="small">{{ a.name }} <span class="badge" :class="a.ok ? 'ok' : 'warn'">{{ a.ok ? "active" : "désactivée" }}</span></li>
      </ul>
      <p v-if="hw.bluetooth.service && hw.bluetooth.service !== 'Running' && hw.bluetooth.adapters.length" class="tiny muted">Service Bluetooth de Windows : {{ hw.bluetooth.service }}.</p>
      <template v-if="hw.bluetooth.paired.length">
        <p class="tiny muted">Appareils appairés :</p>
        <ul class="list">
          <li v-for="p in hw.bluetooth.paired" :key="p.name" class="small">{{ p.name }} <span class="tiny muted">{{ p.le ? "basse consommation" : "classique" }}{{ p.ok ? "" : " · absent" }}</span></li>
        </ul>
      </template>
    </template>
  </section>

  <section class="card">
    <h3 class="sec-title"><Cable :size="16" /> Ports COM</h3>
    <p class="tiny muted">Les clés Zigbee / Z-Wave, cartes Arduino ou ESP32 et modules téléinfo (compteur Linky) apparaissent ici comme ports série.</p>
    <ul v-if="hw?.serial.length" class="list">
      <li v-for="s in hw.serial" :key="s.port" class="small">
        <strong class="mono">{{ s.port }}</strong> {{ s.name }}
        <span v-if="s.vid" class="tiny muted mono">USB {{ s.vid }}:{{ s.pid }}</span>
        <div v-if="s.kind" class="tiny accent-text">→ {{ s.kind }}</div>
      </li>
    </ul>
    <p v-else-if="hw" class="small muted">Aucun port COM.</p>
  </section>

  <section class="card">
    <div class="card-head">
      <h3 class="sec-title"><Network :size="16" /> Réseau local et box</h3>
      <button class="btn sm" :disabled="lanBusy" @click="scan"><RefreshCw :size="14" :class="{ spin: lanBusy }" /> {{ lan ? "Rechercher à nouveau" : "Rechercher les appareils" }}</button>
    </div>
    <p class="tiny muted">Recherche des appareils qui s'annoncent sur ton réseau (box, TV, Chromecast, pont Hue, Home Assistant). Rien ne sort de chez toi, rien n'est modifié.</p>
    <template v-if="lan">
      <div v-if="lan.box" class="box-row">
        <Router :size="18" />
        <div>
          <strong>{{ lan.box.name }}</strong> <span class="tiny muted mono">{{ lan.box.ip }}</span>
          <div v-if="lan.box.api" class="tiny muted">{{ lan.box.api }}</div>
        </div>
      </div>
      <p v-else class="small muted">Box non reconnue{{ lan.gateway ? ` (passerelle ${lan.gateway})` : "" }}.</p>
      <ul class="list">
        <li v-for="d in lan.devices" :key="d.ip" class="small">
          <span class="mono tiny">{{ d.ip }}</span> {{ d.kind }}<span v-if="d.name"> · « {{ d.name }} »</span><span v-if="d.model" class="tiny muted"> ({{ d.model }})</span>
        </li>
      </ul>
      <p class="small" :class="lan.homeAssistant ? '' : 'muted'">
        {{ lan.homeAssistant ? `Home Assistant trouvé : ${lan.homeAssistant.url}` : "Pas de Home Assistant sur le réseau." }}
      </p>
    </template>
  </section>

  <section class="card">
    <h3 class="sec-title"><MousePointerClick :size="16" /> Contrôle de l'écran (AutoHotkey)</h3>
    <p class="small muted">
      Avec AutoHotkey v2, tes agents peuvent cliquer, taper, appuyer sur des raccourcis, faire défiler et glisser à l'écran — pour les logiciels qui n'ont pas
      d'autre moyen d'être pilotés. Chaque action te demande ton accord (sauf mode bypass) ; l'IA ne lance jamais son propre script AutoHotkey, seulement des
      actions précises. Pour trouver où cliquer, elle utilise un modèle de vision local (Ollama).
    </p>
    <div class="row">
      <span v-if="ahk?.installed" class="badge ok">installé</span>
      <span v-if="ahk?.installed" class="tiny muted mono">{{ ahk.path }}</span>
      <button v-else class="btn sm primary" :disabled="ahkBusy || !ahk" @click="installAhk">{{ ahkBusy ? "Installation…" : "Installer AutoHotkey v2" }}</button>
    </div>
  </section>

  <section class="card">
    <h3 class="sec-title"><Home :size="16" /> Domotique : Home Assistant</h3>
    <p class="small muted">
      La box internet ne pilote pas les appareils de la maison : c'est le rôle d'un hub. MyIA s'appuie sur
      <a href="#" @click.prevent="openUrl('https://www.home-assistant.io/installation/')">Home Assistant</a>
      (gratuit, sur un mini-PC, un Raspberry Pi ou une machine virtuelle), qui parle aux lumières, prises, volets, chauffage, capteurs (Zigbee et Z-Wave par une clé USB,
      Wi-Fi, Matter, Philips Hue…). Tes agents lisent l'état de la maison sans confirmation, et agissent seulement avec ton accord ; serrures et alarmes restent dans Home Assistant.
    </p>
    <div class="ha-form">
      <label class="field">
        <span class="small">Adresse</span>
        <input v-model="haUrl" class="input" placeholder="http://homeassistant.local:8123" />
      </label>
      <label class="field">
        <span class="small">Jeton d'accès longue durée {{ ha.keyEnd ? `(enregistré : ${ha.keyEnd})` : "" }}</span>
        <input v-model="haToken" class="input" type="password" autocomplete="off" placeholder="Home Assistant → Profil → Sécurité → Créer un jeton" />
      </label>
      <div class="row">
        <button class="btn primary sm" :disabled="haBusy || (!haToken && !ha.keyEnd)" @click="saveHa">{{ haBusy ? "Vérification…" : ha.configured ? "Mettre à jour" : "Relier" }}</button>
        <button v-if="ha.configured || ha.keyEnd" class="btn sm ghost danger" @click="unlinkHa"><Trash2 :size="13" /> Délier</button>
        <span v-if="ha.configured" class="badge ok">relié</span>
      </div>
    </div>
    <p class="tiny muted">Le jeton est vérifié auprès de Home Assistant puis rangé dans le coffre Windows ; il ne part que vers cette adresse.</p>
  </section>
</template>

<style scoped>
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.sec-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.list {
  margin: 6px 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.box-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin: 8px 0;
}
.accent-text {
  color: var(--accent);
}
.ha-form {
  display: grid;
  gap: 10px;
  margin: 10px 0 6px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
