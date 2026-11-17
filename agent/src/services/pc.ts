import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { childEnv, runProcess } from "../core/proc.js";
import { defineTool, truncate, type Service } from "../core/types.js";
import { defaultWriteDir } from "./file-write.js";

/**
 * Contrôle du PC (Windows) : fenêtres, son, médias, captures d'écran, presse-papiers, processus, verrouillage,
 * alimentation, pages de Paramètres. Voir docs/SPEC.md §3, « Contrôle du PC ».
 *
 * Le modèle ne compose JAMAIS de commande : chaque action est un script PowerShell FIXE de ce fichier, choisi dans une
 * liste fermée, et les valeurs (numéro de fenêtre, volume, texte…) lui arrivent par des variables d'environnement
 * (MYIA_*), jamais insérées dans le texte du script. PowerShell est lancé sans shell, sans profil, sans fenêtre.
 */

const PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
namespace MyIA {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int j();
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int k(); int l(); int m(); int n();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
    int GetMute(out bool pbMute);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
  public static class Audio {
    static IAudioEndpointVolume Vol() {
      var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
      IMMDevice dev = null;
      Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
      IAudioEndpointVolume epv = null;
      var epvid = typeof(IAudioEndpointVolume).GUID;
      Marshal.ThrowExceptionForHR(dev.Activate(ref epvid, 23, 0, out epv));
      return epv;
    }
    public static float Volume {
      get { float v = -1; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
      set { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(value, Guid.Empty)); }
    }
    public static bool Mute {
      get { bool m = false; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
      set { Marshal.ThrowExceptionForHR(Vol().SetMute(value, Guid.Empty)); }
    }
  }
  public static class Win {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool LockWorkStation();
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    public static List<string> List() {
      var res = new List<string>();
      EnumWindows((h, p) => {
        if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
        if ((GetWindowLong(h, -20) & 0x80) != 0) return true;
        int n = GetWindowTextLength(h); if (n == 0) return true;
        var sb = new StringBuilder(n + 1); GetWindowText(h, sb, sb.Capacity);
        uint pid; GetWindowThreadProcessId(h, out pid);
        res.Add(h.ToInt64() + "\t" + pid + "\t" + sb.ToString());
        return true;
      }, IntPtr.Zero);
      return res;
    }
    public static void Key(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); }
    public static void Focus(IntPtr h) {
      // Alt enfoncé puis relâché : Windows autorise alors une autre application à passer au premier plan.
      keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
      ShowWindow(h, 9); SetForegroundWindow(h);
    }
  }
}
'@
`;

/** Scripts fixes, un par action. Les valeurs arrivent par $env:MYIA_*, jamais par le texte du script. */
const SCRIPTS = {
  status: String.raw`
$os = Get-CimInstance Win32_OperatingSystem
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [ordered]@{ drive = $_.DeviceID; label = $_.VolumeName; freeGb = [math]::Round($_.FreeSpace / 1GB, 1); totalGb = [math]::Round($_.Size / 1GB, 1) } })
$bat = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | ForEach-Object { [ordered]@{ percent = $_.EstimatedChargeRemaining; charging = ($_.BatteryStatus -in 2,6,7,8,9) } })
[ordered]@{
  os = $os.Caption; version = $os.Version; machine = $env:COMPUTERNAME
  uptimeMin = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalMinutes)
  ramFreeGb = [math]::Round($os.FreePhysicalMemory / 1MB, 1); ramTotalGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
  volume = [math]::Round([MyIA.Audio]::Volume * 100); mute = [MyIA.Audio]::Mute
  disks = $disks; battery = $bat
} | ConvertTo-Json -Compress -Depth 4`,
  windows: String.raw`
$names = @{}
Get-Process | ForEach-Object { $names[[int]$_.Id] = $_.ProcessName }
@([MyIA.Win]::List() | ForEach-Object {
  $p = $_ -split "\t", 3
  [ordered]@{ id = [string]$p[0]; pid = [int]$p[1]; process = $names[[int]$p[1]]; title = $p[2] }
}) | ConvertTo-Json -Compress -Depth 3`,
  window: String.raw`
$h = [IntPtr][long]$env:MYIA_HWND
if (-not [MyIA.Win]::IsWindow($h)) { throw 'cette fenêtre n''existe plus' }
switch ($env:MYIA_ACTION) {
  'focus' { [MyIA.Win]::Focus($h) }
  'minimize' { [void][MyIA.Win]::ShowWindow($h, 6) }
  'maximize' { [void][MyIA.Win]::ShowWindow($h, 3); [MyIA.Win]::Focus($h) }
  'restore' { [void][MyIA.Win]::ShowWindow($h, 9) }
  'close' { [void][MyIA.Win]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) }
  default { throw 'action inconnue' }
}
'"ok"'`,
  desktop: String.raw`
$shell = New-Object -ComObject Shell.Application
if ($env:MYIA_ACTION -eq 'restore') { $shell.UndoMinimizeALL() } else { $shell.MinimizeAll() }
'"ok"'`,
  key: String.raw`
$n = [int]$env:MYIA_COUNT
for ($i = 0; $i -lt $n; $i++) { [MyIA.Win]::Key([byte][int]$env:MYIA_VK); Start-Sleep -Milliseconds 30 }
[ordered]@{ volume = [math]::Round([MyIA.Audio]::Volume * 100); mute = [MyIA.Audio]::Mute } | ConvertTo-Json -Compress`,
  volume: String.raw`
if ($env:MYIA_LEVEL -match '^\d{1,3}$') { [MyIA.Audio]::Volume = [float]([int]$env:MYIA_LEVEL / 100.0) }
if ($env:MYIA_MUTE -eq '1') { [MyIA.Audio]::Mute = $true } elseif ($env:MYIA_MUTE -eq '0') { [MyIA.Audio]::Mute = $false }
[ordered]@{ volume = [math]::Round([MyIA.Audio]::Volume * 100); mute = [MyIA.Audio]::Mute } | ConvertTo-Json -Compress`,
  screenshot: String.raw`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save($env:MYIA_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
[ordered]@{ width = $b.Width; height = $b.Height } | ConvertTo-Json -Compress`,
  clipboard: String.raw`
Set-Clipboard -Value $env:MYIA_TEXT
'"ok"'`,
  processes: String.raw`
@(Get-Process | Group-Object ProcessName | ForEach-Object {
  [ordered]@{
    name = $_.Name; count = $_.Count; pids = @($_.Group | ForEach-Object { [int]$_.Id })
    memoryMb = [math]::Round(($_.Group | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
    cpuSec = [math]::Round(($_.Group | Measure-Object CPU -Sum).Sum)
    title = ($_.Group | Where-Object { $_.MainWindowTitle } | Select-Object -First 1).MainWindowTitle
  }
} | Sort-Object memoryMb -Descending) | ConvertTo-Json -Compress -Depth 3`,
  kill: String.raw`
$ids = $env:MYIA_PIDS -split ',' | ForEach-Object { [int]$_ }
$stopped = 0
foreach ($id in $ids) { try { Stop-Process -Id $id -Force -ErrorAction Stop; $stopped++ } catch { } }
[ordered]@{ stopped = $stopped; asked = $ids.Count } | ConvertTo-Json -Compress`,
  lock: String.raw`
[void][MyIA.Win]::LockWorkStation()
'"ok"'`,
  sleep: String.raw`
Add-Type -AssemblyName System.Windows.Forms
[void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)
'"ok"'`,
  settings: String.raw`
Start-Process ('ms-settings:' + $env:MYIA_PAGE)
'"ok"'`,
} as const;

type ScriptName = keyof typeof SCRIPTS;

/** Scripts qui ont besoin des appels natifs (son, fenêtres) : les autres évitent la compilation de PRELUDE. */
const NATIVE = new Set<ScriptName>(["status", "windows", "window", "key", "volume", "lock"]);
const BASIC = "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n";

/** Encodage attendu par `powershell -EncodedCommand` : UTF-16LE en base64 (aucun guillemet à échapper). */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows";
const POWERSHELL = path.join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const SHUTDOWN = path.join(SYSTEM_ROOT, "System32", "shutdown.exe");

/** Lance un des scripts fixes ; `env` = les seules valeurs variables. Rend la sortie JSON décodée. */
async function ps<T = unknown>(name: ScriptName, env: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const script = (NATIVE.has(name) ? PRELUDE : BASIC) + SCRIPTS[name];
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) vars[`MYIA_${k}`] = v;
  const out: string[] = [];
  const err: string[] = [];
  const res = await runProcess([POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)], {
    cwd: os.homedir(),
    timeoutMs: 30_000,
    env: { ...childEnv(), ...vars },
    keep: 400,
    signal,
    onLine: (l, s) => (s === "out" ? out : err).push(l),
  });
  if (res.timedOut) throw new Error("Windows n'a pas répondu à temps");
  if (res.code !== 0) {
    const msg = err.find((l) => l.trim() && !l.startsWith("At line") && !l.startsWith("Au caractère")) ?? `code ${res.code}`;
    throw new Error(msg.replace(/^.*?:\s*/, "").slice(0, 300) || "échec");
  }
  const text = out.join("\n").trim();
  try {
    return JSON.parse(text || "null") as T;
  } catch {
    throw new Error(`réponse illisible de Windows : ${truncate(text, 200)}`);
  }
}

// ─── fenêtres ────────────────────────────────────────────────────────────────

export interface WindowInfo {
  id: string;
  pid: number;
  process?: string;
  title: string;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/**
 * Trouve LA fenêtre désignée par un texte (titre ou nom du programme). Titre exact d'abord, puis début de titre,
 * puis titre ou programme qui contient le texte. Plusieurs candidates au même niveau : erreur avec la liste, pour
 * que le modèle précise au lieu d'agir sur la mauvaise fenêtre.
 */
export function matchWindow(list: WindowInfo[], query: string): WindowInfo {
  const q = norm(query);
  if (!q) throw new Error("précise la fenêtre (titre ou programme)");
  const levels = [
    list.filter((w) => norm(w.title) === q),
    list.filter((w) => norm(w.process ?? "") === q),
    list.filter((w) => norm(w.title).startsWith(q)),
    list.filter((w) => norm(w.title).includes(q) || norm(w.process ?? "").includes(q)),
  ];
  for (const found of levels) {
    if (found.length === 1) return found[0]!;
    if (found.length > 1)
      throw new Error(`plusieurs fenêtres correspondent à « ${query} » : ${found.slice(0, 8).map((w) => `« ${w.title} »`).join(", ")}. Précise le titre.`);
  }
  throw new Error(`aucune fenêtre ouverte ne correspond à « ${query} ». Fenêtres : ${list.slice(0, 15).map((w) => `« ${w.title} »`).join(", ") || "aucune"}`);
}

// ─── processus ───────────────────────────────────────────────────────────────

export interface ProcessGroup {
  name: string;
  count: number;
  pids: number[];
  memoryMb: number;
  cpuSec: number;
  title?: string;
}

/**
 * Processus que MyIA refuse d'arrêter : le système (l'arrêter plante ou déconnecte Windows), la sécurité, et MyIA
 * lui-même (Ollama, llama.cpp et le cœur : sinon l'agent se coupe en pleine réponse).
 */
const PROTECTED = new Set(
  [
    "system", "idle", "registry", "smss", "csrss", "wininit", "winlogon", "services", "lsass", "lsaiso", "svchost",
    "fontdrvhost", "dwm", "explorer", "sihost", "ctfmon", "conhost", "taskhostw", "runtimebroker", "searchhost",
    "startmenuexperiencehost", "shellexperiencehost", "textinputhost", "audiodg", "spoolsv", "wudfhost", "dllhost",
    "memory compression", "secure system", "msmpeng", "mssense", "nissrv", "securityhealthservice", "smartscreen",
    "myia", "myia-agent", "ollama", "ollama app", "llama-server", "msedgewebview2",
  ].map((n) => n.toLowerCase()),
);

export function isProtectedProcess(name: string): boolean {
  return PROTECTED.has(name.toLowerCase().replace(/\.exe$/, ""));
}

/** Groupe de processus désigné par son nom (exact, sans .exe), ou par un de ses PID. */
export function matchProcess(list: ProcessGroup[], target: string): ProcessGroup {
  const t = target.trim().toLowerCase().replace(/\.exe$/, "");
  if (/^\d+$/.test(t)) {
    const pid = Number(t);
    const g = list.find((p) => p.pids.includes(pid));
    if (!g) throw new Error(`aucun processus n'a le PID ${pid}`);
    return { ...g, pids: [pid], count: 1 };
  }
  const g = list.find((p) => p.name.toLowerCase() === t);
  if (!g) {
    const near = list.filter((p) => p.name.toLowerCase().includes(t)).slice(0, 6);
    throw new Error(`aucun processus « ${target} »${near.length ? `. Proches : ${near.map((p) => p.name).join(", ")}` : ""}`);
  }
  return g;
}

// ─── médias et pages de Paramètres ───────────────────────────────────────────

/** Touches multimédia de Windows (codes de touche virtuels). */
const MEDIA_KEYS = {
  play_pause: 0xb3,
  next: 0xb0,
  previous: 0xb1,
  stop: 0xb2,
  volume_up: 0xaf,
  volume_down: 0xae,
  mute_toggle: 0xad,
} as const;

/** Pages de Paramètres ouvrables (adresses ms-settings: fixes). */
export const SETTINGS_PAGES = {
  display: "display",
  sound: "sound",
  bluetooth: "bluetooth",
  wifi: "network-wifi",
  network: "network-status",
  battery: "batterysaver",
  power: "powersleep",
  update: "windowsupdate",
  apps: "appsfeatures",
  storage: "storagesense",
  notifications: "notifications",
  focus: "quiethours",
  night_light: "nightlight",
  mouse: "mousetouchpad",
  personalization: "personalization",
  privacy: "privacy",
} as const;

const MEDIA_LABELS: Record<keyof typeof MEDIA_KEYS, string> = {
  play_pause: "lecture/pause",
  next: "morceau suivant",
  previous: "morceau précédent",
  stop: "arrêt de la lecture",
  volume_up: "volume +",
  volume_down: "volume −",
  mute_toggle: "son coupé/rétabli",
};

/** Dossier des captures d'écran : Documents\MyIA\captures (créé au besoin). */
export const capturesDir = () => path.join(defaultWriteDir(), "captures");

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export function pcService(): Service {
  const windowsList = (signal?: AbortSignal) => ps<WindowInfo[] | WindowInfo | null>("windows", {}, signal).then((r) => (Array.isArray(r) ? r : r ? [r] : []));
  const processList = (signal?: AbortSignal) => ps<ProcessGroup[] | ProcessGroup | null>("processes", {}, signal).then((r) => (Array.isArray(r) ? r : r ? [r] : []));

  return {
    id: "pc",
    label: "Contrôle du PC",
    async available() {
      if (process.platform !== "win32") return { ok: false, reason: "Windows uniquement" };
      return fs.existsSync(POWERSHELL) ? { ok: true } : { ok: false, reason: "PowerShell introuvable" };
    },
    tools() {
      return [
        defineTool({
          name: "pc_status",
          description: "État du PC : Windows, durée depuis le démarrage, mémoire libre, espace libre des disques, batterie, volume du son.",
          schema: z.object({}),
          risk: "read",
          preview: () => "",
          async run(_a, ctx) {
            const s = await ps<{
              os: string;
              version: string;
              machine: string;
              uptimeMin: number;
              ramFreeGb: number;
              ramTotalGb: number;
              volume: number;
              mute: boolean;
              disks: { drive: string; label?: string; freeGb: number; totalGb: number }[];
              battery: { percent: number; charging: boolean }[];
            }>("status", {}, ctx.signal);
            const up = s.uptimeMin >= 60 ? `${Math.floor(s.uptimeMin / 60)} h ${s.uptimeMin % 60} min` : `${s.uptimeMin} min`;
            const lines = [
              `${s.machine} · ${s.os} (${s.version}) · allumé depuis ${up}`,
              `Mémoire : ${s.ramFreeGb} Go libres sur ${s.ramTotalGb} Go`,
              `Son : ${s.mute ? "coupé" : `${s.volume} %`}`,
              ...[s.disks].flat().map((d) => `Disque ${d.drive}${d.label ? ` (${d.label})` : ""} : ${d.freeGb} Go libres sur ${d.totalGb} Go`),
              ...[s.battery].flat().map((b) => `Batterie : ${b.percent} %${b.charging ? " (en charge)" : ""}`),
            ];
            return lines.join("\n");
          },
        }),
        defineTool({
          name: "pc_windows",
          description: "Liste les fenêtres ouvertes (titre et programme). À utiliser avant pc_window si tu ne connais pas le titre exact.",
          schema: z.object({}),
          risk: "read",
          preview: () => "",
          async run(_a, ctx) {
            const list = await windowsList(ctx.signal);
            if (!list.length) return "Aucune fenêtre ouverte.";
            return list.map((w) => `- « ${w.title} »${w.process ? ` (${w.process})` : ""}`).join("\n");
          },
        }),
        defineTool({
          name: "pc_window",
          description:
            "Agit sur une fenêtre ouverte, désignée par son titre ou son programme : la mettre au premier plan (focus), la réduire, l'agrandir, la restaurer ou la fermer (close, confirmé : du travail non enregistré pourrait être perdu, le programme le demande en général).",
          schema: z.object({
            window: z.string().min(1).max(200).describe("Titre (ou début du titre) de la fenêtre, ou nom du programme (ex. \"chrome\")"),
            action: z.enum(["focus", "minimize", "maximize", "restore", "close"]),
          }),
          risk: "launch",
          confirmIf: (a) => a.action === "close",
          async preview(a) {
            const w = matchWindow(await windowsList(), a.window);
            return `Fermer la fenêtre « ${w.title} »${w.process ? ` (${w.process})` : ""}`;
          },
          async run(a, ctx) {
            const w = matchWindow(await windowsList(ctx.signal), a.window);
            await ps("window", { HWND: w.id, ACTION: a.action }, ctx.signal);
            const done = { focus: "au premier plan", minimize: "réduite", maximize: "agrandie", restore: "restaurée", close: "fermeture demandée" }[a.action];
            return `Fenêtre « ${w.title} » : ${done}.`;
          },
        }),
        defineTool({
          name: "pc_desktop",
          description: "Affiche le bureau (réduit toutes les fenêtres) ou remet les fenêtres réduites ainsi.",
          schema: z.object({ action: z.enum(["show", "restore"]).default("show") }),
          risk: "launch",
          preview: () => "",
          async run(a, ctx) {
            await ps("desktop", { ACTION: a.action }, ctx.signal);
            return a.action === "show" ? "Bureau affiché, fenêtres réduites." : "Fenêtres remises.";
          },
        }),
        defineTool({
          name: "pc_media",
          description:
            "Touches multimédia : lecture/pause, morceau suivant ou précédent, arrêt (agit sur le lecteur actif : Spotify, navigateur…), volume +/− (2 % par pas) ou couper/rétablir le son.",
          schema: z.object({
            key: z.enum(Object.keys(MEDIA_KEYS) as [keyof typeof MEDIA_KEYS, ...(keyof typeof MEDIA_KEYS)[]]),
            times: z.number().int().min(1).max(25).default(1).describe("Nombre d'appuis (volume_up/volume_down)"),
          }),
          risk: "launch",
          preview: () => "",
          async run(a, ctx) {
            const repeat = a.key === "volume_up" || a.key === "volume_down" ? a.times : 1;
            const r = await ps<{ volume: number; mute: boolean }>("key", { VK: String(MEDIA_KEYS[a.key]), COUNT: String(repeat) }, ctx.signal);
            return `${MEDIA_LABELS[a.key]}${repeat > 1 ? ` ×${repeat}` : ""} · son ${r.mute ? "coupé" : `à ${r.volume} %`}.`;
          },
        }),
        defineTool({
          name: "pc_volume",
          description: "Règle le volume général du PC (0 à 100) et/ou coupe ou rétablit le son. Sans argument : donne le volume actuel.",
          schema: z.object({
            level: z.number().int().min(0).max(100).optional(),
            mute: z.boolean().optional(),
          }),
          risk: "launch",
          preview: () => "",
          async run(a, ctx) {
            const r = await ps<{ volume: number; mute: boolean }>(
              "volume",
              { LEVEL: a.level === undefined ? "none" : String(a.level), MUTE: a.mute === undefined ? "none" : a.mute ? "1" : "0" },
              ctx.signal,
            );
            return `Son ${r.mute ? "coupé" : "actif"}, volume à ${r.volume} %.`;
          },
        }),
        defineTool({
          name: "pc_screenshot",
          description: "Capture tout l'écran (tous les moniteurs) en PNG dans Documents\\MyIA\\captures et rend le chemin du fichier (tu peux l'ouvrir avec open_path).",
          schema: z.object({}),
          risk: "launch",
          preview: () => "",
          async run(_a, ctx) {
            const dir = capturesDir();
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `capture_${stamp()}.png`);
            const r = await ps<{ width: number; height: number }>("screenshot", { PATH: file }, ctx.signal);
            return `Capture enregistrée (${r.width}×${r.height}) : ${file}`;
          },
        }),
        defineTool({
          name: "pc_clipboard_set",
          description: "Copie un texte dans le presse-papiers de Windows (l'utilisateur pourra le coller avec Ctrl+V).",
          schema: z.object({ text: z.string().min(1).max(20_000) }),
          risk: "launch",
          preview: () => "",
          async run(a, ctx) {
            await ps("clipboard", { TEXT: a.text }, ctx.signal);
            return `Copié dans le presse-papiers (${a.text.length} caractères).`;
          },
        }),
        defineTool({
          name: "pc_processes",
          description: "Liste les programmes qui tournent, triés par mémoire utilisée (nom, nombre de processus, mémoire, temps processeur, titre de fenêtre).",
          schema: z.object({
            query: z.string().max(80).default("").describe("Filtre sur le nom (optionnel)"),
            limit: z.number().int().min(1).max(60).default(20),
          }),
          risk: "read",
          preview: () => "",
          async run(a, ctx) {
            const q = a.query.trim().toLowerCase();
            const list = (await processList(ctx.signal)).filter((p) => !q || p.name.toLowerCase().includes(q));
            if (!list.length) return q ? `Aucun programme « ${a.query} » en cours.` : "Aucun processus.";
            return list
              .slice(0, a.limit)
              .map((p) => `- ${p.name}${p.count > 1 ? ` ×${p.count}` : ""} · ${p.memoryMb} Mo · ${p.cpuSec} s CPU${p.title ? ` · « ${p.title} »` : ""}${isProtectedProcess(p.name) ? " · protégé" : ""}`)
              .join("\n");
          },
        }),
        defineTool({
          name: "pc_process_stop",
          description:
            "Arrête de force un programme (tous ses processus) désigné par son nom exact (ex. \"chrome\", vu dans pc_processes) ou un PID. Toujours confirmé : le travail non enregistré est perdu. Les processus du système et de MyIA sont refusés.",
          schema: z.object({ target: z.string().min(1).max(120).describe("Nom du programme sans .exe, ou PID") }),
          risk: "local",
          async check(a) {
            const g = matchProcess(await processList(), a.target);
            if (isProtectedProcess(g.name)) throw new Error(`${g.name} est un processus protégé (système ou MyIA) : arrêt refusé`);
            if (g.pids.includes(process.pid) || g.pids.includes(process.ppid)) throw new Error("arrêt de MyIA refusé");
          },
          async preview(a) {
            const g = matchProcess(await processList(), a.target);
            return `Arrêter de force ${g.name} (${g.pids.length} processus, ${g.memoryMb} Mo)${g.title ? ` — fenêtre « ${g.title} »` : ""}.\nTout travail non enregistré dans ce programme sera perdu.`;
          },
          async run(a, ctx) {
            // Liste relue juste avant : les PID montrés à la confirmation peuvent avoir changé.
            const g = matchProcess(await processList(ctx.signal), a.target);
            if (isProtectedProcess(g.name)) throw new Error(`${g.name} est protégé`);
            const pids = g.pids.filter((p) => p !== process.pid && p !== process.ppid);
            const r = await ps<{ stopped: number; asked: number }>("kill", { PIDS: pids.join(",") }, ctx.signal);
            return `${g.name} : ${r.stopped} processus arrêté(s) sur ${r.asked}.`;
          },
        }),
        defineTool({
          name: "pc_lock",
          description: "Verrouille la session Windows (écran de connexion ; rien n'est fermé).",
          schema: z.object({}),
          risk: "launch",
          preview: () => "",
          async run(_a, ctx) {
            await ps("lock", {}, ctx.signal);
            return "Session verrouillée.";
          },
        }),
        defineTool({
          name: "pc_power",
          description:
            "Alimentation : mise en veille, redémarrage ou arrêt du PC (redémarrage et arrêt après un délai, annulables avec action=cancel). Toujours confirmé.",
          schema: z.object({
            action: z.enum(["sleep", "restart", "shutdown", "cancel"]),
            delay_seconds: z.number().int().min(30).max(3600).default(60).describe("Délai avant redémarrage/arrêt"),
          }),
          risk: "local",
          preview(a) {
            if (a.action === "sleep") return "Mettre le PC en veille maintenant.";
            if (a.action === "cancel") return "Annuler le redémarrage ou l'arrêt programmé.";
            return `${a.action === "restart" ? "Redémarrer" : "Éteindre"} le PC dans ${a.delay_seconds} s (programmes fermés, travail non enregistré perdu).`;
          },
          async run(a, ctx) {
            if (a.action === "sleep") {
              await ps("sleep", {}, ctx.signal);
              return "PC mis en veille.";
            }
            const argv =
              a.action === "cancel"
                ? [SHUTDOWN, "/a"]
                : [SHUTDOWN, a.action === "restart" ? "/r" : "/s", "/t", String(a.delay_seconds), "/c", "MyIA : demandé par ton assistant (annulable)"];
            const r = await runProcess(argv, { cwd: os.homedir(), timeoutMs: 15_000, signal: ctx.signal });
            if (r.code !== 0) throw new Error(a.action === "cancel" ? "aucun arrêt programmé à annuler" : r.tail.join(" ").trim() || `code ${r.code}`);
            if (a.action === "cancel") return "Arrêt programmé annulé.";
            return `${a.action === "restart" ? "Redémarrage" : "Arrêt"} dans ${a.delay_seconds} s (pc_power action=cancel pour annuler).`;
          },
        }),
        defineTool({
          name: "pc_settings_open",
          description: `Ouvre une page des Paramètres de Windows : ${Object.keys(SETTINGS_PAGES).join(", ")}.`,
          schema: z.object({ page: z.enum(Object.keys(SETTINGS_PAGES) as [keyof typeof SETTINGS_PAGES, ...(keyof typeof SETTINGS_PAGES)[]]) }),
          risk: "launch",
          preview: () => "",
          async run(a, ctx) {
            await ps("settings", { PAGE: SETTINGS_PAGES[a.page] }, ctx.signal);
            return `Paramètres ouverts : ${a.page}.`;
          },
        }),
      ];
    },
  };
}
