import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS, teamWorkFile, WorkError, WorkStore } from "./work.js";

/** Acteur de test : id dérivé du nom (comme un id de nœud). */
const A = (name: string) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""), name });

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "myia-travail-")), "registre.json");

describe("registre de travail : invariants", () => {
  it("créer attribue un id unique, le statut ouverte, le type tache, les dates et l'auteur", () => {
    const s = new WorkStore(tmp());
    const a = s.create({ title: "  Écrire la page  " }, A("Chef"));
    const b = s.create({ title: "Relire", type: "bug" }, A("Chef"));
    expect(a.id).toMatch(/^t-[a-z0-9]{6}$/);
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ title: "Écrire la page", status: "ouverte", type: "tache", createdBy: "Chef", rev: 1 });
    expect(b.type).toBe("bug");
    expect(Date.parse(a.createdAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("persiste sur le disque et relit un fichier modifié ailleurs", () => {
    const file = tmp();
    const a = new WorkStore(file).create({ title: "Durable" }, A("Chef"));
    const other = new WorkStore(file);
    expect(other.get(a.id).title).toBe("Durable");
    other.note(a.id, "vu", A("Membre"));
    // Le premier lecteur voit la note écrite par le second (relecture sur changement de fichier).
    const first = new WorkStore(file);
    expect(first.get(a.id).notes.map((n) => n.text)).toEqual(["vu"]);
  });

  it("refuse dépendance ou parent inexistants, les cycles, et un parent qui n'est pas un lot", () => {
    const s = new WorkStore(tmp());
    expect(() => s.create({ title: "x", needs: ["t-zzzzzz"] }, A("C"))).toThrow(/introuvable/);
    expect(s.list()).toHaveLength(0); // rien n'a été écrit
    const a = s.create({ title: "A" }, A("C"));
    const b = s.create({ title: "B", needs: [a.id] }, A("C"));
    expect(() => s.update(a.id, { needs: [b.id] })).toThrow(/cycle/);
    expect(() => s.update(a.id, { needs: [a.id] })).toThrow(/elle-même/);
    expect(() => s.create({ title: "C", parent: a.id }, A("C"))).toThrow(/n'est pas un lot/);
    const lot = s.create({ title: "Lot", type: "lot" }, A("C"));
    expect(s.create({ title: "D", parent: lot.id }, A("C")).parent).toBe(lot.id);
  });

  it("prêtes = ouvertes, sans responsable, dépendances fermées ; fermer débloque", () => {
    const s = new WorkStore(tmp());
    const a = s.create({ title: "A" }, A("C"));
    const b = s.create({ title: "B", needs: [a.id] }, A("C"));
    s.create({ title: "Lot", type: "lot" }, A("C"));
    expect(s.ready().map((i) => i.id)).toEqual([a.id]);
    expect(s.blockers(b.id)).toEqual([a.id]);
    expect(() => s.claim(b.id, A("M"))).toThrow(/attend encore/);
    s.close(a.id, "fait, vérifié", A("C"));
    expect(s.ready().map((i) => i.id)).toEqual([b.id]);
    expect(s.blockers(b.id)).toEqual([]);
  });

  it("fermer est idempotent et exige une raison", () => {
    const s = new WorkStore(tmp());
    const a = s.create({ title: "A" }, A("C"));
    expect(() => s.close(a.id, "  ", A("C"))).toThrow(/raison/);
    const c1 = s.close(a.id, "fait", A("C"));
    const c2 = s.close(a.id, "encore", A("C"));
    expect(c2).toEqual(c1);
    expect(c2.closeReason).toBe("fait");
    expect(s.ready()).toHaveLength(0);
  });

  it("étiquettes et notes s'ajoutent sans remplacer", () => {
    const s = new WorkStore(tmp());
    const a = s.create({ title: "A", labels: ["Front"] }, A("C"));
    s.update(a.id, { labels: ["api", "front"] });
    s.note(a.id, "un", A("C"));
    s.note(a.id, "deux", A("M"));
    const got = s.get(a.id);
    expect(got.labels).toEqual(["front", "api"]);
    expect(got.notes.map((n) => [n.by, n.text])).toEqual([
      ["C", "un"],
      ["M", "deux"],
    ]);
    expect(() => s.update(a.id, { labels: ["pas d'espace"] })).toThrow(WorkError);
    expect(s.list({ label: "API" }).map((i) => i.id)).toEqual([a.id]);
  });

  it("prendre une tâche d'un autre est refusé ; révision périmée refusée", () => {
    const s = new WorkStore(tmp());
    const a = s.create({ title: "A" }, A("C"));
    const mine = s.claim(a.id, A("Alice"));
    expect(mine).toMatchObject({ status: "en_cours", assignee: "Alice", rev: 2 });
    expect(s.claim(a.id, A("Alice")).rev).toBe(2); // reprendre la sienne ne change rien
    expect(() => s.claim(a.id, A("Bob"))).toThrow(/déjà prise par Alice/);
    expect(() => s.release(a.id, A("Bob"))).toThrow(/pas par toi/);
    s.release(a.id, A("Alice"));
    expect(() => s.claim(a.id, A("Bob"), 2)).toThrow(/a changé/);
    expect(s.claim(a.id, A("Bob"), 3).assignee).toBe("Bob");
  });

  it("rouvrir remet la tâche dans les prêtes, sans responsable", () => {
    const s = new WorkStore(tmp());
    const a = s.create({ title: "A" }, A("C"));
    s.claim(a.id, A("M"));
    s.close(a.id, "fait", A("M"));
    expect(() => s.claim(a.id, A("M"))).toThrow(/fermée/);
    const r = s.reopen(a.id, "régression", A("C"));
    expect(r).toMatchObject({ status: "ouverte", assignee: undefined, closeReason: undefined });
    expect(s.ready().map((i) => i.id)).toEqual([a.id]);
  });

  it("un fichier illisible est mis de côté, jamais écrasé", () => {
    const file = tmp();
    fs.writeFileSync(file, "{ pas du json");
    const s = new WorkStore(file);
    expect(() => s.list()).toThrow(/mis de côté/);
    const aside = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".corrompu-"));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), aside[0]!), "utf8")).toBe("{ pas du json");
    expect(s.create({ title: "repart" }, A("C")).title).toBe("repart");
  });

  it("borne le nombre de tâches non fermées et de notes", () => {
    const s = new WorkStore(tmp());
    for (let i = 0; i < LIMITS.openItems; i++) s.create({ title: `t${i}` }, A("C"));
    expect(() => s.create({ title: "de trop" }, A("C"))).toThrow(/registre plein/);
    const first = s.list({ limit: 1 })[0]!;
    for (let i = 0; i < LIMITS.notesPerItem + 5; i++) s.note(first.id, `n${i}`, A("C"));
    const notes = s.get(first.id).notes;
    expect(notes).toHaveLength(LIMITS.notesPerItem);
    expect(notes[0]!.text).toBe("n0"); // la note de départ est gardée
    expect(notes.at(-1)!.text).toBe(`n${LIMITS.notesPerItem + 4}`);
  });

  it("le fichier d'une équipe reste dans data/travail", () => {
    expect(teamWorkFile("D:\\data", "mon-equipe")).toBe(path.join("D:\\data", "travail", "equipe-mon-equipe.json"));
    expect(() => teamWorkFile("D:\\data", "../../x")).toThrow(/invalide/);
  });
});
