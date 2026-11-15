import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import { writeJsonAtomic } from "./profiles.js";
import { defineTool, type Tool } from "./types.js";

/**
 * Planificateur : minuteurs, rendez-vous et tâches récurrentes des agents (SPEC §2 bis).
 *
 * Une tâche appartient à UNE conversation. À l'heure dite, son texte est envoyé dans cette conversation comme un
 * message du « Planificateur » : l'agent le traite comme une demande, avec ses règles de confirmation habituelles
 * (liens du message non fiables, comme un message d'un autre agent). Heures en heure locale de la machine.
 * Stockage : data/planner.json (écriture atomique). App fermée ou PC en veille : une échéance manquée est exécutée
 * une seule fois au retour, marquée « en retard », puis la suivante est calculée à partir de maintenant.
 */

export const DAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"] as const;
export type Day = (typeof DAYS)[number];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)$/;

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_PER_CONVERSATION = 30;
export const MAX_TOTAL = 200;
const MAX_AHEAD_MS = 366 * 24 * 3600_000;

export const ScheduleSchema = z.discriminatedUnion("kind", [
  /** Une seule fois, à une date précise (ISO, avec fuseau). */
  z.object({ kind: z.literal("once"), at: z.iso.datetime({ offset: true }) }),
  /** Chaque jour listé, à l'heure dite (heure locale). */
  z.object({ kind: z.literal("weekly"), time: z.string().regex(HHMM), days: z.array(z.enum(DAYS)).min(1).max(7) }),
  /** Toutes les N minutes. */
  z.object({ kind: z.literal("interval"), minutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(7 * 24 * 60) }),
]);
export type Schedule = z.infer<typeof ScheduleSchema>;

export const JobSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  task: z.string().min(1).max(2000),
  schedule: ScheduleSchema,
  nextRun: z.iso.datetime({ offset: true }),
  createdAt: z.string(),
  lastRun: z.string().optional(),
  runs: z.number().int().min(0).default(0),
});
export type Job = z.infer<typeof JobSchema>;

const FileSchema = z.object({ jobs: z.array(JobSchema).default([]) });

/** Index lundi=0 … dimanche=6 (getDay() : dimanche=0). */
const dayIndex = (d: Date) => (d.getDay() + 6) % 7;

const pad = (n: number) => String(n).padStart(2, "0");

/** Date ISO avec le décalage local (lisible dans le fichier et par le modèle). */
export function localIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

/** « 16/11 14:30 » ou « lun. 16/11 14:30 ». */
export function human(d: Date): string {
  return `${DAYS[dayIndex(d)]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)} à ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Prochaine échéance strictement après `after` (undefined pour une tâche unique déjà passée). */
export function nextOccurrence(s: Schedule, after: Date): Date | undefined {
  if (s.kind === "once") {
    const at = new Date(s.at);
    return at > after ? at : undefined;
  }
  if (s.kind === "interval") return new Date(after.getTime() + s.minutes * 60_000);
  const [h, m] = s.time.split(":").map(Number) as [number, number];
  for (let i = 0; i <= 7; i++) {
    // new Date(y, m, d + i, h, m) : heure locale, changements d'heure gérés par le moteur.
    const c = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i, h, m, 0, 0);
    if (c > after && s.days.includes(DAYS[dayIndex(c)]!)) return c;
  }
  return undefined;
}

export function describeSchedule(s: Schedule): string {
  if (s.kind === "once") return `le ${human(new Date(s.at))}`;
  if (s.kind === "interval") return s.minutes % 60 === 0 ? `toutes les ${s.minutes / 60} h` : `toutes les ${s.minutes} min`;
  const days = s.days.length === 7 ? "tous les jours" : s.days.length === 5 && !s.days.includes("samedi") && !s.days.includes("dimanche") ? "en semaine" : `le ${s.days.join(", ")}`;
  return `${days} à ${s.time}`;
}

/** Arguments simples pour les petits modèles : un seul mode parmi in_minutes, at, time (+ days), every_minutes. */
export const AddArgs = z.object({
  task: z
    .string()
    .trim()
    .min(3)
    .max(2000)
    .describe("Ce que tu devras faire à l'échéance, écrit comme une consigne complète et autonome (tu la recevras telle quelle)"),
  in_minutes: z.number().int().min(1).max(7 * 24 * 60).optional().describe("Minuteur : dans N minutes"),
  at: z.string().optional().describe("Une seule fois : « YYYY-MM-DDTHH:MM » ou « HH:MM » (aujourd'hui, ou demain si l'heure est passée)"),
  time: z.string().optional().describe("Récurrent : heure « HH:MM », chaque jour de `days`"),
  days: z.array(z.enum(DAYS)).max(7).optional().describe("Jours pour `time` (défaut : tous les jours)"),
  every_minutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(7 * 24 * 60).optional().describe(`Récurrent : toutes les N minutes (${MIN_INTERVAL_MINUTES} au moins)`),
});
export type AddArgs = z.infer<typeof AddArgs>;

/** Convertit les arguments du modèle en planification (lève une erreur lisible). */
export function toSchedule(a: Omit<AddArgs, "task">, now: Date): Schedule {
  const modes = [a.in_minutes !== undefined, a.at !== undefined, a.time !== undefined, a.every_minutes !== undefined].filter(Boolean).length;
  if (modes !== 1) throw new Error("donne exactement un de : in_minutes (minuteur), at (date et heure), time (+ days, récurrent), every_minutes (intervalle)");
  if (a.days && a.time === undefined) throw new Error("days s'utilise avec time (ex. time « 09:00 », days [« lundi »])");
  if (a.in_minutes !== undefined) return { kind: "once", at: localIso(new Date(now.getTime() + a.in_minutes * 60_000)) };
  if (a.every_minutes !== undefined) return { kind: "interval", minutes: a.every_minutes };
  if (a.time !== undefined) {
    if (!HHMM.test(a.time)) throw new Error(`heure invalide « ${a.time} » : format HH:MM (ex. 09:30)`);
    return { kind: "weekly", time: a.time, days: a.days?.length ? [...new Set(a.days)] : [...DAYS] };
  }
  const at = a.at!.trim();
  let when: Date;
  if (HHMM.test(at)) {
    const [h, m] = at.split(":").map(Number) as [number, number];
    when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    if (when <= now) when = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h, m);
  } else {
    const p = DATETIME.exec(at);
    if (!p) throw new Error(`date invalide « ${at} » : format YYYY-MM-DDTHH:MM (ex. 2026-11-16T14:30) ou HH:MM`);
    when = new Date(Number(p[1]), Number(p[2]) - 1, Number(p[3]), Number(p[4]), Number(p[5]));
    if (when.getMonth() !== Number(p[2]) - 1 || when.getDate() !== Number(p[3])) throw new Error(`date inexistante « ${at} »`);
    if (when <= now) throw new Error(`« ${at} » est déjà passé (nous sommes le ${human(now)})`);
  }
  if (when.getTime() - now.getTime() > MAX_AHEAD_MS) throw new Error("un an au plus à l'avance");
  return { kind: "once", at: localIso(when) };
}

export interface PlannerHooks {
  /** La conversation existe-t-elle encore ? */
  exists(conversationId: string): boolean;
  /** Un agent répond déjà dans cette conversation : on réessaie au prochain passage. */
  busy(conversationId: string): boolean;
  /** Envoie la tâche dans la conversation (résultat ignoré : la réponse s'affiche dans la conversation). */
  fire(job: Job, text: string): Promise<void>;
  /** La liste a changé (pour l'interface). */
  changed?(): void;
}

export class Planner {
  private jobs: Job[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private readonly firing = new Set<string>();

  constructor(
    private readonly file: string,
    private readonly hooks: PlannerHooks,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.load();
  }

  private load() {
    if (!fs.existsSync(this.file)) return;
    try {
      this.jobs = FileSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8"))).jobs;
    } catch (e) {
      // Fichier abîmé : mis de côté (jamais écrasé sans trace), on repart d'une liste vide.
      const bad = `${this.file}.abime-${Date.now()}`;
      fs.renameSync(this.file, bad);
      console.warn(`[planificateur] ${this.file} illisible (${(e as Error).message}), mis de côté : ${bad}`);
      this.jobs = [];
    }
  }

  private save() {
    writeJsonAtomic(this.file, { jobs: this.jobs });
    this.hooks.changed?.();
  }

  list(conversationId?: string): Job[] {
    return this.jobs.filter((j) => !conversationId || j.conversationId === conversationId).sort((a, b) => a.nextRun.localeCompare(b.nextRun));
  }

  add(conversationId: string, task: string, schedule: Schedule): Job {
    if (this.jobs.length >= MAX_TOTAL) throw new Error(`${MAX_TOTAL} tâches planifiées au plus : annule-en d'abord`);
    if (this.list(conversationId).length >= MAX_PER_CONVERSATION) throw new Error(`${MAX_PER_CONVERSATION} tâches planifiées au plus par conversation`);
    const next = nextOccurrence(schedule, this.now());
    if (!next) throw new Error("cette échéance est déjà passée");
    const job = JobSchema.parse({
      id: crypto.randomUUID(),
      conversationId,
      task,
      schedule,
      nextRun: localIso(next),
      createdAt: localIso(this.now()),
      runs: 0,
    });
    this.jobs.push(job);
    this.save();
    return job;
  }

  /** Annule une tâche ; limitée à une conversation si `conversationId` est donné (un agent n'annule que les siennes). */
  cancel(id: string, conversationId?: string): Job {
    const found = this.jobs.filter((j) => j.id.startsWith(id) && (!conversationId || j.conversationId === conversationId));
    if (found.length > 1) throw new Error(`plusieurs tâches commencent par ${id} : donne l'identifiant complet`);
    const job = found[0];
    if (!job) throw new Error(`tâche planifiée introuvable : ${id}`);
    this.jobs = this.jobs.filter((j) => j !== job);
    this.save();
    return job;
  }

  removeConversation(conversationId: string) {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.conversationId !== conversationId);
    if (this.jobs.length !== before) this.save();
  }

  start(everyMs = 20_000) {
    this.stop();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Déclenche les tâches échues. L'échéance suivante est enregistrée AVANT l'envoi : un plantage ne rejoue rien. */
  async tick(): Promise<void> {
    const now = this.now();
    const fired: Promise<void>[] = [];
    let dirty = false;
    for (const job of [...this.jobs]) {
      const due = new Date(job.nextRun);
      if (due > now || this.firing.has(job.id)) continue;
      if (!this.hooks.exists(job.conversationId)) {
        this.jobs = this.jobs.filter((j) => j !== job);
        dirty = true;
        continue;
      }
      if (this.hooks.busy(job.conversationId)) continue;

      const late = now.getTime() - due.getTime() > 2 * 60_000;
      const next = job.schedule.kind === "once" ? undefined : nextOccurrence(job.schedule, now);
      if (next) Object.assign(job, { nextRun: localIso(next), lastRun: localIso(now), runs: job.runs + 1 });
      else this.jobs = this.jobs.filter((j) => j !== job);
      dirty = true;

      const head =
        `[Tâche planifiée ${describeSchedule(job.schedule)}${late ? ` — prévue le ${human(due)}, exécutée en retard (MyIA était fermé ou le PC en veille)` : ""}]` +
        (next ? ` (prochaine : ${human(next)})` : "");
      this.firing.add(job.id);
      fired.push(
        this.hooks
          .fire(job, `${head}\n${job.task}`)
          .catch((e) => console.warn(`[planificateur] ${job.id} : ${(e as Error).message}`))
          .finally(() => this.firing.delete(job.id)),
      );
    }
    if (dirty) this.save();
    await Promise.all(fired);
  }
}

function line(j: Job): string {
  return `- ${j.id.slice(0, 8)} · ${describeSchedule(j.schedule)} · prochaine : ${human(new Date(j.nextRun))} · ${j.task.replace(/\s+/g, " ").slice(0, 160)}`;
}

/** Outils du planificateur pour l'agent d'UNE conversation. */
export function plannerTools(planner: Planner, conversationId: string, now: () => Date = () => new Date()): Tool[] {
  return [
    defineTool({
      name: "planner_add",
      description:
        "Planifie une tâche que TU exécuteras plus tard dans cette conversation : minuteur (« dans 20 minutes »), rendez-vous " +
        "(« demain à 14h », « reprends à 15h30 »), récurrence (« chaque lundi à 9h », « toutes les 2 heures »). À l'échéance, tu " +
        "reçois `task` comme une demande et tu la traites avec tes outils. Pour « reprends à telle heure », écris dans `task` où " +
        "tu en étais et ce qu'il reste à faire. Pour un simple rappel, écris le rappel à transmettre. Heures locales.",
      schema: AddArgs,
      // Une tâche unique (minuteur, rendez-vous) s'ajoute directement ; une tâche récurrente se confirme.
      risk: "local",
      confirmIf: (a) => a.time !== undefined || a.every_minutes !== undefined,
      check: (a) => void toSchedule(a, now()),
      preview: (a) => {
        const s = toSchedule(a, now());
        return `Tâche récurrente ${describeSchedule(s)} :\n${a.task}`;
      },
      async run(a) {
        const job = planner.add(conversationId, a.task, toSchedule(a, now()));
        return `Planifié (${job.id.slice(0, 8)}) ${describeSchedule(job.schedule)} ; prochaine exécution : ${human(new Date(job.nextRun))}.`;
      },
    }),
    defineTool({
      name: "planner_list",
      description: "Liste les tâches planifiées de cette conversation (minuteurs, rendez-vous, récurrences) avec leur identifiant.",
      schema: z.object({}),
      risk: "read",
      preview: () => "Lister les tâches planifiées",
      async run() {
        const jobs = planner.list(conversationId);
        return jobs.length ? `Nous sommes le ${human(now())}.\n${jobs.map(line).join("\n")}` : "Aucune tâche planifiée dans cette conversation.";
      },
    }),
    defineTool({
      name: "planner_cancel",
      description: "Annule une tâche planifiée de cette conversation (identifiant donné par planner_list, les 8 premiers caractères suffisent).",
      schema: z.object({ id: z.string().trim().min(8).max(36) }),
      risk: "local",
      confirmIf: () => false, // annuler ne fait rien d'autre que retirer la tâche
      preview: (a) => `Annuler la tâche planifiée ${a.id}`,
      async run(a) {
        const j = planner.cancel(a.id, conversationId);
        return `Annulée : ${describeSchedule(j.schedule)} · ${j.task.slice(0, 120)}`;
      },
    }),
  ];
}
