import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";

const SENSITIVE_KEY = /token|secret|password|passwd|api[_-]?key|authorization/i;

export interface AuditEvent {
  event: "tool_call" | "session_start" | "session_end" | "crash" | "ollama_install" | "claude_api_usage" | "claude_api_key" | "files_full_access" | "map_sync";
  /** Version installée (event "ollama_install"). */
  version?: string;
  tool?: string;
  risk?: string;
  args?: unknown;
  decision?: "auto" | "approved" | "refused" | "invalid";
  ok?: boolean;
  error?: string;
  durationMs?: number;
  /** Pile d'appel d'une erreur fatale (event "crash"). */
  stack?: string;
  /** API Claude (events "claude_api_*") : agent, modèle servi, jetons consommés, action sur la clé (jamais la clé). */
  agent?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  action?: "set" | "delete";
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[profondeur]";
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? "[masqué]" : scrub(v, depth + 1);
    return out;
  }
  return value;
}

/** Journal append-only, un fichier JSONL par mois : data/audit/AAAA-MM.jsonl */
export function audit(ev: AuditEvent, dir = paths.audit): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    const file = path.join(dir, `${now.toISOString().slice(0, 7)}.jsonl`);
    const line = JSON.stringify({ ts: now.toISOString(), ...ev, args: scrub(ev.args) });
    fs.appendFileSync(file, line + "\n", "utf8");
  } catch (e) {
    // Le journal ne doit jamais faire planter l'agent, mais l'échec doit se voir.
    process.stderr.write(`[audit] écriture impossible : ${(e as Error).message}\n`);
  }
}
