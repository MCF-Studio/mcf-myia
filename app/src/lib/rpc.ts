import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Client JSON-RPC vers le sidecar. Le Rust relaie les lignes (commande sidecar_send, événement sidecar://message).
 * Le sidecar peut aussi nous appeler (ui.confirm) : ces requêtes passent par `onRequest`.
 */

type Listener = (params: any) => void;
interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

export const inTauri = "__TAURI_INTERNALS__" in window;

let nextId = 1;
const pending = new Map<number, Pending>();
const listeners = new Map<string, Set<Listener>>();
let requestHandler: ((method: string, params: any, id: number) => void) | undefined;

function send(msg: object) {
  return invoke<void>("sidecar_send", { line: JSON.stringify(msg) });
}

/** `timeoutMs` : pour les appels courts ; les longs (réponse d'agent, téléchargement) n'en ont pas. */
export function call<T = unknown>(method: string, params: object = {}, timeoutMs?: number): Promise<T> {
  if (!inTauri) return Promise.reject(new Error("MyIA doit être lancé dans l'app (npm run tauri dev)"));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = timeoutMs
      ? setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} : pas de réponse du cœur MyIA`));
        }, timeoutMs)
      : undefined;
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v as T);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    send({ jsonrpc: "2.0", id, method, params }).catch((e) => {
      pending.delete(id);
      reject(new Error(String(e)));
    });
  });
}

/** Réponse à une requête venue du sidecar (ex. ui.confirm). */
export function reply(id: number, result: unknown) {
  return send({ jsonrpc: "2.0", id, result });
}

export function on(method: string, fn: Listener): () => void {
  if (!listeners.has(method)) listeners.set(method, new Set());
  listeners.get(method)!.add(fn);
  return () => listeners.get(method)?.delete(fn);
}

export function onRequest(fn: (method: string, params: any, id: number) => void) {
  requestHandler = fn;
}

function emit(method: string, params: unknown) {
  for (const fn of listeners.get(method) ?? []) {
    try {
      fn(params);
    } catch (e) {
      console.error(`[rpc] ${method}`, e);
    }
  }
}

let started = false;
export async function startRpc() {
  if (!inTauri || started) return;
  started = true;
  await listen<string>("sidecar://message", (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(ev.payload);
    } catch {
      return;
    }
    if (msg.method === undefined && typeof msg.id === "number") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "erreur"));
      else p.resolve(msg.result);
    } else if (typeof msg.method === "string") {
      if (msg.id !== undefined && msg.id !== null) requestHandler?.(msg.method, msg.params, msg.id);
      else emit(msg.method, msg.params);
    }
  });
  await listen("sidecar://exit", () => {
    for (const p of pending.values()) p.reject(new Error("le cœur MyIA s'est arrêté"));
    pending.clear();
    emit("sidecar.exit", {});
  });
}
