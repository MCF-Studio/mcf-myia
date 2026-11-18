import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { childEnv, runProcess } from "./proc.js";

/**
 * Appareils et domotique (lecture seule) : carte Bluetooth, ports COM (et les clés Zigbee / Z-Wave qu'on y branche),
 * appareils du réseau local qui s'annoncent (SSDP : box, TV, Chromecast, pont Hue…) et Home Assistant.
 *
 * Rien n'est modifié, rien ne sort du réseau local. Les noms renvoyés par les appareils sont des données affichées
 * telles quelles (un appareil peut annoncer n'importe quel nom).
 */

// ─── Bluetooth et ports COM (Windows) ─────────────────────────────────────────

const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows";
const POWERSHELL = path.join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

const HARDWARE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$bt = @(Get-PnpDevice -Class Bluetooth | ForEach-Object { [ordered]@{ name = $_.FriendlyName; status = "$($_.Status)"; id = $_.InstanceId } })
$com = @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\(COM\d+\)' } | ForEach-Object { [ordered]@{ name = $_.Name; manufacturer = $_.Manufacturer; id = $_.PNPDeviceID; status = "$($_.Status)" } })
$radio = $null
try { $radio = (Get-Service bthserv).Status.ToString() } catch {}
[ordered]@{ bluetooth = $bt; com = $com; btService = $radio } | ConvertTo-Json -Depth 4 -Compress
`;

export interface BluetoothInfo {
  /** Cartes (adaptateurs) Bluetooth du PC. */
  adapters: { name: string; ok: boolean }[];
  /** Appareils appairés (casques, manettes, capteurs…). */
  paired: { name: string; ok: boolean; le: boolean }[];
  /** Service Bluetooth de Windows (bthserv) : Running, Stopped… */
  service?: string;
}

export interface SerialPort {
  port: string;
  name: string;
  manufacturer?: string;
  vid?: string;
  pid?: string;
  /** Ce que c'est probablement (clé Zigbee, carte Arduino…). */
  kind?: string;
  ok: boolean;
}

/** Puces USB-série courantes et clés domotiques, par identifiant USB (VID:PID, en majuscules). */
const USB_KINDS: [RegExp, string][] = [
  [/^1A86:55D4$/, "clé Zigbee (Sonoff ZBDongle-E, puce EFR32)"],
  [/^10C4:EA60$/, "puce CP210x (souvent une clé Zigbee Sonoff ZBDongle-P / SkyConnect, ou un ESP32)"],
  [/^1CF1:0030$/, "clé Zigbee ConBee II (dresden elektronik)"],
  [/^1CF1:0031$/, "clé Zigbee ConBee III (dresden elektronik)"],
  [/^0451:16A8$/, "clé Zigbee CC2531 (Texas Instruments)"],
  [/^0658:0200$/, "clé Z-Wave (Aeotec Z-Stick, puce Sigma)"],
  [/^10C4:8A2A$/, "clé Z-Wave / Zigbee (Nortek HUSBZB-1)"],
  [/^0403:6001$/, "adaptateur série FTDI (Arduino ancien, téléinfo Linky…)"],
  [/^0403:6015$/, "adaptateur série FTDI (téléinfo Linky µTeleinfo…)"],
  [/^1A86:7523$/, "puce CH340 (Arduino compatible, ESP8266)"],
  [/^2341:/, "carte Arduino"],
  [/^2E8A:/, "Raspberry Pi Pico"],
  [/^303A:/, "carte Espressif (ESP32-S2/S3/C3)"],
];

export function serialKind(vid?: string, pid?: string): string | undefined {
  if (!vid || !pid) return undefined;
  const key = `${vid}:${pid}`.toUpperCase();
  return USB_KINDS.find(([re]) => re.test(key))?.[1];
}

interface RawHardware {
  bluetooth?: { name?: string; status?: string; id?: string }[] | { name?: string; status?: string; id?: string };
  com?: { name?: string; manufacturer?: string; id?: string; status?: string }[] | { name?: string };
  btService?: string | null;
}
const arr = <T>(v: T | T[] | undefined | null): T[] => (Array.isArray(v) ? v : v ? [v] : []);

export function parseHardware(raw: RawHardware): { bluetooth: BluetoothInfo; serial: SerialPort[] } {
  const adapters: BluetoothInfo["adapters"] = [];
  const paired: BluetoothInfo["paired"] = [];
  for (const d of arr(raw.bluetooth)) {
    const id = String(d.id ?? "");
    const name = String(d.name ?? "").slice(0, 120);
    if (!name) continue;
    const ok = d.status === "OK";
    // BTHENUM / BTHLE = appareils (classique / basse consommation) ; USB / PCI = la carte elle-même.
    if (/^BTH(ENUM|LE|LEDEVICE)\\/i.test(id)) {
      // Les « services » génériques d'un appareil (Generic Attribute Profile…) ne sont pas des appareils.
      if (/^(Generic (Access|Attribute)|Device Information Service|Microsoft Bluetooth)/i.test(name)) continue;
      paired.push({ name, ok, le: /^BTHLE/i.test(id) });
    } else if (/^(USB|PCI|ACPI)\\/i.test(id) && !/enumerator|énumérateur|RFCOMM|LE Generic|Protocol/i.test(name)) {
      adapters.push({ name, ok });
    }
  }
  const serial: SerialPort[] = [];
  for (const c of arr(raw.com) as { name?: string; manufacturer?: string; id?: string; status?: string }[]) {
    const name = String(c.name ?? "");
    const port = /\((COM\d+)\)/.exec(name)?.[1];
    if (!port) continue;
    const id = String(c.id ?? "");
    const vid = /VID_([0-9A-F]{4})/i.exec(id)?.[1]?.toUpperCase();
    const pid = /PID_([0-9A-F]{4})/i.exec(id)?.[1]?.toUpperCase();
    serial.push({
      port,
      name: name.slice(0, 120),
      manufacturer: c.manufacturer ? String(c.manufacturer).slice(0, 80) : undefined,
      vid,
      pid,
      kind: serialKind(vid, pid) ?? (/^ACPI\\PNP050/i.test(id) ? "port série de la carte mère" : undefined),
      ok: c.status === "OK",
    });
  }
  serial.sort((a, b) => Number(a.port.slice(3)) - Number(b.port.slice(3)));
  return { bluetooth: { adapters, paired: paired.slice(0, 60), service: raw.btService ?? undefined }, serial };
}

export async function readHardware(): Promise<{ bluetooth: BluetoothInfo; serial: SerialPort[] }> {
  if (process.platform !== "win32") return { bluetooth: { adapters: [], paired: [] }, serial: [] };
  const out: string[] = [];
  const r = await runProcess(
    [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(HARDWARE_SCRIPT, "utf16le").toString("base64")],
    { cwd: os.homedir(), timeoutMs: 40_000, env: childEnv(), keep: 5, onLine: (l, s) => s === "out" && out.push(l) },
  );
  if (r.timedOut) throw new Error("Windows n'a pas répondu à temps");
  try {
    return parseHardware(JSON.parse(out.join("").trim() || "{}") as RawHardware);
  } catch {
    throw new Error("liste des appareils illisible");
  }
}

// ─── réseau local ─────────────────────────────────────────────────────────────

const PRIVATE4 = new net.BlockList();
for (const [a, p] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["169.254.0.0", 16]] as const) PRIVATE4.addSubnet(a, p, "ipv4");
export const isPrivateIPv4 = (ip: string) => net.isIPv4(ip) && PRIVATE4.check(ip, "ipv4");

export interface NetDevice {
  ip: string;
  /** Nom annoncé par l'appareil (description UPnP). */
  name?: string;
  manufacturer?: string;
  model?: string;
  /** Box, TV, enceinte, pont domotique… */
  kind: string;
  server?: string;
}

export interface LanInfo {
  gateway?: string;
  /** La box internet, si elle s'est reconnue. */
  box?: { name: string; ip: string; api?: string };
  devices: NetDevice[];
  homeAssistant?: { url: string };
}

/** Réponse SSDP → en-têtes (clés en minuscules). */
export function parseSsdp(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim().slice(0, 300);
  }
  return out;
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]{1,200})</${name}>`, "i").exec(xml)?.[1]?.trim();

/** Ce qu'est un appareil, d'après sa description UPnP et son en-tête SERVER. */
export function classify(d: { name?: string; manufacturer?: string; model?: string; server?: string; deviceType?: string }): string {
  const all = `${d.name ?? ""} ${d.manufacturer ?? ""} ${d.model ?? ""} ${d.server ?? ""} ${d.deviceType ?? ""}`.toLowerCase();
  if (/internetgatewaydevice|freebox|livebox|bbox(?!tv)|sfr box|neufbox|fritz!?box/.test(all) && !/bboxtv|player/.test(all)) return "box internet";
  if (/philips hue|ipbridge/.test(all)) return "pont Philips Hue (domotique)";
  if (/home assistant/.test(all)) return "Home Assistant (domotique)";
  if (/sonos/.test(all)) return "enceinte Sonos";
  if (/chromecast|google cast|nest/.test(all)) return "Chromecast / Google";
  if (/bboxtv|freebox player|décodeur|decodeur|tv/.test(all)) return "décodeur TV / téléviseur";
  if (/mediarenderer|mediaserver|dlna/.test(all)) return "lecteur ou serveur multimédia";
  if (/printer|imprimante/.test(all)) return "imprimante";
  if (/nas|synology|qnap/.test(all)) return "NAS";
  return "appareil réseau";
}

/** API locale connue des box françaises (documentation, rien n'est appelé). */
export function boxApi(name: string): string | undefined {
  const n = name.toLowerCase();
  if (n.includes("bbox")) return "API locale Bbox : https://mabbox.bytel.fr/api/v1 (mot de passe administrateur de la box pour agir)";
  if (n.includes("freebox")) return "API Freebox OS : http://mafreebox.freebox.fr/api/ (autorisation à valider sur l'écran de la box)";
  if (n.includes("livebox")) return "API locale Livebox (sysbus) : http://192.168.1.1/ws (mot de passe administrateur)";
  return undefined;
}

async function gateway(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  const out: string[] = [];
  const script = "(Get-NetRoute -DestinationPrefix 0.0.0.0/0 -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop";
  await runProcess([POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: os.homedir(),
    timeoutMs: 15_000,
    env: childEnv(),
    keep: 2,
    onLine: (l, s) => s === "out" && out.push(l.trim()),
  }).catch(() => undefined);
  const ip = out.find((l) => isPrivateIPv4(l));
  return ip;
}

/** Description UPnP d'un appareil : seulement à l'adresse privée qui a répondu, 64 Ko et 2 s au plus. */
async function describe(location: string, from: string): Promise<{ name?: string; manufacturer?: string; model?: string; deviceType?: string }> {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return {};
  }
  if (url.protocol !== "http:" || url.hostname !== from || !isPrivateIPv4(from)) return {};
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "error" });
    const xml = (await res.text()).slice(0, 64 * 1024);
    return { name: tag(xml, "friendlyName"), manufacturer: tag(xml, "manufacturer"), model: tag(xml, "modelName"), deviceType: tag(xml, "deviceType") };
  } catch {
    return {};
  }
}

function ssdpSearch(waitMs: number): Promise<{ ip: string; headers: Record<string, string> }[]> {
  return new Promise((resolve) => {
    const found: { ip: string; headers: Record<string, string> }[] = [];
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const done = () => {
      try {
        sock.close();
      } catch {
        /* déjà fermé */
      }
      resolve(found);
    };
    sock.on("error", done);
    sock.on("message", (m, r) => {
      if (found.length < 200 && isPrivateIPv4(r.address)) found.push({ ip: r.address, headers: parseSsdp(m.toString("utf8").slice(0, 4096)) });
    });
    sock.bind(0, () => {
      const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n');
      sock.send(msg, 1900, "239.255.255.250");
      setTimeout(() => sock.send(msg, 1900, "239.255.255.250", () => undefined), 600);
    });
    setTimeout(done, waitMs);
  });
}

async function findHomeAssistant(): Promise<string | undefined> {
  for (const url of ["http://homeassistant.local:8123", "http://homeassistant:8123"]) {
    try {
      const res = await fetch(`${url}/api/`, { signal: AbortSignal.timeout(2500), redirect: "error" });
      // Home Assistant répond 401 sans jeton sur /api/.
      if (res.status === 401 || res.ok) return url;
    } catch {
      /* absent */
    }
  }
  return undefined;
}

export async function scanLan(waitMs = 3500): Promise<LanInfo> {
  const [gw, answers, ha] = await Promise.all([gateway(), ssdpSearch(waitMs), findHomeAssistant()]);
  const byIp = new Map<string, { server?: string; locations: Set<string> }>();
  for (const a of answers) {
    const e = byIp.get(a.ip) ?? { locations: new Set<string>() };
    if (a.headers.server && !e.server) e.server = a.headers.server;
    if (a.headers.location && e.locations.size < 4) e.locations.add(a.headers.location);
    byIp.set(a.ip, e);
  }
  const devices: NetDevice[] = [];
  await Promise.all(
    [...byIp].slice(0, 40).map(async ([ip, e]) => {
      let best: Awaited<ReturnType<typeof describe>> = {};
      for (const loc of e.locations) {
        const d = await describe(loc, ip);
        if (d.name && (!best.name || /gateway|bbox|freebox|livebox/i.test(`${d.deviceType} ${d.name}`))) best = d;
      }
      devices.push({ ip, name: best.name, manufacturer: best.manufacturer, model: best.model, server: e.server, kind: classify({ ...best, server: e.server }) });
    }),
  );
  devices.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  const boxDev = devices.find((d) => d.kind === "box internet" && (!gw || d.ip === gw)) ?? devices.find((d) => d.kind === "box internet");
  const boxName = boxDev ? [boxDev.name, boxDev.model].filter(Boolean).join(" · ") || "box internet" : undefined;
  return {
    gateway: gw,
    box: boxDev && boxName ? { name: boxName, ip: boxDev.ip, api: boxApi(`${boxDev.name} ${boxDev.manufacturer}`) } : undefined,
    devices,
    homeAssistant: ha ? { url: ha } : undefined,
  };
}
