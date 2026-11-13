import fs from "node:fs";
import path from "node:path";
import { audit } from "./audit.js";
import { McfAccount, vaultStoreFor } from "./mcf-account.js";
import { paths } from "./paths.js";
import { writeJsonAtomic, type AgentProfile } from "./profiles.js";

/**
 * Carte des agents de mcfstudio.fr (spec du site : docs/superpowers/specs/2026-11-13-carte-agents-design.md).
 *
 * Option désactivée par défaut. Activée, MyIA envoie au site les NOMS des agents cochés par l'utilisateur, et rien
 * d'autre (ni consignes, ni modèle, ni conversations), avec une autorisation OAuth de portée `map`, séparée de celle de
 * la Guilde (jeton de renouvellement dans le coffre, secret `mcfstudio_map_refresh`). Au plus 2 envois par jour : au
 * démarrage si le dernier date de plus de 12 h, puis toutes les 12 h, et quand l'utilisateur change sa sélection.
 * Désactiver retire tout de suite les agents du site puis révoque l'autorisation.
 */

export const MAP_REFRESH_SECRET = "mcfstudio_map_refresh";
export const MAP_SYNC_EVERY_MS = 12 * 60 * 60 * 1000;
export const MAP_MAX_AGENTS = 12;
/** Mêmes règles que le site : 1 à 40 caractères, lettres, chiffres, espaces et . _ ' - */
const NAME_RE = /^[\p{L}\p{N} ._'-]{1,40}$/u;

export interface MapState {
  enabled: boolean;
  /** Ids des profils montrés sur la carte. */
  agents: string[];
  lastSyncAt?: string;
  lastError?: string;
}

const stateFile = () => path.join(paths.home, "data", "agents-map.json");

export function loadMapState(file = stateFile()): MapState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MapState>;
    return {
      enabled: raw.enabled === true,
      agents: Array.isArray(raw.agents) ? raw.agents.filter((a): a is string => typeof a === "string").slice(0, MAP_MAX_AGENTS) : [],
      ...(typeof raw.lastSyncAt === "string" ? { lastSyncAt: raw.lastSyncAt } : {}),
      ...(typeof raw.lastError === "string" ? { lastError: raw.lastError } : {}),
    };
  } catch {
    return { enabled: false, agents: [] };
  }
}

export function saveMapState(s: MapState, file = stateFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, s);
}

/** Noms envoyés : ceux des profils cochés qui existent encore et respectent les règles du site. */
export function mapNames(profiles: readonly AgentProfile[], ids: readonly string[]): { names: string[]; refused: string[] } {
  const names: string[] = [];
  const refused: string[] = [];
  for (const id of ids) {
    const p = profiles.find((x) => x.id === id);
    if (!p) continue;
    const name = p.name.normalize("NFC").replace(/\s+/g, " ").trim();
    if (NAME_RE.test(name)) names.push(name);
    else refused.push(p.name);
  }
  return { names: names.slice(0, MAP_MAX_AGENTS), refused };
}

export class AgentsMap {
  readonly account: McfAccount;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly siteUrl: string,
    private readonly profiles: () => readonly AgentProfile[],
    openBrowser: (url: string) => void,
    private readonly file = stateFile(),
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
    try {
      await this.call("PUT", { agents: names });
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
  async enable(agentIds: string[], signal?: AbortSignal): Promise<MapState> {
    if (!(await this.account.accessToken().catch(() => undefined))) await this.account.login(signal);
    saveMapState({ ...this.state(), enabled: true, agents: [...new Set(agentIds)].slice(0, MAP_MAX_AGENTS) }, this.file);
    return this.sync(true);
  }

  /** Change la sélection (option active) et l'envoie. */
  async setAgents(agentIds: string[]): Promise<MapState> {
    saveMapState({ ...this.state(), agents: [...new Set(agentIds)].slice(0, MAP_MAX_AGENTS) }, this.file);
    return this.sync(true);
  }

  /** Désactive : retrait immédiat du site (au mieux), révocation de l'autorisation, oubli local. */
  async disable(): Promise<MapState> {
    await this.call("DELETE").catch(() => undefined);
    await this.account.logout();
    const next: MapState = { ...this.state(), enabled: false, lastSyncAt: undefined, lastError: undefined };
    saveMapState(next, this.file);
    audit({ event: "map_sync", ok: true, input: 0 });
    return next;
  }

  /** Envoi périodique : vérifie toutes les heures si 12 h se sont écoulées depuis le dernier envoi. */
  start() {
    this.stop();
    const tick = () => void this.sync().catch(() => undefined);
    setTimeout(tick, 30_000).unref?.();
    this.timer = setInterval(tick, 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
