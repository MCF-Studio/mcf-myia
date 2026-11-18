import { describe, expect, it } from "vitest";
import { needsConfirmation } from "../core/agent.js";
import { parseConfig } from "../core/config.js";
import { encodePowerShell, isProtectedProcess, matchProcess, matchWindow, pcService, type ProcessGroup, type WindowInfo } from "./pc.js";

const wins: WindowInfo[] = [
  { id: "1", pid: 10, process: "chrome", title: "Recherche — Google Chrome" },
  { id: "2", pid: 11, process: "Code", title: "pc.ts - mcf-myia - Visual Studio Code" },
  { id: "3", pid: 12, process: "explorer", title: "Téléchargements" },
  { id: "4", pid: 13, process: "explorer", title: "Documents" },
];

describe("pc : choix de la fenêtre", () => {
  it("titre exact, programme, début de titre, puis contenu", () => {
    expect(matchWindow(wins, "documents").id).toBe("4");
    expect(matchWindow(wins, "chrome").id).toBe("1");
    expect(matchWindow(wins, "pc.ts").id).toBe("2");
    expect(matchWindow(wins, "telechargements").id).toBe("3");
    expect(matchWindow(wins, "visual studio").id).toBe("2");
  });
  it("plusieurs candidates : erreur au lieu d'agir sur la mauvaise", () => {
    expect(() => matchWindow(wins, "explorer")).toThrow(/plusieurs fenêtres/);
  });
  it("aucune ou vide : erreur lisible", () => {
    expect(() => matchWindow(wins, "photoshop")).toThrow(/aucune fenêtre/);
    expect(() => matchWindow(wins, "  ")).toThrow(/précise/);
  });
});

describe("pc : processus", () => {
  const list: ProcessGroup[] = [
    { name: "chrome", count: 3, pids: [100, 101, 102], memoryMb: 900, cpuSec: 50 },
    { name: "lsass", count: 1, pids: [700], memoryMb: 20, cpuSec: 1 },
  ];
  it("par nom (avec ou sans .exe) ou par PID", () => {
    expect(matchProcess(list, "Chrome.exe").pids).toEqual([100, 101, 102]);
    expect(matchProcess(list, "101").pids).toEqual([101]);
    expect(() => matchProcess(list, "chro")).toThrow(/Proches : chrome/);
    expect(() => matchProcess(list, "999")).toThrow(/PID 999/);
  });
  it("système et MyIA protégés", () => {
    for (const n of ["lsass", "csrss.exe", "explorer", "svchost", "MyIA", "ollama", "dwm"]) expect(isProtectedProcess(n)).toBe(true);
    for (const n of ["chrome", "notepad", "node", "Spotify"]) expect(isProtectedProcess(n)).toBe(false);
  });
});

describe("pc : outils", () => {
  const tools = Object.fromEntries(pcService().tools().map((t) => [t.name, t]));

  it("aucun argument libre vers PowerShell : listes fermées et bornes", () => {
    expect(() => tools.pc_media!.parse({ key: "volume_up; Remove-Item C:\\" })).toThrow();
    expect(() => tools.pc_volume!.parse({ level: 150 })).toThrow();
    expect(() => tools.pc_settings_open!.parse({ page: "../../evil" })).toThrow();
    expect(() => tools.pc_power!.parse({ action: "shutdown", delay_seconds: 0 })).toThrow();
    expect(tools.pc_media!.parse({ key: "next" })).toEqual({ key: "next", times: 1 });
  });

  it("niveaux de risque : arrêt d'un programme et alimentation confirmés, fermeture de fenêtre aussi", () => {
    const trust = { userText: "", fromSearch: new Set<string>() } as never;
    expect(tools.pc_process_stop!.risk).toBe("local");
    expect(tools.pc_power!.risk).toBe("local");
    expect(tools.pc_status!.risk).toBe("read");
    expect(tools.pc_window!.confirmIf!({ window: "x", action: "close" }, trust)).toBe(true);
    expect(tools.pc_window!.confirmIf!({ window: "x", action: "focus" }, trust)).toBe(false);
    // Regarder l'écran : confirmé seulement pour un agent en ligne (la description partirait chez Anthropic).
    expect(tools.pc_screen_look!.confirmIf!({ question: "?" }, trust, { cloud: true })).toBe(true);
    expect(tools.pc_screen_look!.confirmIf!({ question: "?" }, trust, {})).toBe(false);
    expect(needsConfirmation(tools.pc_power!, undefined, parseConfig({}), { action: "sleep" })).toBe(true);
    expect(needsConfirmation(tools.pc_process_stop!, undefined, parseConfig({}), { target: "chrome" })).toBe(true);
  });

  it("encodage PowerShell : UTF-16LE en base64", () => {
    expect(Buffer.from(encodePowerShell("é'\""), "base64").toString("utf16le")).toBe("é'\"");
  });
});

describe.runIf(process.platform === "win32")("pc : Windows réel (lecture seule)", () => {
  const tools = Object.fromEntries(pcService().tools().map((t) => [t.name, t]));
  const ctx = { ui: { confirm: async () => false, progress: () => undefined } } as never;
  it("état du PC et fenêtres", async () => {
    expect(await tools.pc_status!.run({}, ctx)).toMatch(/Mémoire : .* Go libres/);
    expect(typeof (await tools.pc_windows!.run({}, ctx))).toBe("string");
    expect(await tools.pc_processes!.run({ query: "", limit: 5 }, ctx)).toMatch(/Mo/);
  }, 60_000);
});
