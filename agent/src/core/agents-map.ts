import fs from "node:fs";
import path from "node:path";
import { audit } from "./audit.js";
import { McfAccount, vaultStoreFor } from "./mcf-account.js";
import { paths } from "./paths.js";
import { writeJsonAtomic, type AgentProfile } from "./profiles.js";
import type { Team, TeamNode } from "./teams.js";

/**
 * Carte des agents de mcfstudio.fr (spec du site : docs/superpowers/specs/2026-11-13-carte-agents-design.md).
 *
 * Option désactivée par défaut. Activée, MyIA envoie au site les NOMS des agents cochés par l'utilisateur, et rien
 * d'autre (ni consignes, ni modèle, ni conversations), avec une autorisation OAuth de portée `map`, séparée de celle de
 * la Guilde (jeton de renouvellement dans le coffre, secret `mcfstudio_map_refresh`). Au plus 2 envois par jour : au
 * démarrage si le dernier date de plus de 12 h, puis toutes les 12 h, et quand l'utilisateur change sa sélection.
 * Désactiver retire tout de suite les agents du site puis révoque l'autorisation.
 *
 * Équipes (spec du site §10) : seulement celles que l'utilisateur coche (aucune par défaut) : leur nom, leur chef et
 * les liens entre agents PUBLIÉS. Un agent non coché n'apparaît jamais, même à travers une équipe.
 */

export const MAP_REFRESH_SECRET = "mcfstudio_map_refresh";
export const MAP_SYNC_EVERY_MS = 12 * 60 * 60 * 1000;
export const MAP_MAX_AGENTS = 12;
export const MAP_MAX_TEAMS = 4;
export const MAP_MAX_TEAM_LINKS = 30;
/** Mêmes règles que le site : 1 à 40 caractères, lettres, chiffres, espaces et . _ ' - */
const NAME_RE = /^[\p{L}\p{N} ._'-]{1,40}$/u;

export interface MapState {
  enabled: boolean;
  /** Ids des profils montrés sur la carte. */
  agents: string[];
  /** Ids des équipes montrées (liens entre agents montrés seulement). */
  teams: string[];
  lastSyncAt?: string;
  lastError?: string;
  /** Désactivée mais pas encore retirée du site (hors ligne) : on garde le jeton et on réessaie. */
  pendingRemoval?: boolean;
}

const stateFile = () => path.join(paths.home, "data", "agents-map.json");

export function loadMapState(file = stateFile()): MapState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MapState>;
    return {
      enabled: raw.enabled === true,
      agents: Array.isArray(raw.agents) ? raw.agents.filter((a): a is string => typeof a === "string").slice(0, MAP_MAX_AGENTS) : [],
      teams: Array.isArray(raw.teams) ? raw.teams.filter((t): t is string => typeof t === "string").slice(0, MAP_MAX_TEAMS) : [],
      ...(typeof raw.lastSyncAt === "string" ? { lastSyncAt: raw.lastSyncAt } : {}),
      ...(typeof raw.lastError === "string" ? { lastError: raw.lastError } : {}),
      ...(raw.pendingRemoval === true ? { pendingRemoval: true } : {}),
    };
  } catch {
    return { enabled: false, agents: [], teams: [] };
  }
}

export function saveMapState(s: MapState, file = stateFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, s);
}

const clean = (name: string) => name.normalize("NFC").replace(/\s+/g, " ").trim();

/** Noms envoyés : ceux des profils cochés qui existent encore et respectent les règles du site. */
export function mapNames(profiles: readonly AgentProfile[], ids: readonly string[]): { names: string[]; refused: string[] } {
  const names: string[] = [];
  const refused: string[] = [];
  for (const id of ids) {
    const p = profiles.find((x) => x.id === id);
    if (!p) continue;
    const name = clean(p.name);
    if (NAME_RE.test(name)) names.push(name);
    else refused.push(p.name);
  }
  return { names: names.slice(0, MAP_MAX_AGENTS), refused };
}

export interface MapTeamPayload {
  name: string;
  lead: string;
  links: { from: string; to: string; kind: "sub" | "mate" }[];
}

/**
 * Équipes envoyées : celles cochées dont le chef est un agent montré ; seuls les liens directs entre deux agents montrés
 * partent (un agent non coché ne se devine jamais à travers une équipe).
 */
export function mapTeams(
  profiles: readonly AgentProfile[],
  teams: readonly Team[],
  agentIds: readonly string[],
  teamIds: readonly string[],
): { teams: MapTeamPayload[]; refused: string[] } {
  const { names } = mapNames(profiles, agentIds);
  const shown = new Map<string, string>();
  for (const id of agentIds) {
    const p = profiles.find((x) => x.id === id);
    if (p && names.includes(clean(p.name))) shown.set(id, clean(p.name));
  }
  const out: MapTeamPayload[] = [];
  const refused: string[] = [];
  for (const id of teamIds) {
    const t = teams.find((x) => x.id === id);
    if (!t) continue;
    const name = clean(t.name);
    if (!NAME_RE.test(name)) {
      refused.push(t.name);
      continue;
    }
    const lead = shown.get(t.root.agentId);
    if (!lead || out.length >= MAP_MAX_TEAMS) continue;
    const links: MapTeamPayload["links"] = [];
    const visit = (n: TeamNode) => {
      for (const [kind, list] of [["sub", n.subagents], ["mate", n.teammates]] as const) {
        for (const c of list) {
          const from = shown.get(n.agentId);
          const to = shown.get(c.agentId);
          if (from && to && from !== to) links.push({ from, to, kind });
          visit(c);
        }
      }
    };
    visit(t.root);
    out.push({ name, lead, links: links.slice(0, MAP_MAX_TEAM_LINKS) });
  }
  return { teams: out, refused };
}

export class AgentsMap {
  readonly account: McfAccount;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly siteUrl: string,
    private readonly profiles: () => readonly AgentProfile[],
    openBrowser: (url: string) => void,
    private readonly file = stateFile(),
    private readonly teams: () => readonly Team[] = () => [],
  ) {
    this.account = new McfAccount(siteUrl, { scope: "map", store: vaultStoreFor(MAP_REFRESH_SECRET), openBrowser });
  }

  state(): MapState {
    return loadMapState(this.file);
  }

  private async call(method: "PUT" | "DELETE", body?: unknown): Promise<void> {
    const token = await this.account.accessToken();
    if (!token) throw new Error("carte non autorisée sur mcfstudio.fr : réactive l'option");
    let r: Response;
    try {
      r = await fetch(`${this.siteUrl}/api/apps/map/agents`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error("mcfstudio.fr injoignable");
    }
    if (r.ok) return;
    const data = (await r.json().catch(() => ({}))) as { message?: string };
    if (r.status === 404) throw new Error("le site n'a pas encore la carte des agents (fonction en cours de déploiement)");
    throw new Error(data.message ?? `refusé par le site (${r.status})`);
  }

  /** Envoie la sélection (si l'option est active) ; `force` : même si le dernier envoi date de moins de 12 h. */
  async sync(force = false): Promise<MapState> {
    const s = this.state();
    if (!s.enabled) return s;
    if (!force && s.lastSyncAt && Date.now() - Date.parse(s.lastSyncAt) < MAP_SYNC_EVERY_MS) return s;
    const { names } = mapNames(this.profiles(), s.agents);
    const { teams } = mapTeams(this.profiles(), this.teams(), s.agents, s.teams);
    try {
      // `teams` absent = aucune équipe (le site retire les précédentes).
      await this.call("PUT", teams.length ? { agents: names, teams } : { agents: names });
      const next: MapState = { ...s, lastSyncAt: new Date().toISOString(), lastError: undefined };
      saveMapState(next, this.file);
      audit({ event: "map_sync", ok: true, input: names.length });
      return next;
    } catch (e) {
      const next: MapState = { ...s, lastError: (e as Error).message };
      saveMapState(next, this.file);
      audit({ event: "map_sync", ok: false, error: (e as Error).message });
      throw e;
    }
  }

  /** Active l'option : autorisation `map` dans le navigateur si besoin, puis premier envoi. */
  async enable(agentIds: string[], signal?: AbortSignal, teamIds: string[] = []): Promise<MapState> {
    // Réactiver annule un retrait en attente.
    if (!(await this.account.accessToken().catch(() => undefined))) await this.account.login(signal);
    saveMapState(
      {
        ...this.state(),
        enabled: true,
        pendingRemoval: undefined,
        agents: [...new Set(agentIds)].slice(0, MAP_MAX_AGENTS),
        teams: [...new Set(teamIds)].slice(0, MAP_MAX_TEAMS),
      },
      this.file,
    );
    return this.sync(true);
  }

  /** Change la sélection (option active) et l'envoie. `teamIds` absent = équipes inchangées. */
  async setAgents(agentIds: string[], teamIds?: string[]): Promise<MapState> {
    saveMapState(
      {
        ...this.state(),
        agents: [...new Set(agentIds)].slice(0, MAP_MAX_AGENTS),
        ...(teamIds ? { teams: [...new Set(teamIds)].slice(0, MAP_MAX_TEAMS) } : {}),
      },
      this.file,
    );
    return this.sync(true);
  }

  /**
   * Désactive : retrait du site PUIS révocation. Si le retrait échoue (hors ligne), le jeton est gardé et le retrait
   * reste en attente (réessayé toutes les heures) : on ne perd jamais le moyen de retirer ses agents.
   */
  async disable(): Promise<MapState> {
    saveMapState({ ...this.state(), enabled: false, pendingRemoval: true }, this.file);
    return this.removeFromSite();
  }

  private async removeFromSite(): Promise<MapState> {
    try {
      // Plus aucune autorisation (retirée depuis le site) : le site ne montre déjà plus ces agents, rien à retirer.
      if (await this.account.accessToken()) await this.call("DELETE");
    } catch (e) {
      const next: MapState = { ...this.state(), enabled: false, pendingRemoval: true, lastError: `retrait en attente : ${(e as Error).message}` };
      saveMapState(next, this.file);
      audit({ event: "map_sync", ok: false, input: 0, error: (e as Error).message });
      throw new Error(`retrait de la carte en attente (${(e as Error).message}) : MyIA réessaiera automatiquement`);
    }
    await this.account.logout();
    const next: MapState = { ...this.state(), enabled: false, pendingRemoval: undefined, lastSyncAt: undefined, lastError: undefined };
    saveMapState(next, this.file);
    audit({ event: "map_sync", ok: true, input: 0 });
    return next;
  }

  /** Envoi périodique : vérifie toutes les heures si 12 h se sont écoulées depuis le dernier envoi. */
  start() {
    this.stop();
    const tick = () => void (this.state().pendingRemoval ? this.removeFromSite() : this.sync()).catch(() => undefined);
    setTimeout(tick, 30_000).unref?.();
    this.timer = setInterval(tick, 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
