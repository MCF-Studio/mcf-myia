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
