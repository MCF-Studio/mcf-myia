import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "../core/config.js";
import { paths } from "../core/paths.js";
import { getSecret } from "../core/secrets.js";
import type { Availability, Risk, Service, Tool } from "../core/types.js";

const toolName = (server: string, tool: string) =>
  `${server}__${tool}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64);

/** Résout les valeurs "secret:<nom>" depuis le coffre Windows. */
function resolveEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v.startsWith("secret:")) {
      const s = getSecret(v.slice(7));
      if (!s) throw new Error(`secret "${v.slice(7)}" absent du coffre (myia secret set ${v.slice(7)})`);
      out[k] = s;
    } else out[k] = v;
  }
  return out;
}

export interface McpServiceOptions {
  /** Id et libellé du service (défaut : « mcp:<nom> », « MCP <nom> »). */
  id?: string;
  label?: string;
  /** Comment le serveur est nommé dans l'aperçu d'une confirmation (défaut : « Serveur MCP <nom> »). */
  shown?: string;
  /** Environnement de base du processus, à la place de celui de MyIA (scripts d'équipe : environnement réduit). */
  baseEnv?: Record<string, string>;
  /** Contrôle fait à CHAQUE vérification de disponibilité, avant tout lancement : une raison = service indisponible. */
  guard?: () => string | undefined | Promise<string | undefined>;
  /** Délai du premier échange avec le serveur (défaut du SDK : 60 s). */
  startTimeoutMs?: number;
}

/** Un serveur MCP stdio quelconque devient un service : ses outils sont exposés tels quels. */
export function mcpService(name: string, cfg: McpServerConfig, opts: McpServiceOptions = {}): Service {
  let client: Client | undefined;
  let tools: Tool[] = [];
  let starting: Promise<Availability> | undefined;
  const shown = opts.shown ?? `Serveur MCP ${name}`;

  const stop = async () => {
    const c = client;
    client = undefined;
    tools = [];
    await c?.close().catch(() => {});
  };

  return {
    id: opts.id ?? `mcp:${name}`,
    label: opts.label ?? `MCP ${name}${cfg.description ? ` (${cfg.description})` : ""}`,
    async available() {
      if (!cfg.enabled) return { ok: false, reason: "désactivé dans la config" };
      const refused = await opts.guard?.();
      if (refused) {
        await stop();
        return { ok: false, reason: refused };
      }
      // Déjà lancé et toujours en vie : on garde le même processus (un par service, pas un par vérification).
      if (client && !starting) return { ok: true };
      // Deux agents qui vérifient en même temps partagent le même lancement.
      starting ??= start().finally(() => (starting = undefined));
      return starting;
    },
    tools: () => tools,
    close: stop,
  };

  async function start(): Promise<Availability> {
    // Fin de la sortie d'erreur du serveur : c'est elle qui explique un démarrage raté (module manquant, erreur de syntaxe).
    let errTail = "";
    try {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd ?? paths.home,
        env: { ...(opts.baseEnv ?? (process.env as Record<string, string>)), ...resolveEnv(cfg.env) },
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk: Buffer) => {
        errTail = (errTail + chunk.toString("utf8")).slice(-2000);
      });
      const started = new Client({ name: "myia", version: "0.1.0" });
      client = started;
      await started.connect(transport, opts.startTimeoutMs ? { timeout: opts.startTimeoutMs } : undefined);
      // Serveur arrêté ou planté : le prochain contrôle le relancera.
      started.onclose = () => {
        if (client === started) {
          client = undefined;
          tools = [];
        }
      };
      const listed = await started.listTools();
      tools = listed.tools.map((t): Tool => {
        const risk: Risk = cfg.readOnlyTools.includes(t.name) ? "read" : cfg.risk;
        return {
          name: toolName(name, t.name),
          description: `[${name}] ${t.description ?? t.name}`.slice(0, 1000),
          parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
          risk,
          parse(raw) {
            if (raw === null || raw === undefined) return {};
            if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("arguments : objet attendu");
            return raw;
          },
          preview: (a) => `${shown}, outil ${t.name}\nArguments :\n${JSON.stringify(a, null, 2)}`,
          async run(a) {
            if (client !== started) throw new Error(`${shown} n'est plus lancé : renvoie ta demande`);
            const res = await started.callTool({ name: t.name, arguments: a as Record<string, unknown> });
            const content = (res.content as { type: string; text?: string }[] | undefined) ?? [];
            const text = content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
            if (res.isError) throw new Error(text || "erreur sans message");
            return text || "(résultat vide)";
          },
        };
      });
      return { ok: true };
    } catch (e) {
      await stop();
      const last = errTail.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 300);
      return { ok: false, reason: `connexion impossible : ${(e as Error).message}${last ? ` (${last})` : ""}` };
    }
  }
}
