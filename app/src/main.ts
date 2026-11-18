import { getVersion } from "@tauri-apps/api/app";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/base.css";
import { createApp } from "vue";
import App from "./App.vue";
import { loadSettings, settings } from "./lib/settings";
import { inTauri, startRpc } from "./lib/rpc";
import { boot, state, toast } from "./lib/store";

async function main() {
  await startRpc();
  await loadSettings();
  const start = settings.general.startView;
  state.view = (start === "last" ? settings.lastView : start) as typeof state.view;
  createApp(App).mount("#app");
  await boot();
  if (inTauri) {
    // Après une mise à jour : une invitation à lire les nouveautés (pas au tout premier lancement).
    const v = await getVersion().catch(() => "");
    if (v && settings.general.seenVersion && settings.general.seenVersion !== v) toast(`MyIA ${v} est installée : les nouveautés sont dans Paramètres → Nouveautés.`, "info");
    if (v) settings.general.seenVersion = v;
  }
}

void main();
