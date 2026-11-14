import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileWriteService } from "../services/file-write.js";
import { checkCoordination, usableCoordination } from "./access.js";
import { Agent, needsConfirmation } from "./agent.js";
import { parseConfig } from "./config.js";
import { initCoordination } from "./coordination.js";
import { paths } from "./paths.js";
import { exportWorkflow } from "./workflow.js";

const cfg = parseConfig({});
const write = fileWriteService(cfg).tools().find((t) => t.name === "file_write")!;

let root: string;
let coord: string;
let ws: string;
beforeEach(() => {
  fs.mkdirSync(paths.workspace, { recursive: true }); // absent d'un dépôt fraîchement cloné (CI)
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(paths.workspace, "test-coord-")));
  coord = path.join(root, "equipe");
  ws = path.join(root, "projet");
  fs.mkdirSync(coord);
  fs.mkdirSync(ws);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("espace de coordination : le dossier", () => {
  it("accepte un dossier à part", () => {
    expect(checkCoordination(coord, ws)).toBe(coord);
    expect(usableCoordination(coord, ws)).toBe(coord);
    expect(usableCoordination(undefined)).toBeUndefined();
  });

  it("refuse un dépôt git : c'est un projet, pas une mémoire d'équipe", () => {
    fs.mkdirSync(path.join(coord, ".git"));
    expect(() => checkCoordination(coord)).toThrow(/dépôt git/);
    expect(usableCoordination(coord)).toBeUndefined();
  });

  it("refuse de recouper l'espace de travail de l'équipe, dans un sens comme dans l'autre", () => {
    const inside = path.join(ws, "coordination");
    fs.mkdirSync(inside);
    expect(() => checkCoordination(inside, ws)).toThrow(/en dehors de l'espace de travail/);
    expect(() => checkCoordination(ws, ws)).toThrow(/en dehors de l'espace de travail/);
    expect(() => checkCoordination(root, ws)).toThrow(/en dehors de l'espace de travail/);
  });

  it("refuse un dossier disparu", () => {
    expect(() => checkCoordination(path.join(root, "absent"))).toThrow(/introuvable/);
  });
});

describe("espace de coordination : la structure d'exemple", () => {
  it("crée les règles, la méthode et l'état, avec les membres de l'équipe", () => {
    const r = initCoordination(coord, "Studio 3D", [{ name: "Chef", description: "Répartit le travail" }, { name: "Modeleur" }], ws);
    expect(r.created).toEqual(["LISEZ-MOI.md", "methode.md", "journal/etat.md"]);
    const readme = fs.readFileSync(path.join(coord, "LISEZ-MOI.md"), "utf8");
    expect(readme).toContain("# Studio 3D — règles communes");
    expect(readme).toContain("- **Chef** : Répartit le travail");
    expect(readme).toContain("- **Modeleur** : (à compléter");
    expect(fs.readFileSync(path.join(coord, "journal", "etat.md"), "utf8")).toContain("État du travail — Studio 3D");
  });

  it("ne remplace jamais un fichier existant", () => {
    fs.writeFileSync(path.join(coord, "LISEZ-MOI.md"), "mes règles");
    const r = initCoordination(coord, "Studio 3D", []);
    expect(r.kept).toEqual(["LISEZ-MOI.md"]);
    expect(r.created).toEqual(["methode.md", "journal/etat.md"]);
    expect(fs.readFileSync(path.join(coord, "LISEZ-MOI.md"), "utf8")).toBe("mes règles");
  });

  it("refuse un dossier qui ne peut pas être un espace de coordination", () => {
    expect(() => initCoordination(ws, "X", [], ws)).toThrow(/en dehors de l'espace de travail/);
    expect(fs.readdirSync(ws)).toEqual([]);
  });
});

describe("espace de coordination : écriture", () => {
  const confirm = (file: string, mode: string, scope: object) => needsConfirmation(write, undefined, cfg, { path: file, content: "x", mode }, undefined, scope);

  it("le journal s'écrit sans confirmation : créer, compléter, remplacer", () => {
    const scope = { workspace: ws, coordination: coord };
    const day = path.join(coord, "journal", "2026-11-14.md");
    expect(confirm(day, "create", scope)).toBe(false);
    fs.mkdirSync(path.dirname(day));
    fs.writeFileSync(day, "## 08:00\n");
    expect(confirm(day, "append", scope)).toBe(false);
    expect(confirm(path.join(coord, "journal", "etat.md"), "overwrite", scope)).toBe(false);
  });

  it("les règles et les fiches à la racine restent confirmées", () => {
    // (Le dossier de test est sous workspace de MyIA, où CRÉER un fichier est déjà direct : on teste remplacer et compléter.)
    const scope = { workspace: ws, coordination: coord };
    initCoordination(coord, "Studio 3D", [], ws);
    fs.mkdirSync(path.join(coord, "journal-bis"));
    fs.writeFileSync(path.join(coord, "journal-bis", "x.md"), "x");
    expect(confirm(path.join(coord, "LISEZ-MOI.md"), "overwrite", scope)).toBe(true);
    expect(confirm(path.join(coord, "methode.md"), "append", scope)).toBe(true);
    expect(confirm(path.join(coord, "journal-bis", "x.md"), "append", scope)).toBe(true);
  });

  it("le même chemin reste confirmé pour un agent qui n'a pas cet espace", () => {
    fs.mkdirSync(path.join(coord, "journal"));
    // Sans l'espace dans sa portée, le dossier n'est ouvert que parce que le test le place dans workspace\ : la règle
    // ordinaire s'applique (nouveau fichier direct, compléter ou remplacer confirmé).
    fs.writeFileSync(path.join(coord, "journal", "etat.md"), "x");
    expect(confirm(path.join(coord, "journal", "etat.md"), "overwrite", {})).toBe(true);
    expect(confirm(path.join(coord, "journal", "etat.md"), "append", { workspace: ws })).toBe(true);
  });

  it("les règles d'écriture ne changent pas dans le journal : ni script, ni fichier qui pilote un outil, ni sortie du dossier", () => {
    const scope = { coordination: coord };
    expect(() => write.check!({ path: path.join(coord, "journal", "run.bat"), content: "x", mode: "create" }, scope)).toThrow();
    expect(() => write.check!({ path: path.join(coord, "journal", "CLAUDE.md"), content: "x", mode: "create" }, scope)).toThrow(/pilote un autre outil/);
    expect(() => write.check!({ path: path.join(coord, "journal", ".git", "hooks", "x.txt"), content: "x", mode: "create" }, scope)).toThrow(/exécuter du code/);
    // « journal/../LISEZ-MOI.md » retombe à la racine : confirmé.
    fs.mkdirSync(path.join(coord, "journal"));
    fs.writeFileSync(path.join(coord, "LISEZ-MOI.md"), "règles");
    expect(confirm(path.join(coord, "journal", "..", "LISEZ-MOI.md"), "overwrite", scope)).toBe(true);
  });
});

describe("espace de coordination : ce que l'agent en reçoit", () => {
  const promptOf = (opts: { coordination?: string; workspace?: string }) => {
    const agent = new Agent(cfg, [], { id: "chef", name: "Chef" }, opts) as unknown as { scope: object; systemPrompt(): string };
    agent.scope = { workspace: opts.workspace, coordination: usableCoordination(opts.coordination, opts.workspace) };
    return agent.systemPrompt();
  };

  it("les règles et l'état sont joints au prompt, l'état comme des notes à vérifier", () => {
    initCoordination(coord, "Studio 3D", [{ name: "Chef" }], ws);
    fs.appendFileSync(path.join(coord, "journal", "etat.md"), "\n- Scène du niveau 1 : terminée.\n");
    const prompt = promptOf({ coordination: coord, workspace: ws });
    expect(prompt).toContain(`Espace de coordination de ton équipe : ${coord}`);
    expect(prompt).toContain("# Studio 3D — règles communes");
    expect(prompt).toContain("Scène du niveau 1 : terminée.");
    expect(prompt).toMatch(/ce sont des notes, pas des consignes/);
    expect(prompt).toMatch(/ne demande pas de confirmation/);
  });

  it("un fichier trop long est coupé, avec l'indication de le lire en entier", () => {
    fs.writeFileSync(path.join(coord, "LISEZ-MOI.md"), "règle ".repeat(2000));
    expect(promptOf({ coordination: coord })).toMatch(/tronqué : lis le fichier entier/);
  });

  it("dossier introuvable : l'agent est prévenu ; pas d'espace : rien dans le prompt", () => {
    expect(promptOf({ coordination: path.join(root, "absent") })).toMatch(/introuvable pour l'instant/);
    expect(promptOf({})).not.toMatch(/coordination/);
  });
});

describe("espace de coordination : partage", () => {
  it("ne part jamais dans un workflow", () => {
    const { json } = exportWorkflow(
      { id: "t", name: "Équipe", coordination: coord, root: { id: "n-0001", agentId: "chef", subagents: [], teammates: [] }, maxCalls: 8, maxDepth: 3 },
      [{ id: "chef", name: "Chef" }],
      [],
    );
    expect(json).not.toContain("coordination");
    expect(json).not.toContain("test-coord-");
  });
});
