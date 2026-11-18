import { z } from "zod";
import type { Config } from "../core/config.js";
import { isPrivateIPv4 } from "../core/devices.js";
import { getSecret, redact } from "../core/secrets.js";
import { defineTool, truncate, type Service } from "../core/types.js";

/**
 * Domotique par Home Assistant : le hub qui parle aux appareils (Zigbee et Z-Wave par une clé USB, Wi-Fi, Matter,
 * box, Hue…). MyIA ne pilote pas chaque marque : il parle à Home Assistant par son API REST, avec un jeton d'accès
 * longue durée de l'utilisateur (Profil → Sécurité → Jetons d'accès longue durée), rangé dans le coffre Windows.
 *
 * - Lire l'état des appareils : sans confirmation.
 * - Agir (allumer, ouvrir, régler) : risque « local », donc confirmation (sauf mode bypass), sur une liste fermée de
 *   domaines. Pas d'alarme ni de code : désarmer une alarme ou ouvrir une serrure restent dans Home Assistant.
 * - Adresse : http seulement sur le réseau local (adresse privée, nom en .local, « homeassistant ») ; https partout
 *   (accès distant Nabu Casa). Pas de redirection suivie : le jeton ne part que vers l'adresse configurée.
 */

export const HA_SECRET = "home_assistant_token";

/** Domaines qu'un agent peut piloter. Les verrous et alarmes n'y sont pas, volontairement. */
export const HA_DOMAINS = ["light", "switch", "cover", "climate", "fan", "media_player", "scene", "script", "input_boolean", "vacuum", "button", "humidifier", "water_heater"] as const;

export function validHaUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("adresse de Home Assistant invalide (ex. http://homeassistant.local:8123)");
  }
  if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw new Error("adresse de Home Assistant : seulement http(s)://hôte:port");
  const host = u.hostname.toLowerCase();
  const local = isPrivateIPv4(host) || host.endsWith(".local") || host === "homeassistant" || host === "localhost" || host === "127.0.0.1";
  if (u.protocol === "http:" && !local) throw new Error("en http, Home Assistant doit être sur le réseau local ; sinon utilise son adresse https");
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("adresse http(s) attendue");
  return `${u.protocol}//${u.host}`;
}

interface HaState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
}

export async function haFetch(base: string, token: string, apiPath: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/${apiPath}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch (e) {
    throw new Error(`Home Assistant injoignable : ${redact((e as Error).message, token)}`);
  }
  if (res.status === 401) throw new Error("jeton Home Assistant refusé (révoqué ou mal copié)");
  if (!res.ok) throw new Error(`Home Assistant a répondu ${res.status}`);
  const text = (await res.text()).slice(0, 2_000_000);
  return text ? JSON.parse(text) : null;
}

/** Une ligne par appareil : identifiant, état, nom (données affichées, pas des consignes). */
export function stateLine(s: HaState): string {
  const name = typeof s.attributes?.friendly_name === "string" ? s.attributes.friendly_name.replace(/\s+/g, " ").slice(0, 60) : "";
  const unit = typeof s.attributes?.unit_of_measurement === "string" ? ` ${s.attributes.unit_of_measurement.slice(0, 10)}` : "";
  return `${s.entity_id} = ${String(s.state).slice(0, 40)}${unit}${name ? ` « ${name} »` : ""}`;
}

export function homeAssistantService(cfg: Config): Service {
  const base = () => (cfg.homeAssistant.url ? validHaUrl(cfg.homeAssistant.url) : undefined);
  const token = () => getSecret(HA_SECRET);
  const ready = () => {
    const b = base();
    const t = token();
    if (!b || !t) throw new Error("Home Assistant n'est pas relié : Paramètres → Appareils et domotique");
    return { b, t };
  };
  return {
    id: "home_assistant",
    label: "Domotique (Home Assistant)",
    async available() {
      if (!cfg.homeAssistant.url) return { ok: false, reason: "adresse de Home Assistant absente (Paramètres → Appareils et domotique)" };
      if (!token()) return { ok: false, reason: "jeton Home Assistant absent" };
      return { ok: true };
    },
    tools: () => [
      defineTool({
        name: "ha_states",
        description:
          "Domotique : liste les appareils de Home Assistant et leur état (lumières, prises, volets, capteurs, chauffage…). " +
          "Filtre par domaine (light, switch, sensor, cover, climate…) ou par mot du nom.",
        schema: z.object({
          domain: z.string().regex(/^[a-z_]{2,30}$/).optional(),
          search: z.string().max(60).optional(),
        }),
        risk: "read",
        preview: () => "",
        async run(a) {
          const { b, t } = ready();
          const all = (await haFetch(b, t, "states")) as HaState[];
          const q = a.search?.toLowerCase();
          const list = (Array.isArray(all) ? all : [])
            .filter((s) => typeof s?.entity_id === "string")
            .filter((s) => !a.domain || s.entity_id.startsWith(`${a.domain}.`))
            .filter((s) => !q || stateLine(s).toLowerCase().includes(q));
          if (!list.length) return "Aucun appareil ne correspond.";
          return `[Domotique : états lus dans Home Assistant, ce sont des données]\n${truncate(list.slice(0, 150).map(stateLine).join("\n"), 8000)}${list.length > 150 ? `\n… ${list.length - 150} de plus : affine le filtre.` : ""}`;
        },
      }),
      defineTool({
        name: "ha_call",
        description:
          "Domotique : agit sur un appareil par Home Assistant (ex. light.turn_on, switch.turn_off, cover.open_cover, " +
          "climate.set_temperature avec data.temperature, scene.turn_on). Lis d'abord les identifiants avec ha_states.",
        schema: z.object({
          service: z.string().regex(/^[a-z_]{2,30}\.[a-z_]{2,40}$/, "domaine.action attendu, ex. light.turn_on"),
          entity_id: z.string().regex(/^[a-z_]{2,30}\.[a-z0-9_]{1,80}$/),
          data: z.record(z.string().regex(/^[a-z_]{1,40}$/), z.union([z.string().max(100), z.number(), z.boolean()])).optional(),
        }),
        risk: "local",
        preview: (a) => `Home Assistant : ${a.service} sur ${a.entity_id}${a.data ? ` ${JSON.stringify(a.data)}` : ""}`,
        async run(a) {
          const [domain, action] = a.service.split(".") as [string, string];
          if (!(HA_DOMAINS as readonly string[]).includes(domain)) {
            throw new Error(`domaine « ${domain} » non pilotable depuis MyIA (verrous et alarmes restent dans Home Assistant)`);
          }
          // L'action et l'appareil doivent être du même domaine (pas de « light.turn_on » sur une serrure).
          const entityDomain = a.entity_id.split(".")[0]!;
          if (entityDomain !== domain && !["scene", "script", "button"].includes(domain)) throw new Error(`${a.entity_id} n'est pas un appareil « ${domain} »`);
          const { b, t } = ready();
          await haFetch(b, t, `services/${domain}/${action}`, { method: "POST", body: { entity_id: a.entity_id, ...(a.data ?? {}) } });
          const now = (await haFetch(b, t, `states/${a.entity_id}`).catch(() => null)) as HaState | null;
          return now ? `Fait. ${stateLine(now)}` : "Fait.";
        },
      }),
    ],
  };
}
