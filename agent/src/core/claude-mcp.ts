import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Serveurs MCP connus de Claude Code sur ce PC (fichier ~/.claude.json) : portée « utilisateur » (tous les dossiers)
 * et portée « locale » (un dossier précis). Sert à l'écran Paramètres pour choisir ceux que les consoles de l'app
 * lancent (claude.consoleMcp). On ne renvoie que des NOMS : jamais la commande, les arguments ni les variables
 * d'environnement (qui contiennent souvent des jetons).
 */
export interface McpServerName {
  name: string;
  scope: "utilisateur" | "local";
  /** Dossiers où il est déclaré (portée locale). */
  projects?: string[];
}

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export function claudeConfigFile(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

export function listMcpServers(raw: unknown): McpServerName[] {
  const out = new Map<string, McpServerName>();
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const names = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).filter((n) => NAME.test(n)) : []);
  for (const n of names(obj.mcpServers)) out.set(n, { name: n, scope: "utilisateur" });
  const projects = obj.projects && typeof obj.projects === "object" ? (obj.projects as Record<string, unknown>) : {};
  for (const [dir, p] of Object.entries(projects)) {
    for (const n of names((p as Record<string, unknown> | null)?.mcpServers)) {
      const cur = out.get(n);
      if (cur?.scope === "utilisateur") continue;
      const entry = cur ?? { name: n, scope: "local" as const, projects: [] };
      if (entry.projects!.length < 10) entry.projects!.push(dir.slice(0, 260));
      out.set(n, entry);
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
}

export function readMcpServers(file = claudeConfigFile()): McpServerName[] {
  try {
    const st = fs.statSync(file);
    if (st.size > 20 * 1024 * 1024) return [];
    return listMcpServers(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

/** Serveur MCP de Claude Code importable dans MyIA (lancé par une commande, portée utilisateur). */
export interface ImportableServer {
  name: string;
  command: string;
  args: string[];
  /** Variables d'environnement : valeurs à ranger dans le coffre Windows, jamais dans config/agent.json. */
  env: Record<string, string>;
}

/**
 * Serveurs de la portée utilisateur de ~/.claude.json que MyIA peut lancer lui-même (stdio). Les serveurs http/sse
 * (adresse distante) ne sont pas repris : le service MCP de MyIA ne lance que des commandes locales.
 */
export function importableServers(raw: unknown): ImportableServer[] {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const servers = obj.mcpServers && typeof obj.mcpServers === "object" ? (obj.mcpServers as Record<string, unknown>) : {};
  const out: ImportableServer[] = [];
  for (const [name, def] of Object.entries(servers)) {
    if (!NAME.test(name) || !def || typeof def !== "object") continue;
    const d = def as { type?: unknown; command?: unknown; args?: unknown; env?: unknown };
    if ((d.type !== undefined && d.type !== "stdio") || typeof d.command !== "string" || !d.command) continue;
    const args = Array.isArray(d.args) ? d.args.filter((a): a is string => typeof a === "string").slice(0, 50) : [];
    const env: Record<string, string> = {};
    if (d.env && typeof d.env === "object") {
      for (const [k, v] of Object.entries(d.env as Record<string, unknown>)) if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && typeof v === "string") env[k] = v;
    }
    out.push({ name, command: d.command.slice(0, 500), args, env });
  }
  return out;
}

/** Nom du secret qui garde une variable d'environnement d'un serveur importé. */
export const mcpSecretName = (server: string, key: string) =>
  `mcp_${server}_${key}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 80);
