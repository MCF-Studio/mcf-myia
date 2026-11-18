import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { childEnv, runProcess } from "../core/proc.js";
import { defineTool, truncate, type Tool } from "../core/types.js";
import { encodePowerShell } from "./pc.js";

/**
 * Terminal PowerShell : donné SEULEMENT à Jarvis en mode libre (choix explicite de l'utilisateur, averti sur
 * l'onglet Jarvis). Accès total à la machine : aucune liste blanche, aucun dossier fermé.
 */

const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows";
const POWERSHELL = path.join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const PRELUDE = "$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n";
const MAX_OUTPUT = 12_000;

export function shellTool(): Tool {
  return defineTool({
    name: "pc_shell",
    description:
      "Exécute une commande PowerShell sur le PC (accès total : fichiers, registre, programmes, réseau, winget, git…). " +
      "Rend la sortie et le code de retour. Pour tout ce qu'aucun autre outil ne fait.",
    risk: "local",
    schema: z.object({
      command: z.string().min(1).max(20_000).describe("Commande ou script PowerShell"),
      cwd: z.string().optional().describe("Dossier de travail (par défaut : dossier personnel)"),
      timeoutSec: z.number().int().min(1).max(1800).optional().describe("Délai maximal en secondes (60 par défaut)"),
    }),
    preview: (a) => a.command,
    async run(a, ctx) {
      const cwd = a.cwd && fs.statSync(a.cwd, { throwIfNoEntry: false })?.isDirectory() ? a.cwd : os.homedir();
      const lines: string[] = [];
      const res = await runProcess(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(PRELUDE + a.command)],
        {
          cwd,
          timeoutMs: (a.timeoutSec ?? 60) * 1000,
          env: childEnv(),
          keep: 2000,
          signal: ctx.signal,
          onLine: (l, s) => lines.push(s === "err" ? `[err] ${l}` : l),
        },
      );
      const out = truncate(lines.join("\n").trim(), MAX_OUTPUT) || "(aucune sortie)";
      const head = res.timedOut ? `Délai dépassé (${a.timeoutSec ?? 60} s), commande arrêtée.` : `Code de retour : ${res.code}`;
      return `${head}\n${out}`;
    },
  });
}
