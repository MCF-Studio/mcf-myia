import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/base.css";
import { createApp } from "vue";
import App from "./App.vue";
import { loadSettings, settings } from "./lib/settings";
import { startRpc } from "./lib/rpc";
import { boot, state } from "./lib/store";

async function main() {
  await startRpc();
  await loadSettings();
  const start = settings.general.startView;
  state.view = (start === "last" ? settings.lastView : start) as typeof state.view;
  createApp(App).mount("#app");
  await boot();
}

void main();
