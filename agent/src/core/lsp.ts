import os from "node:os";
import { runProcess } from "./proc.js";

/**
 * Serveurs de langage (LSP) pour les consoles Claude Code : avec eux, Claude va à la définition d'un symbole, trouve
 * ses références et voit les erreurs de type sans relire des fichiers entiers. Moins de fichiers lus = moins de
 * jetons consommés sur des projets un peu gros.
 *
 * Deux pièces par langage : le serveur (programme installé sur le PC) et le plugin officiel de Claude Code
 * (marketplace claude-plugins-official) qui le branche. Tout est en liste FERMÉE ci-dessous : l'interface ne choisit
 * qu'un identifiant, jamais une commande.
 */
export interface LspSpec {
  id: string;
  label: string;
  /** Programme du serveur, cherché dans le PATH. */
  server: string;
  /** Plugin Claude Code (marketplace claude-plugins-official). */
  plugin: string;
  /** Installation du serveur : argv fixe (cmd.exe seulement pour les .cmd de npm). */
  install: string[];
  /** Ce qu'il faut déjà avoir pour l'installer. */
  needs: string;
}

const npm = (pkgs: string[]) => (process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", `npm install -g ${pkgs.join(" ")}`] : ["npm", "install", "-g", ...pkgs]);

export const LSPS: readonly LspSpec[] = [
  {
    id: "typescript",
    label: "TypeScript / JavaScript",
    server: "typescript-language-server",
    plugin: "typescript-lsp",
    install: npm(["typescript-language-server", "typescript"]),
    needs: "Node.js (npm)",
  },
  {
    id: "rust",
    label: "Rust",
    server: "rust-analyzer",
    plugin: "rust-analyzer-lsp",
    install: ["rustup", "component", "add", "rust-analyzer"],
    needs: "Rust (rustup)",
  },
  {
    id: "python",
    label: "Python",
    server: "pyright-langserver",
    plugin: "pyright-lsp",
    install: npm(["pyright"]),
    needs: "Node.js (npm)",
  },
  {
    id: "csharp",
    label: "C# (Godot .NET, Unity)",
    server: "csharp-ls",
    plugin: "csharp-lsp",
    install: ["dotnet", "tool", "install", "--global", "csharp-ls"],
    needs: ".NET SDK (dotnet)",
  },
];

export interface LspStatus {
  id: string;
  label: string;
  needs: string;
  server: boolean;
  plugin: boolean;
}

const MARKETPLACE = "claude-plugins-official";

async function onPath(program: string): Promise<boolean> {
  const finder = process.platform === "win32" ? ["where.exe", program] : ["which", program];
  try {
    return (await runProcess(finder, { cwd: os.homedir(), timeoutMs: 10_000, keep: 2 })).code === 0;
  } catch {
    return false;
  }
}

/** Plugins Claude Code installés (noms courts), d'après `claude plugin list --json`. */
export function installedPlugins(json: string): Set<string> {
  try {
    const raw = JSON.parse(json) as unknown;
    const list = Array.isArray(raw) ? raw : ((raw as { plugins?: unknown[] })?.plugins ?? []);
    const names = new Set<string>();
    for (const p of list) {
      const id = typeof p === "string" ? p : ((p as { id?: unknown; name?: unknown })?.id ?? (p as { name?: unknown })?.name);
      if (typeof id === "string") names.add(id.split("@")[0]!);
    }
    return names;
  } catch {
    return new Set();
  }
}

async function claudePlugins(claude: string): Promise<Set<string>> {
  const lines: string[] = [];
  try {
    await runProcess(claudeArgv(claude, ["plugin", "list", "--json"]), { cwd: os.homedir(), timeoutMs: 30_000, keep: 2, onLine: (l, s) => s === "out" && lines.push(l) });
  } catch {
    return new Set();
  }
  return installedPlugins(lines.join("\n"));
}

/** `claude` est un .cmd sous Windows quand il vient de npm : on passe alors par cmd.exe, arguments fixes. */
function claudeArgv(claude: string, args: string[]): string[] {
  if (process.platform !== "win32" || /\.exe$/i.test(claude)) return [claude, ...args];
  return ["cmd.exe", "/d", "/s", "/c", [claude, ...args].join(" ")];
}

export async function lspStatus(claude = "claude"): Promise<LspStatus[]> {
  const plugins = await claudePlugins(claude);
  return Promise.all(
    LSPS.map(async (l) => ({ id: l.id, label: l.label, needs: l.needs, server: await onPath(l.server), plugin: plugins.has(l.plugin) })),
  );
}

/** Installe le serveur (s'il manque) puis le plugin Claude Code. Rend les dernières lignes en cas d'échec. */
export async function installLsp(id: string, claude = "claude"): Promise<{ ok: boolean; detail?: string }> {
  const spec = LSPS.find((l) => l.id === id);
  if (!spec) throw new Error(`langage inconnu : ${id}`);
  if (!(await onPath(spec.server))) {
    const r = await runProcess(spec.install, { cwd: os.homedir(), timeoutMs: 10 * 60_000, keep: 12 });
    if (r.code !== 0) return { ok: false, detail: `installation du serveur impossible (${spec.needs} requis) : ${r.tail.slice(-4).join(" ")}` };
  }
  const p = await runProcess(claudeArgv(claude, ["plugin", "install", `${spec.plugin}@${MARKETPLACE}`, "--scope", "user"]), {
    cwd: os.homedir(),
    timeoutMs: 5 * 60_000,
    keep: 12,
  });
  if (p.code !== 0) return { ok: false, detail: `plugin Claude Code non installé : ${p.tail.slice(-4).join(" ")}` };
  return { ok: true };
}
