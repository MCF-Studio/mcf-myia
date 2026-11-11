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
import { triageTask } from "../core/claude-coach.js";
import { MODEL_NAME, OllamaClient } from "../core/llm.js";
import { makeTeamRoot } from "../core/team-runner.js";
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
import { ConversationStore, type Conversation } from "./store.js";
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

let cfg: Config = loadConfig();
let services: Service[] = buildServices(cfg);
let profiles: AgentProfile[] = loadProfiles();
let teams: Team[] = loadTeams();
const store = new ConversationStore();
const ollama = () => new OllamaClient(cfg.llm);

interface Live {
  agent: Agent;
  signature: string;
  running?: AbortController;
  /** Équipe : budget remis à zéro à chaque message de l'utilisateur. */
  budget?: TeamBudget;
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
    if (team) {
      budget = new TeamBudget(team.maxCalls, team.maxDepth);
      agent = makeTeamRoot({ cfg, services, team, profileOf, budget });
    } else {
      agent = new Agent(cfg, services, profile);
    }
    agent.importHistory(c.history);
    await agent.refreshServices();
    l = { agent, signature, running: l?.running, budget };
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
  const client = ollama();
  let ollamaInfo: Record<string, unknown> = { ok: false, baseUrl: cfg.llm.baseUrl };
  try {
    const [version, running, installed] = await Promise.all([client.version(), client.runningModels(), client.listModels()]);
    ollamaInfo = { ok: true, baseUrl: cfg.llm.baseUrl, version, running, installedCount: installed.length };
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
  const next = profiles.some((x) => x.id === p.id) ? profiles.map((x) => (x.id === p.id ? p : x)) : [...profiles, p];
  saveProfiles(next);
  profiles = next;
  return p;
});

rpc.method("agents.delete", (params) => {
  const { id } = parse(z.object({ id: z.string() }), params);
  if (profiles.length <= 1) throw new Error("il faut garder au moins un agent");
  const used = store.list().filter((c) => c.agentId === id).length;
  if (used) throw new Error(`${used} conversation(s) utilisent encore cet agent`);
  const inTeams = teams.filter((t) => JSON.stringify(t.root).includes(`"agentId":"${id}"`)).map((t) => t.name);
  if (inTeams.length) throw new Error(`cet agent fait partie de : ${inTeams.join(", ")}`);
  profiles = profiles.filter((p) => p.id !== id);
  saveProfiles(profiles);
  return true;
});

rpc.method("agents.import", (params) => {
  const { json } = parse(z.object({ json: z.string().max(64_000) }), params);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("fichier d'agent : JSON invalide");
  }
  const p = parse(AgentProfileSchema, raw);
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

rpc.method("conversations.send", async (params) => {
  const { id, text } = parse(z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(20_000) }), params);
  const c = store.get(id);
  const l = await agentFor(c);
  if (l.running) throw new Error("l'agent répond déjà dans cette conversation");

  const emit = (msg: ReturnType<typeof store.push>) => rpc.notify("conversation.message", { conversationId: id, message: msg });
  emit(store.push(c, { role: "user", text }));
  if (c.messages.filter((m) => m.role === "user").length === 1 && c.title === "Nouvelle conversation") {
    c.title = text.replace(/\s+/g, " ").slice(0, 60);
    store.save(c);
    rpc.notify("conversation.updated", { conversationId: id, title: c.title });
  }

  const running = new AbortController();
  l.running = running;
  if (l.budget) l.budget.calls = 0;
  rpc.notify("conversation.busy", { conversationId: id, busy: true });

  const ui: AgentUI = {
    async confirm(title, details) {
      const m = store.push(c, { role: "confirm", title, text: details, decision: "pending" });
      emit(m);
      let ok = false;
      try {
        ok = (await rpc.call<boolean>("ui.confirm", { conversationId: id, messageId: m.id, title, details }, running.signal)) === true;
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
    const answer = await l.agent.handle(text, ui, running.signal);
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
});

// ─── modèles ─────────────────────────────────────────────────────────────────

rpc.method("models.list", async () => {
  const client = ollama();
  const [installed, running] = await Promise.all([client.listModels(), client.runningModels()]);
  return { installed, running, defaultModel: cfg.llm.model, pulling: [...pulls.keys()] };
});

rpc.method("models.pull", async (params) => {
  const { name } = parse(ModelParam, params);
  if (pulls.has(name)) throw new Error("téléchargement déjà en cours");
  const ac = new AbortController();
  pulls.set(name, ac);
  let last = 0;
  try {
    await ollama().pull(
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
  await ollama().deleteModel(name);
  return true;
});

rpc.method("models.unload", async (params) => {
  await ollama().unload(parse(ModelParam, params).name);
  return true;
});

/** Change llm.model dans config/agent.json (seul champ modifié, le reste du fichier est conservé). */
rpc.method("models.setDefault", async (params) => {
  const { name } = parse(ModelParam, params);
  if (!(await ollama().hasModel(name))) throw new Error(`modèle non installé : ${name}`);
  const raw = JSON.parse(fs.readFileSync(paths.config, "utf8")) as { llm?: Record<string, unknown> };
  raw.llm = { ...(raw.llm ?? {}), model: name };
  writeJsonAtomic(paths.config, raw);
  cfg = loadConfig();
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
  cfg = patchConfigFile(mutate);
  live.clear();
}

rpc.method("claude.triage", async (params) => {
  const { task } = parse(z.object({ task: z.string().trim().min(3).max(6000) }), params);
  return triageTask(ollama(), task);
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
  cfg = loadConfig();
  live.clear(); // les agents verront le nouveau programme dans la description de program_launch
  return added;
});

rpc.method("programs.remove", (params) => {
  removeProgram(parse(z.object({ name: z.string() }), params).name);
  cfg = loadConfig();
  live.clear();
  return true;
});

rpc.method("programs.search", (params) => searchPrograms(parse(z.object({ query: z.string().min(2).max(60) }), params).query));

rpc.method("config.get", () => ({
  userName: cfg.user.name,
  projectRoots: cfg.projectRoots,
  configPath: paths.config,
}));

rpc.method("config.setUserName", (params) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(60) }), params);
  patchConfig((raw) => (raw.user = { ...(raw.user ?? {}), name }));
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
  cfg = loadConfig();
  await Promise.allSettled(services.map((s) => s.close?.()));
  services = buildServices(cfg);
  profiles = loadProfiles();
  teams = loadTeams();
  registry = undefined;
  live.clear();
  return true;
});

// ─── démarrage / arrêt ───────────────────────────────────────────────────────

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const l of live.values()) l.running?.abort();
  for (const p of pulls.values()) p.abort();
  audit({ event: "session_end" });
  await Promise.race([Promise.allSettled(services.map((s) => s.close?.())), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
}

audit({ event: "session_start" });
rpc.notify("ready", { version: VERSION });
ollama()
  .ensureRunning()
  .then(() => rpc.notify("ollama.ready", {}))
  .catch((e) => rpc.notify("ollama.error", { message: (e as Error).message }));
