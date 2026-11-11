import readline from "node:readline";

/**
 * JSON-RPC 2.0 sur stdio, un message JSON par ligne.
 * stdout est RÉSERVÉ au protocole : tout console.log du code est redirigé vers stderr (voir main.ts).
 * Les deux côtés peuvent appeler : l'app appelle les méthodes du sidecar, le sidecar appelle l'app pour
 * les confirmations (ui.confirm) et envoie des notifications (progression, nouveaux messages).
 */

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (params: unknown) => unknown | Promise<unknown>;

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

const MAX_LINE = 4 * 1024 * 1024;

export class RpcPeer {
  private handlers = new Map<string, Handler>();
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(
    private readonly out: (line: string) => void = (l) => process.stdout.write(l + "\n"),
    input: NodeJS.ReadableStream = process.stdin,
  ) {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on("line", (line) => void this.onLine(line));
    rl.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("connexion fermée"));
      this.pending.clear();
      this.onClose?.();
    });
  }

  onClose?: () => void;

  method(name: string, handler: Handler) {
    this.handlers.set(name, handler);
  }

  notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Appel vers l'app (ex. ui.confirm) ; rejeté si `signal` est annulé. */
  call<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("annulé"));
      const onAbort = () => {
        this.pending.delete(id);
        this.notify("rpc.cancel", { id });
        reject(new Error("annulé"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v as T);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(msg: unknown) {
    this.out(JSON.stringify(msg));
  }

  private async onLine(line: string) {
    if (!line.trim()) return;
    if (line.length > MAX_LINE) {
      this.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "message trop long" } });
      return;
    }
    let msg: { id?: number | string | null; method?: unknown; params?: unknown; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON invalide" } });
      return;
    }

    // Réponse à un de nos appels
    if (msg.method === undefined && typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "erreur"));
      else p.resolve(msg.result);
      return;
    }

    if (typeof msg.method !== "string") {
      this.send({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32600, message: "requête invalide" } });
      return;
    }
    const handler = this.handlers.get(msg.method);
    const isNotification = msg.id === undefined;
    if (!handler) {
      if (!isNotification) this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `méthode inconnue : ${msg.method}` } });
      return;
    }
    try {
      const result = await handler(msg.params ?? {});
      if (!isNotification) this.send({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : -32000;
      if (!isNotification) this.send({ jsonrpc: "2.0", id: msg.id, error: { code, message: (e as Error).message } });
    }
  }
}
