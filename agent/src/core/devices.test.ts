import { describe, expect, it } from "vitest";
import { stateLine, validHaUrl } from "../services/home-assistant.js";
import { boxApi, classify, isPrivateIPv4, parseHardware, parseSsdp, serialKind } from "./devices.js";
import { errorDigest, parseReleases, sendBugReport } from "./feedback.js";
import { installedPlugins } from "./lsp.js";

describe("appareils", () => {
  it("sépare carte Bluetooth et appareils appairés, reconnaît les clés domotiques", () => {
    const r = parseHardware({
      bluetooth: [
        { name: "Intel(R) Wireless Bluetooth(R)", status: "OK", id: "USB\\VID_8087&PID_0026\\5&1" },
        { name: "Microsoft Bluetooth Enumerator", status: "OK", id: "BTH\\MS_BTHBRB\\7&1" },
        { name: "Casque WH-1000", status: "OK", id: "BTHENUM\\{0000110b}_VID&0001\\8&1" },
        { name: "Generic Attribute Profile", status: "OK", id: "BTHLEDEVICE\\{00001801}\\9&1" },
        { name: "Capteur Xiaomi", status: "Error", id: "BTHLE\\DEV_A4C138\\8&2" },
      ],
      com: [
        { name: "USB-Enhanced-SERIAL CH9102 (COM5)", id: "USB\\VID_1A86&PID_55D4\\5&1", status: "OK" },
        { name: "Port de communication (COM1)", id: "ACPI\\PNP0501\\0", status: "OK" },
      ],
      btService: "Running",
    });
    expect(r.bluetooth.adapters).toEqual([{ name: "Intel(R) Wireless Bluetooth(R)", ok: true }]);
    expect(r.bluetooth.paired).toEqual([
      { name: "Casque WH-1000", ok: true, le: false },
      { name: "Capteur Xiaomi", ok: false, le: true },
    ]);
    expect(r.serial.map((s) => [s.port, s.kind])).toEqual([
      ["COM1", "port série de la carte mère"],
      ["COM5", "clé Zigbee (Sonoff ZBDongle-E, puce EFR32)"],
    ]);
    expect(serialKind("2341", "0043")).toBe("carte Arduino");
    expect(parseHardware({ bluetooth: { name: "Seul", status: "OK", id: "USB\\X" } }).bluetooth.adapters).toHaveLength(1);
  });

  it("réseau : adresses privées, SSDP, nature des appareils, API des box", () => {
    expect(isPrivateIPv4("192.168.1.254")).toBe(true);
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
    expect(parseSsdp("HTTP/1.1 200 OK\r\nSERVER: MiniUPnPd/1.9\r\nLOCATION: http://192.168.1.254:1/a.xml\r\n\r\n")).toEqual({
      server: "MiniUPnPd/1.9",
      location: "http://192.168.1.254:1/a.xml",
    });
    expect(classify({ name: "Bbox", deviceType: "urn:schemas-upnp-org:device:InternetGatewayDevice:2" })).toBe("box internet");
    expect(classify({ name: "BboxTV", server: "Chromecast/1.6" })).toBe("Chromecast / Google");
    expect(classify({ name: "Philips hue (192.168.1.3)" })).toContain("Hue");
    expect(boxApi("Freebox Server")).toContain("mafreebox");
    expect(boxApi("Bbox Bouygues")).toContain("mabbox");
  });
});

describe("Home Assistant", () => {
  it("http seulement sur le réseau local, https partout, rien d'autre que l'hôte", () => {
    expect(validHaUrl("http://homeassistant.local:8123/")).toBe("http://homeassistant.local:8123");
    expect(validHaUrl("http://192.168.1.20:8123")).toBe("http://192.168.1.20:8123");
    expect(validHaUrl("https://maison.ui.nabu.casa")).toBe("https://maison.ui.nabu.casa");
    expect(() => validHaUrl("http://exemple.fr:8123")).toThrow(/réseau local/);
    expect(() => validHaUrl("http://u:p@192.168.1.2:8123")).toThrow();
    expect(() => validHaUrl("file:///etc")).toThrow();
  });
  it("une ligne par appareil, nom cité", () => {
    expect(stateLine({ entity_id: "sensor.salon", state: "21.5", attributes: { friendly_name: "Température\nsalon", unit_of_measurement: "°C" } })).toBe(
      "sensor.salon = 21.5 °C « Température salon »",
    );
  });
});

describe("signalement et notes de mise à jour", () => {
  it("envoie au site, sans secret, et traduit les refus", async () => {
    const calls: { url: string; body: any }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await sendBugReport("https://mcfstudio.fr", { title: "Bug", description: "La console reste noire", contact: "", log: null }, { appVersion: "0.19.0", os: "windows" }, ok);
    expect(calls[0]!.url).toBe("https://mcfstudio.fr/api/myia/bug-reports");
    expect(calls[0]!.body).toMatchObject({ appVersion: "0.19.0", os: "windows", title: "Bug" });
    const full = (async () => new Response(JSON.stringify({ message: "Trop de rapports" }), { status: 429 })) as unknown as typeof fetch;
    await expect(sendBugReport("https://x", { title: "Bug!", description: "0123456789", contact: "", log: null }, { appVersion: "1.0.0", os: "w" }, full)).rejects.toThrow(
      "Trop de rapports",
    );
  });

  it("journal joint : seulement les erreurs, réduites", () => {
    const d = errorDigest([
      JSON.stringify({ ts: "2026-11-18T10:00:00Z", event: "tool", tool: "web_read", ok: true, args: { secret: "x" } }),
      JSON.stringify({ ts: "2026-11-18T10:01:00Z", event: "crash", error: "boum\n  at x" }),
      "pas du json",
    ]);
    expect(d).toBe("2026-11-18T10:01:00 crash : boum at x");
  });

  it("releases : versions publiées, sans brouillon ni empreinte", () => {
    const r = parseReleases([
      { tag_name: "v0.18.0", name: "MyIA 0.18.0", published_at: "2026-11-18T20:00:00Z", body: "Nouveautés.\n\nSHA-256 : abc", html_url: "https://github.com/x/y/releases/tag/v0.18.0" },
      { tag_name: "v0.19.0", draft: true, html_url: "https://github.com/x" },
      { tag_name: "nightly", html_url: "https://github.com/x" },
      { tag_name: "v0.1.0", html_url: "https://evil.example/x" },
    ]);
    expect(r).toEqual([{ version: "0.18.0", name: "MyIA 0.18.0", date: "2026-11-18", notes: "Nouveautés.", url: "https://github.com/x/y/releases/tag/v0.18.0" }]);
  });
});

describe("LSP", () => {
  it("lit la liste des plugins de Claude Code", () => {
    const s = installedPlugins(JSON.stringify([{ id: "typescript-lsp@claude-plugins-official" }, { id: "x@y" }]));
    expect(s.has("typescript-lsp")).toBe(true);
    expect(installedPlugins("pas du json").size).toBe(0);
  });
});
