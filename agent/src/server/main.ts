/**
 * Sidecar de l'app MyIA (Tauri 2) : lancé par l'app, parle JSON-RPC sur stdio.
 * Même cœur que la console : les règles de confirmation (SPEC §3) passent par ui.confirm côté app.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Agent } from "../core/agent.js";
import { audit } from "../core/audit.js";
import { patchConfigFile } from "../core/config-file.js";
import { loadConfig, type Config } from "../core/config.js";
import { addProgram, assertLocalPath, listPrograms, removeProgram, searchPrograms } from "../core/programs.js";
import { CLAUDE_MODEL_INFO, CLAUDE_MODELS, claudeAccount, triageTask } from "../core/claude-coach.js";
import { API_KEY_SECRET, apiKeyStatus, CLAUDE_API_MODELS, verifyApiKey } from "../core/claude-api-llm.js";
import { deleteSecret, setSecret } from "../core/secrets.js";
import { decide, journal, loadGuild, OfferSchema, readJournal, runSandboxed, saveGuild } from "../core/guild.js";
import { McfAccount } from "../core/mcf-account.js";
import { AgentsMap, mapNames } from "../core/agents-map.js";
import { deviceKeys } from "../core/guild-crypto.js";
import { GuildLink } from "../core/guild-link.js";
import { memoryFor } from "../core/memory.js";
import { openInBrowser } from "../services/web.js";
import { ENGINES, installWhisper, MODELS, transcribe, uninstallWhisper, whisperStatus } from "../core/whisper.js";
import { CLAUDE_LOCAL_CTX, claudeLocalOllamaModel, findOllama, MIN_OLLAMA, MODEL_NAME, OllamaClient, versionAtLeast } from "../core/llm.js";
import { installOllama } from "../core/ollama-install.js";
import { createLlm } from "../core/llm-factory.js";
import { activeBuild, BUILDS, CATALOG, installBuild, installedBuilds, LlamaCppClient, stopLlamaServer, uninstallBuild, type Build } from "../core/llamacpp.js";
import { makeTeamRoot } from "../core/team-runner.js";
import { appControlTools, type AppControl } from "../services/app-control.js";
import { loadTeams, newNodeId, parseTeam, saveTeams, TeamBudget, type Team } from "../core/teams.js";
import { isInside, paths } from "../core/paths.js";
import { ProjectRegistry } from "../core/projects.js";
import {
  AgentProfileSchema,
  DEFAULT_PROFILE,
  loadProfiles,
  saveProfiles,
  writeJsonAtomic,
  type AgentProfile,
} from "../core/profiles.js";
import type { AgentUI, Service } from "../core/types.js";
import { buildServices } from "../services/index.js";
import { RpcError, RpcPeer } from "./rpc.js";
import { ConversationStore, type Conversation, type DisplayMessage } from "./store.js";
import { deleteTheme, installTheme, listThemes } from "./themes.js";

// stdout = protocole. Tout le reste part sur stderr (journal du sidecar côté app).
for (const k of ["log", "info", "warn", "debug"] as const) {
  console[k] = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n");
}

/** Version : fournie par l'app (MYIA_VERSION), sinon lue dans package.json (développement). */
const VERSION = ((): string => {
  if (process.env.MYIA_VERSION) return process.env.MYIA_VERSION;
  if (process.env.MYIA_BUNDLE_VERSION) return process.env.MYIA_BUNDLE_VERSION; // remplacé à l'empaquetage
  try {
    return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "?";
  }
})();

/** Premier lancement (installateur) : dossiers et configuration minimale créés s'ils manquent. */
for (const d of [path.dirname(paths.config), paths.audit, paths.workspace]) fs.mkdirSync(d, { recursive: true });
if (!fs.existsSync(paths.config)) writeJsonAtomic(paths.config, { user: { name: "l'utilisateur" }, projectRoots: [] });

const rpc = new RpcPeer();
rpc.onClose = () => void shutdown();

process.on("uncaughtException", (e) => {
  audit({ event: "crash", error: `sidecar: ${e.message}`, stack: e.stack });
  process.stderr.write(`[crash] ${e.stack}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  const err = e instanceof Error ? e : new Error(String(e));
  audit({ event: "crash", error: `sidecar (promesse): ${err.message}`, stack: err.stack });
  process.stderr.write(`[rejet] ${err.stack}\n`);
});

// ─── état ────────────────────────────────────────────────────────────────────

const cfg: Config = loadConfig();
/**
 * Applique une nouvelle configuration EN PLACE : les services et les agents gardent une référence à `cfg`, ils voient
 * donc tout de suite les nouveaux réglages (dossiers de mémoire, accès aux fichiers…) sans redémarrage.
 */
function setCfg(next: Config) {
  for (const k of Object.keys(cfg)) delete (cfg as Record<string, unknown>)[k];
  Object.assign(cfg, next);
}
let services: Service[] = buildServices(cfg);
let profiles: AgentProfile[] = loadProfiles();
let teams: Team[] = loadTeams();
const store = new ConversationStore();
/** Client du moteur local actif (Ollama ou llama.cpp). */
const engine = () => createLlm(cfg.llm);

interface Live {
  agent: Agent;
  signature: string;
  running?: AbortController;
  /** Équipe : budget remis à zéro à chaque message de l'utilisateur. */
  budget?: TeamBudget;
  /** Agent MASTER : messages à d'autres agents pendant la demande en cours. */
  masterBudget?: { used: number };
}
const live = new Map<string, Live>();
const pulls = new Map<string, AbortController>();

const profileOf = (id: string) => profiles.find((p) => p.id === id) ?? profiles[0] ?? DEFAULT_PROFILE;

/** Agent d'une conversation, recréé si son profil ou le modèle par défaut a changé (historique conservé). */
async function agentFor(c: Conversation): Promise<Live> {
  const team = c.teamId ? teams.find((t) => t.id === c.teamId) : undefined;
  if (c.teamId && !team) throw new Error("cette équipe n'existe plus");
  const profile = profileOf(team ? team.root.agentId : c.agentId);
  const signature = JSON.stringify([profile, cfg.llm.model, team, team ? profiles : null]);
  let l = live.get(c.id);
  if (!l || l.signature !== signature) {
    let agent: Agent;
    let budget: TeamBudget | undefined;
    let masterBudget: { used: number } | undefined;
    if (team) {
      budget = new TeamBudget(team.maxCalls, team.maxDepth);
      agent = makeTeamRoot({ cfg, services, team, profileOf, budget, memory: memoryFor(cfg.memory.folders) });
    } else if (profile.master) {
      masterBudget = { used: 0 };
      agent = new Agent(cfg, services, profile, {
        memory: memoryFor(cfg.memory.folders),
        extraTools: appControlTools(appControl, profile, masterBudget),
        teamNote:
          `Tu es l'agent principal de ${cfg.user.name} (MASTER) : tu pilotes l'app MyIA. Tu peux lister et créer des agents, ouvrir des conversations, ` +
          "consulter la Guilde et écrire aux autres agents (app_agent_message) quand une tâche relève de leur rôle. Fais toi-même ce qui est simple.",
      });
    } else {
      agent = new Agent(cfg, services, profile, { memory: memoryFor(cfg.memory.folders) });
    }
    agent.importHistory(c.history);
    await agent.refreshServices();
    l = { agent, signature, running: l?.running, budget, masterBudget };
    live.set(c.id, l);
  }
  return l;
}

// ─── validation des paramètres ───────────────────────────────────────────────

function parse<S extends z.ZodType>(schema: S, params: unknown): z.infer<S> {
  const r = schema.safeParse(params);
  if (!r.success) throw new RpcError(-32602, r.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(" ; "));
  return r.data;
}
const IdParam = z.object({ id: z.string().uuid() });
const ModelParam = z.object({ name: z.string().regex(MODEL_NAME) });

// ─── app ─────────────────────────────────────────────────────────────────────

rpc.method("app.info", () => ({
  version: VERSION,
  home: paths.home,
  userName: cfg.user.name,
  node: process.version,
  platform: process.platform,
}));

rpc.method("overview", async () => {
  const client = engine();
  const baseUrl = cfg.llm.engine === "llamacpp" ? `http://127.0.0.1:${cfg.llm.llamacpp.port}` : cfg.llm.baseUrl;
  let ollamaInfo: Record<string, unknown> = { ok: false, baseUrl, engine: cfg.llm.engine };
  try {
    const [version, running, installed] = await Promise.all([client.version(), client.runningModels(), client.listModels()]);
    ollamaInfo = { ok: true, baseUrl, engine: cfg.llm.engine, version, running, installedCount: installed.length };
  } catch (e) {
    ollamaInfo.error = (e as Error).message;
  }
  const statuses = await Promise.all(
    services.map(async (s) => {
      try {
        const st = await s.available();
        return { id: s.id, label: s.label, ok: st.ok, reason: st.reason, tools: st.ok ? s.tools().map((t) => t.name) : [] };
      } catch (e) {
        return { id: s.id, label: s.label, ok: false, reason: (e as Error).message, tools: [] };
      }
    }),
  );
  const convs = store.list();
  const busy = [...live.entries()].filter(([, l]) => l.running).map(([id]) => id);
  return {
    ollama: ollamaInfo,
    defaultModel: cfg.llm.model,
    agents: profiles.map((p) => ({
      ...p,
      model: p.model ?? cfg.llm.model,
      conversations: convs.filter((c) => c.agentId === p.id).length,
      busy: busy.filter((id) => store.get(id).agentId === p.id).length,
    })),
    conversations: { total: convs.length, busy: busy.length },
    teams: teams.map((t) => ({ id: t.id, name: t.name })),
    services: statuses,
  };
});

// ─── agents (profils) ────────────────────────────────────────────────────────

rpc.method("agents.list", () => profiles.map((p) => ({ ...p, model: p.model, effectiveModel: p.model ?? cfg.llm.model })));

rpc.method("agents.save", (params) => {
  const p = parse(AgentProfileSchema, params);
  saveProfile(p);
  return p;
});

rpc.method("agents.delete", (params) => {
  deleteAgent(parse(z.object({ id: z.string() }), params).id);
  return true;
});

function deleteAgent(id: string) {
  if (profiles.length <= 1) throw new Error("il faut garder au moins un agent");
  const used = store.list().filter((c) => c.agentId === id).length;
  if (used) throw new Error(`${used} conversation(s) utilisent encore cet agent`);
  const inTeams = teams.filter((t) => JSON.stringify(t.root).includes(`"agentId":"${id}"`)).map((t) => t.name);
  if (inTeams.length) throw new Error(`cet agent fait partie de : ${inTeams.join(", ")}`);
  profiles = profiles.filter((p) => p.id !== id);
  saveProfiles(profiles);
}

rpc.method("agents.import", (params) => {
  const { json } = parse(z.object({ json: z.string().max(64_000) }), params);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("fichier d'agent : JSON invalide");
  }
  // Le rôle MASTER ne s'attribue que depuis l'écran Agents, jamais par un fichier importé.
  const p = { ...parse(AgentProfileSchema, raw), master: undefined };
  if (profiles.some((x) => x.id === p.id)) throw new Error(`un agent « ${p.id} » existe déjà`);
  profiles = [...profiles, p];
  saveProfiles(profiles);
  return p;
});

// ─── équipes ─────────────────────────────────────────────────────────────────

rpc.method("teams.list", () => teams);

rpc.method("teams.save", (params) => {
  const t = parseTeam(params, new Set(profiles.map((p) => p.id)));
  teams = teams.some((x) => x.id === t.id) ? teams.map((x) => (x.id === t.id ? t : x)) : [...teams, t];
  saveTeams(teams);
  return t;
});

rpc.method("teams.delete", (params) => {
  const { id } = parse(z.object({ id: z.string() }), params);
  const used = store.list().filter((c) => c.teamId === id).length;
  if (used) throw new Error(`${used} conversation(s) utilisent encore cette équipe`);
  teams = teams.filter((t) => t.id !== id);
  saveTeams(teams);
  return true;
});

rpc.method("teams.newNodeId", () => newNodeId());

/** Dossiers où ouvrir une console Claude Code : projets connus + workspace. */
let registry: ProjectRegistry | undefined;
rpc.method("projects.list", () => {
  registry ??= new ProjectRegistry(cfg);
  return {
    workspace: paths.workspace,
    projects: registry.all.map((p) => ({ name: p.name, path: p.path, kinds: p.kinds })),
  };
});

rpc.method("services.list", () => services.map((s) => ({ id: s.id, label: s.label })));

// ─── conversations ───────────────────────────────────────────────────────────

rpc.method("conversations.list", () => store.list());

rpc.method("conversations.get", (params) => {
  const { messages, ...rest } = store.get(parse(IdParam, params).id);
  return { ...rest, history: undefined, messages, busy: !!live.get(rest.id)?.running };
});

rpc.method("conversations.create", (params) => {
  const p = parse(
    z.object({ agentId: z.string().optional(), teamId: z.string().optional(), title: z.string().max(80).optional() }),
    params,
  );
  let agentId = p.agentId;
  if (p.teamId) {
    const team = teams.find((t) => t.id === p.teamId);
    if (!team) throw new Error(`équipe inconnue : ${p.teamId}`);
    agentId = team.root.agentId;
  }
  if (!agentId || !profiles.some((x) => x.id === agentId)) throw new Error(`agent inconnu : ${agentId ?? "—"}`);
  const { history: _h, ...c } = store.create(agentId, p.title, p.teamId);
  return c;
});

rpc.method("conversations.update", (params) => {
  const p = parse(
    z.object({ id: z.string().uuid(), title: z.string().trim().min(1).max(80).optional(), pinned: z.boolean().optional(), agentId: z.string().optional() }),
    params,
  );
  const c = store.get(p.id);
  if (p.agentId !== undefined) {
    if (!profiles.some((x) => x.id === p.agentId)) throw new Error(`agent inconnu : ${p.agentId}`);
    if (live.get(c.id)?.running) throw new Error("conversation en cours : attends la réponse");
    c.agentId = p.agentId;
  }
  if (p.title !== undefined) c.title = p.title;
  if (p.pinned !== undefined) c.pinned = p.pinned;
  store.save(c);
  return true;
});

rpc.method("conversations.delete", (params) => {
  const { id } = parse(IdParam, params);
  live.get(id)?.running?.abort();
  live.delete(id);
  store.delete(id);
  return true;
});

rpc.method("conversations.clear", (params) => {
  const { id } = parse(IdParam, params);
  const c = store.get(id);
  if (live.get(id)?.running) throw new Error("conversation en cours");
  c.messages = [];
  c.history = [];
  live.delete(id);
  store.save(c);
  return true;
});

rpc.method("conversations.cancel", (params) => {
  live.get(parse(IdParam, params).id)?.running?.abort();
  return true;
});

interface SendOptions {
  /** Expéditeur affiché quand ce n'est pas l'utilisateur (ex. MASTER). */
  from?: string;
  /** Les confirmations passent par cette interface (celle de l'agent appelant) au lieu de la conversation. */
  confirmVia?: AgentUI;
  signal?: AbortSignal;
}

/** Envoie un message dans une conversation et attend la réponse de son agent (utilisateur ou MASTER). */
async function sendTo(c: Conversation, text: string, opts: SendOptions = {}): Promise<DisplayMessage> {
  const id = c.id;
  const l = await agentFor(c);
  if (l.running) throw new Error("l'agent répond déjà dans cette conversation");

  const emit = (msg: DisplayMessage) => rpc.notify("conversation.message", { conversationId: id, message: msg });
  emit(store.push(c, { role: "user", text, ...(opts.from ? { from: opts.from } : {}) }));
  if (!opts.from && c.messages.filter((m) => m.role === "user").length === 1 && c.title === "Nouvelle conversation") {
    c.title = text.replace(/\s+/g, " ").slice(0, 60);
    store.save(c);
    rpc.notify("conversation.updated", { conversationId: id, title: c.title });
  }

  const running = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) running.abort();
    else opts.signal.addEventListener("abort", () => running.abort(), { once: true });
  }
  l.running = running;
  if (l.budget) l.budget.calls = 0;
  if (l.masterBudget) l.masterBudget.used = 0;
  rpc.notify("conversation.busy", { conversationId: id, busy: true });
  const agentName = profileOf(c.agentId).name;

  const ui: AgentUI = {
    async confirm(title, details) {
      const m = store.push(c, { role: "confirm", title, text: details, decision: "pending" });
      emit(m);
      let ok = false;
      try {
        ok = opts.confirmVia
          ? await opts.confirmVia.confirm(`${agentName} · ${title}`, details)
          : (await rpc.call<boolean>("ui.confirm", { conversationId: id, messageId: m.id, title, details }, running.signal)) === true;
      } catch {
        ok = false;
      }
      m.decision = ok ? "approved" : "refused";
      store.save(c);
      rpc.notify("conversation.confirmed", { conversationId: id, messageId: m.id, decision: m.decision });
      return ok;
    },
    progress(message) {
      emit(store.push(c, { role: "progress", text: message }));
    },
  };

  try {
    // Un message d'un autre agent n'est pas l'utilisateur : ses liens ne sont pas de confiance.
    const answer = await l.agent.handle(text, ui, running.signal, opts.from ? false : undefined);
    c.history = l.agent.exportHistory();
    const m = store.push(c, { role: "assistant", text: answer });
    emit(m);
    return m;
  } catch (e) {
    c.history = l.agent.exportHistory();
    const msg = running.signal.aborted ? "Interrompu." : `Erreur : ${(e as Error).message}`;
    const m = store.push(c, { role: "error", text: msg });
    emit(m);
    return m;
  } finally {
    l.running = undefined;
    rpc.notify("conversation.busy", { conversationId: id, busy: false });
  }
}

rpc.method("conversations.send", async (params) => {
  const { id, text } = parse(z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(20_000) }), params);
  return sendTo(store.get(id), text);
});

// ─── MASTER : ce que l'agent principal peut faire dans l'app ─────────────────

/** Enregistre un profil ; un seul MASTER à la fois. */
function saveProfile(p: AgentProfile) {
  let next = profiles.some((x) => x.id === p.id) ? profiles.map((x) => (x.id === p.id ? p : x)) : [...profiles, p];
  if (p.master) next = next.map((x) => (x.id !== p.id && x.master ? { ...x, master: undefined } : x));
  saveProfiles(next);
  profiles = next;
}

const summary = (c: { id: string; title: string; agentId: string; teamId?: string; updatedAt: string }) => ({ id: c.id, title: c.title, agentId: c.agentId, teamId: c.teamId, updatedAt: c.updatedAt });

const appControl: AppControl = {
  agents: () => profiles,
  teams: () => teams.map((t) => ({ id: t.id, name: t.name, description: t.description })),
  conversations: () => store.list().map(summary),
  installedModels: async () => (await engine().listModels()).map((m) => m.name),
  createAgent(p) {
    const parsed = parse(AgentProfileSchema, { ...p, master: undefined });
    if (profiles.some((x) => x.id === parsed.id)) throw new Error(`un agent « ${parsed.id} » existe déjà`);
    saveProfile(parsed);
    rpc.notify("agents.changed", {});
    return parsed;
  },
  deleteAgent(id) {
    deleteAgent(id);
    rpc.notify("agents.changed", {});
  },
  createConversation(agentId, title) {
    const { history: _h, ...c } = store.create(agentId, title);
    rpc.notify("conversations.changed", {});
    return summary(c);
  },
  guild: () => {
    const g = loadGuild();
    return { enabled: g.enabled, relay: relayStatus(), offers: g.offers };
  },
  publishOffer(offer) {
    const g = loadGuild();
    const o = parse(OfferSchema, offer);
    const saved = saveGuild({ ...g, offers: [...g.offers.filter((x) => x.id !== o.id), o] });
    link?.publishOffers();
    return saved.offers.find((x) => x.id === o.id)!;
  },
  async messageAgent(fromName, agentId, text, confirmVia, signal) {
    const target = profileOf(agentId);
    const title = `${fromName} ↔ ${target.name}`;
    let convId = store.list().find((x) => x.agentId === agentId && !x.teamId && x.title === title)?.id;
    if (!convId) {
      convId = store.create(agentId, title).id;
      rpc.notify("conversations.changed", {});
    }
    const m = await sendTo(store.get(convId), text, { from: fromName, confirmVia, signal });
    if (m.role === "error") throw new Error(m.text);
    return m.text;
  },
};

// ─── modèles ─────────────────────────────────────────────────────────────────

rpc.method("models.list", async () => {
  const client = engine();
  const [installed, running] = await Promise.all([client.listModels(), client.runningModels()]);
  return { installed, running, defaultModel: cfg.llm.model, pulling: [...pulls.keys()], engine: cfg.llm.engine };
});

rpc.method("models.pull", async (params) => {
  const { name } = parse(ModelParam, params);
  if (pulls.has(name)) throw new Error("téléchargement déjà en cours");
  const ac = new AbortController();
  pulls.set(name, ac);
  let last = 0;
  try {
    await engine().pull(
      name,
      (p) => {
        const now = Date.now();
        if (now - last < 200 && p.completed !== p.total) return; // limite le débit d'événements
        last = now;
        rpc.notify("models.progress", { name, ...p });
      },
      ac.signal,
    );
    rpc.notify("models.progress", { name, status: "success" });
    return true;
  } finally {
    pulls.delete(name);
  }
});

rpc.method("models.cancelPull", (params) => {
  pulls.get(parse(ModelParam, params).name)?.abort();
  return true;
});

rpc.method("models.delete", async (params) => {
  const { name } = parse(ModelParam, params);
  if (name === cfg.llm.model) throw new Error("c'est le modèle par défaut : choisis-en un autre avant de le supprimer");
  const users = profiles.filter((p) => p.model === name).map((p) => p.name);
  if (users.length) throw new Error(`utilisé par : ${users.join(", ")}`);
  await engine().deleteModel(name);
  return true;
});

rpc.method("models.unload", async (params) => {
  await engine().unload(parse(ModelParam, params).name);
  return true;
});

/** Change llm.model dans config/agent.json (seul champ modifié, le reste du fichier est conservé). */
rpc.method("models.setDefault", async (params) => {
  const { name } = parse(ModelParam, params);
  if (!(await engine().hasModel(name))) throw new Error(`modèle non installé : ${name}`);
  const raw = JSON.parse(fs.readFileSync(paths.config, "utf8")) as { llm?: Record<string, unknown> };
  raw.llm = { ...(raw.llm ?? {}), model: name };
  writeJsonAtomic(paths.config, raw);
  setCfg(loadConfig());
  return true;
});

// ─── réglages et thèmes ──────────────────────────────────────────────────────

const settingsFile = path.join(paths.home, "data", "app-settings.json");

rpc.method("settings.get", () => {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  } catch {
    return {};
  }
});

rpc.method("settings.set", (params) => {
  const s = parse(z.record(z.string(), z.unknown()), params);
  if (JSON.stringify(s).length > 64_000) throw new Error("réglages trop volumineux");
  writeJsonAtomic(settingsFile, s);
  return true;
});

rpc.method("themes.list", () => listThemes());
rpc.method("themes.install", (params) => installTheme(parse(z.object({ json: z.string() }), params).json));
rpc.method("themes.delete", (params) => {
  deleteTheme(parse(z.object({ id: z.string() }), params).id);
  return true;
});

/** Modifie un réglage simple de config/agent.json sans toucher au reste du fichier. */
function patchConfig(mutate: (raw: Record<string, any>) => void) {
  setCfg(patchConfigFile(mutate));
  live.clear();
}

// ─── Guilde ──────────────────────────────────────────────────────────────────

// Compte mcfstudio.fr (OAuth + PKCE, boucle locale) : jeton de renouvellement dans le coffre Windows.
let mcf = new McfAccount(cfg.site.url, { openBrowser: openInBrowser });

// ─── Carte des agents de mcfstudio.fr (option, noms d'agents seulement) ─────────
let agentsMap = new AgentsMap(cfg.site.url, () => profiles, openInBrowser);
agentsMap.start();
let mapLogin: AbortController | undefined;

const mapStatus = () => {
  const s = agentsMap.state();
  return { ...s, site: cfg.site.url, refused: mapNames(profiles, s.agents).refused };
};

rpc.method("map.status", () => mapStatus());

const MapAgentsParam = z.object({ agents: z.array(z.string().max(40)).max(12) });

rpc.method("map.enable", async (params) => {
  const { agents } = parse(MapAgentsParam, params);
  if (mapLogin) throw new Error("autorisation déjà en cours dans le navigateur");
  mapLogin = new AbortController();
  try {
    await agentsMap.enable(agents, mapLogin.signal);
  } finally {
    mapLogin = undefined;
  }
  return mapStatus();
});

rpc.method("map.cancelLogin", () => {
  mapLogin?.abort();
  return true;
});

rpc.method("map.setAgents", async (params) => {
  await agentsMap.setAgents(parse(MapAgentsParam, params).agents);
  return mapStatus();
});

rpc.method("map.disable", async () => {
  await agentsMap.disable();
  return mapStatus();
});
let mcfLogin: AbortController | undefined;

// Lien avec le relais (wss://myia.mcfstudio.fr/guilde) : clé d'appareil X25519 dans le coffre, contenu chiffré de bout en bout.
function makeLink() {
  return new GuildLink({
    relayUrl: cfg.site.relayUrl,
    keys: deviceKeys(),
    token: () => mcf.accessToken(),
    loadGuild,
    run: (offer, text, maxSeconds, signal) => runSandboxed(cfg, offer, text, maxSeconds, signal),
    emit: (event, data) => rpc.notify(event, data),
    appVersion: VERSION,
  });
}
let link: GuildLink | undefined;
async function startLink() {
  try {
    if (!(await mcf.accessToken())) return;
  } catch {
    return;
  }
  link ??= makeLink();
  link.start();
}
function stopLink(reason?: string) {
  link?.stop(reason);
  link = undefined;
}
void startLink();

const relayStatus = () => link?.status ?? { state: "off", reason: "non connecté à mcfstudio.fr" };
rpc.method("guild.get", () => ({ ...loadGuild(), relay: relayStatus() }));
rpc.method("guild.status", () => relayStatus());
rpc.method("guild.connect", async () => {
  stopLink();
  await startLink();
  return relayStatus();
});
rpc.method("guild.pending", () => link?.pendingList() ?? []);
/** Ajoute (ou lie à son compte) un membre de la liste blanche, depuis une demande reçue : id garanti par le relais. */
rpc.method("guild.trust", (params) => {
  const { id, name } = parse(z.object({ id: z.number().int().positive(), name: z.string().trim().min(2).max(40) }), params);
  const g = loadGuild();
  const same = g.whitelist.find((w) => w.id === id) ?? g.whitelist.find((w) => w.id === undefined && w.name.toLowerCase() === name.toLowerCase());
  if (same) Object.assign(same, { id, name });
  else g.whitelist.push({ id, name });
  return saveGuild(g);
});
rpc.method("guild.accept", async (params) => {
  const { id } = parse(z.object({ id: z.string().min(10).max(64) }), params);
  if (!link) throw new Error("pas connecté au relais");
  await link.accept(id);
  return true;
});
rpc.method("guild.reject", (params) => {
  const { id, reason } = parse(z.object({ id: z.string().min(10).max(64), reason: z.string().trim().max(200).optional() }), params);
  if (!link) throw new Error("pas connecté au relais");
  link.reject(id, reason || undefined);
  return true;
});
let asking: AbortController | undefined;
rpc.method("guild.ask", async (params) => {
  const p = parse(
    z
      .object({
        tag: z.string().trim().min(2).max(24).optional(),
        to: z.number().int().positive().optional(),
        offerId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/).optional(),
        text: z.string().trim().min(3).max(20_000),
      })
      .refine((x) => (x.tag === undefined) !== (x.to === undefined), "une compétence (tag) OU un membre"),
    params,
  );
  if (!link) throw new Error("connecte-toi d'abord à mcfstudio.fr");
  if (asking) throw new Error("une demande à la Guilde est déjà en cours");
  asking = new AbortController();
  try {
    const { text, ...target } = p;
    return await link.ask(target, text, asking.signal);
  } finally {
    asking = undefined;
  }
});
rpc.method("guild.cancelAsk", () => {
  asking?.abort();
  return true;
});

rpc.method("guild.account", async () => {
  try {
    return { site: cfg.site.url, account: (await mcf.account()) ?? null };
  } catch (e) {
    return { site: cfg.site.url, account: null, error: (e as Error).message };
  }
});

rpc.method("guild.login", async () => {
  if (mcfLogin) throw new Error("connexion déjà en cours dans le navigateur");
  mcfLogin = new AbortController();
  try {
    const account = await mcf.login(mcfLogin.signal);
    void startLink();
    return { site: cfg.site.url, account };
  } finally {
    mcfLogin = undefined;
  }
});

rpc.method("guild.cancelLogin", () => {
  mcfLogin?.abort();
  return true;
});

rpc.method("guild.logout", async () => {
  stopLink("déconnecté de mcfstudio.fr");
  await mcf.logout();
  return true;
});

rpc.method("guild.save", (params) => {
  const { relay: _r, ...raw } = (params ?? {}) as Record<string, unknown>;
  const saved = saveGuild(raw);
  link?.publishOffers();
  return saved;
});

/** Ce que la machine ferait d'une demande, sans rien exécuter (simulateur des règles). */
rpc.method("guild.simulate", (params) => {
  const p = parse(
    z.object({
      memberId: z.string().min(2).max(40),
      certified: z.boolean(),
      offerId: z.string(),
      chars: z.number().int().min(1).max(100_000),
      at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      gpuPct: z.number().min(0).max(100).optional(),
      usageHour: z.number().int().min(0).default(0),
      usageDay: z.number().int().min(0).default(0),
    }),
    params,
  );
  const [h, m] = p.at.split(":").map(Number) as [number, number];
  const now = new Date();
  now.setHours(h, m, 0, 0);
  return decide(
    loadGuild(),
    {
      // Membre simulé : s'il est dans ta liste blanche et lié à son compte, on le traite comme tel.
      from: {
        name: p.memberId,
        certified: p.certified,
        id: loadGuild().whitelist.find((w) => w.id !== undefined && w.name.toLowerCase() === p.memberId.toLowerCase())?.id,
      },
      offerId: p.offerId,
      text: "x".repeat(p.chars),
    },
    { memberLastHour: p.usageHour, today: p.usageDay },
    now,
    p.gpuPct,
  );
});

/** Teste une offre en local, exactement comme une demande reçue serait traitée (bac à sable sans outils). */
rpc.method("guild.test", async (params) => {
  const p = parse(z.object({ offerId: z.string(), text: z.string().trim().min(3).max(20_000) }), params);
  const g = loadGuild();
  const offer = g.offers.find((o) => o.id === p.offerId);
  if (!offer) throw new Error("offre introuvable");
  const t0 = Date.now();
  try {
    const answer = await runSandboxed(cfg, offer, p.text, g.limits.maxSeconds);
    journal({ kind: "test", offerId: offer.id, from: "toi (test)", decision: "auto", chars: p.text.length, ms: Date.now() - t0 });
    return { answer, ms: Date.now() - t0 };
  } catch (e) {
    journal({ kind: "test", offerId: offer.id, from: "toi (test)", decision: "erreur", reason: (e as Error).message, chars: p.text.length });
    throw e;
  }
});

rpc.method("guild.journal", () => readJournal());

// ─── dictée (whisper.cpp) ────────────────────────────────────────────────────

let whisperInstall: AbortController | undefined;

rpc.method("whisper.status", () => ({ ...whisperStatus(), engines_info: ENGINES, models_info: MODELS }));

rpc.method("whisper.install", async (params) => {
  const p = parse(z.object({ engine: z.enum(["cpu", "cuda"]), model: z.enum(["large-v3-turbo", "small"]) }), params);
  if (whisperInstall) throw new Error("installation déjà en cours");
  whisperInstall = new AbortController();
  try {
    return await installWhisper(p.engine, p.model, (pr) => rpc.notify("whisper.progress", pr), whisperInstall.signal);
  } finally {
    whisperInstall = undefined;
  }
});

rpc.method("whisper.cancelInstall", () => {
  whisperInstall?.abort();
  return true;
});

rpc.method("whisper.uninstall", () => {
  if (whisperInstall) throw new Error("installation en cours");
  uninstallWhisper();
  return true;
});

rpc.method("whisper.transcribe", async (params) => {
  const p = parse(z.object({ audio: z.string().max(11_200_000), language: z.string().max(4).default("fr") }), params);
  return { text: await transcribe(Buffer.from(p.audio, "base64"), p.language) };
});

rpc.method("claude.triage", async (params) => {
  const { task } = parse(z.object({ task: z.string().trim().min(3).max(6000) }), params);
  return triageTask(engine(), task);
});

/** Abonnement du compte Claude Code de cette machine (affiché à côté du choix du modèle). */
rpc.method("claude.account", () => claudeAccount(cfg.claude.command, paths.home));

/** Modèles Claude proposés dans l'interface : une seule liste, celle du cœur. */
rpc.method("claude.models", () => CLAUDE_MODELS.map((id) => ({ id, ...CLAUDE_MODEL_INFO[id] })));

// ─── Agents sur l'API Claude : clé d'API de l'utilisateur ───────────────────
// La clé ne fait que l'aller (interface → coffre Windows) : aucune méthode ne la renvoie, seule sa fin est affichée.

/** Modèles proposés pour un agent « claude-api:<alias> », et état de la clé. */
rpc.method("claudeApi.status", () => ({
  ...apiKeyStatus(),
  effort: cfg.claudeApi.effort,
  models: Object.entries(CLAUDE_API_MODELS).map(([alias, m]) => ({ id: alias, label: m.label, hint: m.hint })),
}));

rpc.method("claudeApi.setKey", async (params) => {
  const { key } = parse(z.object({ key: z.string().trim().min(10).max(400) }), params);
  await verifyApiKey(key);
  setSecret(API_KEY_SECRET, key);
  audit({ event: "claude_api_key", action: "set" });
  return apiKeyStatus();
});

rpc.method("claudeApi.deleteKey", () => {
  deleteSecret(API_KEY_SECRET);
  audit({ event: "claude_api_key", action: "delete" });
  return apiKeyStatus();
});

/** Passation d'une console : le fichier existe-t-il (et a-t-il fini d'être écrit) ? Dossiers autorisés uniquement. */
rpc.method("handoff.status", (params) => {
  const { cwd, file } = parse(z.object({ cwd: z.string().max(500), file: z.string().regex(/^\.myia\/handoff-[0-9-]{8,20}\.md$/) }), params);
  const allowed = [paths.workspace, ...cfg.projectRoots.map((r) => r.path), ...Object.values(cfg.projects).map((p) => p.path)];
  const dir = path.resolve(assertLocalPath(cwd));
  if (!allowed.some((r) => isInside(r, dir))) throw new Error("dossier non autorisé");
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return { exists: false };
  const st = fs.statSync(full);
  return { exists: true, size: st.size, mtime: st.mtimeMs };
});

rpc.method("programs.list", () => listPrograms());

rpc.method("programs.add", (params) => {
  const p = parse(z.object({ name: z.string(), path: z.string().max(500), description: z.string().max(200).optional() }), params);
  const added = addProgram(p.name.trim(), p.path, p.description);
  setCfg(loadConfig());
  live.clear(); // les agents verront le nouveau programme dans la description de program_launch
  return added;
});

rpc.method("programs.remove", (params) => {
  removeProgram(parse(z.object({ name: z.string() }), params).name);
  setCfg(loadConfig());
  live.clear();
  return true;
});

rpc.method("programs.search", (params) => searchPrograms(parse(z.object({ query: z.string().min(2).max(60) }), params).query));

rpc.method("config.get", () => ({
  userName: cfg.user.name,
  projectRoots: cfg.projectRoots,
  configPath: paths.config,
  claudeBypassPermissions: cfg.claude.bypassPermissions,
  filesFullAccess: cfg.files.fullAccess,
  engine: {
    flashAttention: cfg.llm.flashAttention,
    kvCache: cfg.llm.kvCache,
    engine: cfg.llm.engine,
    backend: cfg.llm.llamacpp.backend,
  },
}));

const DEFAULT_MODEL = { ollama: "qwen3:8b", llamacpp: "Qwen3-8B-Q4_K_M" } as const;

/**
 * Moteur local et ses réglages. Changer de moteur échange le modèle par défaut avec celui gardé pour l'autre moteur
 * (rien n'est perdu) ; le serveur llama.cpp est arrêté pour repartir avec les nouveaux réglages.
 */
rpc.method("config.setEngine", async (params) => {
  const p = parse(
    z.object({
      flashAttention: z.boolean(),
      kvCache: z.enum(["f16", "q8_0", "q4_0"]),
      engine: z.enum(["ollama", "llamacpp"]).optional(),
      backend: z.enum(["cuda", "vulkan", "cpu"]).optional(),
    }),
    params,
  );
  const next = p.engine ?? cfg.llm.engine;
  if (next === "llamacpp" && !activeBuild({ ...cfg.llm, llamacpp: { ...cfg.llm.llamacpp, backend: p.backend ?? cfg.llm.llamacpp.backend } })) {
    throw new Error("installe d'abord une build de llama.cpp (ci-dessous)");
  }
  patchConfig((raw) => {
    const llm = { ...(raw.llm ?? {}) } as Record<string, any>;
    llm.flashAttention = p.flashAttention;
    llm.kvCache = p.kvCache;
    if (p.backend) llm.llamacpp = { ...(llm.llamacpp ?? {}), backend: p.backend };
    if (next !== cfg.llm.engine) {
      const others = { ...(llm.otherModels ?? {}) };
      others[cfg.llm.engine] = cfg.llm.model;
      llm.model = others[next] ?? DEFAULT_MODEL[next];
      delete others[next];
      llm.otherModels = others;
      llm.engine = next;
    }
    raw.llm = llm;
  });
  stopLlamaServer();
  void engine()
    .ensureRunning()
    .then(() => rpc.notify("ollama.ready", {}))
    .catch((e) => rpc.notify("ollama.error", { message: (e as Error).message }));
  return true;
});

// ─── llama.cpp : builds et catalogue de modèles ──────────────────────────────

/**
 * Claude Code sur le modèle local : démarre llama-server et charge le modèle llama.cpp par défaut avant l'ouverture de
 * la console (qui lit elle-même adresse, modèle et clé côté Rust).
 */
rpc.method("claude.localReady", async () => {
  const model = cfg.llm.model;
  if (cfg.llm.engine === "llamacpp") {
    if (!activeBuild(cfg.llm)) throw new Error("llama.cpp n'est pas installé : Paramètres → Système → Moteur");
    const client = new LlamaCppClient(cfg.llm, model);
    if (!(await client.hasModel(model))) throw new Error(`modèle ${model} absent : onglet Modèles`);
    await client.ensureRunning();
    await client.warmUp();
    return { engine: "llamacpp", model };
  }
  // Ollama : variante du modèle par défaut avec un contexte assez grand pour Claude Code (mêmes poids, rien de copié).
  const client = new OllamaClient(cfg.llm);
  await client.ensureRunning();
  if (!(await client.hasModel(model))) throw new Error(`modèle ${model} absent : onglet Modèles`);
  const variant = claudeLocalOllamaModel(model);
  await client.createVariant(variant, model, { num_ctx: CLAUDE_LOCAL_CTX });
  const loaded = await client.loadAndMeasure(variant, CLAUDE_LOCAL_CTX);
  const onGpu = loaded && loaded.size ? loaded.sizeVram / loaded.size : 1;
  const warning =
    onGpu < 0.98
      ? `${Math.round((1 - onGpu) * 100)} % du modèle ne tient pas en VRAM et tourne sur le processeur : Claude Code sera très lent. ` +
        "Choisis un modèle plus petit (qwen3:4b), ou active la mémoire de contexte compressée (Paramètres → Système) en laissant MyIA démarrer Ollama."
      : undefined;
  return { engine: "ollama", model: variant, warning };
});

// ─── Ollama : installation par le script officiel (signature vérifiée) ───────

let ollamaInstall: AbortController | undefined;
rpc.method("ollama.status", () => {
  const found = findOllama();
  return {
    installed: !!found,
    version: found?.version ?? null,
    outdated: !!found && !versionAtLeast(found.version, MIN_OLLAMA),
    minVersion: MIN_OLLAMA,
    installing: !!ollamaInstall,
    canInstall: process.platform === "win32",
  };
});
rpc.method("ollama.install", async () => {
  if (ollamaInstall) throw new Error("installation déjà en cours");
  ollamaInstall = new AbortController();
  try {
    const r = await installOllama((what) => rpc.notify("ollama.installProgress", { what }), ollamaInstall.signal);
    audit({ event: "ollama_install", version: r.version });
    // Moteur actif = Ollama : on le démarre tout de suite, sans attendre un redémarrage de MyIA.
    if (cfg.llm.engine !== "llamacpp") {
      void engine()
        .ensureRunning()
        .then(() => rpc.notify("ollama.ready", {}))
        .catch((e) => rpc.notify("ollama.error", { message: (e as Error).message }));
    }
    return r;
  } finally {
    ollamaInstall = undefined;
  }
});
rpc.method("ollama.cancelInstall", () => {
  ollamaInstall?.abort();
  return true;
});

let buildInstall: AbortController | undefined;
rpc.method("llamacpp.status", () => {
  const local = new Set(fs.existsSync(paths.llamacppModels) ? fs.readdirSync(paths.llamacppModels).filter((f) => f.endsWith(".gguf")).map((f) => f.slice(0, -5)) : []);
  return {
    builds: Object.entries(BUILDS).map(([id, b]) => ({ id, label: b.label, sizeMb: b.sizeMb, installed: installedBuilds()[id as Build] })),
    active: activeBuild(cfg.llm) ?? null,
    catalog: Object.entries(CATALOG).map(([id, m]) => ({ id, label: m.label, note: m.note, size: m.size, installed: local.has(id) })),
    installing: !!buildInstall,
  };
});
rpc.method("llamacpp.install", async (params) => {
  const { build } = parse(z.object({ build: z.enum(["cuda", "vulkan", "cpu"]) }), params);
  if (buildInstall) throw new Error("installation déjà en cours");
  buildInstall = new AbortController();
  try {
    await installBuild(build, (p) => rpc.notify("llamacpp.progress", p), buildInstall.signal);
    return true;
  } finally {
    buildInstall = undefined;
  }
});
rpc.method("llamacpp.cancelInstall", () => {
  buildInstall?.abort();
  return true;
});
rpc.method("llamacpp.uninstall", (params) => {
  const { build } = parse(z.object({ build: z.enum(["cuda", "vulkan", "cpu"]) }), params);
  if (cfg.llm.engine === "llamacpp" && activeBuild(cfg.llm) === build && Object.values(installedBuilds()).filter(Boolean).length === 1) {
    throw new Error("c'est la seule build du moteur actif : repasse sur Ollama avant de la désinstaller");
  }
  uninstallBuild(build);
  return true;
});

/** Accès des agents à tout le PC (lecture et recherche ; écriture toujours confirmée hors Documents\MyIA). */
rpc.method("config.setFilesFullAccess", (params) => {
  const { enabled } = parse(z.object({ enabled: z.boolean() }), params);
  patchConfig((raw) => (raw.files = { ...(raw.files ?? {}), fullAccess: enabled }));
  audit({ event: "files_full_access", ok: enabled });
  return true;
});

rpc.method("config.setClaudeBypassPermissions", (params) => {
  const { enabled } = parse(z.object({ enabled: z.boolean() }), params);
  patchConfig((raw) => (raw.claude = { ...(raw.claude ?? {}), bypassPermissions: enabled }));
  return true;
});

rpc.method("config.setUserName", (params) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(60) }), params);
  patchConfig((raw) => (raw.user = { ...(raw.user ?? {}), name }));
  return true;
});

rpc.method("memory.status", () => {
  const m = memoryFor(cfg.memory.folders);
  return { folders: cfg.memory.folders, docs: m?.list() ?? [] };
});

rpc.method("config.setMemoryFolders", (params) => {
  const { folders } = parse(z.object({ folders: z.array(z.string().min(3).max(500)).max(20) }), params);
  for (const f of folders) {
    const abs = assertLocalPath(f);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`dossier introuvable : ${abs}`);
  }
  patchConfig((raw) => (raw.memory = { folders }));
  return true;
});

rpc.method("config.setProjectRoots", (params) => {
  const { roots } = parse(
    z.object({ roots: z.array(z.object({ path: z.string().min(1).max(500), depth: z.number().int().min(1).max(5) })).max(20) }),
    params,
  );
  for (const r of roots) if (!fs.existsSync(r.path)) throw new Error(`dossier introuvable : ${r.path}`);
  patchConfig((raw) => (raw.projectRoots = roots));
  registry = undefined;
  return true;
});

rpc.method("config.reload", async () => {
  setCfg(loadConfig());
  await Promise.allSettled(services.map((s) => s.close?.()));
  services = buildServices(cfg);
  profiles = loadProfiles();
  teams = loadTeams();
  registry = undefined;
  live.clear();
  mcf = new McfAccount(cfg.site.url, { openBrowser: openInBrowser });
  agentsMap.stop();
  agentsMap = new AgentsMap(cfg.site.url, () => profiles, openInBrowser);
  agentsMap.start();
  stopLink();
  void startLink();
  return true;
});

// ─── démarrage / arrêt ───────────────────────────────────────────────────────

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const l of live.values()) l.running?.abort();
  stopLink("arrêt de MyIA");
  stopLlamaServer();
  for (const p of pulls.values()) p.abort();
  audit({ event: "session_end" });
  await Promise.race([Promise.allSettled(services.map((s) => s.close?.())), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
}

audit({ event: "session_start" });
rpc.notify("ready", { version: VERSION });
engine()
  .ensureRunning()
  .then(() => rpc.notify("ollama.ready", {}))
  .catch((e) => rpc.notify("ollama.error", { message: (e as Error).message }));
