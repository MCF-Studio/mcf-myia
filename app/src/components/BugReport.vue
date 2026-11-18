<script setup lang="ts">
import { Bug, Send } from "lucide-vue-next";
import { computed, ref } from "vue";
import { call } from "../lib/rpc";
import { toast } from "../lib/store";
import ModalBox from "./ModalBox.vue";

/**
 * « Signaler un bug » : le rapport part au site MCF Studio, qui le transmet à l'équipe (Discord des bugs, Telegram).
 * Aucun secret dans l'app ; le site limite les envois et ne garde pas le contenu.
 */
const emit = defineEmits<{ close: [] }>();

const title = ref("");
const description = ref("");
const contact = ref("");
const includeLog = ref(false);
const sending = ref(false);

const valid = computed(() => title.value.trim().length >= 4 && description.value.trim().length >= 10);

async function send() {
  if (!valid.value || sending.value) return;
  sending.value = true;
  try {
    await call("bugs.report", { title: title.value, description: description.value, contact: contact.value, includeLog: includeLog.value }, 30_000);
    toast("Merci ! Le rapport est envoyé à l'équipe MCF Studio.", "success");
    emit("close");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <ModalBox title="Signaler un bug" @close="emit('close')">
    <form class="bug" @submit.prevent="send">
      <h3><Bug :size="18" /> Signaler un bug</h3>
      <p class="tiny muted">Ton message part à l'équipe MCF Studio (Discord des bugs et Telegram). Dis ce que tu faisais, ce qui s'est passé, et ce que tu attendais.</p>
      <label class="field">
        <span class="small">Titre</span>
        <input v-model="title" class="input" maxlength="120" placeholder="Ex. la console Claude reste noire" autofocus />
      </label>
      <label class="field">
        <span class="small">Ce qui se passe</span>
        <textarea v-model="description" class="input" rows="7" maxlength="4000" placeholder="Étapes pour reproduire, message d'erreur affiché…" />
        <span class="tiny muted">{{ description.length }} / 4000</span>
      </label>
      <label class="field">
        <span class="small">Pour te recontacter (facultatif)</span>
        <input v-model="contact" class="input" maxlength="64" placeholder="Pseudo Discord, e-mail…" />
      </label>
      <label class="row small check">
        <input v-model="includeLog" type="checkbox" />
        Joindre les dernières erreurs techniques de MyIA (dates et messages d'erreur, jamais tes conversations)
      </label>
      <div class="row actions">
        <span class="spacer" />
        <button type="button" class="btn ghost" @click="emit('close')">Annuler</button>
        <button class="btn primary" :disabled="!valid || sending"><Send :size="14" /> {{ sending ? "Envoi…" : "Envoyer" }}</button>
      </div>
    </form>
  </ModalBox>
</template>

<style scoped>
.bug {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: min(520px, 86vw);
}
.bug h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
textarea.input {
  resize: vertical;
  font-family: inherit;
}
.check {
  gap: 8px;
  align-items: flex-start;
}
.actions {
  gap: 8px;
}
.spacer {
  flex: 1;
}
</style>
