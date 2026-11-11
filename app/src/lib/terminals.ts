import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { reactive } from "vue";
import { inTauri } from "./rpc";

/** Consoles Claude Code ouvertes dans l'app. Elles vivent tant que l'app est ouverte (pas de persistance). */
export interface TerminalInfo {
  key: string; // "pty:<id>" : même liste d'onglets que les conversations
  id: number;
  title: string;
  cwd: string;
  exited?: number | null;
}

export const terminals = reactive<Record<string, TerminalInfo>>({});

type DataFn = (data: string) => void;
const sinks = new Map<number, DataFn>();
const backlog = new Map<number, string[]>();

export const isTerminalKey = (k: string) => k.startsWith("pty:");

let started = false;
export async function startTerminals() {
  if (!inTauri || started) return;
  started = true;
  await listen<{ id: number; data: string }>("pty://data", (e) => {
    const fn = sinks.get(e.payload.id);
    if (fn) fn(e.payload.data);
    else {
      // L'onglet n'est pas encore monté : on garde la sortie pour l'afficher à l'ouverture.
      const b = backlog.get(e.payload.id) ?? [];
      b.push(e.payload.data);
      backlog.set(e.payload.id, b);
    }
  });
  await listen<{ id: number; code: number | null }>("pty://exit", (e) => {
    const t = terminals[`pty:${e.payload.id}`];
    if (t) t.exited = e.payload.code;
  });
}

export async function openClaude(cwd: string, title: string, resume: boolean): Promise<string> {
  const id = await invoke<number>("pty_spawn", { cwd, resume, cols: 120, rows: 32 });
  const key = `pty:${id}`;
  terminals[key] = { key, id, title, cwd };
  return key;
}

export function attach(id: number, fn: DataFn) {
  sinks.set(id, fn);
  for (const chunk of backlog.get(id) ?? []) fn(chunk);
  backlog.delete(id);
}

export function detach(id: number) {
  sinks.delete(id);
}

export const writeTerminal = (id: number, data: string) => invoke("pty_write", { id, data });
export const resizeTerminal = (id: number, cols: number, rows: number) => invoke("pty_resize", { id, cols, rows });

export async function killTerminal(key: string) {
  const t = terminals[key];
  if (!t) return;
  await invoke("pty_kill", { id: t.id }).catch(() => undefined);
  delete terminals[key];
}
