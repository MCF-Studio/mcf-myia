import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "../core/config.js";
import { paths } from "../core/paths.js";
import { getSecret } from "../core/secrets.js";
import type { Risk, Service, Tool } from "../core/types.js";

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

/** Un serveur MCP stdio quelconque devient un service : ses outils sont exposés tels quels. */
export function mcpService(name: string, cfg: McpServerConfig): Service {
  let client: Client | undefined;
  let tools: Tool[] = [];

  return {
    id: `mcp:${name}`,
    label: `MCP ${name}${cfg.description ? ` (${cfg.description})` : ""}`,
    async available() {
      if (!cfg.enabled) return { ok: false, reason: "désactivé dans la config" };
      try {
        const transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          cwd: cfg.cwd ?? paths.home,
          env: { ...(process.env as Record<string, string>), ...resolveEnv(cfg.env) },
          stderr: "ignore",
        });
        client = new Client({ name: "myia", version: "0.1.0" });
        await client.connect(transport);
        const listed = await client.listTools();
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
            preview: (a) => `Serveur MCP ${name}, outil ${t.name}\nArguments :\n${JSON.stringify(a, null, 2)}`,
            async run(a) {
              const res = await client!.callTool({ name: t.name, arguments: a as Record<string, unknown> });
              const content = (res.content as { type: string; text?: string }[] | undefined) ?? [];
              const text = content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
              if (res.isError) throw new Error(text || "erreur sans message");
              return text || "(résultat vide)";
            },
          };
        });
        return { ok: true };
      } catch (e) {
        await client?.close().catch(() => {});
        client = undefined;
        return { ok: false, reason: `connexion impossible : ${(e as Error).message}` };
      }
    },
    tools: () => tools,
    async close() {
      await client?.close();
    },
  };
}
