import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Registre de travail d'une équipe (docs/TRAVAIL.md) : des tâches durables, hors du contexte du modèle, que les
 * membres prennent, annotent et ferment. Inspiré du modèle des « beads » de Gas City, réécrit pour MyIA.
 *
 * Un registre = un fichier JSON (data/travail/equipe-<id>.json), écrit de façon atomique. Toutes les opérations sont
 * synchrones : dans le sidecar (un seul processus Node), une lecture-modification-écriture ne peut donc pas être
 * entrelacée avec une autre. Le fichier est relu avant chaque opération s'il a changé sur le disque.
 */

export const WORK_TYPES = ["tache", "bug", "decision", "lot"] as const;
export const WORK_STATUSES = ["ouverte", "en_cours", "fermee"] as const;
export type WorkType = (typeof WORK_TYPES)[number];
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const LIMITS = {
  title: 200,
  description: 4000,
  note: 2000,
  notesPerItem: 50,
  labels: 10,
  label: 40,
  needs: 20,
  actor: 60,
  /** Tâches non fermées au plus : au-delà, créer est refusé. */
  openItems: 300,
  /** Tâches au total : au-delà, les plus anciennes fermées sont retirées. */
  totalItems: 2000,
} as const;

const ID = /^t-[a-z0-9]{6}$/;
/**
 * Identité d'un acteur : l'id du nœud de l'équipe pour un agent (unique dans l'équipe, même si deux nœuds ont le même
 * profil ou le même nom), `@utilisateur` pour l'utilisateur. Le nom ne sert qu'à l'affichage.
 */
const ACTOR_ID = /^(@utilisateur|@synchro|[a-z0-9][a-z0-9-]{0,39})$/;
export const USER_ACTOR_ID = "@utilisateur";
/** Changements venus du suivi externe (fournisseur exec:, core/work-sync.ts). */
export const SYNC_ACTOR: Actor = { id: "@synchro", name: "Synchro" };
export interface Actor {
  id: string;
  name: string;
}

const LABEL = /^[\p{L}\p{N}][\p{L}\p{N}:._-]*$/u;

const NoteSchema = z.object({
  at: z.string(),
  by: z.string().min(1).max(LIMITS.actor),
  text: z.string().min(1).max(LIMITS.note),
});
export type WorkNote = z.infer<typeof NoteSchema>;

export const WorkItemSchema = z.object({
  id: z.string().regex(ID),
  title: z.string().min(1).max(LIMITS.title),
  description: z.string().max(LIMITS.description).default(""),
  type: z.enum(WORK_TYPES),
  status: z.enum(WORK_STATUSES),
  /** Nom affiché du responsable ; l'identité, elle, est assigneeId (les comparaisons ne se font que sur l'id). */
  assignee: z.string().min(1).max(LIMITS.actor).optional(),
  assigneeId: z.string().regex(ACTOR_ID).optional(),
  parent: z.string().regex(ID).optional(),
  needs: z.array(z.string().regex(ID)).max(LIMITS.needs).default([]),
  labels: z.array(z.string().max(LIMITS.label)).max(LIMITS.labels).default([]),
  notes: z.array(NoteSchema).max(LIMITS.notesPerItem).default([]),
  createdAt: z.string(),
  createdBy: z.string().min(1).max(LIMITS.actor),
  createdById: z.string().regex(ACTOR_ID),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
  closeReason: z.string().max(LIMITS.note).optional(),
  /** Référence de la tâche dans le suivi externe (« gh#42 »…), posée par la synchronisation seulement. */
  ext: z.string().min(1).max(120).optional(),
  rev: z.number().int().min(1),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

const FileSchema = z.object({ version: z.literal(1), items: z.array(WorkItemSchema) });

export interface NewWork {
  title: string;
  description?: string;
  type?: WorkType;
  parent?: string;
  needs?: string[];
  labels?: string[];
  /** Pris d'office par cet acteur. */
  assignee?: Actor;
}

export interface WorkQuery {
  status?: WorkStatus | "non_fermee";
  assignee?: string;
  label?: string;
  parent?: string;
  /** 0 = sans limite. */
  limit?: number;
}

/** Erreur lisible renvoyée telle quelle à l'agent (pas de pile, pas de chemin). */
export class WorkError extends Error {}

export type WorkChangeKind = "created" | "claimed" | "released" | "noted" | "updated" | "closed" | "reopened";
/** Changement enregistré (après écriture du fichier) : `by` = id de l'acteur quand il est connu. */
export interface WorkChange {
  kind: WorkChangeKind;
  item: WorkItem;
  by?: string;
}

const now = () => new Date().toISOString();

function cleanText(s: string): string {
  // Pas de caractères de contrôle (hors retour à la ligne et tabulation) : ils n'ont rien à faire dans un titre ou une note.
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}

function actor(a: Actor): Actor {
  if (!ACTOR_ID.test(a.id)) throw new WorkError(`acteur invalide : ${a.id}`);
  const name = cleanText(a.name).replace(/\s+/g, " ").slice(0, LIMITS.actor);
  return { id: a.id, name: name || a.id };
}

function cleanLabels(labels: string[]): string[] {
  const out: string[] = [];
  for (const raw of labels) {
    const l = raw.trim().toLowerCase();
    if (!l) continue;
    if (l.length > LIMITS.label || !LABEL.test(l)) throw new WorkError(`étiquette invalide : « ${raw} » (lettres, chiffres, : . _ -)`);
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

export class WorkStore {
  private items: WorkItem[] = [];
  private stamp = "";
  private listeners = new Set<(c: WorkChange) => void>();

  constructor(readonly file: string) {}

  // ─── fichier ────────────────────────────────────────────────────────────────

  private fileStamp(): string {
    try {
      const st = fs.statSync(this.file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "";
    }
  }

  /** Relit le fichier s'il a changé. Un fichier illisible est mis de côté (jamais écrasé) et l'erreur remonte. */
  private load() {
    const stamp = this.fileStamp();
    if (stamp === this.stamp) return;
    if (!stamp) {
      this.items = [];
      this.stamp = "";
      return;
    }
    let parsed: z.infer<typeof FileSchema>;
    try {
      parsed = FileSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      const aside = `${this.file}.corrompu-${now().replace(/[:.]/g, "-")}`;
      try {
        fs.renameSync(this.file, aside);
      } catch {
        /* le renommage a échoué : le fichier reste en place, on n'écrit rien par-dessus */
        throw new WorkError("registre de travail illisible : corrige ou retire le fichier à la main");
      }
      this.items = [];
      this.stamp = "";
      throw new WorkError(`registre de travail illisible : mis de côté (${path.basename(aside)}), un registre vide repart`);
    }
    this.items = parsed.items;
    this.stamp = stamp;
  }

  private save() {
    this.prune();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, this.file);
    this.stamp = this.fileStamp();
  }

  /** Au-delà du plafond, retire les tâches fermées les plus anciennes, sauf celles dont une tâche ouverte dépend. */
  private prune() {
    let excess = this.items.length - LIMITS.totalItems;
    if (excess <= 0) return;
    const needed = new Set(this.items.filter((i) => i.status !== "fermee").flatMap((i) => [...i.needs, ...(i.parent ? [i.parent] : [])]));
    const removable = this.items
      .filter((i) => i.status === "fermee" && !needed.has(i.id))
      .sort((a, b) => (a.closedAt ?? a.updatedAt).localeCompare(b.closedAt ?? b.updatedAt));
    const drop = new Set<string>();
    for (const i of removable) {
      if (excess-- <= 0) break;
      drop.add(i.id);
    }
    this.items = this.items.filter((i) => !drop.has(i.id));
  }

  private mutate<T>(fn: () => T): T {
    this.load();
    const before = structuredClone(this.items);
    try {
      const out = fn();
      this.save();
      return out;
    } catch (e) {
      this.items = before;
      throw e;
    }
  }

  /**
   * Écriture d'une tâche, annoncée aux abonnés seulement si elle a vraiment changé (refermer une tâche fermée, par
   * exemple, n'annonce rien). `id` absent = création.
   */
  private tracked(kind: WorkChangeKind, id: string | undefined, by: Actor | undefined, fn: () => WorkItem): WorkItem {
    this.load();
    const prev = id === undefined ? undefined : this.items.find((i) => i.id === id.trim())?.rev;
    const out = this.mutate(fn);
    if (id === undefined || out.rev !== prev) this.emit(kind, out, by);
    return out;
  }

  /** Abonnement aux changements enregistrés ; rend la fonction de désabonnement. Une erreur d'abonné est ignorée. */
  onChange(fn: (c: WorkChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(kind: WorkChangeKind, item: WorkItem, by?: Actor) {
    for (const fn of this.listeners) {
      try {
        fn({ kind, item: structuredClone(item), by: by?.id });
      } catch {
        /* un abonné en erreur ne doit pas casser l'écriture */
      }
    }
  }

  private find(id: string): WorkItem {
    const item = this.items.find((i) => i.id === id.trim());
    if (!item) throw new WorkError(`tâche introuvable : ${id}`);
    return item;
  }

  private newId(): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    for (;;) {
      const bytes = crypto.randomBytes(6);
      const id = "t-" + [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
      if (!this.items.some((i) => i.id === id)) return id;
    }
  }

  private touch(item: WorkItem) {
    item.updatedAt = now();
    item.rev++;
  }

  /** Vrai si `from` atteint `to` en suivant les dépendances (pour refuser les cycles). */
  private reaches(from: string, to: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(this.items.find((i) => i.id === id)?.needs ?? []));
    }
    return false;
  }

  private checkParent(parent: string | undefined, self?: string) {
    if (!parent) return;
    const p = this.find(parent);
    if (p.type !== "lot") throw new WorkError(`${parent} n'est pas un lot : seul un lot regroupe des tâches`);
    if (parent === self) throw new WorkError("une tâche ne peut pas être son propre lot");
  }

  private addNeeds(item: WorkItem, needs: string[]) {
    for (const raw of needs) {
      const dep = this.find(raw).id;
      if (dep === item.id) throw new WorkError("une tâche ne peut pas dépendre d'elle-même");
      if (item.needs.includes(dep)) continue;
      if (this.reaches(dep, item.id)) throw new WorkError(`dépendance refusée : ${dep} dépend déjà de ${item.id} (cycle)`);
      if (item.needs.length >= LIMITS.needs) throw new WorkError(`au plus ${LIMITS.needs} dépendances par tâche`);
      item.needs.push(dep);
    }
  }

  // ─── lecture ────────────────────────────────────────────────────────────────

  get(id: string): WorkItem {
    this.load();
    return structuredClone(this.find(id));
  }

  list(q: WorkQuery = {}): WorkItem[] {
    this.load();
    const label = q.label?.trim().toLowerCase();
    const out = this.items
      .filter((i) => !q.status || (q.status === "non_fermee" ? i.status !== "fermee" : i.status === q.status))
      .filter((i) => !q.assignee || i.assignee === q.assignee)
      .filter((i) => !label || i.labels.includes(label))
      .filter((i) => !q.parent || i.parent === q.parent)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return structuredClone(q.limit ? out.slice(0, q.limit) : out);
  }

  /** Dépendances encore ouvertes d'une tâche. */
  blockers(id: string): string[] {
    this.load();
    const item = this.find(id);
    return item.needs.filter((d) => this.items.find((i) => i.id === d)?.status !== "fermee");
  }

  /** Tâches prêtes : ouvertes, sans responsable, toutes dépendances fermées. Les lots ne se prennent pas. Plus anciennes d'abord. */
  ready(limit = 0): WorkItem[] {
    this.load();
    const closed = new Set(this.items.filter((i) => i.status === "fermee").map((i) => i.id));
    const out = this.items
      .filter((i) => i.status === "ouverte" && !i.assignee && i.type !== "lot" && i.needs.every((d) => closed.has(d)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return structuredClone(limit ? out.slice(0, limit) : out);
  }

  // ─── écriture ───────────────────────────────────────────────────────────────

  create(input: NewWork, by: Actor): WorkItem {
    return this.tracked("created", undefined, by, () => {
      if (this.items.filter((i) => i.status !== "fermee").length >= LIMITS.openItems) {
        throw new WorkError(`registre plein : ${LIMITS.openItems} tâches non fermées. Ferme ou regroupe avant d'en créer.`);
      }
      // Un titre tient sur une ligne : il est montré dans les prompts, il ne doit pas pouvoir y ouvrir un faux paragraphe.
      const title = cleanText(input.title).replace(/\s+/g, " ").slice(0, LIMITS.title);
      if (!title) throw new WorkError("titre vide");
      this.checkParent(input.parent?.trim() || undefined);
      const t = now();
      const item: WorkItem = WorkItemSchema.parse({
        id: this.newId(),
        title,
        description: cleanText(input.description ?? "").slice(0, LIMITS.description),
        type: input.type ?? "tache",
        status: input.assignee ? "en_cours" : "ouverte",
        assignee: input.assignee ? actor(input.assignee).name : undefined,
        assigneeId: input.assignee ? actor(input.assignee).id : undefined,
        parent: input.parent?.trim() || undefined,
        needs: [],
        labels: cleanLabels(input.labels ?? []),
        notes: [],
        createdAt: t,
        createdBy: actor(by).name,
        createdById: actor(by).id,
        updatedAt: t,
        rev: 1,
      });
      this.items.push(item);
      this.addNeeds(item, input.needs ?? []);
      return structuredClone(item);
    });
  }

  /**
   * Prend une tâche pour `who` : elle passe en cours à son nom. Refusé si elle est fermée, bloquée, ou déjà prise par
   * quelqu'un d'autre. `expectRev` : refuse si la tâche a changé depuis la lecture de l'appelant.
   */
  claim(id: string, who: Actor, expectRev?: number): WorkItem {
    return this.tracked("claimed", id, who, () => {
      const item = this.find(id);
      const me = actor(who);
      if (expectRev !== undefined && item.rev !== expectRev) throw new WorkError(`${item.id} a changé depuis ta lecture : relis-la`);
      if (item.status === "fermee") throw new WorkError(`${item.id} est fermée : rouvre-la d'abord si elle doit reprendre`);
      if (item.type === "lot") throw new WorkError(`${item.id} est un lot : prends une de ses tâches`);
      if (item.assigneeId && item.assigneeId !== me.id) throw new WorkError(`${item.id} est déjà prise par ${item.assignee}`);
      const open = item.needs.filter((d) => this.items.find((i) => i.id === d)?.status !== "fermee");
      if (open.length) throw new WorkError(`${item.id} attend encore : ${open.join(", ")}`);
      if (item.assigneeId === me.id && item.status === "en_cours") return structuredClone(item);
      item.assignee = me.name;
      item.assigneeId = me.id;
      item.status = "en_cours";
      this.touch(item);
      return structuredClone(item);
    });
  }

  /** Rend une tâche (elle redevient prête). Seul son responsable ou l'utilisateur (`force`) peut la rendre. */
  release(id: string, who: Actor, force = false): WorkItem {
    return this.tracked("released", id, who, () => {
      const item = this.find(id);
      if (item.status === "fermee") throw new WorkError(`${item.id} est fermée`);
      if (!force && item.assigneeId && item.assigneeId !== actor(who).id) throw new WorkError(`${item.id} est prise par ${item.assignee}, pas par toi`);
      item.assignee = undefined;
      item.assigneeId = undefined;
      item.status = "ouverte";
      this.touch(item);
      return structuredClone(item);
    });
  }

  note(id: string, text: string, by: Actor): WorkItem {
    return this.tracked("noted", id, by, () => {
      const item = this.find(id);
      const t = cleanText(text);
      if (!t) throw new WorkError("note vide");
      if (item.notes.length >= LIMITS.notesPerItem) {
        // On garde la première note (le contexte de départ) et les plus récentes.
        item.notes.splice(1, 1);
      }
      item.notes.push({ at: now(), by: actor(by).name, text: t.slice(0, LIMITS.note) });
      this.touch(item);
      return structuredClone(item);
    });
  }

  /** Ajoute des étiquettes ou des dépendances, change de lot. Rien n'est jamais retiré par ici. */
  update(id: string, change: { labels?: string[]; needs?: string[]; parent?: string; description?: string }): WorkItem {
    return this.tracked("updated", id, undefined, () => {
      const item = this.find(id);
      if (change.labels?.length) {
        const merged = [...new Set([...item.labels, ...cleanLabels(change.labels)])];
        if (merged.length > LIMITS.labels) throw new WorkError(`au plus ${LIMITS.labels} étiquettes par tâche`);
        item.labels = merged;
      }
      if (change.needs?.length) this.addNeeds(item, change.needs);
      if (change.parent !== undefined) {
        const p = change.parent.trim() || undefined;
        this.checkParent(p, item.id);
        item.parent = p;
      }
      if (change.description !== undefined) item.description = cleanText(change.description).slice(0, LIMITS.description);
      this.touch(item);
      return structuredClone(item);
    });
  }

  /** Ferme une tâche avec une raison. Idempotent : refermer une tâche fermée ne change rien. */
  close(id: string, reason: string, by: Actor): WorkItem {
    return this.tracked("closed", id, by, () => {
      const item = this.find(id);
      if (item.status === "fermee") return structuredClone(item);
      const r = cleanText(reason);
      if (!r) throw new WorkError("une raison est nécessaire pour fermer (ce qui est fait, ou pourquoi on abandonne)");
      item.status = "fermee";
      item.closedAt = now();
      item.closeReason = r.slice(0, LIMITS.note);
      item.notes.push({ at: item.closedAt, by: actor(by).name, text: `Fermée : ${item.closeReason}` });
      if (item.notes.length > LIMITS.notesPerItem) item.notes.splice(1, 1);
      this.touch(item);
      return structuredClone(item);
    });
  }

  reopen(id: string, reason: string, by: Actor): WorkItem {
    return this.tracked("reopened", id, by, () => {
      const item = this.find(id);
      if (item.status !== "fermee") return structuredClone(item);
      if (this.items.filter((i) => i.status !== "fermee").length >= LIMITS.openItems) throw new WorkError("registre plein");
      item.status = "ouverte";
      item.assignee = undefined;
      item.assigneeId = undefined;
      item.closedAt = undefined;
      item.closeReason = undefined;
      item.notes.push({ at: now(), by: actor(by).name, text: `Rouverte : ${cleanText(reason) || "(sans raison)"}` });
      if (item.notes.length > LIMITS.notesPerItem) item.notes.splice(1, 1);
      this.touch(item);
      return structuredClone(item);
    });
  }

  // ─── synchronisation (core/work-sync.ts) ─────────────────────────────────────

  /** Tâche liée à une référence externe. */
  byExt(ref: string): WorkItem | undefined {
    this.load();
    const it = this.items.find((i) => i.ext === ref);
    return it ? structuredClone(it) : undefined;
  }

  /** Lie une tâche à sa référence externe (sans l'annoncer : ce n'est pas un changement du travail). */
  setExt(id: string, ref: string): void {
    const r = cleanText(ref).replace(/\s+/g, " ").slice(0, 120);
    if (!r) throw new WorkError("référence externe vide");
    this.mutate(() => {
      const other = this.items.find((i) => i.ext === r && i.id !== id.trim());
      if (other) throw new WorkError(`référence ${r} déjà liée à ${other.id}`);
      this.find(id).ext = r;
    });
  }
}

/** Fichier du registre d'une équipe. L'id est revalidé ici : il ne peut pas sortir du dossier. */
export function teamWorkFile(dataDir: string, teamId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(teamId)) throw new WorkError(`id d'équipe invalide : ${teamId}`);
  return path.join(dataDir, "travail", `equipe-${teamId}.json`);
}

/** Une instance par fichier (partagée entre les conversations d'une même équipe). */
const stores = new Map<string, WorkStore>();
export function workStoreFor(file: string): WorkStore {
  const key = path.resolve(file);
  let s = stores.get(key);
  if (!s) {
    s = new WorkStore(key);
    stores.set(key, s);
  }
  return s;
}
