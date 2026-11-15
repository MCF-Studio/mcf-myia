import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nextOccurrence, Planner, plannerTools, toSchedule, type Job } from "./planner.js";
import { UrlTrust } from "./urls.js";

// Dimanche 15 novembre 2026, 10:00 (heure locale).
const T0 = new Date(2026, 10, 15, 10, 0);
const conv = crypto.randomUUID();

function setup(start = T0) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "myia-plan-")), "planner.json");
  let now = start;
  const fired: { job: Job; text: string }[] = [];
  const state = { busy: false, exists: true };
  const p = new Planner(
    file,
    {
      exists: () => state.exists,
      busy: () => state.busy,
      fire: async (job, text) => void fired.push({ job, text }),
    },
    () => now,
  );
  return { p, file, fired, state, setNow: (d: Date) => (now = d), now: () => now };
}

describe("planification : conversion des arguments", () => {
  it("minuteur : dans N minutes", () => {
    const s = toSchedule({ in_minutes: 20 }, T0);
    expect(s.kind).toBe("once");
    expect(new Date((s as { at: string }).at).getTime()).toBe(T0.getTime() + 20 * 60_000);
  });

  it("at HH:MM : aujourd'hui, ou demain si l'heure est passée", () => {
    expect(new Date((toSchedule({ at: "14:30" }, T0) as { at: string }).at)).toEqual(new Date(2026, 10, 15, 14, 30));
    expect(new Date((toSchedule({ at: "09:00" }, T0) as { at: string }).at)).toEqual(new Date(2026, 10, 16, 9, 0));
  });

  it("at date complète ; refuse le passé, les dates inexistantes et les formats flous", () => {
    expect(new Date((toSchedule({ at: "2026-11-20T08:15" }, T0) as { at: string }).at)).toEqual(new Date(2026, 10, 20, 8, 15));
    expect(() => toSchedule({ at: "2026-11-14T08:15" }, T0)).toThrow(/déjà passé/);
    expect(() => toSchedule({ at: "2026-02-30T08:15" }, T0)).toThrow(/inexistante/);
    expect(() => toSchedule({ at: "demain" }, T0)).toThrow(/invalide/);
    expect(() => toSchedule({ at: "2028-11-20T08:15" }, T0)).toThrow(/un an/);
  });

  it("exactement un mode", () => {
    expect(() => toSchedule({}, T0)).toThrow(/exactement un/);
    expect(() => toSchedule({ in_minutes: 5, at: "14:00" }, T0)).toThrow(/exactement un/);
    expect(() => toSchedule({ days: ["lundi"], in_minutes: 5 }, T0)).toThrow(/days s'utilise avec time/);
  });

  it("time sans days : tous les jours", () => {
    expect(toSchedule({ time: "09:00" }, T0)).toMatchObject({ kind: "weekly", days: expect.arrayContaining(["lundi", "dimanche"]) });
  });
});

describe("planification : prochaine échéance", () => {
  it("jours de la semaine", () => {
    const s = { kind: "weekly" as const, time: "09:00", days: ["lundi" as const, "mercredi" as const] };
    expect(nextOccurrence(s, T0)).toEqual(new Date(2026, 10, 16, 9, 0)); // lundi
    expect(nextOccurrence(s, new Date(2026, 10, 16, 9, 0))).toEqual(new Date(2026, 10, 18, 9, 0)); // mercredi
    expect(nextOccurrence(s, new Date(2026, 10, 18, 12, 0))).toEqual(new Date(2026, 10, 23, 9, 0)); // lundi suivant
  });

  it("même jour, heure pas encore passée", () => {
    expect(nextOccurrence({ kind: "weekly", time: "18:00", days: ["dimanche"] }, T0)).toEqual(new Date(2026, 10, 15, 18, 0));
  });
});

describe("Planner", () => {
  it("déclenche une tâche unique à l'heure puis la retire, et persiste", async () => {
    const { p, file, fired, setNow } = setup();
    p.add(conv, "Rappelle à l'utilisateur de sortir le gâteau", toSchedule({ in_minutes: 10 }, T0));
    await p.tick();
    expect(fired).toHaveLength(0);
    setNow(new Date(T0.getTime() + 10 * 60_000));
    await p.tick();
    expect(fired).toHaveLength(1);
    expect(fired[0]!.text).toContain("sortir le gâteau");
    expect(fired[0]!.text).not.toContain("en retard");
    expect(p.list()).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).jobs).toEqual([]);
  });

  it("récurrent : passe à l'échéance suivante ; en retard après une veille, exécuté une seule fois", async () => {
    const { p, fired, setNow } = setup();
    p.add(conv, "Fais le point sur les tickets", toSchedule({ time: "09:00", days: ["lundi"] }, T0));
    setNow(new Date(2026, 10, 30, 11, 0)); // deux lundis manqués
    await p.tick();
    await p.tick();
    expect(fired).toHaveLength(1);
    expect(fired[0]!.text).toContain("en retard");
    expect(new Date(p.list()[0]!.nextRun)).toEqual(new Date(2026, 11, 7, 9, 0));
    expect(p.list()[0]!.runs).toBe(1);
  });

  it("conversation occupée : attend ; conversation supprimée : tâche retirée", async () => {
    const { p, fired, state, setNow } = setup();
    p.add(conv, "tâche", toSchedule({ in_minutes: 1 }, T0));
    setNow(new Date(T0.getTime() + 60_000));
    state.busy = true;
    await p.tick();
    expect(fired).toHaveLength(0);
    expect(p.list()).toHaveLength(1);
    state.busy = false;
    state.exists = false;
    await p.tick();
    expect(fired).toHaveLength(0);
    expect(p.list()).toHaveLength(0);
  });

  it("relit le fichier ; un fichier abîmé est mis de côté", () => {
    const { p, file } = setup();
    p.add(conv, "tâche", toSchedule({ every_minutes: 30 }, T0));
    expect(new Planner(file, { exists: () => true, busy: () => false, fire: async () => {} }).list()).toHaveLength(1);
    fs.writeFileSync(file, "{pas du json");
    expect(new Planner(file, { exists: () => true, busy: () => false, fire: async () => {} }).list()).toHaveLength(0);
    expect(fs.readdirSync(path.dirname(file)).some((f) => f.includes("abime"))).toBe(true);
  });

  it("un agent n'annule que les tâches de sa conversation", () => {
    const { p } = setup();
    const j = p.add(crypto.randomUUID(), "autre", toSchedule({ in_minutes: 5 }, T0));
    expect(() => p.cancel(j.id.slice(0, 8), conv)).toThrow(/introuvable/);
    expect(p.cancel(j.id.slice(0, 8)).id).toBe(j.id);
  });
});

describe("outils du planificateur", () => {
  it("minuteur demandé par l'utilisateur sans confirmation, récurrence confirmée", () => {
    const { p, now } = setup();
    const add = plannerTools(p, conv, now, () => true).find((t) => t.name === "planner_add")!;
    const trust = new UrlTrust();
    expect(add.confirmIf!(add.parse({ task: "rappel", in_minutes: 5 }), trust)).toBe(false);
    expect(add.confirmIf!(add.parse({ task: "rapport", time: "09:00", days: ["lundi"] }), trust)).toBe(true);
    expect(add.confirmIf!(add.parse({ task: "veille", every_minutes: 60 }), trust)).toBe(true);
  });

  it("pendant une tâche planifiée ou un message d'agent : même un minuteur se confirme (pas d'auto-reprogrammation)", async () => {
    const { p, now } = setup();
    const add = plannerTools(p, conv, now, () => false).find((t) => t.name === "planner_add")!;
    const args = add.parse({ task: "recommence", in_minutes: 5 });
    expect(add.confirmIf!(args, new UrlTrust())).toBe(true);
    expect(await add.preview(args)).toMatch(/pas par toi/);
  });

  it("planifie, liste et annule", async () => {
    const { p, now } = setup();
    const tools = new Map(plannerTools(p, conv, now).map((t) => [t.name, t]));
    const ctx = { ui: { confirm: async () => true, progress: () => undefined }, trust: new UrlTrust() };
    const out = await tools.get("planner_add")!.run(tools.get("planner_add")!.parse({ task: "Reprends la refonte du menu", at: "15:30" }), ctx);
    expect(out).toMatch(/dimanche 15\/11 à 15:30/);
    const list = await tools.get("planner_list")!.run({}, ctx);
    expect(list).toContain("Reprends la refonte du menu");
    const id = p.list()[0]!.id.slice(0, 8);
    await tools.get("planner_cancel")!.run({ id }, ctx);
    expect(p.list()).toHaveLength(0);
  });
});
