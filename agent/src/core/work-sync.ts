import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SYNC_ACTOR, WorkError, type WorkChange, type WorkItem, type WorkStore } from "./work.js";

/**
 * Fournisseur `exec:<script>` du registre de travail (docs/TRAVAIL.md §7, étape 4) : synchronise le registre d'une
 * équipe avec un autre outil de suivi (GitHub Issues, bd, Jira…) par un script de l'utilisateur.
 *
 * Le registre local reste la référence : ses invariants, ses permissions et ses tests ne dépendent pas du script.
 * Le script reçoit les changements (`push`) et peut renvoyer ceux du suivi externe (`pull`), appliqués par les
 * méthodes ordinaires du registre au nom de « Synchro ». Tout passe par l'entrée et la sortie standard en JSON :
 * jamais par la ligne de commande ni par un shell, un titre écrit par un agent ne peut donc pas devenir une commande.
 */

export const SYNC_LIMITS = {
  /** Changements en attente d'envoi par équipe (au-delà, les plus anciens sont oubliés et c'est journalisé). */
  outbox: 500,
  /** Changements envoyés par appel du script. */
  batch: 100,
  /** Changements acceptés par `pull`. */
  pull: 100,
  stdout: 1024 * 1024,
  stderr: 8 * 1024,
} as const;

export interface ExecProvider {
  kind: "exec";
  script: string;
  timeoutMs: number;
  pullMs: number;
}
export type WorkProvider = { kind: "file" } | ExecProvider;

const SCRIPT_EXT = [".exe", ".cmd", ".bat", ".ps1", ".py", ".js", ".mjs"] as const;

/**
 * Lit `work.provider` de config/agent.json : « file » (défaut) ou « exec:<chemin absolu du script> ». Le chemin ne
 * vient que de ce fichier, que les agents ne peuvent pas modifier (config fermée, core/access.ts).
 */
export function parseProvider(work: { provider?: string; timeoutSeconds?: number; pullMinutes?: number } | undefined): WorkProvider {
  const raw = (work?.provider ?? "").trim();
  if (!raw || raw === "file") return { kind: "file" };
  if (!raw.startsWith("exec:")) throw new WorkError(`fournisseur du registre inconnu : ${raw} (file ou exec:<script>)`);
  const script = raw.slice(5).trim();
  if (!path.isAbsolute(script)) throw new WorkError("exec: le chemin du script doit être absolu");
  // Caractères qui changent de sens pour cmd.exe : refusés, le chemin est passé tel quel à un .cmd/.bat.
  if (/["%^&|<>!\r\n]/.test(script)) throw new WorkError("exec: caractère interdit dans le chemin du script");
  const ext = path.extname(script).toLowerCase();
  if (!(SCRIPT_EXT as readonly string[]).includes(ext)) throw new WorkError(`exec: type de script non pris en charge (${SCRIPT_EXT.join(", ")})`);
  return {
    kind: "exec",
    script,
    timeoutMs: Math.min(300, Math.max(5, work?.timeoutSeconds ?? 30)) * 1000,
    pullMs: Math.min(1440, Math.max(0, work?.pullMinutes ?? 0)) * 60_000,
  };
}

/** Programme et arguments pour lancer le script, sans shell. `op` est un mot fixe (push / pull). */
export function launchSpec(script: string, op: "push" | "pull"): { file: string; args: string[]; verbatim?: boolean } {
  const ext = path.extname(script).toLowerCase();
  switch (ext) {
    case ".exe":
      return { file: script, args: [op] };
    case ".cmd":
    case ".bat":
      // cmd.exe est obligatoire pour un .cmd ; le chemin a été filtré (parseProvider), l'opération est un mot fixe.
      return { file: "cmd.exe", args: ["/d", "/s", "/c", `""${script}" ${op}"`], verbatim: true };
    case ".ps1":
      return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, op] };
    case ".py":
      return { file: process.platform === "win32" ? "py" : "python3", args: [...(process.platform === "win32" ? ["-3"] : []), script, op] };
    default: {
      const node = /^node(\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : "node";
      return { file: node, args: [script, op] };
    }
  }
}

/** Environnement du script : celui du cœur sans ce qui ressemble à un secret (clés, jetons, mots de passe). */
export function scriptEnv(base: NodeJS.ProcessEnv, teamId: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!/KEY|TOKEN|SECRET|PASSW|CREDENTIAL|COOKIE/i.test(k)) out[k] = v;
  out.MYIA_TEAM = teamId;
  return out;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type Runner = (op: "push" | "pull", input: string) => Promise<RunResult>;

/** Lance le script avec `input` sur l'entrée standard ; sortie bornée, arrêté au bout du délai. */
export function execRunner(p: ExecProvider, teamId: string): Runner {
  return (op, input) =>
    new Promise((resolve) => {
      const spec = launchSpec(p.script, op);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let done = false;
      const finish = (code: number | null, extra = "") => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr: (stderr + extra).slice(0, SYNC_LIMITS.stderr), timedOut });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(spec.file, spec.args, {
          cwd: path.dirname(p.script),
          env: scriptEnv(process.env, teamId),
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: spec.verbatim ?? false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e) {
        resolve({ code: null, stdout: "", stderr: (e as Error).message, timedOut: false });
        return;
      }
      // Délai dépassé : on arrête le script et on attend sa fin réelle (2 s au plus) avant de rendre la main.
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        setTimeout(() => finish(null), 2000).unref();
      }, p.timeoutMs);
      child.stdout!.on("data", (b: Buffer) => {
        stdout += b.toString("utf8");
        if (stdout.length > SYNC_LIMITS.stdout) {
          child.kill();
          finish(null, "\nsortie trop longue (1 Mo max)");
        }
      });
      child.stderr!.on("data", (b: Buffer) => {
        if (stderr.length < SYNC_LIMITS.stderr) stderr += b.toString("utf8");
      });
      child.on("error", (e) => finish(null, e.message));
      child.on("close", (code) => finish(code));
      child.stdin!.on("error", () => undefined); // script qui ne lit pas son entrée
      child.stdin!.end(input);
    });
}

// ─── protocole ────────────────────────────────────────────────────────────────

/** Ce que le script reçoit d'une tâche (pas les ids internes des acteurs). */
export function publicItem(i: WorkItem) {
  return {
    id: i.id,
    ext: i.ext,
    title: i.title,
    description: i.description,
    type: i.type,
    status: i.status,
    assignee: i.assignee,
    parent: i.parent,
    needs: i.needs,
    labels: i.labels,
    lastNote: i.notes.at(-1),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    closedAt: i.closedAt,
    closeReason: i.closeReason,
    rev: i.rev,
  };
}

const EXT = z.string().trim().min(1).max(120);
const Target = { id: z.string().regex(/^t-[a-z0-9]{6}$/).optional(), ext: EXT.optional() };
const PullChange = z
  .discriminatedUnion("op", [
    z.object({
      op: z.literal("create"),
      ext: EXT,
      title: z.string().min(1).max(200),
      description: z.string().max(4000).optional(),
      // Pas de « decision » ni de « lot » depuis l'extérieur : seuls l'utilisateur et les agents structurent le travail.
      type: z.enum(["tache", "bug"]).optional(),
      labels: z.array(z.string().max(40)).max(8).optional(),
    }),
    z.object({ op: z.literal("note"), text: z.string().min(1).max(2000), ...Target }),
    z.object({ op: z.literal("close"), reason: z.string().min(1).max(2000), ...Target }),
    z.object({ op: z.literal("reopen"), reason: z.string().min(1).max(2000), ...Target }),
  ])
  .refine((c) => c.op === "create" || c.id || c.ext, "id ou ext requis");
const PushReply = z.object({ refs: z.record(z.string().regex(/^t-[a-z0-9]{6}$/), EXT).optional() }).passthrough();
const PullReply = z.object({ changes: z.array(z.unknown()).max(SYNC_LIMITS.pull).default([]) }).passthrough();

function parseReply<S extends z.ZodType>(schema: S, stdout: string): z.infer<S> {
  const text = stdout.trim();
  if (!text) return schema.parse({});
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new WorkError("réponse du script illisible (un objet JSON attendu sur la sortie standard)");
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new WorkError(`réponse du script invalide : ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" ; ")}`);
  return r.data;
}

export interface SyncReport {
  ok: boolean;
  sent?: number;
  applied?: number;
  skipped?: number;
  error?: string;
}

export interface WorkSyncOptions {
  teamId: string;
  store: WorkStore;
  run: Runner;
  /** Fichier des changements en attente (survit à un redémarrage). */
  outboxFile: string;
  log?: (event: { op: "push" | "pull"; ok: boolean; error?: string; sent?: number; applied?: number; skipped?: number; dropped?: number }) => void;
  /** Délai de regroupement des changements avant l'envoi (ms). */
  debounceMs?: number;
}

/**
 * Synchronisation d'un registre : les changements sont mis en attente (fichier), envoyés par lots au script, et
 * gardés tant que le script échoue (nouvel essai au changement suivant ou au prochain `pull`). Une seule exécution du
 * script à la fois par équipe. Les changements faits par la synchronisation elle-même ne sont pas renvoyés.
 */
export class WorkSync {
  private outbox: { kind: string; at: string; item: ReturnType<typeof publicItem> }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private unsubscribe: () => void;

  constructor(private o: WorkSyncOptions) {
    try {
      const raw = JSON.parse(fs.readFileSync(o.outboxFile, "utf8"));
      if (Array.isArray(raw?.events)) this.outbox = raw.events.slice(-SYNC_LIMITS.outbox);
    } catch {
      /* pas de changements en attente */
    }
    this.unsubscribe = o.store.onChange((c) => this.onChange(c));
  }

  stop() {
    this.unsubscribe();
    clearTimeout(this.timer);
  }

  pending(): number {
    return this.outbox.length;
  }

  private onChange(c: WorkChange) {
    if (c.by === SYNC_ACTOR.id) return;
    this.outbox.push({ kind: c.kind, at: new Date().toISOString(), item: publicItem(c.item) });
    let dropped = 0;
    while (this.outbox.length > SYNC_LIMITS.outbox) {
      this.outbox.shift();
      dropped++;
    }
    if (dropped) this.o.log?.({ op: "push", ok: false, error: "file d'attente pleine", dropped });
    this.persist();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.push(), this.o.debounceMs ?? 2000);
  }

  private persist() {
    try {
      fs.mkdirSync(path.dirname(this.o.outboxFile), { recursive: true });
      const tmp = `${this.o.outboxFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, events: this.outbox }) + "\n", "utf8");
      fs.renameSync(tmp, this.o.outboxFile);
    } catch {
      /* la file reste en mémoire ; nouvel essai au prochain changement */
    }
  }

  /** Une exécution du script à la fois : les appels suivants attendent la fin du précédent. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Envoie les changements en attente. */
  push(): Promise<SyncReport> {
    return this.serial(async () => {
      let sent = 0;
      while (this.outbox.length) {
        const batch = this.outbox.slice(0, SYNC_LIMITS.batch);
        const input = JSON.stringify({ version: 1, op: "push", team: this.o.teamId, events: batch });
        const r = await this.o.run("push", input);
        try {
          if (r.timedOut) throw new WorkError("le script n'a pas répondu à temps");
          if (r.code !== 0) throw new WorkError(`le script a échoué (code ${r.code ?? "?"}) : ${r.stderr.trim().slice(0, 300)}`);
          const reply = parseReply(PushReply, r.stdout);
          for (const [id, ref] of Object.entries(reply.refs ?? {})) {
            try {
              this.o.store.setExt(id, ref);
            } catch {
              /* tâche retirée entre-temps ou référence en double : ignorée */
            }
          }
        } catch (e) {
          const error = (e as Error).message;
          this.o.log?.({ op: "push", ok: false, error, sent });
          return { ok: false, sent, error };
        }
        this.outbox.splice(0, batch.length);
        sent += batch.length;
        this.persist();
      }
      if (sent) this.o.log?.({ op: "push", ok: true, sent });
      return { ok: true, sent };
    });
  }

  /**
   * Demande au script les changements du suivi externe et les applique au nom de « Synchro ». Un changement invalide
   * ou refusé par le registre (tâche inconnue, registre plein…) est compté et ignoré, les autres passent.
   */
  pull(): Promise<SyncReport> {
    const pushed = this.outbox.length ? this.push() : Promise.resolve(undefined);
    return pushed.then(() =>
      this.serial(async () => {
        const known = this.o.store
          .list({})
          .filter((i) => i.ext || i.status !== "fermee")
          .slice(0, 1000)
          .map((i) => ({ id: i.id, ext: i.ext, status: i.status, rev: i.rev, title: i.title }));
        const r = await this.o.run("pull", JSON.stringify({ version: 1, op: "pull", team: this.o.teamId, items: known }));
        let changes: unknown[];
        try {
          if (r.timedOut) throw new WorkError("le script n'a pas répondu à temps");
          if (r.code !== 0) throw new WorkError(`le script a échoué (code ${r.code ?? "?"}) : ${r.stderr.trim().slice(0, 300)}`);
          changes = parseReply(PullReply, r.stdout).changes;
        } catch (e) {
          const error = (e as Error).message;
          this.o.log?.({ op: "pull", ok: false, error });
          return { ok: false, error };
        }
        let applied = 0;
        let skipped = 0;
        for (const raw of changes) {
          const c = PullChange.safeParse(raw);
          if (!c.success || !this.apply(c.data)) skipped++;
          else applied++;
        }
        this.o.log?.({ op: "pull", ok: true, applied, skipped });
        return { ok: true, applied, skipped };
      }),
    );
  }

  private apply(c: z.infer<typeof PullChange>): boolean {
    const s = this.o.store;
    try {
      if (c.op === "create") {
        if (s.byExt(c.ext.trim())) return false; // déjà importée
        const item = s.create(
          { title: c.title, description: c.description, type: c.type ?? "tache", labels: [...(c.labels ?? []), "externe"] },
          SYNC_ACTOR,
        );
        s.setExt(item.id, c.ext);
        return true;
      }
      const target = c.id ? s.get(c.id) : s.byExt(c.ext!.trim());
      if (!target) return false;
      if (c.op === "note") s.note(target.id, c.text, SYNC_ACTOR);
      else if (c.op === "close") s.close(target.id, c.reason, SYNC_ACTOR);
      else s.reopen(target.id, c.reason, SYNC_ACTOR);
      return true;
    } catch {
      return false;
    }
  }
}
