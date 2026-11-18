import { computed, onMounted, ref } from "vue";
import { call } from "./rpc";
import { state } from "./store";
import { apiProviders, claudeApi, loadApiProviders, loadClaudeApi } from "./terminals";
import { agentStatus, type StatusContext } from "./topology";
import type { AgentProfile } from "./types";

/** État des agents pour la carte : occupés (vue d'ensemble), modèles locaux installés, clé d'API Claude. */
export function useAgentStatus() {
  const installed = ref<Set<string> | null>(null);
  onMounted(async () => {
    void loadClaudeApi();
    void loadApiProviders();
    try {
      const r = await call<{ installed: { name: string }[] }>("models.list", {}, 10_000);
      installed.value = new Set(r.installed.map((m) => m.name));
    } catch {
      installed.value = null;
    }
  });
  const ctx = computed<StatusContext>(() => ({
    busy: new Map((state.overview?.agents ?? []).map((a) => [a.id, a.busy])),
    defaultModel: state.overview?.defaultModel ?? "",
    installed: installed.value,
    localEngineOk: state.overview?.ollama.ok ?? true,
    claudeApiKey: claudeApi.value.configured,
    apiKeys: new Set(apiProviders.value.filter((p) => p.configured).map((p) => p.id)),
  }));
  return computed(() => (a: AgentProfile) => agentStatus(a, ctx.value));
}
