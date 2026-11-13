import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { reactive } from "vue";
import { call, inTauri, on, onRequest, reply, startRpc } from "./rpc";
import { settings } from "./settings";
import { playSound, speak } from "./sound";
import { checkClaudeLogin, loadClaudeApi, loadClaudeModels, startTerminals } from "./terminals";
import { refreshDictation } from "./dictation";
import type {
  AgentProfile,
  ConversationFull,
  ConversationSummary,
  DisplayMessage,
  Overview,
  SidecarStatus,
  SystemMetrics,
  Team,
  Theme,
} from "./types";

export type View = "overview" | "conversations" | "agents" | "teams" | "guild" | "models" | "marketplace" | "settings";

interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

const HISTORY = 60;

export const state = reactive({
  view: "overview" as View,
  ready: false,
  sidecar: { running: false, home: "" } as SidecarStatus,
  info: undefined as undefined | { version: string; home: string; userName: string; node: string },
  overview: undefined as Overview | undefined,
  metrics: undefined as SystemMetrics | undefined,
  history: { cpu: [] as number[], ram: [] as number[], gpu: [] as number[], vram: [] as number[] },
  conversations: [] as ConversationSummary[],
  open: {} as Record<string, ConversationFull>,
  agents: [] as AgentProfile[],
  teams: [] as Team[],
  installedThemes: [] as Theme[],
  /** messageId de confirmation → id de la requête ui.confirm du sidecar */
  confirms: {} as Record<string, number>,
  toasts: [] as Toast[],
  pullProgress: {} as Record<string, { status: string; total?: number; completed?: number }>,
  focused: true,
});

let toastId = 1;
export function toast(text: string, kind: Toast["kind"] = "info") {
  const id = toastId++;
  state.toasts.push({ id, kind, text });
  setTimeout(() => (state.toasts = state.toasts.filter((t) => t.id !== id)), kind === "error" ? 7000 : 3500);
}

export function navigate(v: View) {
  state.view = v;
  settings.lastView = v;
}

// ─── données ─────────────────────────────────────────────────────────────────

export async function refreshOverview() {
  try {
    state.overview = await call<Overview>("overview");
  } catch {
    /* sidecar pas prêt */
  }
}

export async function refreshMetrics() {
  if (!inTauri) return;
  try {
    const m = await invoke<SystemMetrics>("system_metrics");
    state.metrics = m;
    const push = (arr: number[], v: number) => {
      arr.push(v);
      if (arr.length > HISTORY) arr.shift();
    };
    push(state.history.cpu, m.cpuUsage);
    push(state.history.ram, (m.memoryUsed / m.memoryTotal) * 100);
    const g = m.gpus[0];
    if (g) {
      push(state.history.gpu, g.utilization);
      push(state.history.vram, (g.memoryUsedMb / g.memoryTotalMb) * 100);
    }
  } catch (e) {
    console.warn("métriques :", e);
  }
}

export async function refreshConversations() {
  state.conversations = await call<ConversationSummary[]>("conversations.list");
}

export async function refreshAgents() {
  state.agents = await call<AgentProfile[]>("agents.list");
}

export async function refreshTeams() {
  state.teams = await call<Team[]>("teams.list");
}

export async function refreshThemes() {
  state.installedThemes = await call<Theme[]>("themes.list");
}

export async function refreshSidecar() {
  if (inTauri) state.sidecar = await invoke<SidecarStatus>("sidecar_status");
}

export const agentById = (id: string) => state.agents.find((a) => a.id === id);

// ─── conversations ───────────────────────────────────────────────────────────

export async function openConversation(id: string) {
  if (!state.open[id]) state.open[id] = await call<ConversationFull>("conversations.get", { id });
  const tabs = settings.conversations.openTabs;
  if (!tabs.includes(id)) tabs.push(id);
  settings.conversations.activeTab = id;
  navigate("conversations");
}

export function closeTab(id: string) {
  const tabs = settings.conversations.openTabs;
  const i = tabs.indexOf(id);
  if (i >= 0) tabs.splice(i, 1);
  if (settings.conversations.activeTab === id) settings.conversations.activeTab = tabs[Math.max(0, i - 1)] ?? "";
}

export async function createConversation(agentId: string, teamId?: string) {
  const c = await call<ConversationSummary>("conversations.create", teamId ? { teamId } : { agentId });
  await refreshConversations();
  await openConversation(c.id);
  return c.id;
}

export async function deleteConversation(id: string) {
  await call("conversations.delete", { id });
  closeTab(id);
  delete state.open[id];
  await refreshConversations();
}

export async function sendMessage(id: string, text: string) {
  const conv = state.open[id];
  if (conv) conv.busy = true;
  try {
    await call("conversations.send", { id, text });
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    await refreshConversations();
  }
}

export function cancelConversation(id: string) {
  return call("conversations.cancel", { id });
}

export async function answerConfirm(messageId: string, ok: boolean) {
  const rpcId = state.confirms[messageId];
  if (rpcId === undefined) return;
  delete state.confirms[messageId];
  await reply(rpcId, ok);
}

// ─── notifications ───────────────────────────────────────────────────────────

async function notify(title: string, body: string) {
  const n = settings.notifications;
  if (!n.desktop || !inTauri) return;
  if (n.onlyWhenUnfocused && state.focused) return;
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (ok) sendNotification({ title, body: body.slice(0, 200) });
  } catch {
    /* notifications indisponibles */
  }
}

function onNewMessage(conversationId: string, m: DisplayMessage) {
  const conv = state.open[conversationId];
  if (conv && !conv.messages.some((x) => x.id === m.id)) conv.messages.push(m);
  const summary = state.conversations.find((c) => c.id === conversationId);
  const agent = summary ? agentById(summary.agentId) : undefined;
  const name = agent?.name ?? "MyIA";

  if (m.role === "assistant") {
    playSound("reply");
    const visible = state.view === "conversations" && settings.conversations.openTabs.includes(conversationId);
    const mode = settings.sound.readReplies;
    if (mode === "all" || (mode === "focused" && visible && state.focused)) speak(m.text);
    if (settings.notifications.onReply) void notify(name, m.text);
  } else if (m.role === "error") {
    playSound("error");
  } else if (m.role === "confirm") {
    playSound("confirm");
    if (settings.notifications.onConfirm) void notify(`${name} attend ta confirmation`, m.title ?? "");
  }
}

// ─── démarrage ───────────────────────────────────────────────────────────────

let pollers: ReturnType<typeof setInterval>[] = [];

export async function boot() {
  window.addEventListener("focus", () => (state.focused = true));
  window.addEventListener("blur", () => (state.focused = false));

  on("conversation.message", (p) => onNewMessage(p.conversationId, p.message));
  on("conversation.busy", (p) => {
    const c = state.open[p.conversationId];
    if (c) c.busy = p.busy;
    void refreshOverview();
  });
  on("conversation.updated", (p) => {
    const c = state.open[p.conversationId];
    if (c && p.title) c.title = p.title;
    void refreshConversations();
  });
  on("conversation.confirmed", (p) => {
    const m = state.open[p.conversationId]?.messages.find((x) => x.id === p.messageId);
    if (m) m.decision = p.decision;
    delete state.confirms[p.messageId];
  });
  on("models.progress", (p) => {
    state.pullProgress[p.name] = p;
    if (p.status === "success") {
      delete state.pullProgress[p.name];
      playSound("done");
      toast(`${p.name} installé`, "success");
    }
  });
  on("ollama.error", (p) => toast(`${state.overview?.ollama.engine === "llamacpp" ? "llama.cpp" : "Ollama"} : ${p.message}`, "error"));
  on("ollama.ready", () => void refreshOverview());
  on("sidecar.exit", () => {
    state.ready = false;
    void refreshSidecar();
  });
  on("ready", () => void afterReady());
  // MASTER a créé ou supprimé un agent, ouvert une conversation.
  on("agents.changed", () => void refreshAgents());
  on("conversations.changed", () => void refreshConversations());
  onRequest((method, params, id) => {
    if (method === "ui.confirm") state.confirms[params.messageId] = id;
    else void reply(id, null);
  });

  await startRpc();
  await startTerminals();
  await refreshSidecar();
  if (state.sidecar.running) await afterReady();
}

async function afterReady() {
  try {
    state.info = await call("app.info", {}, 8000);
  } catch {
    return; // le sidecar n'a pas encore fini de démarrer : on attend son « ready »
  }
  state.ready = true;
  void loadClaudeModels();
  void loadClaudeApi();
  void checkClaudeLogin();
  await Promise.all([refreshAgents(), refreshTeams(), refreshConversations(), refreshThemes(), refreshOverview(), refreshDictation()]);
  // Les onglets restaurés doivent encore exister.
  settings.conversations.openTabs = settings.conversations.openTabs.filter((id) => state.conversations.some((c) => c.id === id));
  await Promise.all(settings.conversations.openTabs.map((id) => openConversation(id).catch(() => closeTab(id))));
  startPolling();
}

export function startPolling() {
  pollers.forEach(clearInterval);
  void refreshMetrics();
  pollers = [
    setInterval(refreshMetrics, Math.max(1, settings.general.metricsInterval) * 1000),
    setInterval(refreshOverview, 5000),
  ];
}

export async function restartSidecar() {
  state.ready = false;
  try {
    await invoke("sidecar_restart");
    toast("Cœur MyIA redémarré", "success");
  } catch (e) {
    toast(String(e), "error");
  }
  await refreshSidecar();
  state.open = {};
}
